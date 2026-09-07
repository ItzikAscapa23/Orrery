import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockAppendEvent } = vi.hoisted(() => ({
  mockAppendEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/events.js', () => ({
  appendEvent: mockAppendEvent,
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { persistFindings } from '../lib/persistFindings.js';

afterEach(async () => {
  await disconnectPrisma();
});

beforeEach(async () => {
  mockAppendEvent.mockClear();
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  // Seed a feature row that finding rows can FK-reference
  await getPrisma().$executeRaw`
    INSERT INTO features (id, slug, name, requirement, status, simulated_run, created_at)
    VALUES ('feat-pf', 'pf-test', 'PF Test', 'req', 'CODE_REVIEW', false, NOW())
  `;
});

const FID = 'feat-pf';
const SPEC_REV = 0;

const f1 = { id: 'f1', severity: 'blocker', section: 'POST /foo', issue: 'missing field' };
const _f2 = { id: 'f2', severity: 'warning', section: 'GET /bar', issue: 'slow response' };

async function seedFinding(
  id: string,
  resolution: string | null = null,
  reason: string | null = null,
) {
  await getPrisma().finding.create({
    data: {
      id,
      featureId: FID,
      specRev: SPEC_REV,
      severity: id === 'f1' ? 'blocker' : 'warning',
      section: id === 'f1' ? 'POST /foo' : 'GET /bar',
      issue: id === 'f1' ? 'missing field' : 'slow response',
      resolution,
      reason,
    },
  });
}

describe('persistFindings', () => {
  it('C-1: orphan deletion — round 1 raises f1+f2, round 2 raises only f1 → f2 row gone', async () => {
    await seedFinding('f1');
    await seedFinding('f2');

    await persistFindings(FID, SPEC_REV, [f1], 'review');

    const rows = await getPrisma().finding.findMany({
      where: { featureId: FID, specRev: SPEC_REV },
    });
    expect(rows.map((r) => r.id)).toEqual(['f1']);

    // Gate check: no unresolved blockers at specRev 0 means approve passes
    const unresolvedBlockers = await getPrisma().finding.count({
      where: { featureId: FID, specRev: SPEC_REV, severity: 'blocker', resolution: null },
    });
    expect(unresolvedBlockers).toBe(1); // f1 is still there, unresolved
    // f2 is gone — it cannot block the gate
    const f2Row = await getPrisma().finding.findUnique({
      where: { featureId_specRev_id: { featureId: FID, specRev: SPEC_REV, id: 'f2' } },
    });
    expect(f2Row).toBeNull();
  });

  it('C-1: zero-finding case — round 1 raises f1, round 2 raises none → f1 row gone', async () => {
    await seedFinding('f1');

    await persistFindings(FID, SPEC_REV, [], 'review');

    const rows = await getPrisma().finding.findMany({
      where: { featureId: FID, specRev: SPEC_REV },
    });
    expect(rows).toHaveLength(0);
  });

  it('C-2: resolution reset — f1 dismissed by operator, re-review re-raises f1 → resolution null + muted log', async () => {
    await seedFinding('f1', 'dismissed', 'not applicable');

    await persistFindings(FID, SPEC_REV, [f1], 'review');

    const row = await getPrisma().finding.findUniqueOrThrow({
      where: { featureId_specRev_id: { featureId: FID, specRev: SPEC_REV, id: 'f1' } },
    });
    expect(row.resolution).toBeNull();

    expect(mockAppendEvent).toHaveBeenCalledOnce();
    // appendEvent(prisma, featureId, payload) — payload is the third arg
    const [, , payload] = mockAppendEvent.mock.calls[0] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(payload.type).toBe('agent.log');
    expect(payload.severity).toBe('muted');
    expect(String(payload.text)).toContain('f1');
    expect(String(payload.text)).toContain('dismissed');
  });

  it('C-2: no spurious log — findings unchanged across rounds → mockAppendEvent not called', async () => {
    await seedFinding('f1', null, null);

    await persistFindings(FID, SPEC_REV, [f1], 'review');

    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it('fixed resolution — orphaned finding emits finding.resolved(fixed) before deletion', async () => {
    await seedFinding('f1');
    await seedFinding('f2'); // will be orphaned

    await persistFindings(FID, SPEC_REV, [f1], 'review');

    // f2 row must be deleted
    const f2Row = await getPrisma().finding.findUnique({
      where: { featureId_specRev_id: { featureId: FID, specRev: SPEC_REV, id: 'f2' } },
    });
    expect(f2Row).toBeNull();

    // finding.resolved(fixed) event must have been emitted for f2
    const fixedCall = mockAppendEvent.mock.calls.find(([, , payload]) => {
      const p = payload as Record<string, unknown>;
      return p.type === 'finding.resolved' && p.resolution === 'fixed' && p.finding_id === 'f2';
    });
    expect(fixedCall).toBeDefined();
  });
});
