import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_PROVIDER'] = 'anthropic';
process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const {
  mockRunTestAgent,
  mockReadArtifact,
  mockCommitArtifact,
  mockFsExistsSync,
  mockFsReadFileSync,
  mockFsUnlinkSync,
  mockCheckBedrock,
  mockGetRepoEntry,
  mockContainerExecHoisted,
  mockContainerStopHoisted,
  mockCreateWorktree,
} = vi.hoisted(() => ({
  mockRunTestAgent: vi.fn().mockResolvedValue(undefined),
  mockReadArtifact: vi
    .fn()
    .mockImplementation((_slug: string, filename: string) =>
      filename === 'test-harness-brief.md' ? null : '# Spec',
    ),
  mockCommitArtifact: vi
    .fn()
    .mockReturnValue({ path: 'f/test-harness-brief.md', commit: 'abc', message: 'm' }),
  // fs stubs: intercepted only for paths under the mock worktree (/tmp/test-wt)
  mockFsExistsSync: vi.fn().mockReturnValue(false),
  mockFsReadFileSync: vi.fn().mockReturnValue(''),
  mockFsUnlinkSync: vi.fn(),
  mockCheckBedrock: vi.fn().mockResolvedValue(true),
  mockGetRepoEntry: vi.fn().mockReturnValue({
    id: 'demo-server',
    url: 'https://git.example.com/demo-server',
    default_branch: 'main',
    side: 'server',
    description: 'Demo server',
    install_timeout_ms: 10_000,
    exec_timeout_ms: 10_000,
  }),
  mockContainerExecHoisted: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }),
  mockContainerStopHoisted: vi.fn().mockResolvedValue(undefined),
  mockCreateWorktree: vi.fn().mockReturnValue({
    repoId: 'demo-server',
    bareRepoPath: '/tmp/test-wt.git',
    worktreePath: '/tmp/test-wt',
    branch: 'feature/task-test-job',
  }),
}));

vi.mock('../agents/testAgent.js', () => ({
  runTestAgent: mockRunTestAgent,
  TestViolationInfo: class {},
  measurePromptSections: vi
    .fn()
    .mockReturnValue({ total: 100, claudeMd: 10, contract: 30, spec: 50, rules: 10 }),
}));

vi.mock('../lib/artifacts.js', () => ({
  readArtifact: mockReadArtifact,
  commitArtifact: mockCommitArtifact,
  ArtifactCommitError: class extends Error {},
}));

vi.mock('../lib/connectivity.js', () => ({
  checkBedrockConnectivity: mockCheckBedrock,
  checkBedrockWithRetry: mockCheckBedrock,
}));

vi.mock('../lib/promptScope.js', () => ({
  scopeSpecByRefs: vi.fn().mockImplementation((spec: string) => spec),
  scopeContract: vi.fn().mockReturnValue('contract'),
}));

vi.mock('../lib/container.js', () => ({
  startContainer: vi.fn().mockReturnValue({
    exec: mockContainerExecHoisted,
    stop: mockContainerStopHoisted,
  }),
  runInstallContainer: vi.fn().mockResolvedValue(undefined),
  runHostInstall: vi.fn().mockResolvedValue(undefined),
  runBootstrapInstall: vi.fn().mockResolvedValue(undefined),
  AllowlistViolationError: class extends Error {},
  MetacharViolationError: class extends Error {},
  EXEC_MAX_BUFFER: 50 * 1024 * 1024,
}));

const {
  mockGitCommit,
  mockGitStatus,
  mockGitAdd,
  mockGitCheckout,
  mockGitClean,
  mockGetAuthoredTestFilesForTask,
} = vi.hoisted(() => ({
  mockGitCommit: vi.fn(),
  mockGitStatus: vi.fn().mockReturnValue('A src/__tests__/items.test.ts'),
  mockGitAdd: vi.fn(),
  mockGitCheckout: vi.fn(),
  mockGitClean: vi.fn(),
  mockGetAuthoredTestFilesForTask: vi.fn().mockReturnValue(['src/__tests__/items.test.ts']),
}));

