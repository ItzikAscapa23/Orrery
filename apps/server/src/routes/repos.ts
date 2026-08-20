import type { FastifyInstance } from 'fastify';
import { loadActiveRepos } from '../agents/plannerAgent.js';

// eslint-disable-next-line @typescript-eslint/require-await
export async function reposRoutes(app: FastifyInstance): Promise<void> {
  app.get('/repos', (_request, reply) => {
    const repos = loadActiveRepos().map((r) => ({
      id: r.id,
      side: r.side,
      description: r.description.trim(),
      default_branch: r.default_branch,
    }));
    return reply.send(repos);
  });
}
