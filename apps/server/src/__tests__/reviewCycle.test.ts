import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockCommitSpecDraft, mockRunAwsReview } = vi.hoisted(() => ({
  mockCommitSpecDraft: vi
    .fn()
    .mockReturnValue({ path: 'features/t/spec.md', commit: 'abc', message: 'spec: t draft r0' }),
  mockRunAwsReview: vi.fn(),
}));

vi.mock('../lib/artifacts.js', () => ({
  commitSpecDraft: mockCommitSpecDraft,
  ArtifactCommitError: class ArtifactCommitError extends Error {},
}));
vi.mock('../lib/queue.js', () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
  getQueue: vi.fn(),
  closeQueue: vi.fn(),
}));
vi.mock('../agents/awsAgent.js', () => ({ runAwsReview: mockRunAwsReview }));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import { createFeature } from '../lib/features.js';
import { appendEvent } from '../lib/events.js';
import { runAwsReviewJob } from '../jobs/awsReviewJob.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let featureId: string;

async function seedGate(revision: number): Promise<void> {
  await appendEvent(getPrisma(), featureId, {
    type: 'gate.opened',
    gate: 'spec_approval',
    summary: 'Test spec.',
    revision,
  });
}

function finding(
  id: string,
  specRev: number,
  overrides: Partial<{ severity: string; resolution: string | null; suggestedText: string }> = {},
) {
  return {
    id,
    featureId,
    specRev,
    severity: overrides.severity ?? 'blocker',
    section: 'Overview',
    issue: 'Test issue.',
    suggestedText: overrides.suggestedText ?? null,
    resolution: overrides.resolution ?? null,
  };
}

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  app = await createApp();
  vi.clearAllMocks();
  mockCommitSpecDraft.mockReturnValue({
    path: 'features/t/spec.md',
    commit: 'abc',
    message: 'spec: t draft r0',
  });

  const feature = await createFeature({ name: 'Cycle Feature', requirement: 'req' });
  featureId = feature.id;
  await getPrisma().feature.update({
    where: { id: featureId },
    data: { status: 'AWAITING_APPROVAL', proposedSpec: '## Overview\nTest spec.' },
  });
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

// ── Finding identity across review cycles (composite PK) ────────────────────

describe('finding identity', () => {
  it('allows the same finding id in different review cycles of one feature', async () => {
    await seedGate(0);
    await getPrisma().finding.createMany({ data: [finding('f1', 0), finding('f2', 0)] });
    // Second review cycle re-issues f1 — must NOT collide
    await seedGate(1);
    await expect(
      getPrisma().finding.createMany({ data: [finding('f1', 1)] }),
    ).resolves.toBeTruthy();
    const rows = await getPrisma().finding.findMany({ where: { featureId, id: 'f1' } });
    expect(rows).toHaveLength(2);
  });

  it('allows the same finding id on a second feature', async () => {
    await seedGate(0);
    await getPrisma().finding.createMany({ data: [finding('f1', 0)] });

    const other = await createFeature({ name: 'Other Feature', requirement: 'req' });
    await expect(
      getPrisma().finding.createMany({
        data: [{ ...finding('f1', 0), featureId: other.id }],
      }),
    ).resolves.toBeTruthy();
  });
});

// ── Approve gate scoped to the current review cycle ─────────────────────────

describe('approve gate supersession', () => {
  it('ignores unresolved blockers from a superseded review cycle', async () => {
    await seedGate(0);
    await getPrisma().finding.createMany({ data: [finding('f1', 0)] }); // unresolved blocker, old cycle
    await seedGate(1); // re-review happened; no blockers this cycle

    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/approve` });
    expect(res.statusCode).toBe(200);
  });

  it('still gates on unresolved blockers from the current cycle', async () => {
    await seedGate(0);
    await getPrisma().finding.createMany({ data: [finding('f1', 0)] });
    await seedGate(1);
    await getPrisma().finding.createMany({ data: [finding('f1', 1)] }); // current-cycle blocker

    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/approve` });
    expect(res.statusCode).toBe(409);
    expect((JSON.parse(res.body) as { error: string }).error).toContain('1 blocker finding(s)');
  });

  it('409s accept/dismiss of a stale finding from a superseded cycle', async () => {
    await seedGate(0);
    await getPrisma().finding.createMany({
      data: [finding('f1', 0, { suggestedText: 'Old fix.' })],
    });
    await seedGate(1);

    const accept = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/f1/accept`,
    });
    expect(accept.statusCode).toBe(409);
    expect((JSON.parse(accept.body) as { error: string }).error).toContain(
      'belongs to spec revision 0',
    );

    const dismiss = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/f1/dismiss`,
      payload: { reason: 'stale' },
    });
    expect(dismiss.statusCode).toBe(409);
  });
});

// ── code_review gate must NOT advance the spec-revision clock ────────────────
//
// Regression test for: finding written at specRev N, then gate.opened
// (code_review) emitted (which previously bumped gateOpenedCount), causing
// currentCycleRev = N+1 at dismiss-time → 409.

