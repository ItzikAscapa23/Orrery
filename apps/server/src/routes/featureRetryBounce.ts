import type { FastifyInstance } from 'fastify';
import { findFeatureById } from '../lib/features.js';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { dispatchForState } from '../lib/dispatch.js';
import { createSyntheticFixTasks } from '../lib/syntheticTasks.js';
import type { ReviewFindingsPayload } from '@orrery/shared';

/**
 * POST /features/:id/retry-bounce
 *
 * Recovery route for features stalled in IMPLEMENTING after a real-path
 * REVIEW_FAIL that produced no synthetic task rows (the bounce-back gap bug).
 *
 * Reads the latest review.findings event, creates synthetic fix task rows,
 * then dispatches dispatchForState(IMPLEMENTING) so the worker picks them up.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function featureRetryBounceRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>('/features/:id/retry-bounce', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }
    if (feature.status !== 'IMPLEMENTING') {
      return reply.status(409).send({
        error: `retry-bounce is only valid in IMPLEMENTING state (current: ${feature.status})`,
      });
    }

    // Refuse if synthetic tasks already exist (idempotency guard).
    const existing = await getPrisma().task.findMany({
      where: { featureId: feature.id, title: { startsWith: 'Fix review blockers' } },
      select: { id: true, status: true },
    });
    if (existing.length > 0) {
      return reply.status(409).send({
        error: 'Synthetic fix tasks already exist — check task status before retrying',
        tasks: existing,
      });
    }

    // Find the latest review.findings event.
    const findingsEvent = await getPrisma().event.findFirst({
      where: {
        featureId: feature.id,
        type: 'review.findings',
        payload: { path: ['agent'], equals: 'review' },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!findingsEvent) {
      return reply.status(422).send({ error: 'No review.findings event found for this feature' });
    }

    const payload = findingsEvent.payload as ReviewFindingsPayload;
    const fallbackRepos = Object.keys(feature.current_branches);

    const created = await createSyntheticFixTasks(feature.id, payload.findings, fallbackRepos);

    if (created.length === 0) {
      return reply.status(422).send({
        error: 'No blocker findings found in the latest review.findings event — nothing to dispatch',
      });
    }

    await appendEvent(getPrisma(), feature.id, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'info',
      text: `↻ retry-bounce: ${created.length} synthetic fix task(s) created (${created.map((c) => c.repo).join(', ')})`,
    });

    await dispatchForState(feature.id, 'IMPLEMENTING', { simulated_run: false });

    return reply.status(200).send({ tasksCreated: created.length, tasks: created });
  });
}
