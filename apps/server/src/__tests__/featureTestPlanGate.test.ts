import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockEnqueueJob } = vi.hoisted(() => ({
  mockEnqueueJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/queue.js', () => ({
  enqueueJob: mockEnqueueJob,
  getQueue: vi.fn(),
  closeQueue: vi.fn(),
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { appendEvent } from '../lib/events.js';
import Fastify from 'fastify';
import { featureTestPlanGateRoutes } from '../routes/featureTestPlanGate.js';

let app: ReturnType<typeof Fastify>;
let featureId: string;
let taskId1: string;
let taskId2: string;

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  mockEnqueueJob.mockClear();

  app = Fastify({ logger: false });
  await app.register(featureTestPlanGateRoutes);
  await app.ready();

  const f = await createFeature({ name: 'TDD Gate', requirement: 'test' });
  featureId = f.id;
  await getPrisma().feature.update({
    where: { id: featureId },
    data: { status: 'AWAITING_TEST_PLAN_APPROVAL', proposedSpec: 'spec' },
  });

  const t1 = await getPrisma().task.create({
    data: {
      featureId,
      repo: 'demo-server',
      side: 'server',
      title: 'Add endpoint',
      description: 'POST /items',
      specRefs: [],
      dependsOn: [],
      status: 'pending',
    },
  });
  taskId1 = t1.id;

  const t2 = await getPrisma().task.create({
    data: {
      featureId,
      repo: 'demo-server',
      side: 'server',
      title: 'Run migration',
      description: 'DB migration',
      specRefs: [],
      dependsOn: [],
      status: 'pending',
    },
  });
  taskId2 = t2.id;

  // Emit test_plan.proposed event with task-1 covered, task-2 skipped
  await appendEvent(getPrisma(), featureId, {
    type: 'test_plan.proposed',
    agent: 'test-planner',
    spec_rev: 0,
    plan_summary: '1 covered, 1 skipped',
    task_count: 2,
    coverage: [
      { taskId: taskId1, covered: true, behaviour: 'POST /items returns 201' },
      { taskId: taskId2, covered: false, skipReason: 'Migration only' },
    ],
  });
});

describe('POST /features/:id/approve-test-plan', () => {
  it('returns 404 for nonexistent feature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features/nonexistent/approve-test-plan',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when feature is not AWAITING_TEST_PLAN_APPROVAL', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'IMPLEMENTING' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/approve-test-plan`,
    });
    expect(res.statusCode).toBe(409);
  });

  it('transitions to IMPLEMENTING', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/approve-test-plan`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string })['status']).toBe('IMPLEMENTING');
  });

  it('sets coveredByTestPlan=true on covered tasks only', async () => {
    await app.inject({ method: 'POST', url: `/features/${featureId}/approve-test-plan` });
    const t1 = await getPrisma().task.findUnique({ where: { id: taskId1 } });
    const t2 = await getPrisma().task.findUnique({ where: { id: taskId2 } });
    expect(t1?.coveredByTestPlan).toBe(true);
    expect(t2?.coveredByTestPlan).toBe(false);
  });

  it('emits gate.resolved and phase.changed events', async () => {
    await app.inject({ method: 'POST', url: `/features/${featureId}/approve-test-plan` });
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const resolved = events.find((e) => e.type === 'gate.resolved');
    expect(resolved).not.toBeUndefined();
    expect((resolved!.payload as { gate: string; resolution: string }).gate).toBe(
      'test_plan_approval',
    );
    expect((resolved!.payload as { resolution: string }).resolution).toBe('approved');
    expect(events.some((e) => e.type === 'phase.changed')).toBe(true);
  });

  it('enqueues server-dev jobs via IMPLEMENTING dispatch', async () => {
    // After approve-test-plan → IMPLEMENTING → dispatchForState enqueues tasks
    // Covered task with testsWritten=false → server-test-task
    // But since no tasks have testsWritten, dispatchUnblockedTasks routes to test-task first
    await app.inject({ method: 'POST', url: `/features/${featureId}/approve-test-plan` });
    // enqueueJob should have been called for the covered task (server-test-task)
    const calls = mockEnqueueJob.mock.calls;
    const testTaskCall = calls.find(
      (c: unknown[]) => c[1] === 'server-test-task' || c[1] === 'server-dev',
    );
    expect(testTaskCall).not.toBeUndefined();
  });
});

describe('POST /features/:id/request-test-plan-changes', () => {
  it('returns 400 without comment body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-test-plan-changes`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('transitions back to PLANNING_TESTS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-test-plan-changes`,
      payload: { comment: 'Cover the migration task too' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string })['status']).toBe('PLANNING_TESTS');
  });

  it('emits gate.resolved with changes_requested and enqueues test-plan', async () => {
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-test-plan-changes`,
      payload: { comment: 'Need more coverage' },
    });
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const resolved = events.find((e) => e.type === 'gate.resolved');
    expect((resolved!.payload as { resolution: string }).resolution).toBe('changes_requested');
    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'test-plan', undefined);
  });
});

describe('POST /features/:id/tasks/:taskId/override-acceptance', () => {
  beforeEach(async () => {
    // Set feature to IMPLEMENTING and task to parked
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'IMPLEMENTING' },
    });
    await getPrisma().task.update({ where: { id: taskId1 }, data: { status: 'parked' } });
  });

  it('returns 409 when task is not parked', async () => {
    await getPrisma().task.update({ where: { id: taskId1 }, data: { status: 'pending' } });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/tasks/${taskId1}/override-acceptance`,
    });
    expect(res.statusCode).toBe(409);
  });

  it('marks task as completed', async () => {
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/tasks/${taskId1}/override-acceptance`,
    });
    const task = await getPrisma().task.findUnique({ where: { id: taskId1 } });
    expect(task?.status).toBe('completed');
  });

  it('emits gate.resolved with override', async () => {
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/tasks/${taskId1}/override-acceptance`,
    });
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const resolved = events.find(
      (e) =>
        e.type === 'gate.resolved' &&
        (e.payload as { gate: string }).gate === 'task_acceptance_gate',
    );
    expect(resolved).not.toBeUndefined();
    expect((resolved!.payload as { resolution: string }).resolution).toBe('override');
  });
});

describe('POST /features/:id/tasks/:taskId/retry-acceptance', () => {
  beforeEach(async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'IMPLEMENTING' },
    });
    await getPrisma().task.update({
      where: { id: taskId1 },
      data: { status: 'parked', attemptCount: 2 },
    });
  });

  it('resets task to pending with attemptCount=0', async () => {
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/tasks/${taskId1}/retry-acceptance`,
    });
    const task = await getPrisma().task.findUnique({ where: { id: taskId1 } });
    expect(task?.status).toBe('pending');
    expect(task?.attemptCount).toBe(0);
  });

  it('emits gate.resolved with retry', async () => {
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/tasks/${taskId1}/retry-acceptance`,
    });
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const resolved = events.find(
      (e) =>
        e.type === 'gate.resolved' &&
        (e.payload as { gate: string }).gate === 'task_acceptance_gate',
    );
    expect((resolved!.payload as { resolution: string }).resolution).toBe('retry');
  });
});
