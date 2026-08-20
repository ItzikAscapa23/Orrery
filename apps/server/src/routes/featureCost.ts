import type { FastifyInstance } from 'fastify';
import { findFeatureById } from '../lib/features.js';
import { getPrisma } from '../lib/prisma.js';
import { computeCost } from '../lib/costCalc.js';

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureCostRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/features/:id/cost', async (request, reply) => {
    const { id } = request.params;

    const feature = await findFeatureById(id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }

    const events = await getPrisma().event.findMany({
      where: { featureId: id, type: 'usage.recorded' },
      orderBy: { seq: 'asc' },
    });

    const result = await computeCost(getPrisma(), events);
    return reply.send(result);
  });

  app.get('/cost', async (_request, reply) => {
    const features = await getPrisma().feature.findMany({ orderBy: { createdAt: 'asc' } });

    let total_usd = 0;
    let priced_events = 0;
    let partial_events = 0;
    let unpriceable_events = 0;
    let rate_unknown_events = 0;
    let tagged_simulated_events = 0;

    const by_feature: {
      featureId: string;
      name: string;
      total_usd: number;
      priced_events: number;
      partial_events: number;
      unpriceable_events: number;
      rate_unknown_events: number;
      tagged_simulated_events: number;
    }[] = [];

    for (const feature of features) {
      const events = await getPrisma().event.findMany({
        where: { featureId: feature.id, type: 'usage.recorded' },
        orderBy: { seq: 'asc' },
      });
      const cost = await computeCost(getPrisma(), events);

      total_usd += cost.total_usd;
      priced_events += cost.priced_events;
      partial_events += cost.partial_events;
      unpriceable_events += cost.unpriceable_events;
      rate_unknown_events += cost.rate_unknown_events;
      tagged_simulated_events += cost.tagged_simulated_events;

      by_feature.push({
        featureId: feature.id,
        name: feature.name,
        total_usd: cost.total_usd,
        priced_events: cost.priced_events,
        partial_events: cost.partial_events,
        unpriceable_events: cost.unpriceable_events,
        rate_unknown_events: cost.rate_unknown_events,
        tagged_simulated_events: cost.tagged_simulated_events,
      });
    }

    by_feature.sort((a, b) => b.total_usd - a.total_usd);

    return reply.send({
      total_usd,
      priced_events,
      partial_events,
      unpriceable_events,
      rate_unknown_events,
      tagged_simulated_events,
      by_feature,
    });
  });
}
