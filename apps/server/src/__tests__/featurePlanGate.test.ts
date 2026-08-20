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

  const feature = await createFeature({ name: 'Plan Gate Test', requirement: 'req' });
  featureId = feature.id;

  // Put feature in AWAITING_PLAN_APPROVAL
  await getPrisma().feature.update({
    where: { id: featureId },
    data: { status: 'AWAITING_PLAN_APPROVAL' },
  });
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

// ── POST /approve-plan ────────────────────────────────────────────────────────

describe('POST /features/:id/approve-plan', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/features/nonexistent/approve-plan' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when feature is not in AWAITING_PLAN_APPROVAL', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'PLANNING' },
    });
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/approve-plan` });
    expect(res.statusCode).toBe(409);
  });

  it('returns 200 and transitions to PLANNING_TESTS', async () => {
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/approve-plan` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>()['status']).toBe('PLANNING_TESTS');
  });

  it('emits gate.resolved(approved) and phase.changed to PLANNING_TESTS', async () => {
    await app.inject({ method: 'POST', url: `/features/${featureId}/approve-plan` });
    const events = await getPrisma().event.findMany({
      where: { featureId },
      orderBy: { seq: 'asc' },
    });
    const types = events.map((e) => e.type);
    expect(types).toContain('gate.resolved');
    expect(types).toContain('phase.changed');

    const gateEvent = events.find((e) => e.type === 'gate.resolved');
    expect((gateEvent?.payload as { gate: string; resolution: string }).gate).toBe('plan_approval');
    expect((gateEvent?.payload as { resolution: string }).resolution).toBe('approved');
  });

  it('enqueues test-plan job for real run on approve-plan', async () => {
    // approve-plan now dispatches PLANNING_TESTS → enqueues test-plan, not dev jobs
    await app.inject({ method: 'POST', url: `/features/${featureId}/approve-plan` });
    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'test-plan', undefined);
  });

  it('enqueues simulate-resume for simulated run on approve-plan', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { simulatedRun: true },
    });
    await app.inject({ method: 'POST', url: `/features/${featureId}/approve-plan` });
    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'simulate-resume', undefined);
  });

  it('seeds Task rows from plan.proposed event on approve-plan', async () => {
    // Seed a plan.proposed event with two tasks
    await appendEvent(getPrisma(), featureId, {
      type: 'plan.proposed',
      agent: 'planner',
      spec_rev: 0,
      plan_summary: '2 task(s)',
      task_count: 2,
      tasks: [
        {
          repo: 'demo-server',
          side: 'server',
          title: 'Add health endpoint',
          description: 'Implement GET /health.',
          spec_refs: ['API endpoints'],
          depends_on: [],
        },
        {
          repo: 'demo-server',
          side: 'server',
          title: 'Add uptime endpoint',
          description: 'Implement GET /uptime.',
          spec_refs: ['API endpoints'],
          depends_on: ['Add health endpoint'],
        },
      ],
    });

    await app.inject({ method: 'POST', url: `/features/${featureId}/approve-plan` });

    const tasks = await getPrisma().task.findMany({
      where: { featureId },
      orderBy: { createdAt: 'asc' },
    });
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.title).toBe('Add health endpoint');
    expect(tasks[0]?.status).toBe('pending');
    expect(tasks[1]?.title).toBe('Add uptime endpoint');
    // depends_on is stored as task IDs (resolved from titles at seed time)
    expect(tasks[1]?.dependsOn).toEqual([tasks[0]?.id]);
  });

  it('approve-plan with no plan.proposed event creates no Task rows', async () => {
    // No plan.proposed event in this test — approve anyway
    await app.inject({ method: 'POST', url: `/features/${featureId}/approve-plan` });
    const tasks = await getPrisma().task.findMany({ where: { featureId } });
    expect(tasks).toHaveLength(0);
  });
});

// ── POST /request-plan-changes ────────────────────────────────────────────────

describe('POST /features/:id/request-plan-changes', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features/nonexistent/request-plan-changes',
      payload: { comment: 'Fix the contract.' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when feature is not in AWAITING_PLAN_APPROVAL', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'PLANNING' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-plan-changes`,
      payload: { comment: 'Fix it.' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 400 when comment is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-plan-changes`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 and transitions back to PLANNING', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-plan-changes`,
      payload: { comment: 'Add more detail to the contract.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>()['status']).toBe('PLANNING');
  });

  it('re-enqueues the plan job via dispatchForState', async () => {
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-plan-changes`,
      payload: { comment: 'Revisit the contract.' },
    });
    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'plan', undefined);
  });

  it('emits gate.resolved(changes_requested) and phase.changed to PLANNING', async () => {
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-plan-changes`,
      payload: { comment: 'Fix the API contract.' },
    });
    const events = await getPrisma().event.findMany({
      where: { featureId },
      orderBy: { seq: 'asc' },
    });
    const gateEvent = events.find((e) => e.type === 'gate.resolved');
    expect((gateEvent?.payload as { resolution: string }).resolution).toBe('changes_requested');

    const phaseEvent = events.filter((e) => e.type === 'phase.changed').at(-1);
    expect((phaseEvent?.payload as { to: string }).to).toBe('PLANNING');
  });
});
