import { execFileSync } from 'node:child_process';
import type { FeatureStatus } from '@prisma/client';
import { enqueueJob, getQueue } from './queue.js';
import type { AgentJobPayload } from './queue.js';
import type { Feature } from './features.js';
import { getPrisma } from './prisma.js';
import { appendEvent } from './events.js';

// Read once at module load — forking git on every dispatch is too expensive.
// tsx watch restarts the process on commit, so the value stays current.
// Wrapped in a mutable object so tests can set _headCommit.value without a
// git process — ES module live bindings are not assignable from outside.
export const _headCommit: { value: string | null } = {
  value: (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      }).trim();
    } catch {
      return null;
    }
  })(),
};

/**
 * Enqueue a job and emit a structured warning when no worker is consuming the
 * queue. Centralises both concerns so every dispatch path (state-entry and
 * dev-tool kick-offs) gets the observability for free.
 *
 * enqueueJob remains the raw BullMQ primitive; all callers outside lib/ and
 * jobs/ must go through dispatchJob or dispatchForState.
 */
export async function dispatchJob(
  featureId: string,
  task: AgentJobPayload['task'],
  extra?: { taskId?: string; charterPath?: string },
): Promise<string> {
  const jobId = await enqueueJob(featureId, task, extra);

  try {
    const workers = await getQueue().getWorkers();
    if (workers.length === 0) {
      console.error(
        JSON.stringify({
          event: 'dispatch_no_workers',
          task,
          featureId,
          warning: 'Job queued but no active worker — job will not run until a worker connects',
        }),
      );
    }
  } catch {
    // Non-fatal: Redis briefly unavailable; don't block the caller.
  }

  try {
    const workerCommit = process.env['WORKER_CODE_COMMIT'];
    if (workerCommit && workerCommit !== 'unknown') {
      if (_headCommit.value && _headCommit.value !== workerCommit) {
        console.error(
          JSON.stringify({
            event: 'dispatch_commit_drift',
            worker_commit: workerCommit,
            head_commit: _headCommit.value,
            task,
            featureId,
          }),
        );
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'muted',
          text: `· worker booted at ${workerCommit}, HEAD is now ${_headCommit.value} — loaded code may not match`,
        });
      }
    }
  } catch {
    // Non-fatal: drift detection must never block dispatch.
  }

  return jobId;
}

/**
 * Enqueue dev jobs for pending tasks on the given side whose depends_on are all
 * satisfied (i.e. every dependency task ID is completed). Tasks with outstanding
 * dependencies are left pending and will be enqueued by the next call.
 *
 * One-task-per-repo-per-wave invariant: if a task for a repo is already running,
 * that repo is skipped entirely this wave. This prevents two independent tasks
 * from the same repo running concurrently and racing on the shared worktree —
 * each job begins with `git checkout . && git clean -fd` which would delete the
 * sibling's uncommitted files mid-flight.
 *
 * Called both at IMPLEMENTING entry (dispatchForState) and after each task
 * completes (completeTask in serverDevJob), so sequential order is respected.
 */
