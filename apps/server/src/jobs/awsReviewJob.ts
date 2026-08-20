import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { runAwsReview } from '../agents/awsAgent.js';
import { gateOpenedCount } from '../lib/reviewCycle.js';
import { persistFindings } from '../lib/persistFindings.js';
import { usageEventPayload } from '../lib/usageEvent.js';

export interface JobAttemptContext {
  /** 1-based attempt number (BullMQ attemptsMade is 0 on the first attempt). */
  attempt: number;
  /** Total attempts configured on the job (job.opts.attempts, default 1). */
  maxAttempts: number;
}

export async function runAwsReviewJob(
  featureId: string,
  { attempt, maxAttempts }: JobAttemptContext = { attempt: 1, maxAttempts: 1 },
  jobId?: string,
): Promise<void> {
  const feature = await getPrisma().feature.findUniqueOrThrow({ where: { id: featureId } });

  if (feature.status !== 'AWS_REVIEW' || !feature.proposedSpec) {
    // Already advanced or spec missing — nothing to do
    return;
  }

  const specRev = await gateOpenedCount(featureId);

  // Read the SHA committed at specProposed time so gate.opened can carry it.
  // The viewer uses this to pin to the exact draft that was under review.
  const specCommittedEvent = await getPrisma().event.findFirst({
    where: {
      featureId,
      type: 'artifact.committed',
      payload: { path: ['path'], equals: `features/${feature.slug}/spec.md` },
    },
    orderBy: { seq: 'desc' },
  });
  const specCommit = specCommittedEvent
    ? (specCommittedEvent.payload as { commit: string }).commit
    : undefined;

  try {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'aws',
      status: 'working',
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'aws',
      severity: 'action',
      text: '▸ reviewing spec against charter',
    });

    const findings = await runAwsReview(
      featureId,
      feature.name,
      feature.proposedSpec,
      async (usage) => {
        await appendEvent(getPrisma(), featureId, usageEventPayload(usage, 'aws', { jobId }));
      },
    );

    // persistFindings: deletes orphans from prior rounds, upserts current ones,
    // and emits a muted log event for any cleared operator resolution (C-1/C-2).
    await persistFindings(
      featureId,
      specRev,
      findings.map((f) => ({ ...f, suggestedText: f.suggested_text ?? null })),
      'aws',
    );

    const blockers = findings.filter((f) => f.severity === 'blocker').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const suggestions = findings.filter((f) => f.severity === 'suggestion').length;

    // Emit review.findings event
    await appendEvent(getPrisma(), featureId, {
      type: 'review.findings',
      agent: 'aws',
      spec_rev: specRev,
      findings,
    });

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'aws',
      severity: 'ok',
      text: `✓ review complete — ${findings.length} finding(s) (${blockers} blockers, ${warnings} warnings)`,
    });

    const summary = feature.proposedSpec.slice(0, 200);

    // Atomic: gate.opened + transition + phase.changed
    await getPrisma().$transaction(async (tx) => {
      await appendEvent(tx, featureId, {
        type: 'gate.opened',
        gate: 'spec_approval',
        summary,
        revision: specRev,
        counts: { blockers, warnings, suggestions },
        spec_commit: specCommit,
      });
      const next = await applyTransition(tx, featureId, 'AWS_REVIEW', 'AWS_DONE');
      if (next) {
        await appendEvent(tx, featureId, {
          type: 'phase.changed',
          from: 'AWS_REVIEW',
          to: next,
        });
      }
    });

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'aws',
      status: 'done',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: 'aws_review_job_error',
        featureId,
        attempt,
        maxAttempts,
        error: msg,
      }),
    );

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'aws',
      status: 'failed',
    });

    // Per spec 03 failure policy: BullMQ retries the job once. On a non-final
    // attempt, rethrow so BullMQ re-runs it (the next attempt re-enters via
    // the normal 'working' transition — failed status is not sticky). Only on
    // the final attempt does the machine advance without findings.
    if (attempt < maxAttempts) {
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'aws',
        severity: 'info',
        text: `◦ review attempt ${attempt} failed — retrying`,
      });
      throw err;
    }

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'aws',
      severity: 'muted',
      text: '· AWS review unavailable — proceeding without findings',
    });

    // Never brick the feature — advance to AWAITING_APPROVAL without counts
    const summary = (feature.proposedSpec ?? '').slice(0, 200);
    await getPrisma().$transaction(async (tx) => {
      await appendEvent(tx, featureId, {
        type: 'gate.opened',
        gate: 'spec_approval',
        summary,
        revision: specRev,
        spec_commit: specCommit,
      });
      const next = await applyTransition(tx, featureId, 'AWS_REVIEW', 'AWS_DONE');
      if (next) {
        await appendEvent(tx, featureId, {
          type: 'phase.changed',
          from: 'AWS_REVIEW',
          to: next,
        });
      }
    });
  }
}
