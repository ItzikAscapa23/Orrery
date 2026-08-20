import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These must be set before ANY server module evaluates env.ts (which parses
// process.env at module-load time). vi.hoisted runs before imports.
const { mockExecFileSync, mockReadArtifact } = vi.hoisted(() => {
  process.env['ANTHROPIC_API_KEY'] = 'test-key';
  process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';
  return {
    mockExecFileSync: vi.fn(),
    mockReadArtifact: vi.fn(),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, execFileSync: mockExecFileSync };
});

vi.mock('../lib/artifacts.js', () => ({
  readArtifact: mockReadArtifact,
  commitArtifact: vi.fn(),
  commitSpecDraft: vi.fn(),
  ArtifactCommitError: class ArtifactCommitError extends Error {},
}));

import { createApp } from '../app.js';
import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { appendEvent } from '../lib/events.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let featureId: string;
let featureSlug: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  vi.clearAllMocks();

  const feature = await createFeature({ name: 'Artifact Test Feature', requirement: 'req' });
  featureId = feature.id;
  featureSlug = feature.slug;
  app = await createApp();
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

async function inject(path: string) {
  return app.inject({ method: 'GET', url: path });
}

describe('GET /features/:id/artifacts/:kind', () => {
  it('returns 400 for unknown kind', async () => {
    const res = await inject(`/features/${featureId}/artifacts/unknown`);
    expect(res.statusCode).toBe(400);
    const parsed400 = res.json<{ error: string }>();
    expect(parsed400.error).toContain('Unknown artifact kind');
  });

  it('returns 404 when feature does not exist', async () => {
    const res = await inject('/features/00000000-0000-0000-0000-000000000000/artifacts/spec');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Feature not found' });
  });

  it('serves content at pinned SHA when artifact.committed event exists', async () => {
    // Seed an artifact.committed event so the route has a SHA to resolve.
    await appendEvent(getPrisma(), featureId, {
      type: 'artifact.committed',
      path: `features/${featureSlug}/spec.md`,
      commit: 'abc1234',
      message: `spec: ${featureSlug} v1`,
    });

    mockExecFileSync.mockReturnValue('# Spec at abc1234\n\nContent.');

    const res = await inject(`/features/${featureId}/artifacts/spec`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { content: string; sha: string; filename: string };
    expect(body.sha).toBe('abc1234');
    expect(body.filename).toBe('spec.md');
    expect(body.content).toContain('Content.');

    // Verify the correct git show invocation was made.
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/tmp/test-artifacts', 'show', `abc1234:features/${featureSlug}/spec.md`],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('uses the LATEST artifact.committed SHA when multiple revisions exist', async () => {
    // Two revisions of spec.md — the endpoint must serve the second (newest).
    await appendEvent(getPrisma(), featureId, {
      type: 'artifact.committed',
      path: `features/${featureSlug}/spec.md`,
      commit: 'old1111',
      message: `spec: ${featureSlug} v1`,
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'artifact.committed',
      path: `features/${featureSlug}/spec.md`,
      commit: 'new2222',
      message: `spec: ${featureSlug} v2`,
    });

    mockExecFileSync.mockReturnValue('# New revision');

    const res = await inject(`/features/${featureId}/artifacts/spec`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { sha: string };
    expect(body.sha).toBe('new2222');

    // execFileSync called with the newer SHA, not the old one.
    const call = mockExecFileSync.mock.calls[0] as unknown[];
    expect((call[1] as string[]).find((a) => a.startsWith('new2222'))).toBeTruthy();
    expect((call[1] as string[]).find((a) => a.startsWith('old1111'))).toBeUndefined();
  });

  it('returns 404 when git show fails (SHA not in history)', async () => {
    await appendEvent(getPrisma(), featureId, {
      type: 'artifact.committed',
      path: `features/${featureSlug}/spec.md`,
      commit: 'deadbeef',
      message: `spec: ${featureSlug} v1`,
    });

    mockExecFileSync.mockImplementation(() => {
      throw new Error('fatal: Path not found in revision');
    });

    const res = await inject(`/features/${featureId}/artifacts/spec`);
    expect(res.statusCode).toBe(404);
    const parsed404sha = res.json<{ error: string }>();
    expect(parsed404sha.error).toContain('deadbeef');
  });

  it('falls back to readArtifact (working tree) when no artifact.committed event exists', async () => {
    mockReadArtifact.mockReturnValue('# Working tree spec');

    const res = await inject(`/features/${featureId}/artifacts/spec`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { content: string; sha: null };
    expect(body.sha).toBeNull();
    expect(body.content).toBe('# Working tree spec');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns 404 fallback when no event and readArtifact returns null', async () => {
    mockReadArtifact.mockReturnValue(null);

    const res = await inject(`/features/${featureId}/artifacts/spec`);
    expect(res.statusCode).toBe(404);
    const parsed404fb = res.json<{ error: string }>();
    expect(parsed404fb.error).toContain("'spec'");
  });

  it('serves contract.yaml with correct filename', async () => {
    mockReadArtifact.mockReturnValue('openapi: "3.0.0"\npaths: {}');

    const res = await inject(`/features/${featureId}/artifacts/contract`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { filename: string };
    expect(body.filename).toBe('contract.yaml');
  });

  it('serves plan.md with correct filename', async () => {
    mockReadArtifact.mockReturnValue('# Plan\n\n- task 1');

    const res = await inject(`/features/${featureId}/artifacts/plan`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { filename: string };
    expect(body.filename).toBe('plan.md');
  });

  it('serves test-plan.md with correct filename', async () => {
    mockReadArtifact.mockReturnValue('# Test Plan\n\n- task 1: covered');

    const res = await inject(`/features/${featureId}/artifacts/test-plan`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { filename: string };
    expect(body.filename).toBe('test-plan.md');
  });

  it('unknown kind error message lists test-plan in valid values', async () => {
    const res = await inject(`/features/${featureId}/artifacts/unknown`);
    expect(res.statusCode).toBe(400);
    const parsed = res.json<{ error: string }>();
    expect(parsed.error).toContain('test-plan');
  });
});