export async function dispatchUnblockedTasks(
  featureId: string,
  side: 'server' | 'client',
): Promise<void> {
  const jobType = side === 'server' ? ('server-dev' as const) : ('client-dev' as const);

  // Load ALL tasks for the feature — dependencies can cross sides.
  // completedIds must include server task IDs so client tasks that depend on
  // server tasks (and vice versa) are unblocked correctly.
  const allFeatureTasks = await getPrisma().task.findMany({
    where: { featureId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      status: true,
      title: true,
      dependsOn: true,
      repo: true,
      side: true,
      coveredByTestPlan: true,
      testsWritten: true,
      testTaskAttempts: true,
    },
  });

  // Completed set spans both sides — cross-side depends_on is resolved correctly.
  const completedIds = new Set(
    allFeatureTasks.filter((t) => t.status === 'completed').map((t) => t.id),
  );

  // Only dispatch tasks on the requested side; enforce wave invariant per-side.
  const sideTasks = allFeatureTasks.filter((t) => t.side === side);

  // Repos that already have a running task — skip the entire repo this wave
  // to enforce max-one-running-task-per-worktree.
  const runningRepos = new Set(sideTasks.filter((t) => t.status === 'running').map((t) => t.repo));

  const allUnblocked = sideTasks.filter(
    (t) =>
      t.status === 'pending' &&
      !runningRepos.has(t.repo) &&
      (t.dependsOn as string[]).every((dep) => completedIds.has(dep)),
  );

  // Deduplicate to first-per-repo: only enqueue the earliest unblocked task per repo.
  const seenRepos = new Set<string>();
  const dispatchable = allUnblocked.filter((t) => {
    if (seenRepos.has(t.repo)) return false;
    seenRepos.add(t.repo);
    return true;
  });

  for (const task of dispatchable) {
    // Covered tasks with no tests yet go to the task-test job first; once
    // testsWritten is set, the same task routes to the dev job on re-dispatch.
    // If a prior test-task attempt already ran (testTaskAttempts > 0), skip
    // the test-task routing — the task proceeds directly to the dev job.
    const needsTestFirst =
      task.coveredByTestPlan && !task.testsWritten && task.testTaskAttempts === 0;
    const resolvedJobType = needsTestFirst
      ? side === 'server'
        ? ('server-test-task' as const)
        : ('client-test-task' as const)
      : jobType;
    const jobId = await dispatchJob(featureId, resolvedJobType, { taskId: task.id });
    if (jobId) {
      await getPrisma().task.update({ where: { id: task.id }, data: { bullJobId: jobId } });
    }
  }

  if (dispatchable.length === 0) {
    const pendingCount = sideTasks.filter((t) => t.status === 'pending').length;
    // Suppress the no-tasks warning when all tasks are completed or awaiting_tests
    // (covered tasks holding in awaiting_tests are not a seeding bug).
    const allDone =
      sideTasks.length > 0 &&
      sideTasks.every((t) => t.status === 'completed' || t.status === 'awaiting_tests');
    if (pendingCount > 0) {
      console.error(
        JSON.stringify({
          event: 'dispatch_all_tasks_blocked',
          featureId,
          side,
          warning: `${pendingCount} pending task(s) blocked by unmet dependencies or running sibling`,
        }),
      );
    } else if (!allDone) {
      // Only warn when no tasks exist at all (plan seeding bug).
      // Suppress when all tasks are completed or awaiting acceptance tests.
      console.error(
        JSON.stringify({
          event: 'dispatch_no_tasks',
          featureId,
          side,
          warning: `IMPLEMENTING entered but no pending ${side} tasks found — check plan seeding`,
        }),
      );
    }
  }
}

/**
 * Dispatches the appropriate background job whenever the state machine enters
 * a new state. Called from every transition point (route handlers, job handlers)
 * immediately after applyTransition returns a non-null next state.
 *
 * This is the single source of truth for "entering state X enqueues job Y".
 * Route handlers and job handlers must never call enqueueJob directly.
 *
 * IMPLEMENTING → enqueues server-dev jobs for pending server-side tasks (4b).
 * Phase 4c TODO: also enqueue client-dev jobs when parallel dispatch lands.
 */
export async function dispatchForState(
  featureId: string,
  newState: FeatureStatus,
  feature: Pick<Feature, 'simulated_run'>,
): Promise<void> {
  switch (newState) {
    case 'PLANNING':
      // The plan job handles real vs simulated internally via feature.simulatedRun.
      await dispatchJob(featureId, 'plan');
      break;

    case 'PLANNING_TESTS':
      if (feature.simulated_run) {
        await dispatchJob(featureId, 'simulate-resume');
      } else {
        await dispatchJob(featureId, 'test-plan');
      }
      break;

    case 'LIGHT_IMPLEMENTING': {
      // Dispatch one light-dev job per selected repo. No tasks, no test runner.
      const lightFeature = await getPrisma().feature.findUniqueOrThrow({
        where: { id: featureId },
        select: { repos: true },
      });
      for (const repoId of lightFeature.repos) {
        await enqueueJob(featureId, 'light-dev', { repoId });
      }
      break;
    }

    case 'IMPLEMENTING':
      if (feature.simulated_run) {
        // Simulated run: continue the simulator walk to DONE.
        await dispatchJob(featureId, 'simulate-resume');
      } else {
        // Real run: enqueue unblocked tasks for both sides in parallel.
        // Each call is independent — server and client worktrees are separate.
        // Within each side, max one task per repo per wave is enforced by
        // dispatchUnblockedTasks to prevent worktree reset races.
        await Promise.all([
          dispatchUnblockedTasks(featureId, 'server'),
          dispatchUnblockedTasks(featureId, 'client'),
        ]);
      }
      break;

    case 'CODE_REVIEW':
      if (feature.simulated_run) {
        // Simulated run: walk the configured CODE_REVIEW sub-path (Phase 5).
        await dispatchJob(featureId, 'simulate-resume');
      } else {
        // Real run: create ADO pull requests then run the Review Agent.
        await dispatchJob(featureId, 'create-ado-pr');
      }
      break;

    case 'TESTING':
      if (feature.simulated_run) {
        await dispatchJob(featureId, 'simulate-resume');
      } else {
        await dispatchJob(featureId, 'test');
      }
      break;

    default:
      // No dispatch needed for this state.
      break;
  }
}
