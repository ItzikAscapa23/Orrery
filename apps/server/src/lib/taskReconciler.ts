import { getPrisma } from './prisma.js';
import { getQueue } from './queue.js';
import { appendEvent } from './events.js';
import { dispatchUnblockedTasks } from './dispatch.js';

/**
 * Build the set of BullMQ job IDs that are currently "live" — i.e. should
 * not be treated as zombies. A job is live if it is:
 *   active  — currently being processed by a worker
 *   waiting — queued and ready to run
 *   delayed — in retry backoff (counts as live; the task will resume)
 */
async function getLiveJobIds(): Promise<Set<string>> {
  const [active, waiting, delayed] = await Promise.all([
    getQueue().getActive(),
    getQueue().getWaiting(),
    getQueue().getDelayed(),
  ]);
  const ids = new Set<string>();
  for (const job of [...active, ...waiting, ...delayed]) {
    if (job.id) ids.add(job.id);
  }
  return ids;
}

// Allow 2 auto-recoveries; the 3rd orphan event parks the task.
// orphanCount is 0-indexed: 0=1st orphan, 1=2nd orphan, 2=3rd orphan (cap).
const ORPHAN_MAX_RECOVERIES = 2;
const ORPHAN_DISPLAY_TOTAL = ORPHAN_MAX_RECOVERIES + 1; // "3 times" in messages

/**
 * Scan all tasks in `running` state. Any task whose bullJobId is not present
 * in the live BullMQ job set is an orphan — the server was killed mid-job
 * before the graceful shutdown handler could write the task.failed event.
 *
 * Under-cap (orphanCount < 3): reset to pending and re-enqueue so the task
 * continues automatically without operator action. The orphaned attempt does
 * not consume a retry slot.
 *
 * At-cap (orphanCount >= 3): park with parkReason 'orphan_cap'. Three
 * consecutive orphans indicate a structural problem; operator must investigate.
 */
export async function reconcileOrphanedTasks(): Promise<void> {
  const runningTasks = await getPrisma().task.findMany({
    where: { status: 'running' },
    select: {
      id: true,
      featureId: true,
      repo: true,
      side: true,
      bullJobId: true,
      attemptCount: true,
      testTaskAttempts: true,
      testsWritten: true,
      coveredByTestPlan: true,
      orphanCount: true,
    },
  });
  if (runningTasks.length === 0) return;

  const liveJobIds = await getLiveJobIds();

  // Collect (featureId, side) pairs for tasks that were re-enqueued (not capped),
  // keyed by "featureId:side" to deduplicate.
  const toDispatch = new Map<string, { featureId: string; side: string }>();

  for (const task of runningTasks) {
    // A null bullJobId means dispatch persisted the job before the handler ran — not orphaned.
    // Only treat as orphaned when a non-null ID is absent from the live BullMQ set.
    if (!task.bullJobId || liveJobIds.has(task.bullJobId)) continue;

    // No live BullMQ job — orphaned by a prior restart or mid-backoff gap.
    // The job incremented its counter (testTaskAttempts or attemptCount) at startup
    // before doing any real work. Undo that increment so the orphan does not consume
    // a retry slot — environmental failures should not penalise the agent budget.
    const wasInTestJob = task.coveredByTestPlan && !task.testsWritten && task.testTaskAttempts > 0;
    const attemptForEvent = Math.max(1, wasInTestJob ? task.testTaskAttempts : task.attemptCount);
    const attemptDecrement = wasInTestJob
      ? ({ testTaskAttempts: { decrement: 1 } } as const)
      : ({ attemptCount: { decrement: 1 } } as const);

    if (task.orphanCount < ORPHAN_MAX_RECOVERIES) {
      // Under cap: reset to pending so the next dispatch cycle picks it up.
      await getPrisma().task.update({
        where: { id: task.id },
        data: {
          status: 'pending',
          bullJobId: null,
          parkReason: null,
          orphanCount: { increment: 1 },
          ...attemptDecrement,
        },
      });
      await appendEvent(getPrisma(), task.featureId, {
        type: 'task.failed',
        repo: task.repo,
        task_id: task.id,
        reason: `orphaned by restart — will be re-enqueued (recovery ${task.orphanCount + 1}/${ORPHAN_DISPLAY_TOTAL})`,
        attempt: attemptForEvent,
        final: false,
        orphaned: true,
      });
      console.error(
        JSON.stringify({
          event: 'task_orphan_requeued',
          taskId: task.id,
          featureId: task.featureId,
          orphanCount: task.orphanCount + 1,
          bullJobId: task.bullJobId ?? null,
        }),
      );
      toDispatch.set(`${task.featureId}:${task.side}`, {
        featureId: task.featureId,
        side: task.side,
      });
    } else {
      // Cap reached: park with a distinct reason so operators and the startup
      // sweep can tell this apart from a genuine agent failure.
      await getPrisma().task.update({
        where: { id: task.id },
        data: {
          status: 'parked',
          parkReason: 'orphan_cap',
          ...attemptDecrement,
        },
      });
      await appendEvent(getPrisma(), task.featureId, {
        type: 'task.failed',
        repo: task.repo,
        task_id: task.id,
        reason: `orphaned ${ORPHAN_DISPLAY_TOTAL} times — structural issue suspected; task parked`,
        attempt: attemptForEvent,
        final: true,
        orphaned: true,
      });
      console.error(
        JSON.stringify({
          event: 'task_orphan_capped',
          taskId: task.id,
          featureId: task.featureId,
          bullJobId: task.bullJobId ?? null,
        }),
      );

      // The task is now parked, so a count of 'running' tasks for this side
      // naturally excludes it. Only emit agent.status(failed) when no sibling
      // task on the same side is still running — two tasks on one side, one
      // orphaned, should not mark the whole agent failed while the other runs.
      const siblingRunning = await getPrisma().task.count({
        where: {
          featureId: task.featureId,
          side: task.side,
          status: 'running',
        },
      });
      if (siblingRunning === 0) {
        await appendEvent(getPrisma(), task.featureId, {
          type: 'agent.status',
          agent: task.side,
          status: 'failed',
          repo: task.repo,
        });
      }
    }
  }

  // Re-dispatch tasks that were re-enqueued above. Only IMPLEMENTING
  // non-simulated features need a dispatch — other states manage their own
  // dispatch cycle.
  for (const { featureId, side } of toDispatch.values()) {
    const feature = await getPrisma().feature.findUnique({
      where: { id: featureId },
      select: { status: true, simulatedRun: true },
    });
    if (feature?.status === 'IMPLEMENTING' && !feature.simulatedRun) {
      await dispatchUnblockedTasks(featureId, side as 'server' | 'client');
    }
  }
}

/**
 * Start a periodic reconciliation sweep. Runs once immediately at startup,
 * then every 60 seconds. Returns the interval handle so callers can clear it.
 */
export function startReconcilerInterval(): NodeJS.Timeout {
  void reconcileOrphanedTasks();
  return setInterval(() => void reconcileOrphanedTasks(), 60_000);
}
