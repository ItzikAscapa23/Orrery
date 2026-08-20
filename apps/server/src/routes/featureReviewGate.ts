import type { FastifyInstance } from 'fastify';
import { findFeatureById } from '../lib/features.js';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { dispatchJob, dispatchForState } from '../lib/dispatch.js';
import { gateOpenedCount } from '../lib/reviewCycle.js';

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureReviewGateRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /approve-review ───────────────────────────────────────────────────
  // Valid in CODE_REVIEW when the code_review gate is open. All blockers for
  // the current cycle must already be resolved (via dismiss). Fires REVIEW_PASS.
  app.post<{ Params: { id: string } }>('/features/:id/approve-review', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }
    if (feature.status !== 'CODE_REVIEW') {
      return reply.status(409).send({ error: 'Feature is not in CODE_REVIEW' });
    }

    const cycleRev = (await gateOpenedCount(feature.id)) - 1;
    const unresolvedBlockers = await getPrisma().finding.count({
      where: { featureId: feature.id, specRev: cycleRev, severity: 'blocker', resolution: null },
    });
    if (unresolvedBlockers > 0) {
      return reply.status(409).send({
        error: `${unresolvedBlockers} blocker finding(s) must be dismissed before approval`,
      });
    }

    await getPrisma().$transaction(async (tx) => {
      await appendEvent(tx, feature.id, {
        type: 'gate.resolved',
        gate: 'code_review',
        resolution: 'approved',
      });
      const next = await applyTransition(tx, feature.id, 'CODE_REVIEW', 'REVIEW_PASS');
      if (next) {
        await appendEvent(tx, feature.id, {
          type: 'phase.changed',
          from: 'CODE_REVIEW',
          to: next,
        });
      }
    });

    // Dispatch the job for the new TESTING state.
    await dispatchForState(feature.id, 'TESTING', feature);

    const updated = await findFeatureById(feature.id);
    return reply.status(200).send(updated);
  });

  // ── POST /retry-review ────────────────────────────────────────────────────
  // Re-enqueue the review job after a parse failure or Bedrock error. Feature
  // must be in CODE_REVIEW. Same pattern as POST /retry-pr.
  app.post<{ Params: { id: string } }>('/features/:id/retry-review', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }
    if (feature.status !== 'CODE_REVIEW') {
      return reply.status(409).send({
        error: `retry-review is only valid in CODE_REVIEW state (current: ${feature.status})`,
      });
    }

    await appendEvent(getPrisma(), feature.id, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: '↻ review retried by operator',
    });

    await dispatchJob(feature.id, 'review');

    return reply.status(200).send({ dispatched: 'review' });
  });
}
