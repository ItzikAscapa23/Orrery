import type { FastifyInstance } from 'fastify';
import { findFeatureById } from '../lib/features.js';
import { dispatchJob } from '../lib/dispatch.js';
import { getPrisma } from '../lib/prisma.js';

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureSimulateRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: { review_path?: string } | null }>(
    '/features/:id/simulate',
    async (request, reply) => {
      if (process.env['NODE_ENV'] === 'production') {
        return reply.status(403).send({ error: 'Simulator is not available in production' });
      }

      const feature = await findFeatureById(request.params.id);
      if (!feature) {
        return reply.status(404).send({ error: 'Feature not found' });
      }

      // review_path controls the CODE_REVIEW sub-path the simulator walks.
      // 'forced-fix' (default): blocker → bounce-back → fix → re-review passes.
      // 'gate': blocker → bounce-back → fix incomplete → human gate.
      const reviewPath = request.body?.review_path === 'gate' ? 'gate' : 'forced-fix';

      await getPrisma().feature.update({
        where: { id: feature.id },
        data: { simulatedRun: true, simulatorReviewPath: reviewPath },
      });

      // dispatchJob enqueues and warns when no worker is consuming the queue.
      await dispatchJob(feature.id, 'simulate');

      return reply.status(202).send({ message: 'Simulation enqueued', featureId: feature.id });
    },
  );
}