describe('code_review gate does not advance specRev clock', () => {
  it('dismiss succeeds when code_review gate was opened after the finding was written', async () => {
    // Simulate the full sim gate-path sequence:
    // spec_approval (cycle 0) + plan_approval (cycle 1) = gateOpenedCount 2
    await seedGate(0); // spec_approval → gateOpenedCount = 1, cycleRev = 0
    await appendEvent(getPrisma(), featureId, {
      type: 'gate.opened',
      gate: 'plan_approval',
      summary: 'Simulated plan gate.',
      revision: 1,
    }); // plan_approval → gateOpenedCount = 2, cycleRev = 1

    // Finding written at cycleRev = 1
    await getPrisma().finding.create({
      data: finding('sim-rf1', 1, { severity: 'blocker' }),
    });

    // code_review gate opened AFTER finding — must NOT shift the clock
    await appendEvent(getPrisma(), featureId, {
      type: 'gate.opened',
      gate: 'code_review',
      summary: '1 unresolved blocker — human review required',
      revision: 1,
    }); // still gateOpenedCount = 2, cycleRev = 1

    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'CODE_REVIEW' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/findings/sim-rf1/dismiss`,
      payload: { reason: 'test dismiss' },
    });

    expect(res.statusCode).toBe(200);
  });
});

// ── Review-job retry policy (spec 03 failure policy) ────────────────────────

describe('aws review job retry policy', () => {
  beforeEach(async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'AWS_REVIEW' },
    });
  });

  async function eventsOfType(type: string) {
    return getPrisma().event.findMany({ where: { featureId, type }, orderBy: { seq: 'asc' } });
  }

  it('rethrows on a non-final attempt without advancing the machine', async () => {
    mockRunAwsReview.mockRejectedValueOnce(new Error('transient API error'));

    await expect(
      runAwsReviewJob(featureId, { attempt: 1, maxAttempts: 2 }, undefined, 'test-charter.md'),
    ).rejects.toThrow('transient API error');

    const feature = await getPrisma().feature.findUniqueOrThrow({ where: { id: featureId } });
    expect(feature.status).toBe('AWS_REVIEW'); // machine did NOT advance

    const statuses = await eventsOfType('agent.status');
    expect(statuses.map((e) => (e.payload as { status: string }).status)).toEqual([
      'working',
      'failed',
    ]);
    const logs = await eventsOfType('agent.log');
    expect(logs.some((e) => (e.payload as { text: string }).text.includes('retrying'))).toBe(true);
    expect((await eventsOfType('gate.opened')).length).toBe(0);
  });

  it('advances without findings only on the final attempt', async () => {
    mockRunAwsReview.mockRejectedValue(new Error('persistent API error'));

    // Attempt 1: rethrows (BullMQ would retry)
    await expect(
      runAwsReviewJob(featureId, { attempt: 1, maxAttempts: 2 }, undefined, 'test-charter.md'),
    ).rejects.toThrow('persistent API error');
    // Attempt 2 (final): advances without findings
    await expect(
      runAwsReviewJob(featureId, { attempt: 2, maxAttempts: 2 }, undefined, 'test-charter.md'),
    ).resolves.toBeUndefined();

    const feature = await getPrisma().feature.findUniqueOrThrow({ where: { id: featureId } });
    expect(feature.status).toBe('AWAITING_APPROVAL');

    // Two failed statuses — one per attempt ("fails twice")
    const statuses = await eventsOfType('agent.status');
    const failed = statuses.filter((e) => (e.payload as { status: string }).status === 'failed');
    expect(failed).toHaveLength(2);

    const logs = await eventsOfType('agent.log');
    expect(
      logs.some((e) => (e.payload as { text: string }).text.includes('review unavailable')),
    ).toBe(true);

    expect((await eventsOfType('review.findings')).length).toBe(0);
    const gates = await eventsOfType('gate.opened');
    expect(gates).toHaveLength(1);
    expect(gates[0]?.payload).not.toHaveProperty('counts');
  });

  it('persists findings and advances on success', async () => {
    mockRunAwsReview.mockResolvedValueOnce([
      {
        id: 'f1',
        severity: 'warning',
        section: 'Overview',
        issue: 'Minor issue.',
      },
    ]);

    await runAwsReviewJob(featureId, { attempt: 1, maxAttempts: 2 }, undefined, 'test-charter.md');

    const feature = await getPrisma().feature.findUniqueOrThrow({ where: { id: featureId } });
    expect(feature.status).toBe('AWAITING_APPROVAL');
    expect(await getPrisma().finding.count({ where: { featureId } })).toBe(1);
    const gates = await eventsOfType('gate.opened');
    expect(gates).toHaveLength(1);
    expect((gates[0]?.payload as { counts?: object }).counts).toEqual({
      blockers: 0,
      warnings: 1,
      suggestions: 0,
    });
  });
});
