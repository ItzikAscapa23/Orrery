import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockCommitSpecDraft, mockEnqueueJob } = vi.hoisted(() => ({
  mockCommitSpecDraft: vi
    .fn()
    .mockReturnValue({ path: 'features/t/spec.md', commit: 'abc', message: 'spec: t draft r0' }),
  mockEnqueueJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/artifacts.js', () => ({
  commitSpecDraft: mockCommitSpecDraft,
  ArtifactCommitError: class ArtifactCommitError extends Error {},
}));
vi.mock('../lib/queue.js', () => ({
  enqueueJob: mockEnqueueJob,
  getQueue: () => ({ getWorkers: vi.fn().mockResolvedValue([]) }),
  closeQueue: vi.fn(),
}));
// Simulate a repo with a charter so runSimulate uses the AWS-review path.
vi.mock('../lib/charterResolver.js', () => ({
  resolveCharterPath: vi.fn().mockReturnValue('docs/agents/aws-charter.md'),
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import { createFeature } from '../lib/features.js';
import { appendEvent } from '../lib/events.js';
import { runSimulate, _delayMs } from '../jobs/simulatorJob.js';
import * as dispatchModule from '../lib/dispatch.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let featureId: string;
let findingSeq = 0;

beforeEach(async () => {
  dispatchModule._headCommit.value = 'test-stub';
  _delayMs.min = 0;
  _delayMs.max = 0;
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  app = await createApp();
  vi.clearAllMocks();

  const feature = await createFeature({ name: 'Test Feature', requirement: 'req' });
  featureId = feature.id;

  // Put feature in AWAITING_APPROVAL with a proposed spec
  await getPrisma().feature.update({
    where: { id: featureId },
    data: { status: 'AWAITING_APPROVAL', proposedSpec: '## Overview\nTest spec.' },
  });

  // Seed a gate.opened event so gateCount=1 → currentRev=0, matching specRev:0 findings
  await appendEvent(getPrisma(), featureId, {
    type: 'gate.opened',
    gate: 'spec_approval',
    summary: 'Test spec.',
    revision: 0,
  });
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

async function createFinding(
  overrides: Partial<{
    severity: string;
    suggestedText: string | null;
    resolution: string | null;
    specRev: number;
  }> = {},
) {
  return getPrisma().finding.create({
    data: {
      id: `f-test-${++findingSeq}`,
      featureId,
      specRev: overrides.specRev ?? 0,
      severity: overrides.severity ?? 'warning',
      section: 'API endpoints',
      issue: 'Test issue.',
      suggestedText: overrides.suggestedText !== undefined ? overrides.suggestedText : 'Fix text.',
      resolution: overrides.resolution ?? null,
    },
  });
}

// ── accept ─────────────────────────────────────────────────────────────────

describe('POST /features/:id/findings/:findingId/accept', () => {
  it('returns 200, updates proposedSpec, and emits spec.revised + finding.resolved', async () => {
    const finding = await createFinding();

    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${finding.id}/accept`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    // proposedSpec updated
    const updated = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(updated?.proposedSpec).toContain('Fix text.');

    // Finding marked accepted
    const resolved = await getPrisma().finding.findFirst({ where: { featureId, id: finding.id } });
    expect(resolved?.resolution).toBe('accepted');

    // Events emitted
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const types = events.map((e) => e.type);
    expect(types).toContain('spec.revised');
    expect(types).toContain('finding.resolved');

    const resolved_event = events.find((e) => e.type === 'finding.resolved');
    expect((resolved_event?.payload as { resolution: string }).resolution).toBe('accepted');
  });

  it('returns 400 when finding has no suggested_text', async () => {
    const finding = await createFinding({ suggestedText: null });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${finding.id}/accept`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 when finding is already resolved', async () => {
    const finding = await createFinding({ resolution: 'dismissed' });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${finding.id}/accept`,
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 404 for unknown finding', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/nonexistent/accept`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when finding specRev is older than current revision', async () => {
    // Finding has specRev=0 but we add a second gate.opened so currentRev=1
    await appendEvent(getPrisma(), featureId, {
      type: 'gate.opened',
      gate: 'spec_approval',
      summary: 'Revised spec.',
      revision: 1,
    });
    const stale = await createFinding({ specRev: 0 });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${stale.id}/accept`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('spec revision 0');
  });

  it('consecutive accepts within one review cycle both succeed (no deadlock)', async () => {
    // Two findings from the same review cycle (specRev=0, gateCount stays at 1
    // because spec.revised events don't increment gate.opened count).
    const f1 = await createFinding({ suggestedText: 'Fix one.' });
    const f2 = await createFinding({ suggestedText: 'Fix two.' });

    const res1 = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${f1.id}/accept`,
    });
    expect(res1.statusCode).toBe(200);

    // Second accept must also succeed — spec.revised from f1 did not move the gate
    const res2 = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${f2.id}/accept`,
    });
    expect(res2.statusCode).toBe(200);

    // Both findings resolved
    const [rf1, rf2] = await Promise.all([
      getPrisma().finding.findFirst({ where: { featureId, id: f1.id } }),
      getPrisma().finding.findFirst({ where: { featureId, id: f2.id } }),
    ]);
    expect(rf1?.resolution).toBe('accepted');
    expect(rf2?.resolution).toBe('accepted');
  });
});

// ── dismiss ────────────────────────────────────────────────────────────────

describe('POST /features/:id/findings/:findingId/dismiss', () => {
  it('returns 200 for warning with no reason', async () => {
    const finding = await createFinding({ severity: 'warning' });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${finding.id}/dismiss`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    const resolved = await getPrisma().finding.findFirst({ where: { featureId, id: finding.id } });
    expect(resolved?.resolution).toBe('dismissed');
  });

  it('returns 400 for blocker with no reason', async () => {
    const finding = await createFinding({ severity: 'blocker' });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${finding.id}/dismiss`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 for blocker with reason', async () => {
    const finding = await createFinding({ severity: 'blocker' });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${finding.id}/dismiss`,
      payload: { reason: 'Mitigated via existing IAM policy.' },
    });
    expect(res.statusCode).toBe(200);

    const resolved = await getPrisma().finding.findFirst({ where: { featureId, id: finding.id } });
    expect(resolved?.resolution).toBe('dismissed');
    expect(resolved?.reason).toBe('Mitigated via existing IAM policy.');
  });

  it('emits finding.resolved(dismissed) event', async () => {
    const finding = await createFinding({ severity: 'suggestion' });
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${finding.id}/dismiss`,
      payload: {},
    });

    const events = await getPrisma().event.findMany({ where: { featureId } });
    const dismissEvent = events.find((e) => e.type === 'finding.resolved');
    expect((dismissEvent?.payload as { resolution: string }).resolution).toBe('dismissed');
  });
});

// ── approve blocker guard ──────────────────────────────────────────────────

describe('POST /features/:id/approve — blocker guard', () => {
  it('returns 409 when there is an unresolved blocker', async () => {
    await createFinding({ severity: 'blocker' });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/approve`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('blocker');
  });

  it('returns 200 after all blockers are dismissed', async () => {
    const finding = await createFinding({ severity: 'blocker' });

    // Dismiss the blocker
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${finding.id}/dismiss`,
      payload: { reason: 'Acknowledged.' },
    });

    // Approve should now succeed
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/approve`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('warnings do not block approval', async () => {
    await createFinding({ severity: 'warning' });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/approve`,
    });
    // Approve may fail for other reasons (artifact commit) but not the blocker guard
    expect(res.statusCode).not.toBe(409);
  });
});

// ── CODE_REVIEW dismiss (T4) ──────────────────────────────────────────────────

describe('dismiss in CODE_REVIEW state', () => {
  beforeEach(async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'CODE_REVIEW' },
    });
  });

  it('dismiss works in CODE_REVIEW and returns 200', async () => {
    const finding = await createFinding({ severity: 'warning', specRev: 0 });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${finding.id}/dismiss`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('dismiss in CODE_REVIEW with last blocker auto-advances to TESTING', async () => {
    const finding = await createFinding({ severity: 'blocker', specRev: 0 });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${finding.id}/dismiss`,
      payload: { reason: 'out of scope' },
    });
    expect(res.statusCode).toBe(200);

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('TESTING');
  });

  it('dismiss in CODE_REVIEW with remaining blockers does NOT advance', async () => {
    await createFinding({ severity: 'blocker', specRev: 0 });
    const secondFinding = await createFinding({ severity: 'blocker', specRev: 0 });

    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${secondFinding.id}/dismiss`,
      payload: { reason: 'waived' },
    });
    expect(res.statusCode).toBe(200);

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('CODE_REVIEW'); // still in CODE_REVIEW — one blocker left
  });

  it('dismiss of last blocker in CODE_REVIEW enqueues simulate-resume for simulated run', async () => {
    // Mark the feature as a simulated run.
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { simulatedRun: true },
    });
    const finding = await createFinding({ severity: 'blocker', specRev: 0 });

    mockEnqueueJob.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${finding.id}/dismiss`,
      payload: { reason: 'waived' },
    });
    expect(res.statusCode).toBe(200);

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('TESTING');
    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'simulate-resume', undefined);
  });

  it('dismiss of last blocker in CODE_REVIEW enqueues test job for real run', async () => {
    // Feature is not a simulated run (default).
    const finding = await createFinding({ severity: 'blocker', specRev: 0 });

    mockEnqueueJob.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${finding.id}/dismiss`,
      payload: { reason: 'waived' },
    });
    expect(res.statusCode).toBe(200);

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('TESTING');
    expect(mockEnqueueJob).toHaveBeenCalledWith(featureId, 'test', undefined);
  });
});

