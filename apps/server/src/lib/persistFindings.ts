import { getPrisma } from './prisma.js';
import { appendEvent } from './events.js';

export interface FindingInput {
  id: string;
  severity: string;
  section: string;
  issue: string;
  suggestedText?: string | null;
}

/**
 * Authoritative write path for a review cycle's findings.
 *
 * 1. C-2 pre-flight: for any finding being re-raised that currently has a
 *    non-null resolution, emit an agent.log/muted event so the operator
 *    dismissal is traceable even after it is cleared.
 * 2. Atomic transaction:
 *    - deleteMany removes every (featureId, specRev) row whose id is NOT in
 *      the new findings list. When findings is empty this deletes all rows.
 *    - upsert for each finding refreshes severity/section/issue and resets
 *      resolution/reason so the gate counts current data only.
 */
export async function persistFindings(
  featureId: string,
  specRev: number,
  findings: FindingInput[],
  agent: string,
): Promise<void> {
  // C-2 pre-flight: detect prior operator decisions being cleared
  if (findings.length > 0) {
    const cleared = await getPrisma().finding.findMany({
      where: {
        featureId,
        specRev,
        id: { in: findings.map((f) => f.id) },
        resolution: { not: null },
      },
      select: { id: true, resolution: true },
    });
    for (const row of cleared) {
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent,
        severity: 'muted',
        text: `finding ${row.id}: prior resolution '${row.resolution}' cleared by re-review`,
      });
    }
  }

  // Pre-flight: emit finding.resolved(fixed) for findings the re-review no longer raises.
  // These are deleted below; the event preserves the resolution trail.
  const newIds = findings.map((f) => f.id);
  const orphaned = await getPrisma().finding.findMany({
    where: { featureId, specRev, id: { notIn: newIds } },
    select: { id: true },
  });
  for (const row of orphaned) {
    await appendEvent(getPrisma(), featureId, {
      type: 'finding.resolved',
      finding_id: row.id,
      resolution: 'fixed',
      reason: `auto-fixed by ${agent}`,
    });
  }

  // Atomic: delete orphans then upsert current findings
  await getPrisma().$transaction([
    getPrisma().finding.deleteMany({
      where: {
        featureId,
        specRev,
        id: { notIn: findings.map((f) => f.id) },
      },
    }),
    ...findings.map((f) =>
      getPrisma().finding.upsert({
        where: { featureId_specRev_id: { featureId, specRev, id: f.id } },
        create: {
          id: f.id,
          featureId,
          specRev,
          severity: f.severity,
          section: f.section,
          issue: f.issue,
          suggestedText: f.suggestedText ?? null,
        },
        update: {
          severity: f.severity,
          section: f.section,
          issue: f.issue,
          suggestedText: f.suggestedText ?? null,
          resolution: null,
          reason: null,
        },
      }),
    ),
  ]);
}
