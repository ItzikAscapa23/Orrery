import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockEnqueueJob, mockCommitSpecDraft, mockCommitArtifact } = vi.hoisted(() => ({
  mockEnqueueJob: vi.fn().mockResolvedValue(undefined),
  mockCommitSpecDraft: vi
    .fn()
    .mockReturnValue({ path: 'features/t/spec.md', commit: 'abc', message: 'spec: t draft r0' }),
  mockCommitArtifact: vi
    .fn()
    .mockReturnValue({ path: 'features/t/plan.md', commit: 'def', message: 'plan: t plan.md' }),
}));

vi.mock('../lib/queue.js', () => ({
  enqueueJob: mockEnqueueJob,
  getQueue: vi.fn(),
  closeQueue: vi.fn(),
}));

vi.mock('../lib/artifacts.js', () => ({
  commitSpecDraft: mockCommitSpecDraft,
  commitArtifact: mockCommitArtifact,
  readArtifact: vi.fn().mockReturnValue(null),
  ArtifactCommitError: class ArtifactCommitError extends Error {},
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
  const feature = await createFeature({ name: 'Sim Test', requirement: 'req' });
  featureId = feature.id;
  vi.clearAllMocks();
  mockEnqueueJob.mockResolvedValue(undefined);
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

describe('POST /features/:id/simulate', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/features/nonexistent/simulate' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 202 and enqueues a simulate job', async () => {
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/simulate` });
    expect(res.statusCode).toBe(202);
    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'simulate', undefined);
  });

  it('returns 403 in production', async () => {
    const original = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/simulate` });
    process.env['NODE_ENV'] = original;
    expect(res.statusCode).toBe(403);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('response body includes featureId', async () => {
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/simulate` });
    expect(res.json<{ featureId: string }>()['featureId']).toBe(featureId);
  });

  it('sets simulatorReviewPath to forced-fix by default (no body)', async () => {
    await app.inject({ method: 'POST', url: `/features/${featureId}/simulate` });
    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.simulatorReviewPath).toBe('forced-fix');
  });

  it('sets simulatorReviewPath to gate when review_path=gate', async () => {
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/simulate`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ review_path: 'gate' }),
    });
    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.simulatorReviewPath).toBe('gate');
  });

  it('sets simulatorReviewPath to forced-fix for unknown review_path values', async () => {
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/simulate`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ review_path: 'unknown-value' }),
    });
    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.simulatorReviewPath).toBe('forced-fix');
  });
});

// ── priorReviewRounds regression (T1 bug fix) ─────────────────────────────────
//
// runSimulate emits a review.findings event with agent='aws' for the spec review.
// runSimulateResume must not count that event when computing priorReviewRounds —
// otherwise it would skip round 0 (no blocker, no REVIEW_FAIL) and jump straight
// to the round-1 forced-fix path on the first CODE_REVIEW entry.

describe('priorReviewRounds filter — agent=review only', () => {
  it('counts zero when only an aws review.findings event exists (not a review-agent round)', async () => {
    // Seed an aws review.findings event — this is what runSimulate emits for the spec review
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'review.findings',
        agent: 'aws',
        spec_rev: 0,
        findings: [],
      }),
    );

    // The priorReviewRounds query must filter to agent='review' and return 0
    const count = await getPrisma().event.count({
      where: {
        featureId,
        type: 'review.findings',
        payload: { path: ['agent'], equals: 'review' },
      },
    });
    expect(count).toBe(0);
  });

  it('counts one when a review-agent review.findings event exists', async () => {
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'review.findings',
        agent: 'review',
        spec_rev: 0,
        findings: [],
      }),
    );

    const count = await getPrisma().event.count({
      where: {
        featureId,
        type: 'review.findings',
        payload: { path: ['agent'], equals: 'review' },
      },
    });
    expect(count).toBe(1);
  });

  it('aws event does not inflate the count alongside a real review round', async () => {
    // Seed both — aws (spec review) and review (round 0 bounce-back)
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'review.findings',
        agent: 'aws',
        spec_rev: 0,
        findings: [],
      }),
    );
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'review.findings',
        agent: 'review',
        spec_rev: 0,
        findings: [],
      }),
    );

    const count = await getPrisma().event.count({
      where: {
        featureId,
        type: 'review.findings',
        payload: { path: ['agent'], equals: 'review' },
      },
    });
    expect(count).toBe(1); // only the review-agent round, not the aws one
  });
});
