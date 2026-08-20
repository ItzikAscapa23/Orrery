import type { FastifyInstance } from 'fastify';
import { findFeatureById, updateFeatureStatus } from '../lib/features.js';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { dispatchForState } from '../lib/dispatch.js';

/**
 * POST /features/:id/retry-pr
 *
 * Re-enqueue the create-ado-pr job after it failed (e.g. bad PAT, ADO outage,
 * oversized body). The feature must be in FAILED state; all dev tasks are
 * already completed so no task seeding or parked-task resurrection is needed.
 *
 * Action: restore status CODE_REVIEW → dispatch create-ado-pr.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function featureRetryPrRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>('/features/:id/retry-pr', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }
    if (feature.status !== 'FAILED') {
      return reply.status(409).send({
        error: `retry-pr is only valid in FAILED state (current: ${feature.status})`,
      });
    }

    await updateFeatureStatus(feature.id, 'CODE_REVIEW');

    await appendEvent(getPrisma(), feature.id, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: '↻ PR creation retried by operator',
    });

    await dispatchForState(feature.id, 'CODE_REVIEW', { simulated_run: false });

    return reply.status(200).send({ dispatched: 'create-ado-pr' });
  });
}