vi.mock('../jobs/testJob.js', () => ({
  discoverTestDir: vi.fn().mockReturnValue({ dir: 'src/__tests__', method: 'candidate' }),
  getAuthoredTestFilesForTask: mockGetAuthoredTestFilesForTask,
  parseTestOutput: vi.fn(),
  detectJsonCommand: vi.fn().mockReturnValue('npx vitest run --reporter=json'),
  findingsFromTests: vi.fn().mockReturnValue([]),
  getAuthoredTestFiles: vi.fn().mockReturnValue([]),
  getExistingTestFilesWithDescribes: vi.fn().mockReturnValue([]),
}));

const { mockReadClaudeMd } = vi.hoisted(() => ({
  mockReadClaudeMd: vi.fn().mockReturnValue('# CLAUDE.md'),
}));

vi.mock('../jobs/devJob.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../jobs/devJob.js')>();
  return {
    ...original,
    getRepoEntry: mockGetRepoEntry,
    readClaudeMdFromDefaultBranch: mockReadClaudeMd,
  };
});

vi.mock('../lib/worktree.js', () => ({
  createWorktree: mockCreateWorktree,
}));

vi.mock('../lib/dispatch.js', () => ({
  dispatchUnblockedTasks: vi.fn().mockResolvedValue(undefined),
  dispatchForState: vi.fn().mockResolvedValue(undefined),
  dispatchJob: vi.fn().mockResolvedValue(undefined),
}));

// Mock child_process git to avoid real git calls
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('status')) return mockGitStatus();
      if (args.includes('add')) return mockGitAdd();
      if (args.includes('checkout')) return mockGitCheckout();
      if (args.includes('clean')) return mockGitClean();
      if (args.includes('commit')) {
        // Find the message after '-m'
        const mIdx = args.indexOf('-m');
        const msg = mIdx !== -1 ? args[mIdx + 1] : undefined;
        return mockGitCommit(msg);
      }
      return '';
    }),
  };
});

// Mock node:fs to intercept worktree path operations without using vi.spyOn
// (vi.spyOn + vi.restoreAllMocks can also reset vi.mock factories which breaks execFileSync).
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  const isWt = (p: unknown) => typeof p === 'string' && p.startsWith('/tmp/test-wt');
  const sm = {
    existsSync: (p: any) => (isWt(p) ? (mockFsExistsSync(p) as boolean) : actual.existsSync(p)),
    readFileSync: (...a: any[]) =>
      isWt(a[0]) ? mockFsReadFileSync(String(a[0])) : (actual.readFileSync as any)(...a),
    unlinkSync: (p: any) => {
      if (isWt(p)) {
        mockFsUnlinkSync(p);
      } else {
        actual.unlinkSync(p);
      }
    },
  };
  return { ...actual, default: { ...(actual as any), ...sm }, ...sm };
});

import { createHash } from 'node:crypto';
import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { runTaskTestJob } from '../jobs/taskTestJob.js';

afterEach(async () => {
  await disconnectPrisma();
});

let featureId: string;
let taskId: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  mockRunTestAgent.mockClear();
  mockGitCommit.mockClear();
  mockGitCheckout.mockClear();
  mockGitClean.mockClear();
  mockCreateWorktree.mockClear();
  mockCommitArtifact.mockClear();
  // Reset fs stubs to safe defaults for each test
  mockFsExistsSync.mockReturnValue(false);
  mockFsReadFileSync.mockReturnValue('');
  mockFsUnlinkSync.mockClear();
  // Reset mockReadArtifact to discriminate by filename (test-harness-brief.md → null, others → '# Spec')
  mockReadArtifact.mockImplementation((_slug: string, filename: string) =>
    filename === 'test-harness-brief.md' ? null : '# Spec',
  );
  mockGetAuthoredTestFilesForTask.mockReturnValue(['src/__tests__/items.test.ts']);

  const f = await createFeature({ name: 'Task Test Job', requirement: 'req' });
  featureId = f.id;
  await getPrisma().feature.update({
    where: { id: featureId },
    data: { status: 'IMPLEMENTING' },
  });

  const t = await getPrisma().task.create({
    data: {
      featureId,
      repo: 'demo-server',
      side: 'server',
      title: 'Add items endpoint',
      description: 'POST /items',
      specRefs: ['API endpoints'],
      dependsOn: [],
      status: 'pending',
      coveredByTestPlan: true,
      testsWritten: false,
    },
  });
  taskId = t.id;
});

