import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockEnqueueJob, mockGetActive, mockGetWaiting, mockGetDelayed } = vi.hoisted(() => ({
  mockEnqueueJob: vi.fn().mockResolvedValue(undefined),
  mockGetActive: vi.fn().mockResolvedValue([]),
  mockGetWaiting: vi.fn().mockResolvedValue([]),
  mockGetDelayed: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/queue.js', () => ({
  enqueueJob: mockEnqueueJob,
  getQueue: () => ({
    getWorkers: vi.fn().mockResolvedValue([]),
    getActive: mockGetActive,
    getWaiting: mockGetWaiting,
    getDelayed: mockGetDelayed,
  }),
  closeQueue: vi.fn(),
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { dispatchUnblockedTasks } from '../lib/dispatch.js';
import { reconcileOrphanedTasks } from '../lib/taskReconciler.js';
import { appendEvent } from '../lib/events.js';
import { completeTask } from '../jobs/serverDevJob.js';

let featureId: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  vi.clearAllMocks();
  mockEnqueueJob.mockResolvedValue(undefined);
  mockGetActive.mockResolvedValue([]);
  mockGetWaiting.mockResolvedValue([]);
  mockGetDelayed.mockResolvedValue([]);

  const feature = await createFeature({ name: 'Dispatch Test', requirement: 'req' });
  featureId = feature.id;
  await getPrisma().feature.update({
    where: { id: featureId },
    data: { status: 'IMPLEMENTING' },
  });
});

afterEach(async () => {
  await disconnectPrisma();
});

// ── depends_on enforcement ─────────────────────────────────────────────────────

describe('dispatchUnblockedTasks — depends_on enforcement', () => {
  // Seed tasks with ID-based depends_on resolution (mirrors featurePlanGate.ts).
  // titles in dependsOn are resolved to IDs of previously-created tasks in this call.
  async function seedTasks(
    tasks: Array<{ title: string; dependsOn?: string[]; status?: string }>,
  ): Promise<Array<{ id: string; title: string }>> {
    const created: Array<{ id: string; title: string }> = [];
    const titleToId = new Map<string, string>();
    for (const t of tasks) {
      const depIds = (t.dependsOn ?? []).map((title) => titleToId.get(title) ?? title);
      const row = await getPrisma().task.create({
        data: {
          featureId,
          repo: 'demo-server',
          side: 'server',
          title: t.title,
          description: t.title,
          specRefs: [],
          dependsOn: depIds,
          status: (t.status ?? 'pending') as 'pending' | 'completed' | 'running' | 'parked',
        },
      });
      created.push({ id: row.id, title: row.title });
      titleToId.set(t.title, row.id);
    }
    return created;
  }

  it('enqueues task with no deps immediately', async () => {
    const [impl] = await seedTasks([{ title: 'Implement endpoint' }]);
    await dispatchUnblockedTasks(featureId, 'server');
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'server-dev', { taskId: impl!.id });
  });

  it('does NOT enqueue dependent task until dependency is completed', async () => {
    await seedTasks([
      { title: 'Implement endpoint' },
      { title: 'Write unit tests', dependsOn: ['Implement endpoint'] },
    ]);
    await dispatchUnblockedTasks(featureId, 'server');
    // Only Implement should be enqueued — Write unit tests is blocked
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    const calledWith = mockEnqueueJob.mock.calls[0]?.[2] as { taskId: string };
    const dispatchedTask = await getPrisma().task.findUnique({
      where: { id: calledWith.taskId },
    });
    expect(dispatchedTask?.title).toBe('Implement endpoint');
  });

  it('enqueues dependent task once dependency is completed', async () => {
    const [impl, tests] = await seedTasks([
      { title: 'Implement endpoint' },
      { title: 'Write unit tests', dependsOn: ['Implement endpoint'] },
    ]);

    // Mark impl as completed
    await getPrisma().task.update({
      where: { id: impl!.id },
      data: { status: 'completed' },
    });

    await dispatchUnblockedTasks(featureId, 'server');
    // Implement is completed (not pending) — only Write unit tests should dispatch
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'server-dev', { taskId: tests!.id });
  });

  it('does not re-enqueue completed tasks', async () => {
    await seedTasks([
      { title: 'Task A', status: 'completed' },
      { title: 'Task B' }, // pending, no deps — Task A is done so Task B should dispatch
    ]);
    await dispatchUnblockedTasks(featureId, 'server');
    // Task B should dispatch; Task A is completed (not re-enqueued)
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue a pending task if its repo has a running sibling', async () => {
    await seedTasks([
      { title: 'Task A', status: 'running' }, // same repo, running
      { title: 'Task C' }, // pending, no deps, same repo — blocked
    ]);
    await dispatchUnblockedTasks(featureId, 'server');
    // Task C blocked: repo already has a running task
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('logs dispatch_all_tasks_blocked when all pending tasks have unmet deps', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await seedTasks([
      { title: 'Write tests', dependsOn: ['Implement endpoint'] }, // dep missing entirely
    ]);
    await dispatchUnblockedTasks(featureId, 'server');
    expect(mockEnqueueJob).not.toHaveBeenCalled();
    const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('dispatch_all_tasks_blocked');
    consoleSpy.mockRestore();
  });

  it('one-task-per-repo-per-wave: skips repo when a task is already running', async () => {
    // Task A is running — repo is locked for this wave.
    // Task B (same repo, no deps) is pending but must NOT be enqueued.
    await seedTasks([
      { title: 'Task A', status: 'running' },
      { title: 'Task B' }, // pending, no deps, same repo
    ]);
    await dispatchUnblockedTasks(featureId, 'server');
    // No dispatch — repo has a running task
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('one-task-per-repo-per-wave: enqueues only the first pending task per repo', async () => {
    // Two independent tasks (no deps), same repo, both pending.
    // Only the first (by createdAt) should be enqueued.
    const [first, second] = await seedTasks([{ title: 'Task A' }, { title: 'Task B' }]);
    await dispatchUnblockedTasks(featureId, 'server');
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'server-dev', { taskId: first!.id });
    // Task B not enqueued — only one per repo per wave
    expect(mockEnqueueJob).not.toHaveBeenCalledWith(featureId, 'server-dev', {
      taskId: second!.id,
    });
  });

  it('amendment_paused tasks are not dispatched', async () => {
    // amendment_paused is a separate status from pending — must not be enqueued
    // even though its depends_on are satisfied.
    await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Paused task',
        description: 'Waiting for contract amendment to resolve',
        specRefs: [],
        dependsOn: [],
        status: 'amendment_paused',
        attemptCount: 0,
      },
    });
    await dispatchUnblockedTasks(featureId, 'server');
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('cross-side dependency: client task unblocked by a completed SERVER task is dispatched', async () => {
    // Reproduce the aqi-widget stall: client task depends on a server task ID.
    // dispatchUnblockedTasks('client') must see the server task as completed.
    const [serverTask] = await seedTasks([{ title: 'Implement API', status: 'completed' }]);

    // Create a client task that depends on the server task's ID
    const clientTask = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-client',
        side: 'client',
        title: 'Implement UI Widget',
        description: 'Uses the server API',
        specRefs: [],
        dependsOn: [serverTask!.id], // cross-side dependency
        status: 'pending',
        attemptCount: 0,
      },
    });

    await dispatchUnblockedTasks(featureId, 'client');

    // Client task must be dispatched — its server dependency is satisfied
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'client-dev', {
      taskId: clientTask.id,
    });
  });

  it('multi-repo: dispatches one job per server repo when two server repos have pending tasks', async () => {
    // Seed one task per server repo — no depends_on, both should fire simultaneously.
    const t1 = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Task on repo 1',
        description: 'desc',
        specRefs: [],
        dependsOn: [],
        status: 'pending',
      },
    });
    const t2 = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server-2',
        side: 'server',
        title: 'Task on repo 2',
        description: 'desc',
        specRefs: [],
        dependsOn: [],
        status: 'pending',
      },
    });

    await dispatchUnblockedTasks(featureId, 'server');

    expect(mockEnqueueJob).toHaveBeenCalledTimes(2);
    const taskIds = mockEnqueueJob.mock.calls.map((c) => (c[2] as { taskId: string }).taskId);
    expect(taskIds).toContain(t1.id);
    expect(taskIds).toContain(t2.id);
  });
});

