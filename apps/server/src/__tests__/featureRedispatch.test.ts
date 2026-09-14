import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockEnqueueJob, mockGetQueue } = vi.hoisted(() => ({
  mockEnqueueJob: vi.fn().mockResolvedValue(undefined),
  mockGetQueue: vi.fn(),
}));

vi.mock('../lib/queue.js', () => ({
  enqueueJob: mockEnqueueJob,
  getQueue: mockGetQueue,
  closeQueue: vi.fn(),
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import { createFeature } from '../lib/features.js';
import { appendEvent } from '../lib/events.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let featureId: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  app = await createApp();
  vi.clearAllMocks();

  const feature = await createFeature({ name: 'Redispatch Test', requirement: 'req' });
  featureId = feature.id;

  await getPrisma().feature.update({
    where: { id: featureId },
    data: { status: 'IMPLEMENTING' },
  });
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

const PLAN_TASKS = [
  {
    repo: 'demo-server',
    side: 'server' as const,
    title: 'Add endpoint',
    description: 'Implement it.',
    spec_refs: [],
    depends_on: [],
  },
];

// ── POST /redispatch ──────────────────────────────────────────────────────────

describe('POST /features/:id/redispatch', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/features/nonexistent/redispatch' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when feature is not in IMPLEMENTING', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'PLANNING' },
    });
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/redispatch` });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('PLANNING');
  });

  it('seeds Task rows from plan.proposed and enqueues server-dev jobs', async () => {
    await appendEvent(getPrisma(), featureId, {
      type: 'plan.proposed',
      agent: 'planner',
      spec_rev: 0,
      plan_summary: '1 task(s)',
      task_count: 1,
      tasks: PLAN_TASKS,
    });

    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/redispatch` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tasksSeeded: number; jobsEnqueued: number }>();
    expect(body.tasksSeeded).toBe(1);
    expect(body.jobsEnqueued).toBe(1);

    const tasks = await getPrisma().task.findMany({ where: { featureId } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Add endpoint');
    expect(tasks[0]?.status).toBe('pending');

    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'server-dev', {
      taskId: tasks[0]?.id,
    });
  });

  it('is idempotent — existing pending rows are not duplicated', async () => {
    await appendEvent(getPrisma(), featureId, {
      type: 'plan.proposed',
      agent: 'planner',
      spec_rev: 0,
      plan_summary: '1 task(s)',
      task_count: 1,
      tasks: PLAN_TASKS,
    });

    // First redispatch seeds the row
    await app.inject({ method: 'POST', url: `/features/${featureId}/redispatch` });
    // Second redispatch must not create a duplicate
    const res2 = await app.inject({ method: 'POST', url: `/features/${featureId}/redispatch` });
    expect(res2.statusCode).toBe(200);
    const body = res2.json<{ tasksSeeded: number }>();
    expect(body.tasksSeeded).toBe(0); // skipped duplicate

    const tasks = await getPrisma().task.findMany({ where: { featureId } });
    expect(tasks).toHaveLength(1);
  });

  it('returns 200 with zero seeded when no plan.proposed event exists', async () => {
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/redispatch` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tasksSeeded: number; jobsEnqueued: number }>();
    expect(body.tasksSeeded).toBe(0);
    expect(body.jobsEnqueued).toBe(0);
  });

  it('resets parked task to pending with attempt_count=0 and enqueues job', async () => {
    await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Add endpoint',
        description: 'Implement it.',
        specRefs: [],
        dependsOn: [],
        status: 'parked',
        attemptCount: 2,
      },
    });

    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/redispatch` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      tasksSeeded: number;
      tasksResurrected: number;
      jobsEnqueued: number;
    }>();
    expect(body.tasksResurrected).toBe(1);
    expect(body.jobsEnqueued).toBe(1);

    const task = await getPrisma().task.findFirst({ where: { featureId } });
    expect(task?.status).toBe('pending');
    expect(task?.attemptCount).toBe(0);

    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'server-dev', { taskId: task?.id });
  });

  it('emits agent.log event per resurrected task', async () => {
    await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Add endpoint',
        description: 'Implement it.',
        specRefs: [],
        dependsOn: [],
        status: 'parked',
        attemptCount: 3,
      },
    });

    await app.inject({ method: 'POST', url: `/features/${featureId}/redispatch` });

    const events = await getPrisma().event.findMany({
      where: { featureId, type: 'agent.log' },
      orderBy: { seq: 'asc' },
    });
    expect(
      events.some((e) => {
        const p = e.payload as { text?: string };
        return p.text?.includes('reset by redispatch');
      }),
    ).toBe(true);
  });

  it('enqueues one light-dev job per repo for LIGHT_IMPLEMENTING', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'LIGHT_IMPLEMENTING', repos: ['repo-a', 'repo-b'] },
    });

    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/redispatch` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ path: string; jobsEnqueued: number }>();
    expect(body.path).toBe('light');
    expect(body.jobsEnqueued).toBe(2);

    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'light-dev', { repoId: 'repo-a' });
    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'light-dev', { repoId: 'repo-b' });
  });

  it('does not seed Task rows for LIGHT_IMPLEMENTING', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'LIGHT_IMPLEMENTING', repos: ['repo-a'] },
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'plan.proposed',
      agent: 'planner',
      spec_rev: 0,
      plan_summary: '1 task(s)',
      task_count: 1,
      tasks: PLAN_TASKS,
    });

    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/redispatch` });
    expect(res.statusCode).toBe(200);

    const tasks = await getPrisma().task.findMany({ where: { featureId } });
    expect(tasks).toHaveLength(0);
  });

  it('does not alter attempt_count of tasks that are already pending', async () => {
    await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Add endpoint',
        description: 'Implement it.',
        specRefs: [],
        dependsOn: [],
        status: 'pending',
        attemptCount: 1,
      },
    });

    await app.inject({ method: 'POST', url: `/features/${featureId}/redispatch` });

    const task = await getPrisma().task.findFirst({ where: { featureId } });
    expect(task?.status).toBe('pending');
    expect(task?.attemptCount).toBe(1);
  });

  it('releases stuck-running tasks: removes their BullMQ job and transitions to pending', async () => {
    const mockRemove = vi.fn().mockResolvedValue(undefined);
    mockGetQueue.mockReturnValue({
      getJob: vi.fn().mockResolvedValue({ remove: mockRemove }),
      getActive: vi.fn().mockResolvedValue([]),
      getWaiting: vi.fn().mockResolvedValue([]),
      getDelayed: vi.fn().mockResolvedValue([]),
    });

    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Stuck running task',
        description: 'Was running when server died.',
        specRefs: [],
        dependsOn: [],
        status: 'running',
        bullJobId: 'job-stuck-42',
      },
    });

    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/redispatch` });
    expect(res.statusCode).toBe(200);

    // BullMQ job was removed
    expect(mockRemove).toHaveBeenCalledOnce();

    // Task ends up pending (reconciler reset it after job removal)
    const updated = await getPrisma().task.findUnique({ where: { id: task.id } });
    expect(updated?.status).toBe('pending');
    expect(updated?.bullJobId).toBeNull();
  });

  it('does not call getJob when no running tasks exist', async () => {
    const mockGetJob = vi.fn();
    mockGetQueue.mockReturnValue({ getJob: mockGetJob });

    // Only a parked task — no running
    await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Parked task',
        description: 'desc',
        specRefs: [],
        dependsOn: [],
        status: 'parked',
      },
    });

    await app.inject({ method: 'POST', url: `/features/${featureId}/redispatch` });
    expect(mockGetJob).not.toHaveBeenCalled();
  });
});
