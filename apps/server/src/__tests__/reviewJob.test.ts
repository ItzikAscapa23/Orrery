import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';
process.env['WORKTREES_ROOT'] = '/tmp/test-worktrees';

const { mockRunReviewAgent, mockExecFileSync, mockReadArtifact, mockCheckBedrock } = vi.hoisted(
  () => ({
    mockRunReviewAgent: vi.fn(),
    mockExecFileSync: vi.fn().mockReturnValue('diff --git a/index.ts b/index.ts\n'),
    mockReadArtifact: vi.fn().mockReturnValue('# Spec\n\nFeature spec.'),
    mockCheckBedrock: vi.fn().mockResolvedValue(true),
  }),
);

vi.mock('../agents/reviewAgent.js', () => ({ runReviewAgent: mockRunReviewAgent }));
vi.mock('../lib/connectivity.js', () => ({
  checkBedrockConnectivity: mockCheckBedrock,
  checkBedrockWithRetry: mockCheckBedrock,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFileSync: mockExecFileSync };
});
vi.mock('../lib/artifacts.js', () => ({
  readArtifact: mockReadArtifact,
  commitSpecDraft: vi.fn(),
  commitArtifact: vi.fn(),
  ArtifactCommitError: class ArtifactCommitError extends Error {},
}));
vi.mock('../lib/queue.js', () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
  getQueue: vi.fn(),
  closeQueue: vi.fn(),
}));
// Mock getRepoEntry to return a manifest entry for the test repo
vi.mock('../jobs/devJob.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../jobs/devJob.js')>();
  return {
    ...original,
    getRepoEntry: vi.fn().mockReturnValue({
      id: 'demo-server',
      side: 'server',
      active: true,
      url: 'https://example.com/repo.git',
      default_branch: 'main',
    }),
  };
});

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import { createFeature } from '../lib/features.js';
import { appendEvent } from '../lib/events.js';
import { runReviewJob } from '../jobs/reviewJob.js';

let featureId: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  const feature = await createFeature({ name: 'Review Test', requirement: 'req' });
  featureId = feature.id;

  // Put feature in CODE_REVIEW with a currentBranches map
  await getPrisma().feature.update({
    where: { id: featureId },
    data: {
      status: 'CODE_REVIEW',
      currentBranches: { 'demo-server': 'feature/review-test' },
    },
  });

  vi.clearAllMocks();
  mockExecFileSync.mockReturnValue('diff --git a/index.ts b/index.ts\n+export function hello() {}');
  mockReadArtifact.mockReturnValue('# Spec\n\nFeature spec content.');
  mockRunReviewAgent.mockResolvedValue({ findings: [], priorFindingStatuses: [] });
  mockCheckBedrock.mockResolvedValue(true);
});

afterEach(async () => {
  await disconnectPrisma();
});

async function getEvents() {
  return getPrisma().event.findMany({ where: { featureId }, orderBy: { seq: 'asc' } });
}

describe('runReviewJob — no blockers (REVIEW_PASS)', () => {
  it('emits review.started, review.findings, phase.changed to TESTING', async () => {
    mockRunReviewAgent.mockResolvedValue({ findings: [], priorFindingStatuses: [] }); // no findings

    await runReviewJob(featureId);

    const events = await getEvents();
    const types = events.map((e) => e.type);

    expect(types).toContain('review.started');
    expect(types).toContain('review.findings');
    expect(types).toContain('phase.changed');

    const phaseEvents = events.filter((e) => e.type === 'phase.changed');
    const toStates = phaseEvents.map((e) => (e.payload as { to: string }).to);
    expect(toStates).toContain('TESTING');

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('TESTING');
  });
});

describe('runReviewJob — blockers, round 0 (REVIEW_FAIL + bounce-back)', () => {
  it('emits REVIEW_FAIL transition and orchestrator bounce-back log', async () => {
    mockRunReviewAgent.mockResolvedValue({
      findings: [
        {
          id: 'rf1',
          severity: 'blocker',
          section: 'POST /api',
          issue: 'Missing id field',
          repo: 'demo-server',
        },
      ],
      priorFindingStatuses: [],
    });

    await runReviewJob(featureId);

    const events = await getEvents();
    const types = events.map((e) => e.type);

    expect(types).toContain('review.findings');
    expect(types).toContain('phase.changed');

    const phaseToStates = events
      .filter((e) => e.type === 'phase.changed')
      .map((e) => (e.payload as { to: string }).to);
    expect(phaseToStates).toContain('IMPLEMENTING');

    const bounceback = events.find(
      (e) => e.type === 'agent.log' && (e.payload as { text: string }).text.includes('bounce-back'),
    );
    expect(bounceback).toBeDefined();

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('IMPLEMENTING');
  });
});