// ── reconcileOrphanedTasks ────────────────────────────────────────────────────

describe('reconcileOrphanedTasks', () => {
  it('re-enqueues a running task with no live BullMQ job and emits task.failed (final: false)', async () => {
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Orphaned task',
        description: 'Was running when server died',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 2,
        orphanCount: 0,
        bullJobId: 'dead-job-99',
      },
    });

    // No live jobs anywhere
    mockGetActive.mockResolvedValue([]);
    mockGetWaiting.mockResolvedValue([]);
    mockGetDelayed.mockResolvedValue([]);

    await reconcileOrphanedTasks();

    const updated = await getPrisma().task.findUnique({ where: { id: task.id } });
    expect(updated?.status).toBe('pending'); // re-enqueued, not parked
    expect(updated?.orphanCount).toBe(1);

    const failedEvent = await getPrisma().event.findFirst({
      where: { featureId, type: 'task.failed' },
    });
    expect(failedEvent).not.toBeNull();
    const payload = failedEvent?.payload as { reason: string; final: boolean };
    expect(payload.reason).toContain('orphaned by restart');
    expect(payload.final).toBe(false); // not final — will be retried
  });

  it('leaves a running task untouched when its bullJobId is in the active set', async () => {
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Genuinely running task',
        description: 'Has a live job',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 1,
        bullJobId: 'live-job-42',
      },
    });

    // bullJobId appears in active jobs (matched by job.id, not job.data.taskId)
    mockGetActive.mockResolvedValue([{ id: 'live-job-42', data: {} }]);

    await reconcileOrphanedTasks();

    const unchanged = await getPrisma().task.findUnique({ where: { id: task.id } });
    expect(unchanged?.status).toBe('running');
    const failedEvent = await getPrisma().event.findFirst({
      where: { featureId, type: 'task.failed' },
    });
    expect(failedEvent).toBeNull();
  });

  it('does nothing when no tasks are in running state', async () => {
    await reconcileOrphanedTasks();
    expect(mockGetActive).not.toHaveBeenCalled();
  });

  it('leaves a running task untouched when its bullJobId is in the delayed set (retry backoff)', async () => {
    await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Task in retry backoff',
        description: 'BullMQ is waiting to retry',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 1,
        bullJobId: 'delayed-job-77',
      },
    });

    // Job is in delayed (retry backoff) — counts as live
    mockGetActive.mockResolvedValue([]);
    mockGetWaiting.mockResolvedValue([]);
    mockGetDelayed.mockResolvedValue([{ id: 'delayed-job-77', data: {} }]);

    await reconcileOrphanedTasks();

    const tasks = await getPrisma().task.findMany({ where: { featureId, status: 'running' } });
    expect(tasks).toHaveLength(1); // still running — not parked
  });

  it('emits agent.status(failed) for the side when orphaned task is last running on that side (cap case)', async () => {
    await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Orphaned sole task',
        description: 'Last running task on server side',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 1,
        orphanCount: 2, // third orphan → cap reached → parks → emits agent.status(failed)
        bullJobId: 'dead-job-solo',
      },
    });

    mockGetActive.mockResolvedValue([]);
    mockGetWaiting.mockResolvedValue([]);
    mockGetDelayed.mockResolvedValue([]);

    await reconcileOrphanedTasks();

    const events = await getPrisma().event.findMany({ where: { featureId } });
    const agentFailed = events.filter(
      (e) =>
        e.type === 'agent.status' &&
        (e.payload as { agent: string }).agent === 'server' &&
        (e.payload as { status: string }).status === 'failed',
    );
    expect(agentFailed).toHaveLength(1);
  });

  it('does not emit agent.status when a sibling task on the same side is still running', async () => {
    await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Orphaned task',
        description: 'Will be re-enqueued',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 1,
        bullJobId: 'dead-job-88',
      },
    });
    await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Sibling still running',
        description: 'Has a live job',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 1,
        bullJobId: 'live-job-55',
      },
    });

    mockGetActive.mockResolvedValue([{ id: 'live-job-55', data: {} }]);
    mockGetWaiting.mockResolvedValue([]);
    mockGetDelayed.mockResolvedValue([]);

    await reconcileOrphanedTasks();

    const orphaned = await getPrisma().task.findFirst({
      where: { featureId, title: 'Orphaned task' },
    });
    expect(orphaned?.status).toBe('pending'); // re-enqueued, not parked (sibling still holds the repo slot)

    const sibling = await getPrisma().task.findFirst({
      where: { featureId, bullJobId: 'live-job-55' },
    });
    expect(sibling?.status).toBe('running');

    const agentStatusEvents = await getPrisma().event.findMany({
      where: { featureId, type: 'agent.status' },
    });
    expect(agentStatusEvents).toHaveLength(0);
  });

  it('emits no agent.status event for a task whose BullMQ job is alive', async () => {
    await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Genuinely running task',
        description: 'Has a live job',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 1,
        bullJobId: 'live-job-intact',
      },
    });

    mockGetActive.mockResolvedValue([{ id: 'live-job-intact', data: {} }]);
    mockGetWaiting.mockResolvedValue([]);
    mockGetDelayed.mockResolvedValue([]);

    await reconcileOrphanedTasks();

    const events = await getPrisma().event.findMany({ where: { featureId } });
    expect(events.filter((e) => e.type === 'agent.status')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'task.failed')).toHaveLength(0);
  });
});

