import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockEnqueueJob } = vi.hoisted(() => ({
  mockEnqueueJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/queue.js', () => ({
  enqueueJob: mockEnqueueJob,
  getQueue: () => ({ getWorkers: vi.fn().mockResolvedValue([]) }),
  closeQueue: vi.fn(),
}));

vi.mock('../lib/artifacts.js', () => ({
  commitArtifact: vi.fn().mockReturnValue({
    path: 'features/test/contract.yaml',
    commit: 'abc1234',
    message: 'plan: test contract.yaml',
  }),
  readArtifact: vi.fn().mockReturnValue(null),
  commitSpecDraft: vi.fn(),
  ArtifactCommitError: class ArtifactCommitError extends Error {},
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import { createFeature } from '../lib/features.js';
import { appendEvent } from '../lib/events.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let featureId: string;

async function seedAmendmentPausedTasks() {
  return getPrisma().task.createMany({
    data: [
      {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Server task',
        description: 'desc',
        specRefs: [],
        dependsOn: [],
        status: 'amendment_paused',
        attemptCount: 1,
      },
      {
        featureId,
        repo: 'demo-client',
        side: 'client',
        title: 'Client task',
        description: 'desc',
        specRefs: [],
        dependsOn: [],
        status: 'amendment_paused',
        attemptCount: 0,
      },
    ],
  });
}

async function seedOpenAmendmentGate() {
  await appendEvent(getPrisma(), featureId, {
    type: 'contract.amendment.proposed',
    repo: 'demo-server',
    task_id: 'some-task-id',
    proposed_contract_yaml: 'openapi: "3.0.0"\ninfo:\n  title: Revised\n  version: "2"\npaths: {}',
    rationale: 'Missing /greeting endpoint.',
  });
}

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  app = await createApp();
  vi.clearAllMocks();
  mockEnqueueJob.mockResolvedValue(undefined);

  const feature = await createFeature({ name: 'Amendment Test', requirement: 'req' });
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

// ── POST /approve-amendment ───────────────────────────────────────────────────

describe('POST /features/:id/approve-amendment', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features/nonexistent/approve-amendment',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when no open amendment gate exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/approve-amendment`,
    });
    expect(res.statusCode).toBe(409);
  });

  it('commits contract, emits events, resets tasks to pending, dispatches', async () => {
    await seedOpenAmendmentGate();
    await seedAmendmentPausedTasks();

    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/approve-amendment`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().contractCommit).toBe('abc1234');

    // All amendment_paused tasks reset to pending
    const tasks = await getPrisma().task.findMany({ where: { featureId } });
    expect(tasks.every((t) => t.status === 'pending')).toBe(true);
    expect(tasks.every((t) => t.attemptCount === 0)).toBe(true);

    // gate.resolved event emitted
    const resolvedEvent = await getPrisma().event.findFirst({
      where: { featureId, type: 'gate.resolved' },
    });
    expect(resolvedEvent).not.toBeNull();
    const p = resolvedEvent?.payload as { gate: string; resolution: string };
    expect(p.gate).toBe('amendment');
    expect(p.resolution).toBe('approved');

    // contract.revised event emitted
    const revisedEvent = await getPrisma().event.findFirst({
      where: { featureId, type: 'contract.revised' },
    });
    expect(revisedEvent).not.toBeNull();

    // dispatchUnblockedTasks called for both sides
    // (tasks are now pending with no deps → both should enqueue)
    expect(mockEnqueueJob).toHaveBeenCalledTimes(2);
  });

  it('returns 409 when amendment gate was already resolved', async () => {
    await seedOpenAmendmentGate();
    // Close the gate
    await appendEvent(getPrisma(), featureId, {
      type: 'gate.resolved',
      gate: 'amendment',
      resolution: 'approved',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/approve-amendment`,
    });
    expect(res.statusCode).toBe(409);
  });
});

// ── POST /reject-amendment ────────────────────────────────────────────────────

describe('POST /features/:id/reject-amendment', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features/nonexistent/reject-amendment',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when no open amendment gate exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/reject-amendment`,
    });
    expect(res.statusCode).toBe(409);
  });

  it('resolves gate, resets tasks to pending, dispatches', async () => {
    await seedOpenAmendmentGate();
    await seedAmendmentPausedTasks();

    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/reject-amendment`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    const tasks = await getPrisma().task.findMany({ where: { featureId } });
    expect(tasks.every((t) => t.status === 'pending')).toBe(true);

    const resolvedEvent = await getPrisma().event.findFirst({
      where: { featureId, type: 'gate.resolved' },
    });
    const p = resolvedEvent?.payload as { gate: string; resolution: string };
    expect(p.gate).toBe('amendment');
    expect(p.resolution).toBe('changes_requested');
  });
});
