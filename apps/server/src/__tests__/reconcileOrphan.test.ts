import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockGetActive, mockGetWaiting, mockGetDelayed } = vi.hoisted(() => ({
  mockGetActive: vi.fn().mockResolvedValue([]),
  mockGetWaiting: vi.fn().mockResolvedValue([]),
  mockGetDelayed: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/queue.js', () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
  getQueue: () => ({
    getWorkers: vi.fn().mockResolvedValue([]),
    getActive: mockGetActive,
    getWaiting: mockGetWaiting,
    getDelayed: mockGetDelayed,
  }),
  closeQueue: vi.fn(),
}));

vi.mock('../lib/dispatch.js', () => ({
  dispatchUnblockedTasks: vi.fn().mockResolvedValue(undefined),
  dispatchJob: vi.fn().mockResolvedValue(undefined),
  dispatchForState: vi.fn().mockResolvedValue(undefined),
  _headCommit: { value: null },
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { reconcileOrphanedTasks } from '../lib/taskReconciler.js';
import { dispatchUnblockedTasks } from '../lib/dispatch.js';

let featureId: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  vi.clearAllMocks();
  mockGetActive.mockResolvedValue([]);
  mockGetWaiting.mockResolvedValue([]);
  mockGetDelayed.mockResolvedValue([]);

  const feature = await createFeature({ name: 'Orphan Test', requirement: 'req' });
  featureId = feature.id;
  await getPrisma().feature.update({
    where: { id: featureId },
    data: { status: 'IMPLEMENTING' },
  });
});

afterEach(async () => {
  await disconnectPrisma();
});

// ── orphan-park must not consume a retry attempt ───────────────────────────────

describe('reconcileOrphanedTasks — attempt preservation', () => {
  it('orphaned dev-task: attemptCount is decremented back and task is re-enqueued (not a consumed attempt)', async () => {
    // Simulate: devJob incremented attemptCount to 1 at job start, then the process crashed.
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Dev task',
        description: 'Dev task',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 1,
        bullJobId: 'orphaned-job-1',
      },
    });

    // All BullMQ lists are empty — the job has no live entry.
    await reconcileOrphanedTasks();

    const updated = await getPrisma().task.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe('pending'); // re-enqueued, not parked
    expect(updated.attemptCount).toBe(0); // undone — the agent never had a turn

    const failedEvent = await getPrisma().event.findFirst({
      where: { featureId, type: 'task.failed' },
    });
    expect(failedEvent).not.toBeNull();
    const payload = failedEvent!.payload as Record<string, unknown>;
    expect(payload['orphaned']).toBe(true);
    expect(payload['final']).toBe(false); // not final — will retry
  });

  it('orphaned test-task: testTaskAttempts is decremented back and task is re-enqueued (not a consumed round)', async () => {
    // Simulate: taskTestJob incremented testTaskAttempts to 1 at job start, then the process crashed.
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Test task',
        description: 'Test task',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 0,
        coveredByTestPlan: true,
        testsWritten: false,
        testTaskAttempts: 1,
        bullJobId: 'orphaned-job-2',
      },
    });

    await reconcileOrphanedTasks();

    const updated = await getPrisma().task.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe('pending'); // re-enqueued, not parked
    expect(updated.testTaskAttempts).toBe(0); // undone — the test agent never had a turn
    expect(updated.attemptCount).toBe(0); // dev attempt count untouched

    const failedEvent = await getPrisma().event.findFirst({
      where: { featureId, type: 'task.failed' },
    });
    expect(failedEvent).not.toBeNull();
    const payload = failedEvent!.payload as Record<string, unknown>;
    expect(payload['orphaned']).toBe(true);
    expect(payload['final']).toBe(false); // not final — will retry
  });

  it('genuine agent failure (already parked by devJob): reconcile leaves attemptCount unchanged', async () => {
    // Simulate: devJob ran, agent produced output, then hit a final error and parked the task.
    // The task is already parked — reconcile should not touch it.
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Failed dev task',
        description: 'Failed dev task',
        specRefs: [],
        dependsOn: [],
        status: 'parked',
        attemptCount: 2,
        parkReason: 'failure',
        bullJobId: null,
      },
    });

    await reconcileOrphanedTasks();

    const unchanged = await getPrisma().task.findUniqueOrThrow({ where: { id: task.id } });
    expect(unchanged.status).toBe('parked');
    expect(unchanged.parkReason).toBe('failure'); // genuine failure: must be preserved
    expect(unchanged.attemptCount).toBe(2);
  });
});

