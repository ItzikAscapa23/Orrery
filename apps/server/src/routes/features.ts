import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import {
  CreateFeatureBodySchema,
  type CreateFeatureBody,
  createFeature,
  findAllFeatures,
  findFeatureById,
} from '../lib/features.js';
import { loadActiveRepos } from '../agents/plannerAgent.js';

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureRoutes(app: FastifyInstance): Promise<void> {
  app.post('/features', async (request, reply) => {
    let body: unknown;
    try {
      body = CreateFeatureBodySchema.parse(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: err.issues.map((i) => i.message).join(', ') });
      }
      throw err;
    }

    const validated = body as CreateFeatureBody;
    const activeRepos = loadActiveRepos();
    const activeIds = new Set(activeRepos.map((r) => r.id));
    const invalidId = validated.repos.find((id) => !activeIds.has(id));
    if (invalidId) {
      return reply.status(400).send({
        error: `Unknown or inactive repo: "${invalidId}". Valid ids: ${[...activeIds].join(', ')}`,
      });
    }

    // Derive feature path: LIGHT only when every selected repo has path:'light' in the manifest.
    const selectedRepos = activeRepos.filter((r) => validated.repos.includes(r.id));
    const featurePath = selectedRepos.every((r) => r.path === 'light') ? 'LIGHT' : 'FULL';

    try {
      const feature = await createFeature({ ...validated, featurePath });
      return reply.status(201).send(feature);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unique constraint failed')) {
        return reply.status(409).send({ error: 'A feature with this name already exists' });
      }
      throw err;
    }
  });

  app.get('/features', async (_request, reply) => {
    return reply.send(await findAllFeatures());
  });

  app.get<{ Params: { id: string } }>('/features/:id', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }
    return reply.send(feature);
  });
}
