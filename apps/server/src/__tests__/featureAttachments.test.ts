import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const { mockCommitArtifact } = vi.hoisted(() => {
  process.env['ANTHROPIC_API_KEY'] = 'test-key';
  process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';
  return {
    mockCommitArtifact: vi.fn().mockReturnValue({
      path: 'features/slug/attachment-foo.md',
      commit: 'abc1234',
      message: 'attach: ...',
    }),
  };
});

vi.mock('../lib/artifacts.js', () => ({
  commitArtifact: mockCommitArtifact,
  readArtifact: vi.fn(),
  listArtifacts: vi.fn().mockReturnValue([]),
  commitSpecDraft: vi.fn(),
  ArtifactCommitError: class ArtifactCommitError extends Error {},
}));

vi.mock('../lib/queue.js', () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
  getQueue: vi.fn(),
  closeQueue: vi.fn(),
}));

import { createApp } from '../app.js';
import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let featureId: string;
let featureSlug: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  vi.clearAllMocks();
  mockCommitArtifact.mockReturnValue({
    path: 'features/slug/attachment-foo.md',
    commit: 'abc1234',
    message: 'attach: slug attachment-foo.md',
  });

  const feature = await createFeature({ name: 'Attach Test Feature', requirement: 'req' });
  featureId = feature.id;
  featureSlug = feature.slug;
  app = await createApp();
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

async function post(id: string, form: FormData) {
  return app.inject({ method: 'POST', url: `/features/${id}/attachments`, payload: form });
}

async function get(id: string) {
  return app.inject({ method: 'GET', url: `/features/${id}/attachments` });
}

describe('POST /features/:id/attachments', () => {
  it('rejects .png by extension', async () => {
    const form = new FormData();
    form.append('kind', 'reference');
    form.append('file', new File([Buffer.from('data')], 'img.png', { type: 'image/png' }));

    const res = await post(featureId, form);

    expect(res.statusCode).toBe(400);
    expect(mockCommitArtifact).not.toHaveBeenCalled();
  });

  it('rejects .exe by extension', async () => {
    const form = new FormData();
    form.append('kind', 'input');
    form.append(
      'file',
      new File([Buffer.from('data')], 'virus.exe', { type: 'application/octet-stream' }),
    );

    const res = await post(featureId, form);

    expect(res.statusCode).toBe(400);
    expect(mockCommitArtifact).not.toHaveBeenCalled();
  });

  it('accepts a valid .yml file', async () => {
    const content = 'key: value\nfoo: bar\n';
    const form = new FormData();
    form.append('kind', 'input');
    form.append('file', new File([Buffer.from(content)], 'notes.yml', { type: 'text/yaml' }));

    const res = await post(featureId, form);

    expect(res.statusCode).toBe(201);
    const body = res.json<{ filename: string; commit: string }>();
    expect(body.filename).toBe('attachment-notes.yml');
    expect(body.commit).toBe('abc1234');
    expect(mockCommitArtifact).toHaveBeenCalledWith(
      featureSlug,
      'attachment-notes.yml',
      expect.stringContaining('key: value'),
      'attach',
    );
  });

  it('rejects path traversal and never writes to disk', async () => {
    const form = new FormData();
    form.append('kind', 'reference');
    form.append(
      'file',
      new File([Buffer.from('evil')], '../../etc/passwd', { type: 'text/plain' }),
    );

    const res = await post(featureId, form);

    expect(res.statusCode).toBe(400);
    // commitArtifact not called → writeFileSync never ran; the validation
    // intercepted the path before any disk write could occur.
    expect(mockCommitArtifact).not.toHaveBeenCalled();
    // Belt-and-suspenders: the escape path must not exist on disk either.
    expect(fs.existsSync('/tmp/test-artifacts/features/../etc/passwd')).toBe(false);
  });

  it('rejects reserved filename spec.md', async () => {
    const form = new FormData();
    form.append('kind', 'reference');
    form.append('file', new File([Buffer.from('# spec')], 'spec.md', { type: 'text/markdown' }));

    const res = await post(featureId, form);

    expect(res.statusCode).toBe(400);
    expect(mockCommitArtifact).not.toHaveBeenCalled();
  });

  it('rejects file over 1 MB', async () => {
    const form = new FormData();
    form.append('kind', 'input');
    form.append(
      'file',
      new File([Buffer.from('a'.repeat(1_048_577))], 'big.md', { type: 'text/markdown' }),
    );

    const res = await post(featureId, form);

    expect(res.statusCode).toBe(413);
    expect(mockCommitArtifact).not.toHaveBeenCalled();
  });

  it('returns 409 when feature is in IMPLEMENTING state', async () => {
    // Advance the feature to IMPLEMENTING via direct DB update.
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'IMPLEMENTING' },
    });

    const form = new FormData();
    form.append('kind', 'input');
    form.append('file', new File([Buffer.from('hello')], 'notes.md', { type: 'text/markdown' }));

    const res = await post(featureId, form);

    expect(res.statusCode).toBe(409);
    expect(mockCommitArtifact).not.toHaveBeenCalled();
  });

  it('returns 400 when kind field is omitted', async () => {
    const form = new FormData();
    form.append('file', new File([Buffer.from('hello')], 'notes.md', { type: 'text/markdown' }));

    const res = await post(featureId, form);

    expect(res.statusCode).toBe(400);
    expect(mockCommitArtifact).not.toHaveBeenCalled();
  });
});

describe('GET /features/:id/attachments', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await get('00000000-0000-0000-0000-000000000000');
    expect(res.statusCode).toBe(404);
  });

  it('returns empty array when no attachments committed', async () => {
    const res = await get(featureId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
