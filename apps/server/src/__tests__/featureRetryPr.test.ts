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

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import { createFeature } from '../lib/features.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let featureId: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  app = await createApp();
  vi.clearAllMocks();

  const feature = await createFeature({ name: 'Retry PR Test', requirement: 'req' });
  featureId = feature.id;
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

describe('POST /features/:id/retry-pr', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/features/nonexistent/retry-pr' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when feature is not in FAILED', async () => {
    // Default status after createFeature is DRAFTING_SPEC
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/retry-pr` });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('FAILED');
  });

  it('returns 409 when feature is in IMPLEMENTING', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'IMPLEMENTING' },
    });
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/retry-pr` });
    expect(res.statusCode).toBe(409);
  });

  it('returns 200, sets status to CODE_REVIEW, and enqueues create-ado-pr when FAILED', async () => {
    await getPrisma().feature.update({ where: { id: featureId }, data: { status: 'FAILED' } });

    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/retry-pr` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dispatched: 'create-ado-pr' });

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('CODE_REVIEW');

    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'create-ado-pr', undefined);
  });

  it('emits agent.log event on successful retry', async () => {
    await getPrisma().feature.update({ where: { id: featureId }, data: { status: 'FAILED' } });

    await app.inject({ method: 'POST', url: `/features/${featureId}/retry-pr` });

    const logs = await getPrisma().event.findMany({
      where: { featureId, type: 'agent.log' },
    });
    expect(
      logs.some((e) => {
        const p = e.payload as { text?: string };
        return p.text?.includes('retried by operator');
      }),
    ).toBe(true);
  });
});
