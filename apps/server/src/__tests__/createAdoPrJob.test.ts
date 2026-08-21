import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/repo-manifest.yaml',
);

// vi.hoisted ensures the mock fn is available when the factory runs (hoisted to top).
const { mockCreateAdoPullRequest } = vi.hoisted(() => ({
  mockCreateAdoPullRequest: vi.fn(),
}));

// parseAdoRepoUrl is called per-repo; extract repoId from URL so each call resolves correctly.
vi.mock('../lib/ado.js', () => ({
  createAdoPullRequest: mockCreateAdoPullRequest,
  parseAdoRepoUrl: (url: string) => {
    const m = url.match(/_git\/([^/]+)$/);
    return {
      orgUrl: 'https://dev.azure.com/myorg',
      project: 'my-project',
      repoId: m ? m[1] : 'demo-server',
    };
  },
}));

// Mock artifacts — return minimal content so the PR body builds.
vi.mock('../lib/artifacts.js', () => ({
  readArtifact: vi.fn().mockReturnValue('# spec content'),
  commitArtifact: vi.fn(),
  commitSpecDraft: vi.fn(),
  ArtifactCommitError: class ArtifactCommitError extends Error {},
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { appendEvent } from '../lib/events.js';
import { runCreateAdoPrJob, buildPrBody } from '../jobs/createAdoPrJob.js';

let featureId: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  vi.clearAllMocks();

  const feature = await createFeature({ name: 'ADO Test Feature', requirement: 'req' });
  featureId = feature.id;
  await getPrisma().feature.update({
    where: { id: featureId },
    data: {
      status: 'CODE_REVIEW',
      // Seed the currentBranches map — mirrors what devJob writes after a successful push.
      currentBranches: { 'demo-server': 'feature/ado-test-feature' },
    },
  });

  await getPrisma().task.create({
    data: {
      featureId,
      repo: 'demo-server',
      side: 'server',
      title: 'Add endpoint',
      description: 'desc',
      specRefs: [],
      dependsOn: [],
      status: 'completed',
      commitSha: 'abc1234567890',
    },
  });
});

afterEach(async () => {
  await disconnectPrisma();
});

describe('runCreateAdoPrJob', () => {
  it('creates a PR and emits pr.created + leaves feature in CODE_REVIEW when AZURE_DEVOPS_PAT is set', async () => {
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';
    mockCreateAdoPullRequest.mockResolvedValueOnce({
      prId: 42,
      prUrl: 'https://dev.azure.com/myorg/my-project/_git/demo-server/pullrequest/42',
    });

    const result = await runCreateAdoPrJob(featureId, 'job-1', { manifestPath: FIXTURE_PATH });

    expect(result).toBe('completed');

    const prEvents = await getPrisma().event.findMany({
      where: { featureId, type: 'pr.created' },
    });
    expect(prEvents).toHaveLength(1);
    const payload = prEvents[0]!.payload as Record<string, unknown>;
    expect(payload['pr_id']).toBe(42);
    expect(payload['repo']).toBe('demo-server');

    // PR job does not advance state — the review agent job runs next in agentWorker.
    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('CODE_REVIEW');

    delete process.env['AZURE_DEVOPS_PAT'];
  });

  it('parks immediately with agent.log when AZURE_DEVOPS_PAT is missing', async () => {
    delete process.env['AZURE_DEVOPS_PAT'];

    const result = await runCreateAdoPrJob(featureId, 'job-2', { manifestPath: FIXTURE_PATH });

    expect(result).toBe('parked');
    expect(mockCreateAdoPullRequest).not.toHaveBeenCalled();

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('FAILED');

    const logs = await getPrisma().event.findMany({
      where: { featureId, type: 'agent.log' },
    });
    expect(logs.some((l) => JSON.stringify(l.payload).includes('AZURE_DEVOPS_PAT'))).toBe(true);
  });

  it('parks on ADO API failure and sets FAILED', async () => {
    process.env['AZURE_DEVOPS_PAT'] = 'bad-pat';
    mockCreateAdoPullRequest.mockRejectedValueOnce(new Error('HTTP 401 — Unauthorized'));

    const result = await runCreateAdoPrJob(featureId, 'job-3', { manifestPath: FIXTURE_PATH });

    expect(result).toBe('parked');

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('FAILED');

    const prEvents = await getPrisma().event.findMany({
      where: { featureId, type: 'pr.created' },
    });
    expect(prEvents).toHaveLength(0);

    delete process.env['AZURE_DEVOPS_PAT'];
  });

  it('three-repo currentBranches map → three PR payloads with matching repo/source/target', async () => {
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';

    // Seed a 3-repo currentBranches map (server + server-2 + client).
    await getPrisma().feature.update({
      where: { id: featureId },
      data: {
        currentBranches: {
          'demo-server': 'feature/service-status',
          'demo-server-2': 'feature/service-status',
          'demo-client': 'feature/service-status',
        },
      },
    });
    // Seed tasks for all three repos so PR bodies are non-empty.
    await getPrisma().task.createMany({
      data: [
        {
          featureId,
          repo: 'demo-server-2',
          side: 'server',
          title: 'Server-2 endpoint',
          description: 'desc',
          specRefs: [],
          dependsOn: [],
          status: 'completed',
          commitSha: 'bbb1234567890',
        },
        {
          featureId,
          repo: 'demo-client',
          side: 'client',
          title: 'Client screen',
          description: 'desc',
          specRefs: [],
          dependsOn: [],
          status: 'completed',
          commitSha: 'ccc1234567890',
        },
      ],
    });

    mockCreateAdoPullRequest
      .mockResolvedValueOnce({ prId: 10, prUrl: 'https://ado/pr/10' })
      .mockResolvedValueOnce({ prId: 11, prUrl: 'https://ado/pr/11' })
      .mockResolvedValueOnce({ prId: 12, prUrl: 'https://ado/pr/12' });

    const result = await runCreateAdoPrJob(featureId, 'job-4', { manifestPath: FIXTURE_PATH });
    expect(result).toBe('completed');

    // Exactly three PRs created.
    const prEvents = await getPrisma().event.findMany({
      where: { featureId, type: 'pr.created' },
    });
    expect(prEvents).toHaveLength(3);

    const repos = prEvents.map((e) => (e.payload as Record<string, unknown>)['repo']);
    expect(repos).toContain('demo-server');
    expect(repos).toContain('demo-server-2');
    expect(repos).toContain('demo-client');

    // Each ADO call used the branch from currentBranches, not feature.slug.
    const calls = mockCreateAdoPullRequest.mock.calls as [
      { sourceBranch: string; targetBranch: string; repoId: string },
    ][];
    for (const [args] of calls) {
      expect(args.sourceBranch).toBe('refs/heads/feature/service-status');
      expect(args.targetBranch).toBe('refs/heads/main');
    }

    delete process.env['AZURE_DEVOPS_PAT'];
  });

  it('parks with agent.log when currentBranches is empty', async () => {
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { currentBranches: {} },
    });

    const result = await runCreateAdoPrJob(featureId, 'job-5', { manifestPath: FIXTURE_PATH });
    expect(result).toBe('parked');
    expect(mockCreateAdoPullRequest).not.toHaveBeenCalled();

    const logs = await getPrisma().event.findMany({ where: { featureId, type: 'agent.log' } });
    expect(logs.some((l) => JSON.stringify(l.payload).includes('currentBranches'))).toBe(true);

    delete process.env['AZURE_DEVOPS_PAT'];
  });

  it('skips repo that already has a pr.created event — no duplicate creation on retry', async () => {
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';

    // Simulate a prior partial run: demo-server PR was already created.
    await appendEvent(getPrisma(), featureId, {
      type: 'pr.created',
      repo: 'demo-server',
      pr_id: 42,
      pr_url: 'https://dev.azure.com/myorg/my-project/_git/demo-server/pullrequest/42',
      title: 'feat: existing PR',
    });

    // Job runs again (retry) with the same currentBranches.
    const result = await runCreateAdoPrJob(featureId, 'job-6', { manifestPath: FIXTURE_PATH });
    expect(result).toBe('completed');

    // createAdoPullRequest must NOT be called for the already-created repo.
    expect(mockCreateAdoPullRequest).not.toHaveBeenCalled();

    // Exactly one pr.created event — the pre-existing one, not a new duplicate.
    const prEvents = await getPrisma().event.findMany({
      where: { featureId, type: 'pr.created' },
    });
    expect(prEvents).toHaveLength(1);
    const payload = prEvents[0]!.payload as Record<string, unknown>;
    expect(payload['pr_id']).toBe(42);

    delete process.env['AZURE_DEVOPS_PAT'];
  });
});

