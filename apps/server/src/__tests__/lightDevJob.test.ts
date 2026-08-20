/**
 * Integration tests for lightDevJob push behaviour (spec 14b).
 *
 * Separate from lightPath.test.ts to isolate the file-level
 * vi.mock('node:child_process') from the pure-unit probeSyntax tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_PROVIDER'] = 'anthropic';
process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';
process.env['WORKTREES_ROOT'] = '/tmp/orrery-worktrees';

// ── node:child_process mock ───────────────────────────────────────────────────

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      if (Array.isArray(args)) {
        if (args.includes('status') && args.includes('--porcelain')) return 'M src/config.yaml';
        if (args.includes('status')) return 'M src/config.yaml';
        if (args.includes('fetch')) return '';
        if (args.includes('show')) return '# CLAUDE.md';
        if (args.includes('rev-parse')) return 'deadbeef1234abcd';
        if (args.includes('commit')) return '';
        if (args.includes('add')) return '';
        if (args.includes('push')) return '';
        if (args.includes('diff') && args.includes('--cached') && args.includes('--name-only'))
          return 'src/config.yaml';
        if (args.includes('diff')) return '';
      }
      return '';
    }),
    execSync: vi.fn().mockReturnValue(''),
  };
});

// ── Other module mocks ────────────────────────────────────────────────────────

vi.mock('../lib/worktree.js', () => ({
  createWorktree: vi.fn().mockReturnValue({
    worktreePath: '/tmp/orrery-worktrees/light-test',
    branch: 'feat/light-push-test',
  }),
  removeWorktree: vi.fn(),
}));

vi.mock('../agents/devAgent.js', () => ({
  runLightDevAgent: vi.fn().mockResolvedValue(undefined),
  runDevAgent: vi.fn(),
  AgentNoopError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'AgentNoopError';
    }
  },
  AgentOutcome: {},
  ViolationInfo: class {},
  ToolCallInfo: class {},
  measurePromptSections: vi.fn(),
}));

vi.mock('../lib/connectivity.js', () => ({
  checkBedrockConnectivity: vi.fn().mockResolvedValue(true),
}));

vi.mock('../lib/dispatch.js', () => ({
  dispatchForState: vi.fn().mockResolvedValue(undefined),
  dispatchUnblockedTasks: vi.fn().mockResolvedValue(undefined),
  dispatchJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/repoOrientation.js', () => ({
  generateRepoOrientation: vi.fn().mockReturnValue('## Orientation\n'),
}));

// existsSync → false so the syntax-probe loop skips all staged files
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn().mockImplementation((p: string, opts?: unknown) => {
      if (typeof p === 'string' && p.includes('repo-manifest')) return '# mocked manifest';
      return actual.readFileSync(p, opts as Parameters<typeof actual.readFileSync>[1]);
    }),
    existsSync: vi.fn().mockReturnValue(false),
  };
});

const mockYamlLoad = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    repos: [
      {
        id: 'swaggers',
        side: 'server',
        active: true,
        path: 'light',
        url: 'https://example.com/swaggers.git',
        default_branch: 'main',
        description: 'Swagger YMLs',
      },
    ],
  }),
);

vi.mock('js-yaml', () => ({
  default: { load: mockYamlLoad },
  load: mockYamlLoad,
}));

// ── Imports (must follow all vi.mock calls) ───────────────────────────────────

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { runLightDevJob } from '../jobs/lightDevJob.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const REPO_ID = 'swaggers';
const BRANCH = 'feat/light-push-test';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createLightFeature(): Promise<string> {
  const f = await createFeature({
    name: 'Push integration test',
    requirement: 'Update swagger definitions',
    repos: [REPO_ID],
    featurePath: 'LIGHT',
  });
  await getPrisma().feature.update({
    where: { id: f.id },
    data: {
      status: 'LIGHT_IMPLEMENTING',
      proposedSpec: '# Add GET /users\nAdd a new endpoint.',
    },
  });
  return f.id;
}

function happyPathExecMock(_cmd: string, args: readonly string[] | undefined): string {
  if (Array.isArray(args)) {
    if (args.includes('status') && args.includes('--porcelain')) return 'M src/config.yaml';
    if (args.includes('status')) return 'M src/config.yaml';
    if (args.includes('fetch')) return '';
    if (args.includes('show')) return '# CLAUDE.md';
    if (args.includes('rev-parse')) return 'deadbeef1234abcd';
    if (args.includes('commit')) return '';
    if (args.includes('add')) return '';
    if (args.includes('push')) return '';
    if (args.includes('diff') && args.includes('--cached') && args.includes('--name-only'))
      return 'src/config.yaml';
    if (args.includes('diff')) return '';
  }
  return '';
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

afterEach(async () => {
  await disconnectPrisma();
});

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;

  const { execFileSync } = await import('node:child_process');
  vi.mocked(execFileSync).mockImplementation(happyPathExecMock);

  const { dispatchForState } = await import('../lib/dispatch.js');
  vi.mocked(dispatchForState).mockClear();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('lightDevJob — branch push', () => {
  it('calls git push after committing', async () => {
    const { execFileSync } = await import('node:child_process');
    const featureId = await createLightFeature();

    await runLightDevJob(featureId, REPO_ID, 'job-push-1');

    const pushCall = vi
      .mocked(execFileSync)
      .mock.calls.find(
        ([_cmd, args]) => Array.isArray(args) && (args as string[]).includes('push'),
      );
    expect(pushCall).toBeDefined();
    expect(pushCall![1]).toEqual(
      expect.arrayContaining(['-C', expect.any(String), 'push', 'origin', BRANCH]),
    );
  });

  it('emits an agent.log event confirming the push', async () => {
    const featureId = await createLightFeature();

    await runLightDevJob(featureId, REPO_ID, 'job-push-2');

    const events = await getPrisma().event.findMany({ where: { featureId } });
    const pushLog = events.find((e) => {
      const p = e.payload as Record<string, unknown>;
      return (
        p['type'] === 'agent.log' &&
        p['agent'] === 'orchestrator' &&
        p['severity'] === 'ok' &&
        typeof p['text'] === 'string' &&
        (p['text'] as string).includes(`✓ branch ${BRANCH} pushed to ${REPO_ID}`)
      );
    });
    expect(pushLog).toBeDefined();
  });

  it('does not advance to review when push fails', async () => {
    const { execFileSync } = await import('node:child_process');
    const { dispatchForState } = await import('../lib/dispatch.js');
    const featureId = await createLightFeature();

    vi.mocked(execFileSync).mockImplementation(
      (_cmd: string, args: readonly string[] | undefined) => {
        if (Array.isArray(args) && args.includes('push'))
          throw new Error('fatal: unable to access remote: Connection refused');
        return happyPathExecMock(_cmd, args);
      },
    );

    await expect(runLightDevJob(featureId, REPO_ID, 'job-push-3')).rejects.toThrow(
      'unable to access remote',
    );

    expect(vi.mocked(dispatchForState)).not.toHaveBeenCalled();

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('LIGHT_IMPLEMENTING');

    const events = await getPrisma().event.findMany({ where: { featureId } });
    const completedEvent = events.find(
      (e) => (e.payload as Record<string, unknown>)['type'] === 'light_dev.completed',
    );
    expect(completedEvent).toBeUndefined();
  });
});

describe('lightDevJob — CLAUDE.md fetch failure logging', () => {
  it('emits a muted agent.log when CLAUDE.md cannot be read from the default branch', async () => {
    const { execFileSync } = await import('node:child_process');
    const featureId = await createLightFeature();

    // Override 'show' to throw so CLAUDE.md read fails; all other git ops pass through.
    vi.mocked(execFileSync).mockImplementation(
      (_cmd: string, args: readonly string[] | undefined) => {
        if (Array.isArray(args) && args.includes('show'))
          throw new Error('fatal: path CLAUDE.md does not exist in origin/main');
        return happyPathExecMock(_cmd, args);
      },
    );

    await runLightDevJob(featureId, REPO_ID, 'job-claudemd-fail');

    const events = await getPrisma().event.findMany({ where: { featureId } });
    const muteLog = events.find(
      (e) =>
        e.type === 'agent.log' &&
        (e.payload as { severity?: string }).severity === 'muted' &&
        (e.payload as { text?: string }).text?.includes('main'),
    );
    expect(muteLog).toBeDefined();
  });
});