// ── orphan auto-recovery (re-enqueue instead of park) ─────────────────────────

describe('reconcileOrphanedTasks — orphan auto-recovery', () => {
  it('first orphan: task reset to pending, orphanCount 0→1, dispatched', async () => {
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Dev task',
        description: 'Dev task',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 1,
        orphanCount: 0,
        bullJobId: 'orphaned-job-10',
      },
    });

    await reconcileOrphanedTasks();

    const updated = await getPrisma().task.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe('pending'); // re-enqueued, not parked
    expect(updated.orphanCount).toBe(1); // recovery counter incremented
    expect(updated.parkReason).toBeNull(); // not parked
    expect(updated.bullJobId).toBeNull(); // stale job id cleared
    expect(updated.attemptCount).toBe(0); // attempt decrement preserved

    const failedEvent = await getPrisma().event.findFirst({
      where: { featureId, type: 'task.failed' },
    });
    expect(failedEvent).not.toBeNull();
    const payload = failedEvent!.payload as Record<string, unknown>;
    expect(payload['orphaned']).toBe(true);
    expect(payload['final']).toBe(false); // not final — will be retried

    expect(dispatchUnblockedTasks).toHaveBeenCalledWith(featureId, 'server');
  });

  it('second orphan: orphanCount 1→2, still re-enqueued (not at cap)', async () => {
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Dev task 2',
        description: 'Dev task 2',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 1,
        orphanCount: 1,
        bullJobId: 'orphaned-job-11',
      },
    });

    await reconcileOrphanedTasks();

    const updated = await getPrisma().task.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe('pending');
    expect(updated.orphanCount).toBe(2);
    expect(updated.parkReason).toBeNull();
  });

  it('running task with null bullJobId is NOT treated as orphaned (not yet dispatched window)', async () => {
    await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Just dispatched task',
        description: 'Just dispatched task',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 1,
        bullJobId: null,
      },
    });

    // All BullMQ lists are empty — but null bullJobId means "not yet dispatched", not orphaned.
    await reconcileOrphanedTasks();

    const row = await getPrisma().task.findFirstOrThrow({
      where: { featureId, title: 'Just dispatched task' },
    });
    expect(row.status).toBe('running');
    expect(dispatchUnblockedTasks).not.toHaveBeenCalled();
  });

  it('third orphan (cap reached): task parked with orphan_cap, dispatchUnblockedTasks not called', async () => {
    vi.clearAllMocks();
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Dev task 3',
        description: 'Dev task 3',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 1,
        orphanCount: 2, // about to hit cap
        bullJobId: 'orphaned-job-12',
      },
    });

    await reconcileOrphanedTasks();

    const updated = await getPrisma().task.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.status).toBe('parked');
    expect(updated.parkReason).toBe('orphan_cap'); // distinct reason from agent failure
    expect(updated.orphanCount).toBe(2); // not incremented once capped

    const failedEvent = await getPrisma().event.findFirst({
      where: { featureId, type: 'task.failed' },
    });
    expect(failedEvent).not.toBeNull();
    const payload = failedEvent!.payload as Record<string, unknown>;
    expect(payload['orphaned']).toBe(true);
    expect(payload['final']).toBe(true); // final — structural issue

    expect(dispatchUnblockedTasks).not.toHaveBeenCalled();
  });
});