describe('runTaskTestJob', () => {
  it('does nothing when task has testsWritten=true', async () => {
    await getPrisma().task.update({ where: { id: taskId }, data: { testsWritten: true } });
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    expect(mockRunTestAgent).not.toHaveBeenCalled();
  });

  it('does nothing when task is not covered', async () => {
    await getPrisma().task.update({ where: { id: taskId }, data: { coveredByTestPlan: false } });
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    expect(mockRunTestAgent).not.toHaveBeenCalled();
  });

  it('does NOT fail when the test suite exits with non-zero (red is expected)', async () => {
    // Container returns exit code 1 (red suite) — job must still succeed
    mockContainerExecHoisted.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'FAIL' });
    await expect(runTaskTestJob(featureId, taskId, 'job-1', 'server')).resolves.toBeUndefined();
  });

  it('sets testsWritten=true and status=pending after writing tests', async () => {
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    const task = await getPrisma().task.findUnique({ where: { id: taskId } });
    expect(task?.testsWritten).toBe(true);
    expect(task?.status).toBe('pending');
  });

  it('commits with X-Orrery-Agent: test and X-Orrery-Task: <taskId> trailers', async () => {
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    const commitArg = mockGitCommit.mock.calls[0]?.[0] as string | undefined;
    expect(commitArg).toContain('X-Orrery-Agent: test');
    expect(commitArg).toContain(`X-Orrery-Task: ${taskId}`);
  });

  it('emits task.tests_written event', async () => {
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const written = events.find((e) => e.type === 'task.tests_written');
    expect(written).not.toBeUndefined();
    expect((written!.payload as { task_id: string }).task_id).toBe(taskId);
  });

  it('sets testsWritten=true and emits agent.log when agent writes no files', async () => {
    // Zero staged files: git status returns '', getAuthoredTestFilesForTask returns [].
    // The job must still mark testsWritten so the task proceeds to the dev job.
    mockGitStatus.mockReturnValueOnce('');
    mockGetAuthoredTestFilesForTask.mockReturnValueOnce([]);
    await runTaskTestJob(featureId, taskId, 'job-2', 'server');
    const task = await getPrisma().task.findUnique({ where: { id: taskId } });
    expect(task?.testsWritten).toBe(true);
    expect(task?.status).toBe('pending');
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const noFilesLog = events.find(
      (e) =>
        e.type === 'agent.log' &&
        typeof (e.payload as Record<string, unknown>)['text'] === 'string' &&
        ((e.payload as Record<string, unknown>)['text'] as string).includes('wrote no files'),
    );
    expect(noFilesLog).not.toBeUndefined();
  });

  it('sets testsWritten=true and dispatches dev job after one transient error', async () => {
    // The increment fires at job start (testTaskAttempts becomes 1), then the
    // agent throws a non-violation error. The catch branch must detect
    // testTaskAttempts >= 1, mark testsWritten=true, and call dispatchUnblockedTasks.
    const { dispatchUnblockedTasks: mockDispatch } = await import('../lib/dispatch.js');
    mockRunTestAgent.mockRejectedValueOnce(new Error('transient network error'));
    await runTaskTestJob(featureId, taskId, 'job-3', 'server');
    const task = await getPrisma().task.findUnique({ where: { id: taskId } });
    expect(task?.testsWritten).toBe(true);
    expect(task?.status).toBe('pending');
    expect(mockDispatch).toHaveBeenCalled();
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const skipLog = events.find(
      (e) =>
        e.type === 'agent.log' &&
        typeof (e.payload as Record<string, unknown>)['text'] === 'string' &&
        ((e.payload as Record<string, unknown>)['text'] as string).includes('skipping to dev job'),
    );
    expect(skipLog).not.toBeUndefined();
  });

  it('includes only task title and specRefs in agent context, not description', async () => {
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    expect(mockRunTestAgent).toHaveBeenCalledWith(
      featureId,
      expect.objectContaining({
        specMarkdown: expect.stringContaining('Add items endpoint'),
      }),
      expect.anything(), // container
      expect.any(String), // worktreePath
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    const specArg = mockRunTestAgent.mock.calls[0]?.[1]?.specMarkdown as string;
    // The task description 'POST /items' must NOT appear in the spec context
    // (the description is not injected)
    expect(specArg).not.toContain('POST /items'); // only title injection, not description
  });

  it('calls createWorktree with repo url, slug, default_branch and repoId', async () => {
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      'https://git.example.com/demo-server',
      expect.any(String), // feature.slug
      'main',
      'demo-server',
    );
  });

  it('creates the worktree before readClaudeMdFromDefaultBranch and discoverTestDir are called', async () => {
    const { readClaudeMdFromDefaultBranch } = await import('../jobs/devJob.js');
    const { discoverTestDir } = await import('../jobs/testJob.js');
    const callOrder: string[] = [];
    mockCreateWorktree.mockImplementation(() => {
      callOrder.push('createWorktree');
      return {
        repoId: 'demo-server',
        bareRepoPath: '/tmp/test-wt.git',
        worktreePath: '/tmp/test-wt',
        branch: 'feature/task-test-job',
      };
    });
    vi.mocked(readClaudeMdFromDefaultBranch).mockImplementation(() => {
      callOrder.push('readClaudeMd');
      return '# CLAUDE.md';
    });
    vi.mocked(discoverTestDir).mockImplementation(() => {
      callOrder.push('discoverTestDir');
      return { dir: 'src/__tests__', method: 'candidate' as const };
    });
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    const wtIdx = callOrder.indexOf('createWorktree');
    const mdIdx = callOrder.indexOf('readClaudeMd');
    const dtIdx = callOrder.indexOf('discoverTestDir');
    expect(wtIdx).toBeGreaterThanOrEqual(0);
    expect(mdIdx).toBeGreaterThan(wtIdx);
    expect(dtIdx).toBeGreaterThan(wtIdx);
  });

  it('issues git checkout . and git clean -fd as part of the worktree reset', async () => {
    const { execFileSync } = await import('node:child_process');
    const calls: ReadonlyArray<string>[] = [];
    vi.mocked(execFileSync).mockImplementation((_cmd: unknown, args: unknown) => {
      const a = (args ?? []) as ReadonlyArray<string>;
      calls.push(a);
      if (a.includes('status')) return mockGitStatus();
      if (a.includes('add')) return mockGitAdd();
      if (a.includes('checkout')) return mockGitCheckout();
      if (a.includes('clean')) return mockGitClean();
      if (a.includes('commit')) {
        const mIdx = a.indexOf('-m');
        const msg = mIdx !== -1 ? a[mIdx + 1] : undefined;
        return mockGitCommit(msg);
      }
      return '';
    });
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    const hasCheckoutDot = calls.some((a) => a.includes('checkout') && a.includes('.'));
    const hasCleanFd = calls.some((a) => a.includes('clean') && a.includes('-fd'));
    expect(hasCheckoutDot).toBe(true);
    expect(hasCleanFd).toBe(true);
  });

  it('emits a muted agent.log when CLAUDE.md cannot be read from the default branch', async () => {
    mockReadClaudeMd.mockImplementationOnce(() => {
      throw new Error('fatal: not a git repository');
    });
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const muteLog = events.find(
      (e) =>
        e.type === 'agent.log' &&
        (e.payload as { severity?: string }).severity === 'muted' &&
        (e.payload as { text?: string }).text?.includes('main'),
    );
    expect(muteLog).toBeDefined();
  });

  it('git helper passes maxBuffer: EXEC_MAX_BUFFER on every execFileSync git call', async () => {
    const { execFileSync } = await import('node:child_process');
    const capturedOpts: Array<Record<string, unknown> | undefined> = [];
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const a = (args[1] ?? []) as ReadonlyArray<string>;
      const opts = args[2] as Record<string, unknown> | undefined;
      capturedOpts.push(opts);
      if (a.includes('status')) return mockGitStatus();
      if (a.includes('add')) return mockGitAdd();
      if (a.includes('checkout')) return mockGitCheckout();
      if (a.includes('clean')) return mockGitClean();
      if (a.includes('commit')) {
        const mIdx = a.indexOf('-m');
        const msg = mIdx !== -1 ? a[mIdx + 1] : undefined;
        return mockGitCommit(msg);
      }
      return '';
    });
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    expect(capturedOpts.length).toBeGreaterThan(0);
    for (const opts of capturedOpts) {
      expect(opts?.maxBuffer).toBe(50 * 1024 * 1024);
    }
  });

  it('git ENOBUFS during commit parks task, does not throw', async () => {
    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const a = (args[1] ?? []) as ReadonlyArray<string>;
      if (a.includes('status')) return 'A src/__tests__/items.test.ts';
      if (a.includes('add')) return mockGitAdd();
      if (a.includes('checkout')) return mockGitCheckout();
      if (a.includes('clean')) return mockGitClean();
      if (a.includes('commit')) {
        throw Object.assign(new Error('stdout maxBuffer exceeded'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
      }
      return '';
    });
    await expect(runTaskTestJob(featureId, taskId, 'job-1', 'server')).resolves.toBeUndefined();
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const failEvent = events.find(
      (e) => e.type === 'agent.status' && (e.payload as { status?: string }).status === 'failed',
    );
    expect(failEvent).toBeDefined();
  });
});

