import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { findFeatureById } from '../lib/features.js';
import { commitArtifact, readArtifact, listArtifacts } from '../lib/artifacts.js';

const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.yml', '.yaml']);
const RESERVED_NAMES = new Set(['spec.md', 'contract.yaml', 'plan.md']);
const MAX_BYTES = 1_048_576;

function validateFilename(name: string): string | null {
  if (name.includes('/') || name.includes('\\')) return 'Filename must not contain path separators';
  if (name.includes('..')) return 'Filename must not contain ".."';
  if (name.startsWith('.')) return 'Filename must not start with "."';
  if (RESERVED_NAMES.has(name)) return `"${name}" is a reserved artifact name`;
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';
  if (!ALLOWED_EXTENSIONS.has(ext)) return 'Only .txt, .md, .yml, .yaml files are accepted';
  return null;
}

function parseFrontMatter(raw: string): { kind: string; sha: string | null; body: string } {
  if (!raw.startsWith('---\n')) return { kind: 'unknown', sha: null, body: raw };
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return { kind: 'unknown', sha: null, body: raw };
  const header = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const kindMatch = /^kind:\s*(.+)$/m.exec(header);
  const shaMatch = /^sha:\s*(.+)$/m.exec(header);
  return {
    kind: kindMatch?.[1]?.trim() ?? 'unknown',
    sha: shaMatch?.[1]?.trim() ?? null,
    body,
  };
}

export async function featureAttachmentsRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, { attachFieldsToBody: false });

  app.post<{ Params: { id: string } }>('/features/:id/attachments', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }

    if (feature.status !== 'DRAFTING_SPEC' && feature.status !== 'AWAITING_APPROVAL') {
      return reply.status(409).send({
        error:
          'Attachments can only be added when the feature is in DRAFTING_SPEC or AWAITING_APPROVAL',
      });
    }

    let kind: string | undefined;
    let uploadedFilename: string | undefined;
    let uploadedBuffer: Buffer | undefined;

    for await (const part of request.parts()) {
      if (part.type === 'field' && part.fieldname === 'kind') {
        kind = part.value as string;
      } else if (part.type === 'file') {
        if (uploadedFilename === undefined) {
          uploadedBuffer = await part.toBuffer();
          uploadedFilename = part.filename ?? '';
        } else {
          // Drain extra file parts to avoid busboy backpressure deadlock
          await part.toBuffer();
        }
      }
    }

    if (kind !== 'reference' && kind !== 'input') {
      return reply.status(400).send({ error: 'Field "kind" must be "reference" or "input"' });
    }

    if (!uploadedFilename || uploadedBuffer === undefined) {
      return reply.status(400).send({ error: 'A file part is required' });
    }

    const filenameError = validateFilename(uploadedFilename);
    if (filenameError) {
      return reply.status(400).send({ error: filenameError });
    }

    if (uploadedBuffer.byteLength > MAX_BYTES) {
      return reply.status(413).send({ error: 'File must not exceed 1 MB' });
    }

    let rawContent: string;
    try {
      rawContent = new TextDecoder('utf-8', { fatal: true }).decode(uploadedBuffer);
    } catch {
      return reply.status(400).send({ error: 'File must be valid UTF-8 text' });
    }

    const storedName = `attachment-${uploadedFilename}`;
    // Front-matter embeds kind; sha is filled in after commit and re-committed.
    const result = commitArtifact(
      feature.slug,
      storedName,
      `---\nkind: ${kind}\nsha: tbd\n---\n${rawContent}`,
      'attach',
    );
    // Second write embeds the real commit sha so GET /attachments can return it.
    const withSha = commitArtifact(
      feature.slug,
      storedName,
      `---\nkind: ${kind}\nsha: ${result.commit}\n---\n${rawContent}`,
      'attach',
    );

    return reply
      .status(201)
      .send({ filename: storedName, commit: withSha.commit, path: withSha.path });
  });

  app.get<{ Params: { id: string } }>('/features/:id/attachments', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }

    const names = listArtifacts(feature.slug, 'attachment-');
    const items = names.map((name) => {
      const raw = readArtifact(feature.slug, name) ?? '';
      const { kind, sha, body } = parseFrontMatter(raw);
      return {
        name,
        kind,
        size: Buffer.byteLength(body, 'utf-8'),
        sha,
      };
    });

    return reply.send(items);
  });
}