// ── simulator finding id consistency (5b-T8) ──────────────────────────────────
//
// runSimulate persists the spec-approval mock finding and emits a review.findings
// event. The id in the DB and the id in the event payload must match so that
// accept/dismiss calls using the event-payload id return 200, not 404.

describe('simulator spec-approval finding — accept uses event-payload id', () => {
  it('POST accept with the id from the review.findings event payload returns 200', async () => {
    // runSimulate starts from DRAFTING_SPEC, so reset the feature to that state.
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'DRAFTING_SPEC', simulatedRun: true },
    });

    await runSimulate(featureId);

    // Feature should now be at AWAITING_APPROVAL (spec-approval gate).
    const feature = await getPrisma().feature.findUniqueOrThrow({ where: { id: featureId } });
    expect(feature.status).toBe('AWAITING_APPROVAL');

    // Extract the finding id the UI would receive from the review.findings event.
    const reviewEvent = await getPrisma().event.findFirst({
      where: { featureId, type: 'review.findings' },
      orderBy: { seq: 'desc' },
    });
    expect(reviewEvent).not.toBeNull();
    const payload = reviewEvent!.payload as { findings: Array<{ id: string }> };
    const eventFindingId = payload.findings[0]!.id;

    // Accept using the event-payload id — must return 200, not 404.
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/${eventFindingId}/accept`,
    });
    expect(res.statusCode).toBe(200);
  });
});
