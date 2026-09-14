import { getPrisma } from './prisma.js';
import { dispatchUnblockedTasks } from './dispatch.js';

/**
 * After sweepOrphanContainers() kills all containers from the prior process,
 * every task still in 'running' state is provably stale — its container no
 * longer exists. Reset them to pending so the reconciler and startup sweep can
 * dispatch them normally.
 *
 * Called at worker startup between sweepOrphanContainers and resumeOrphanStalledFeatures.
 */
export async function resetStaleRunningTasks(): Promise<void> {
  const count = await getPrisma().task.updateMany({
    where: { status: 'running' },
    data: { status: 'pending', bullJobId: null },
  });
  if (count.count > 0) {
    console.error(
      JSON.stringify({
        event: 'startup_stale_tasks_reset',
        count: count.count,
      }),
    );
  }
}

/**
 * On worker startup, scan for IMPLEMENTING features whose tasks are all
 * parked-by-orphan (parkReason === 'orphan') with no genuine failures.
 * These tasks were parked by a previous reconciler run after a crash and
 * never got a dispatch because the server restarted before re-enqueueing.
 *
 * Safe to call repeatedly — already-running or failure-parked features are
 * skipped. Only features where every non-completed task is orphan-parked
 * (or pending) get a single dispatch round.
 */
export async function resumeOrphanStalledFeatures(): Promise<void> {
  const features = await getPrisma().feature.findMany({
    where: { status: 'IMPLEMENTING', simulatedRun: false },
    include: { tasks: true },
  });

  for (const feature of features) {
    const tasks = feature.tasks;
    if (tasks.length === 0) continue;

    // Reconciler handles still-running tasks in the next sweep.
    if (tasks.some((t) => t.status === 'running')) continue;

    // Real agent failure or structural cap → needs operator attention.
    if (tasks.some((t) => t.status === 'parked' && t.parkReason === 'failure')) continue;
    if (tasks.some((t) => t.status === 'parked' && t.parkReason === 'orphan_cap')) continue;

    const orphanParked = tasks.filter((t) => t.status === 'parked' && t.parkReason === 'orphan');
    if (orphanParked.length === 0) continue;

    // Guard: reject any parked task with an unrecognised reason to avoid
    // silently resuming a feature in an unknown state.
    const unrecognised = tasks.filter((t) => t.status === 'parked' && t.parkReason !== 'orphan');
    if (unrecognised.length > 0) continue;

    await getPrisma().task.updateMany({
      where: { featureId: feature.id, status: 'parked', parkReason: 'orphan' },
      data: { status: 'pending', parkReason: null },
    });

    await Promise.all([
      dispatchUnblockedTasks(feature.id, 'server'),
      dispatchUnblockedTasks(feature.id, 'client'),
    ]);

    console.error(
      JSON.stringify({
        event: 'startup_orphan_resume',
        featureId: feature.id,
        tasksResumed: orphanParked.length,
      }),
    );
  }
}
