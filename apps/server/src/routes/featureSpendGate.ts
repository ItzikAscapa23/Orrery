import type { FastifyInstance } from 'fastify';
import { findFeatureById } from '../lib/features.js';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { dispatchUnblockedTasks } from '../lib/dispatch.js';

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureSpendGateRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /features/:id/tasks/:taskId/resume-spend-gate ────────────────────
  app.post<{ Params: { id: string; taskId: string } }>(
    '/features/:id/tasks/:taskId/resume-spend-gate',
    async (request, reply) => {
      const feature = await findFeatureById(request.params.id);
      if (!feature) {
        return reply.status(404).send({ error: 'Feature not found' });
      }
      if (feature.status !== 'IMPLEMENTING' && feature.status !== 'LIGHT_IMPLEMENTING') {
        return reply.status(409).send({
          error: 'Feature is not in IMPLEMENTING or LIGHT_IMPLEMENTING state',
        });
      }

      const task = await getPrisma().task.findFirst({
        where: { id: request.params.taskId, featureId: feature.id },
      });
      if (!task) {
        return reply.status(404).send({ error: 'Task not found' });
      }
      if (task.status !== 'parked') {
        return reply.status(409).send({ error: 'Task is not parked' });
      }
      if (task.parkReason !== 'spend_limit') {
        return reply.status(409).send({ error: 'Task was not parked by the spend guard' });
      }

      await getPrisma().$transaction(async (tx) => {
        await appendEvent(tx, feature.id, {
          type: 'gate.resolved',
          gate: 'spend_guard',
          resolution: 'override',
          taskId: task.id,
        });
        await tx.task.update({
          where: { id: task.id },
          data: {
            attemptCount: 0,
            status: 'pending',
            parkReason: null,
            bullJobId: null,
          },
        });
      });

      await dispatchUnblockedTasks(feature.id, task.side as 'server' | 'client');

      const updated = await findFeatureById(feature.id);
      return reply.status(200).send(updated);
    },
  );
}