describe('taskTestJob — bootstrap install routing', () => {
  beforeEach(async () => {
    const { runBootstrapInstall, runHostInstall } = await import('../lib/container.js');
    vi.mocked(runBootstrapInstall).mockClear().mockResolvedValue(undefined);
    vi.mocked(runHostInstall).mockClear();
  });

  it('uses bootstrap command when bootstrap field is set, not runHostInstall', async () => {
    const { runBootstrapInstall, runHostInstall } = await import('../lib/container.js');
    mockGetRepoEntry.mockReturnValueOnce({
      id: 'demo-server',
      url: 'https://git.example.com/demo-server',
      default_branch: 'main',
      side: 'server',
      description: 'Demo server',
      install_timeout_ms: 10_000,
      exec_timeout_ms: 10_000,
      bootstrap: 'echo | ./run_all_npm_install.sh',
    });
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    expect(vi.mocked(runBootstrapInstall)).toHaveBeenCalledWith(
      expect.any(String),
      'echo | ./run_all_npm_install.sh',
      expect.any(String),
      10_000,
    );
    expect(vi.mocked(runHostInstall)).not.toHaveBeenCalled();
  });

  it('uses runHostInstall when no bootstrap field is set', async () => {
    const { runBootstrapInstall, runHostInstall } = await import('../lib/container.js');
    // default mockGetRepoEntry has no bootstrap field
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    expect(vi.mocked(runHostInstall)).toHaveBeenCalled();
    expect(vi.mocked(runBootstrapInstall)).not.toHaveBeenCalled();
  });

  it('resets task to pending and skips agent when bootstrap install fails', async () => {
    const { runBootstrapInstall } = await import('../lib/container.js');
    mockGetRepoEntry.mockReturnValueOnce({
      id: 'demo-server',
      url: 'https://git.example.com/demo-server',
      default_branch: 'main',
      side: 'server',
      install_timeout_ms: 10_000,
      exec_timeout_ms: 10_000,
      bootstrap: 'echo | ./run_all_npm_install.sh',
    });
    vi.mocked(runBootstrapInstall).mockRejectedValueOnce(new Error('bootstrap script failed'));
    mockRunTestAgent.mockClear();
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    const task = await getPrisma().task.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('pending');
    expect(mockRunTestAgent).not.toHaveBeenCalled();
  });
});