// ── buildPrBody ───────────────────────────────────────────────────────────────

describe('buildPrBody', () => {
  it('oversized spec lands under 4000 chars and retains title + task list + spec link', () => {
    const body = buildPrBody(
      'my-slug',
      'My Feature',
      [{ title: 'Add endpoint', commitSha: 'abc1234567890' }],
      'x'.repeat(5000),
    );
    expect(body.length).toBeLessThanOrEqual(4000);
    expect(body).toContain('My Feature');
    expect(body).toContain('Add endpoint');
    expect(body).toContain('features/my-slug/spec.md');
  });

  it('small spec is included in full without truncation', () => {
    const body = buildPrBody(
      'tiny-slug',
      'Tiny Feature',
      [{ title: 'Do thing', commitSha: null }],
      '# Overview\n\nShort spec.',
    );
    expect(body.length).toBeLessThanOrEqual(4000);
    expect(body).toContain('Short spec');
    expect(body).not.toContain('truncated');
  });

  it('null spec omits spec overview section', () => {
    const body = buildPrBody('s', 'F', [{ title: 'T', commitSha: null }], null);
    expect(body).not.toContain('Spec overview');
    expect(body).toContain('features/s/spec.md');
  });

  it('task checkboxes use [x] and include 7-char commit sha', () => {
    const body = buildPrBody('s', 'F', [{ title: 'My task', commitSha: 'deadbeef1234' }], null);
    expect(body).toContain('[x] My task (deadbee)');
  });
});
