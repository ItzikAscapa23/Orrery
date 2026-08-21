import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { findFeatureById } from '../lib/features.js';
import { readArtifact } from '../lib/artifacts.js';
import { getPrisma } from '../lib/prisma.js';
import { FILE_TO_KIND } from '@orrery/shared';

// Derived from the single source of truth in @orrery/shared — adding a kind
// there automatically makes it valid here too.
const KIND_TO_FILE: Record<string, string> = Object.fromEntries(
  Object.entries(FILE_TO_KIND).map(([file, kind]) => [kind, file]),
);

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureArtifactsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string; kind: string } }>(
    '/features/:id/artifacts/:kind',
    async (request, reply) => {
      const { id, kind } = request.params;

      const filename = KIND_TO_FILE[kind];
      if (!filename) {
        return reply.status(400).send({
          error: `Unknown artifact kind '${kind}'. Valid values: ${Object.keys(KIND_TO_FILE).join(', ')}`,
        });
      }

      const feature = await findFeatureById(id);
      if (!feature) {
        return reply.status(404).send({ error: 'Feature not found' });
      }

      const { slug } = feature;
      const filePath = `features/${slug}/${filename}`;

      // Find the most recent artifact.committed event for this exact file path.
      // This is the pinned revision — the content the gate was opened against.
      const committedEvent = await getPrisma().event.findFirst({
        where: {
          featureId: id,
          type: 'artifact.committed',
          payload: { path: ['path'], equals: filePath },
        },
        orderBy: { seq: 'desc' },
      });

      const repoPath = process.env['ARTIFACTS_REPO_PATH'];

      if (committedEvent) {
        const sha = (committedEvent.payload as { commit: string }).commit;

        if (!repoPath) {
          return reply
            .status(404)
            .send({ error: 'ARTIFACTS_REPO_PATH is not configured on this server' });
        }

        try {
          const content = execFileSync('git', ['-C', repoPath, 'show', `${sha}:${filePath}`], {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return reply.send({ content, sha, filename });
        } catch {
          return reply
            .status(404)
            .send({ error: `Artifact revision ${sha} not found in git history` });
        }
      }

      // Fallback: no artifact.committed event — serve working-tree file.
      const content = readArtifact(slug, filename);
      if (content === null) {
        return reply.status(404).send({ error: `Artifact '${kind}' not found for this feature` });
      }
      return reply.send({ content, sha: null, filename });
    },
  );
}