describe('runTaskTestJob — harness brief', () => {
  it('never calls detectJsonCommand (no probe in task-test job)', async () => {
    const { detectJsonCommand } = await import('../jobs/testJob.js');
    vi.mocked(detectJsonCommand).mockClear();
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');
    expect(vi.mocked(detectJsonCommand)).not.toHaveBeenCalled();
  });

  it('first task: prompt contains brief-writing instruction, brief committed, excluded from test commit', async () => {
    const BRIEF_CONTENT =
      '<!-- orrery-sources: {} -->\n# Test Harness Brief\n## Mocks\naxios: stubs HTTP\n';
    // Agent writes the brief file → existsSync returns true for it; readFileSync returns its content
    mockFsExistsSync.mockImplementation((p: unknown) =>
      String(p).endsWith('__orrery_harness_brief.md'),
    );
    mockFsReadFileSync.mockImplementation((p: unknown) =>
      String(p).endsWith('__orrery_harness_brief.md') ? BRIEF_CONTENT : '',
    );

    await runTaskTestJob(featureId, taskId, 'job-1', 'server');

    const specArg = mockRunTestAgent.mock.calls[0]?.[1]?.specMarkdown as string;
    expect(specArg).toContain('Harness Brief (write this on first test-task only)');
    expect(specArg).toContain('__orrery_harness_brief.md');

    expect(mockCommitArtifact).toHaveBeenCalledWith(
      expect.any(String),
      'test-harness-brief.md',
      BRIEF_CONTENT,
      'test-harness-brief',
    );

    expect(mockFsUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('__orrery_harness_brief.md'),
    );

    // Brief must not appear in the test commit message (or no commit = also fine since unlinkSync ran)
    const commitArg = mockGitCommit.mock.calls[0]?.[0] as string | undefined;
    expect(commitArg ?? '').not.toContain('__orrery_harness_brief');
  });

  it('subsequent task: fresh brief injected with "do not re-read" instruction, commitArtifact not called', async () => {
    const SOURCE_CONTENT = 'mock source content';
    const sourceHash = createHash('sha256').update(SOURCE_CONTENT).digest('hex');
    const freshBrief =
      `<!-- orrery-sources: {"__tests__/setup.ts": "${sourceHash}"} -->\n` +
      `# Test Harness Brief\n\n## Mocks\n__tests__/setup.ts: stubs the DB client\n`;

    mockReadArtifact.mockImplementation((_slug: string, filename: string) =>
      filename === 'test-harness-brief.md' ? freshBrief : '# Spec',
    );
    mockFsExistsSync.mockImplementation((p: unknown) => String(p).endsWith('setup.ts'));
    mockFsReadFileSync.mockImplementation((p: unknown) =>
      String(p).endsWith('setup.ts') ? SOURCE_CONTENT : '',
    );

    await runTaskTestJob(featureId, taskId, 'job-1', 'server');

    const specArg = mockRunTestAgent.mock.calls[0]?.[1]?.specMarkdown as string;
    expect(specArg).toContain('Test Harness Brief');
    expect(specArg).toContain('Do not re-read the files listed above');
    expect(specArg).not.toContain('Harness Brief (write this on first test-task only)');

    expect(mockCommitArtifact).not.toHaveBeenCalled();
  });

  it('stale brief (hash mismatch): treated as first task, brief-writing instruction injected', async () => {
    const staleBrief =
      `<!-- orrery-sources: {"__tests__/setup.ts": "deadbeef"} -->\n` +
      `# Test Harness Brief\n## Mocks\nstale content\n`;

    mockReadArtifact.mockImplementation((_slug: string, filename: string) =>
      filename === 'test-harness-brief.md' ? staleBrief : '# Spec',
    );
    // Source file exists but content hashes to something other than 'deadbeef'
    mockFsExistsSync.mockImplementation((p: unknown) => String(p).endsWith('setup.ts'));
    mockFsReadFileSync.mockImplementation((p: unknown) =>
      String(p).endsWith('setup.ts') ? 'changed content' : '',
    );

    await runTaskTestJob(featureId, taskId, 'job-1', 'server');

    const specArg = mockRunTestAgent.mock.calls[0]?.[1]?.specMarkdown as string;
    expect(specArg).toContain('Harness Brief (write this on first test-task only)');

    const events = await getPrisma().event.findMany({ where: { featureId } });
    const staleLog = events.find(
      (e) =>
        e.type === 'agent.log' &&
        (e.payload as { text?: string }).text?.includes('harness brief stale'),
    );
    expect(staleLog).toBeDefined();
  });

  it('agent writes no brief: no commitArtifact call, logs "did not write harness brief"', async () => {
    // Default mocks: readArtifact returns null for brief (first task), existsSync returns false
    // (agent wrote nothing). No spies needed — real existsSync returns false for /tmp/test-wt paths.
    await runTaskTestJob(featureId, taskId, 'job-1', 'server');

    expect(mockCommitArtifact).not.toHaveBeenCalled();

    const events = await getPrisma().event.findMany({ where: { featureId } });
    const noBriefLog = events.find(
      (e) =>
        e.type === 'agent.log' &&
        (e.payload as { text?: string }).text?.includes('did not write harness brief'),
    );
    expect(noBriefLog).toBeDefined();
  });
});