// ── redispatch + depends_on integration ───────────────────────────────────────

describe('featureRedispatch + depends_on (integration)', () => {
  it('redispatch enqueues only unblocked tasks after reset', async () => {
    // Seed tasks and set up event
    await appendEvent(getPrisma(), featureId, {
      type: 'plan.proposed',
      agent: 'planner',
      spec_rev: 0,
      plan_summary: '2 tasks',
      task_count: 2,
      tasks: [
        {
          repo: 'demo-server',
          side: 'server',
          title: 'Implement endpoint',
          description: 'Impl',
          spec_refs: [],
          depends_on: [],
        },
        {
          repo: 'demo-server',
          side: 'server',
          title: 'Write unit tests',
          description: 'Tests',
          spec_refs: [],
          depends_on: ['Implement endpoint'],
        },
      ],
    });
    // Seed with ID-based depends_on: create impl first, then tests referencing its id.
    const implRow = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Implement endpoint',
        description: 'Impl',
        specRefs: [],
        dependsOn: [],
        status: 'parked',
        attemptCount: 2,
      },
    });
    await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Write unit tests',
        description: 'Tests',
        specRefs: [],
        dependsOn: [implRow.id],
        status: 'parked',
        attemptCount: 1,
      },
    });

    // Import and call dispatchForState(IMPLEMENTING) to simulate redispatch
    const { dispatchForState } = await import('../lib/dispatch.js');
    // Reset both to pending first (as redispatch would do)
    await getPrisma().task.updateMany({
      where: { featureId, status: 'parked' },
      data: { status: 'pending', attemptCount: 0 },
    });

    await dispatchForState(featureId, 'IMPLEMENTING', { simulated_run: false });

    // Only "Implement endpoint" should be enqueued — "Write unit tests" is blocked
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    const calledWith = mockEnqueueJob.mock.calls[0]?.[2] as { taskId: string };
    const task = await getPrisma().task.findUnique({ where: { id: calledWith.taskId } });
    expect(task?.title).toBe('Implement endpoint');
  });
});