describe('runReviewJob — blockers, round 1 (human gate)', () => {
  it('emits gate.opened and agent.status(waiting) when priorReviewRounds >= 1', async () => {
    // Seed a prior review.findings event with agent='review' to simulate round 1
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'review.findings',
        agent: 'review',
        spec_rev: 0,
        findings: [],
      }),
    );

    mockRunReviewAgent.mockResolvedValue({
      findings: [
        {
          id: 'rf1',
          severity: 'blocker',
          section: 'POST /api',
          issue: 'Still missing',
          repo: 'demo-server',
        },
      ],
      priorFindingStatuses: [],
    });

    await runReviewJob(featureId);

    const events = await getEvents();
    const types = events.map((e) => e.type);

    expect(types).toContain('gate.opened');
    const gateEvent = events.find((e) => e.type === 'gate.opened');
    expect((gateEvent?.payload as { gate: string }).gate).toBe('code_review');

    const statusEvents = events
      .filter(
        (e) => e.type === 'agent.status' && (e.payload as { agent: string }).agent === 'review',
      )
      .map((e) => (e.payload as { status: string }).status);
    expect(statusEvents).toContain('waiting');

    // Machine must NOT have advanced
    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('CODE_REVIEW');
  });
});

describe('runReviewJob — fail-open (review.skipped scar)', () => {
  it('emits review.skipped and REVIEW_PASS when agent throws', async () => {
    mockRunReviewAgent.mockRejectedValue(new Error('Review agent parse failure after retry.'));

    await runReviewJob(featureId);

    const events = await getEvents();
    const types = events.map((e) => e.type);

    expect(types).toContain('review.skipped');
    expect(types).toContain('phase.changed');

    const skipped = events.find((e) => e.type === 'review.skipped');
    expect((skipped?.payload as { reason: string }).reason).toContain('parse failure');

    const phaseToStates = events
      .filter((e) => e.type === 'phase.changed')
      .map((e) => (e.payload as { to: string }).to);
    expect(phaseToStates).toContain('TESTING');

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('TESTING');
  });
});

describe('runReviewJob — empty currentBranches', () => {
  it('runs without error when no repos have branches (no diff available)', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { currentBranches: {} },
    });
    mockRunReviewAgent.mockResolvedValue({ findings: [], priorFindingStatuses: [] });

    await expect(runReviewJob(featureId)).resolves.not.toThrow();

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('TESTING');
  });
});

// ── T4: featureReviewGate routes ─────────────────────────────────────────────