// ── R-23: Bedrock park leaves a consistent, recoverable task row ───────────────

describe('taskTestJob — Bedrock unreachable (R-23)', () => {
  beforeEach(() => {
    mockCheckBedrock.mockResolvedValue(false);
  });

  afterEach(() => {
    mockCheckBedrock.mockResolvedValue(true);
  });

  it('sets status to parked (not pending) on Bedrock failure', async () => {
    await runTaskTestJob(featureId, taskId, 'job-park-1', 'server');
    const task = await getPrisma().task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('parked');
    expect(task.parkReason).toBe('bedrock_unreachable');
  });

  it('clears bullJobId so the row is visible to reconciler and dispatch', async () => {
    await getPrisma().task.update({
      where: { id: taskId },
      data: { status: 'running', bullJobId: 'stale-641' },
    });
    await runTaskTestJob(featureId, taskId, 'job-park-2', 'server');
    const task = await getPrisma().task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.bullJobId).toBeNull();
  });

  it('rolls back testTaskAttempts so next dispatch re-routes to the test-task job', async () => {
    // Dispatch increments testTaskAttempts to 1 at job start.
    // Park must decrement it back to 0 so the task routes to test-task, not dev.
    await runTaskTestJob(featureId, taskId, 'job-park-3', 'server');
    const task = await getPrisma().task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.testTaskAttempts).toBe(0);
  });

  it('emits task.failed with final:false', async () => {
    await runTaskTestJob(featureId, taskId, 'job-park-4', 'server');
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const failedEvt = events.find((e) => e.type === 'task.failed');
    expect(failedEvt).not.toBeUndefined();
    expect((failedEvt!.payload as { final: boolean }).final).toBe(false);
  });
});

// ── R-25: testsWritten update clears bullJobId ────────────────────────────────

describe('taskTestJob — testsWritten update clears bullJobId (R-25)', () => {
  it('clears bullJobId when setting testsWritten=true on success path', async () => {
    await getPrisma().task.update({ where: { id: taskId }, data: { bullJobId: 'dev-job-old' } });
    await runTaskTestJob(featureId, taskId, 'job-tw-1', 'server');
    const task = await getPrisma().task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.testsWritten).toBe(true);
    expect(task.bullJobId).toBeNull();
  });
});