// ── completeTask helper — both paths trigger downstream dispatch ───────────────

describe('completeTask — dispatch from normal and noop-success paths', () => {
  // A fake worktreeInfo whose worktreePath/branch are never reached because
  // we always seed a second task so remaining > 0 and pushBranch never fires.
  const fakeWorktree = {
    bareRepoPath: '/tmp/fake.git',
    repoId: 'demo-server',
    worktreePath: '/tmp/fake-work',
    branch: 'feature/test',
  };

  async function seedTwo(): Promise<{ implId: string; testsId: string }> {
    const impl = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Implement endpoint',
        description: 'Impl',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        attemptCount: 1,
      },
    });
    const tests = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Write tests',
        description: 'Tests',
        specRefs: [],
        dependsOn: [impl.id], // ID-based (mirrors featurePlanGate.ts seedTasksWithIdDeps)
        status: 'pending',
        attemptCount: 0,
      },
    });
    return { implId: impl.id, testsId: tests.id };
  }

  it('normal path (with commitSha) marks completed and dispatches unblocked successor', async () => {
    const { implId, testsId } = await seedTwo();
    const taskRow = {
      id: implId,
      repo: 'demo-server',
      side: 'server',
      title: 'Implement endpoint',
    };

    await completeTask(featureId, implId, taskRow, fakeWorktree, 'abc1234');

    const updated = await getPrisma().task.findUnique({ where: { id: implId } });
    expect(updated?.status).toBe('completed');
    expect(updated?.commitSha).toBe('abc1234');

    // dispatchUnblockedTasks should have enqueued the unblocked successor
    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'server-dev', { taskId: testsId });
  });

  it('noop-success path (commitSha undefined) marks completed and dispatches unblocked successor', async () => {
    const { implId, testsId } = await seedTwo();
    const taskRow = {
      id: implId,
      repo: 'demo-server',
      side: 'server',
      title: 'Implement endpoint',
    };

    await completeTask(featureId, implId, taskRow, fakeWorktree, undefined);

    const updated = await getPrisma().task.findUnique({ where: { id: implId } });
    expect(updated?.status).toBe('completed');
    expect(updated?.commitSha).toBeNull();

    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'server-dev', { taskId: testsId });
  });
});

// ── R8: dispatch persists bullJobId before task is observable as running ────────

describe('dispatchUnblockedTasks — persists bullJobId at dispatch time (R8)', () => {
  it('writes bullJobId to the task row immediately when a job is enqueued', async () => {
    mockEnqueueJob.mockResolvedValueOnce('bull-job-xyz');
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'R8 test task',
        description: 'R8 test task',
        specRefs: [],
        dependsOn: [],
        status: 'pending',
      },
    });

    await dispatchUnblockedTasks(featureId, 'server');

    const row = await getPrisma().task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.bullJobId).toBe('bull-job-xyz');
  });
});
