import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { findFeatureById } from '../lib/features.js';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { dispatchForState } from '../lib/dispatch.js';
import { gateOpenedCount } from '../lib/reviewCycle.js';

const DismissBodySchema = z.object({
  reason: z.string().optional(),
});

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureFindingsRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /features/:id/findings/:findingId/accept ──────────────────────────
  app.post<{ Params: { id: string; findingId: string } }>(
    '/features/:id/findings/:findingId/accept',
    async (request, reply) => {
      const feature = await findFeatureById(request.params.id);
      if (!feature) {
        return reply.status(404).send({ error: 'Feature not found' });
      }
      if (feature.status !== 'AWAITING_APPROVAL' && feature.status !== 'CODE_REVIEW') {
        return reply.status(409).send({ error: 'Feature is not in a review state' });
      }

      // Enforce review-cycle pinning: findings carry the gate.opened revision
      // index (specRev = number of prior gate.opened events at the time the
      // review ran). This counts gate.opened events only — spec.revised events
      // from sibling accepts within the same review cycle do NOT increment this
      // counter, so multiple consecutive accepts from one review all pass.
      // A stale finding from a previous review cycle (after re-propose) 409s.
      // Finding identity is composite (featureId, specRev, id) — the same
      // label ("f1") legitimately recurs across review cycles, so we fetch the
      // most recent occurrence for the stale-vs-missing distinction.
      const gateCount = await gateOpenedCount(feature.id);
      const currentCycleRev = gateCount - 1; // 0-based index of the latest gate
      const finding = await getPrisma().finding.findFirst({
        where: { featureId: feature.id, id: request.params.findingId },
        orderBy: { specRev: 'desc' },
      });
      if (!finding) {
        return reply.status(404).send({ error: 'Finding not found' });
      }
      if (finding.specRev !== currentCycleRev) {
        return reply.status(409).send({
          error: `Finding belongs to spec revision ${finding.specRev}, but current revision is ${currentCycleRev}. Re-run the review.`,
        });
      }
      if (!finding.suggestedText) {
        return reply.status(400).send({ error: 'Finding has no suggested_text to accept' });
      }
      if (finding.resolution !== null) {
        return reply.status(409).send({ error: 'Finding is already resolved' });
      }

      const newRev = gateCount; // revision number for the spec.revised event

      await getPrisma().$transaction(async (tx) => {
        // Append suggested_text as a new revision block
        const currentSpec = feature.proposed_spec ?? '';
        const updatedSpec = currentSpec + '\n\n' + finding.suggestedText;
        await tx.feature.update({
          where: { id: feature.id },
          data: { proposedSpec: updatedSpec },
        });

        await appendEvent(tx, feature.id, {
          type: 'spec.revised',
          rev: newRev,
          cause: 'finding_accepted',
        });
        await appendEvent(tx, feature.id, {
          type: 'finding.resolved',
          finding_id: finding.id,
          resolution: 'accepted',
        });

        await tx.finding.update({
          where: {
            featureId_specRev_id: {
              featureId: finding.featureId,
              specRev: finding.specRev,
              id: finding.id,
            },
          },
          data: { resolution: 'accepted' },
        });
      });

      return reply.status(200).send({ ok: true });
    },
  );

  // ── POST /features/:id/findings/:findingId/dismiss ─────────────────────────
  app.post<{ Params: { id: string; findingId: string } }>(
    '/features/:id/findings/:findingId/dismiss',
    async (request, reply) => {
      const feature = await findFeatureById(request.params.id);
      if (!feature) {
        return reply.status(404).send({ error: 'Feature not found' });
      }
      if (
        feature.status !== 'AWAITING_APPROVAL' &&
        feature.status !== 'CODE_REVIEW' &&
        feature.status !== 'TESTING'
      ) {
        return reply.status(409).send({ error: 'Feature is not in a review state' });
      }

      // Enforce review-cycle pinning for dismiss (same semantics as accept).
      const gateCount = await gateOpenedCount(feature.id);
      const currentCycleRev = gateCount - 1;
      const finding = await getPrisma().finding.findFirst({
        where: { featureId: feature.id, id: request.params.findingId },
        orderBy: { specRev: 'desc' },
      });
      if (!finding) {
        return reply.status(404).send({ error: 'Finding not found' });
      }
      if (finding.specRev !== currentCycleRev) {
        return reply.status(409).send({
          error: `Finding belongs to spec revision ${finding.specRev}, but current revision is ${currentCycleRev}. Re-run the review.`,
        });
      }
      if (finding.resolution !== null) {
        return reply.status(409).send({ error: 'Finding is already resolved' });
      }

      let body: { reason?: string | undefined };
      try {
        body = DismissBodySchema.parse(request.body);
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: err.issues.map((i) => i.message).join(', ') });
        }
        throw err;
      }

      if (finding.severity === 'blocker' && !body.reason) {
        return reply
          .status(400)
          .send({ error: 'A reason is required when dismissing a blocker finding' });
      }

      await getPrisma().$transaction(async (tx) => {
        await appendEvent(tx, feature.id, {
          type: 'finding.resolved',
          finding_id: finding.id,
          resolution: 'dismissed',
          reason: body.reason,
        });

        await tx.finding.update({
          where: {
            featureId_specRev_id: {
              featureId: finding.featureId,
              specRev: finding.specRev,
              id: finding.id,
            },
          },
          data: { resolution: 'dismissed', reason: body.reason ?? null },
        });
      });

      // Gate auto-resolution: if all relevant findings for the current cycle are
      // resolved, close the gate and advance state.
      // CODE_REVIEW → REVIEW_PASS → TESTING  (checks blockers + warnings)
      // TESTING     → TEST_PASS  → DONE      (checks blockers only)
      if (feature.status === 'CODE_REVIEW' || feature.status === 'TESTING') {
        const cycleRev = (await gateOpenedCount(feature.id)) - 1;
        const isCodeReview = feature.status === 'CODE_REVIEW';
        // CODE_REVIEW gate requires all blockers AND warnings to have a decision.
        // TESTING gate (test_report) requires only blockers — warnings are a
        // separate concern handled by phase 43's vacuous-detector changes.
        const remainingSeverities = isCodeReview ? { in: ['blocker', 'warning'] } : 'blocker';
        const remaining = await getPrisma().finding.count({
          where: {
            featureId: feature.id,
            specRev: cycleRev,
            severity: remainingSeverities,
            resolution: null,
          },
        });
        if (remaining === 0) {
          const gate = isCodeReview ? 'code_review' : 'test_report';
          const transition = isCodeReview ? ('REVIEW_PASS' as const) : ('TEST_PASS' as const);
          const nextState = isCodeReview ? ('TESTING' as const) : ('DONE' as const);

          await getPrisma().$transaction(async (tx) => {
            await appendEvent(tx, feature.id, {
              type: 'gate.resolved',
              gate,
              resolution: 'approved',
            });
            const next = await applyTransition(
              tx,
              feature.id,
              feature.status as import('@prisma/client').FeatureStatus,
              transition,
            );
            if (next) {
              await appendEvent(tx, feature.id, {
                type: 'phase.changed',
                from: feature.status,
                to: next,
              });
            }
          });

          // Dispatch the successor state job (simulate-resume for sim runs,
          // real agent job for real runs). DONE has no successor job.
          if (nextState !== 'DONE') {
            await dispatchForState(feature.id, nextState, feature);
          }
        }
      }

      return reply.status(200).send({ ok: true });
    },
  );
}