describe('POST /features/:id/approve-review', () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/features/nonexistent/approve-review' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when feature is not in CODE_REVIEW', async () => {
    await getPrisma().feature.update({ where: { id: featureId }, data: { status: 'TESTING' } });
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/approve-review` });
    expect(res.statusCode).toBe(409);
  });

  it('returns 200 and advances to TESTING when no unresolved blockers', async () => {
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/approve-review` });
    expect(res.statusCode).toBe(200);
    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('TESTING');
  });

  it('returns 409 when unresolved blockers remain', async () => {
    // Seed a spec_approval gate so gateOpenedCount=1 → cycleRev=0.
    // code_review gates are excluded from the spec-cycle counter, so this
    // must be a spec_approval (or plan_approval) gate to advance the clock.
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'gate.opened',
        gate: 'spec_approval',
        summary: 'test gate',
        revision: 0,
      }),
    );
    await getPrisma().finding.create({
      data: {
        id: 'rf1',
        featureId,
        specRev: 0,
        severity: 'blocker',
        section: 'POST /api',
        issue: 'Missing field',
        resolution: null,
      },
    });
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/approve-review` });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /features/:id/retry-review', () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/features/nonexistent/retry-review' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when feature is not in CODE_REVIEW', async () => {
    await getPrisma().feature.update({ where: { id: featureId }, data: { status: 'TESTING' } });
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/retry-review` });
    expect(res.statusCode).toBe(409);
  });

  it('enqueues review job and returns 200', async () => {
    const { enqueueJob } = await import('../lib/queue.js');
    vi.mocked(enqueueJob).mockClear();

    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/retry-review` });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledWith(featureId, 'review', undefined);
  });
});

describe('runReviewJob — finding re-review: severity updated in DB on second round at same specRev', () => {
  it('DB reflects blocker when severity changes warning→blocker between two runs at same specRev', async () => {
    // Round 1: finding f1 is a warning
    mockRunReviewAgent.mockResolvedValueOnce({
      findings: [{ id: 'f1', severity: 'warning', section: 'GET /api', issue: 'Minor issue' }],
      priorFindingStatuses: [],
    });
    await runReviewJob(featureId);

    // Round 2: same specRev (no gate opened), finding f1 is now a blocker
    // Reset feature back to CODE_REVIEW so runReviewJob does not skip
    await getPrisma().feature.update({ where: { id: featureId }, data: { status: 'CODE_REVIEW' } });
    mockRunReviewAgent.mockResolvedValueOnce({
      findings: [{ id: 'f1', severity: 'blocker', section: 'GET /api', issue: 'Serious issue' }],
      priorFindingStatuses: [],
    });
    await runReviewJob(featureId);

    // The DB row must reflect the new severity — not the stale one from round 1
    const specRev = -1; // gateOpenedCount=0 → specRev = 0 - 1 = -1
    const row = await getPrisma().finding.findUnique({
      where: { featureId_specRev_id: { featureId, specRev, id: 'f1' } },
    });
    expect(row).not.toBeNull();
    expect(row?.severity).toBe('blocker');
    expect(row?.resolution).toBeNull();
  });
});

// ── Bedrock 403 / credential failure handling ─────────────────────────────────

describe('runReviewJob — pre-flight Bedrock unreachable → parks in CODE_REVIEW', () => {
  it('emits agent.status(failed) and does not fire phase.changed', async () => {
    mockCheckBedrock.mockResolvedValue(false);

    await runReviewJob(featureId);

    const events = await getEvents();

    // phase.changed from createFeature (DRAFTING_SPEC) must NOT be counted —
    // only transitions out of CODE_REVIEW matter here
    const codeReviewExits = events.filter(
      (e) => e.type === 'phase.changed' && (e.payload as { from: string }).from === 'CODE_REVIEW',
    );
    expect(codeReviewExits).toHaveLength(0);

    const failed = events.filter(
      (e) =>
        e.type === 'agent.status' &&
        (e.payload as { status: string }).status === 'failed' &&
        (e.payload as { agent: string }).agent === 'review',
    );
    expect(failed.length).toBeGreaterThan(0);

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('CODE_REVIEW');
  });
});

describe('runReviewJob — Bedrock 403 in catch → parks in CODE_REVIEW', () => {
  it('stays in CODE_REVIEW and emits no phase.changed or review.skipped', async () => {
    mockRunReviewAgent.mockRejectedValue(
      new Error(
        'Request failed with status code 403: security token included in the request is expired',
      ),
    );

    await runReviewJob(featureId);

    const events = await getEvents();

    const codeReviewExits = events.filter(
      (e) => e.type === 'phase.changed' && (e.payload as { from: string }).from === 'CODE_REVIEW',
    );
    expect(codeReviewExits).toHaveLength(0);

    const reviewSkippedEvents = events.filter((e) => e.type === 'review.skipped');
    expect(reviewSkippedEvents).toHaveLength(0);

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('CODE_REVIEW');
  });
});

describe('runReviewJob — non-credential error → review.skipped sets reviewSkipped=true', () => {
  it('fires REVIEW_PASS (fail-open), emits review.skipped, and sets feature.reviewSkipped = true', async () => {
    mockRunReviewAgent.mockRejectedValue(new Error('Review agent parse failure after retry.'));

    await runReviewJob(featureId);

    const events = await getEvents();
    const types = events.map((e) => e.type);

    expect(types).toContain('review.skipped');
    expect(types).toContain('phase.changed');

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.reviewSkipped).toBe(true);
  });
});
