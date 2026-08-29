/**
 * Tests for the per-task acceptance check in devJob.
 * The check runs after the dev agent commits, before completeTask.
 * We test it indirectly via runDevJob with mocked containers and agents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_PROVIDER'] = 'anthropic';
process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';
process.env['WORKTREES_ROOT'] = '/tmp/orrery-worktrees';

const { mockContainerExec, mockContainerStop } = vi.hoisted(() => ({
  mockContainerExec: vi.fn(),
  mockContainerStop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/container.js', () => ({
  startContainer: vi.fn().mockReturnValue({
    name: 'orrery-agent-test',
    exec: mockContainerExec,
    stop: mockContainerStop,
  }),
  runInstallContainer: vi.fn().mockResolvedValue(undefined),
  runHostInstall: vi.fn().mockResolvedValue(undefined),
  runBootstrapInstall: vi.fn().mockResolvedValue(undefined),
  AllowlistViolationError: class extends Error {},
  MetacharViolationError: class extends Error {},
  EXEC_MAX_BUFFER: 50 * 1024 * 1024,
}));

vi.mock('../lib/queue.js', () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
  getQueue: vi.fn(),
  closeQueue: vi.fn(),
}));

vi.mock('../lib/dispatch.js', () => ({
  dispatchUnblockedTasks: vi.fn().mockResolvedValue(undefined),
  dispatchForState: vi.fn().mockResolvedValue(undefined),
  dispatchJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/connectivity.js', () => ({
  checkBedrockConnectivity: vi.fn().mockResolvedValue(true),
  checkBedrockWithRetry: vi.fn().mockResolvedValue(true),
}));

// Mock node:fs so manifest reads don't fail on missing file
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn().mockImplementation((p: string, _opts?: unknown) => {
      if (typeof p === 'string' && p.includes('repo-manifest')) {
        return '# mocked manifest';
      }
      return actual.readFileSync(p, _opts as Parameters<typeof actual.readFileSync>[1]);
    }),
    existsSync: vi.fn().mockReturnValue(false),
  };
});

const mockYamlLoad = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    repos: [
      {
        id: 'demo-server',
        side: 'server',
        active: true,
        url: 'https://example.com/demo-server.git',
        default_branch: 'main',
        description: 'Demo server',
        exec_timeout_ms: 10_000,
        install_timeout_ms: 10_000,
      },
    ],
  }),
);

vi.mock('js-yaml', () => ({
  default: { load: mockYamlLoad },
  load: mockYamlLoad,
}));

vi.mock('../lib/artifacts.js', () => ({
  readArtifact: vi.fn().mockReturnValue('# Spec'),
  commitArtifact: vi.fn(),
  ArtifactCommitError: class extends Error {},
}));

vi.mock('../lib/promptScope.js', () => ({
  scopeSpecByRefs: vi.fn().mockImplementation((s: string) => s),
  scopeContract: vi.fn().mockReturnValue('contract'),
}));

// Mock devAgent to return 'code' outcome (normal completion)
const { mockRunDevAgent, _mockGetRepoEntry, _mockReadClaudeMd } = vi.hoisted(() => ({
  mockRunDevAgent: vi.fn(),
  _mockGetRepoEntry: vi.fn().mockReturnValue({
    id: 'demo-server',
    side: 'server',
    description: 'Demo',
    install_timeout_ms: 10_000,
    exec_timeout_ms: 10_000,
  }),
  _mockReadClaudeMd: vi.fn().mockReturnValue('# CLAUDE.md\n## Commands\nnpm test\n'),
}));

vi.mock('../agents/devAgent.js', () => ({
  runDevAgent: mockRunDevAgent,
  AgentNoopError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'AgentNoopError';
    }
  },
  AgentOutcome: {},
  ViolationInfo: class {},
  ToolCallInfo: class {},
  measurePromptSections: vi.fn().mockReturnValue({
    total: 100,
    claudeMd: 10,
    contract: 30,
    spec: 50,
    task: 5,
    orientation: 5,
    rules: 0,
  }),
}));

// Mock getAuthoredTestFilesForTask and parseTestOutput from testJob
const {
  mockGetAuthoredTestFilesForTask,
  mockParseTestOutput,
  mockDetectJsonCommand,
  mockFindingsFromTests,
  mockPlainTestCommand,
} = vi.hoisted(() => ({
  mockGetAuthoredTestFilesForTask: vi.fn(),
  mockParseTestOutput: vi.fn(),
  mockDetectJsonCommand: vi.fn().mockReturnValue('npx vitest run --reporter=json'),
  mockFindingsFromTests: vi.fn().mockReturnValue([
    {
      id: 'f1',
      severity: 'blocker',
      section: 'acceptance tests',
      issue: 'Test failed',
      test_name: 'test 1',
    },
  ]),
  mockPlainTestCommand: vi.fn().mockImplementation((p?: string) => p ?? 'npm test'),
}));

vi.mock('../jobs/testJob.js', () => ({
  getAuthoredTestFilesForTask: mockGetAuthoredTestFilesForTask,
  discoverTestDir: vi.fn().mockReturnValue({ dir: 'src/__tests__', method: 'candidate' }),
  parseTestOutput: mockParseTestOutput,
  detectJsonCommand: mockDetectJsonCommand,
  plainTestCommand: mockPlainTestCommand,
  findingsFromTests: mockFindingsFromTests,
  getAuthoredTestFiles: vi.fn().mockReturnValue([]),
  TEST_REPORT_FILE: '/tmp/test-report.json',
}));

// Mock git so we don't need a real worktree
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      if (Array.isArray(args)) {
        if (args.includes('status') && args.includes('--porcelain')) {
          return 'M src/items.ts'; // staged changes present → take the commit path
        }
        if (args.includes('status')) return 'M src/items.ts';
        if (args.includes('fetch')) return '';
        if (args.includes('show')) return '# CLAUDE.md';
        if (args.includes('rev-parse')) return 'abc123';
        if (args.includes('commit')) return '';
        if (args.includes('add')) return '';
        if (args.includes('push')) return '';
        if (args.includes('diff') && args.includes('--cached') && args.includes('--name-only')) {
          return 'src/items.ts'; // staged file list
        }
        if (args.includes('diff')) return ''; // other diff calls
      }
      return '';
    }),
    execSync: vi.fn().mockReturnValue(''),
  };
});

vi.mock('../lib/worktree.js', () => ({
  createWorktree: vi.fn().mockReturnValue({
    worktreePath: '/tmp/orrery-worktrees/test-worktree',
    branch: 'feat/test-branch',
  }),
  removeWorktree: vi.fn(),
}));

vi.mock('../routes/featureAmendment.js', () => ({
  getRejectedAmendments: vi.fn().mockResolvedValue([]),
}));

const { mockGenerateOrientation } = vi.hoisted(() => ({
  mockGenerateOrientation: vi
    .fn()
    .mockReturnValue('## Repository orientation\n\n### File tree\nsrc/index.ts'),
}));

vi.mock('../lib/repoOrientation.js', () => ({
  generateRepoOrientation: mockGenerateOrientation,
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { runDevJob } from '../jobs/devJob.js';
import { runBootstrapInstall, runHostInstall } from '../lib/container.js';

afterEach(async () => {
  await disconnectPrisma();
});

let featureId: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  mockContainerExec.mockReset();
  mockContainerStop.mockClear();
  mockRunDevAgent.mockClear();
  mockGetAuthoredTestFilesForTask.mockClear();
  mockParseTestOutput.mockClear();
  mockFindingsFromTests.mockClear();
  mockGenerateOrientation.mockClear();

  const f = await createFeature({ name: 'Acceptance Test', requirement: 'req' });
  featureId = f.id;
  await getPrisma().feature.update({
    where: { id: featureId },
    data: {
      status: 'IMPLEMENTING',
      currentBranches: { 'demo-server': 'feat/acceptance-test' },
    },
  });

  // Agent returns completed outcome
  mockRunDevAgent.mockResolvedValue({ kind: 'completed' });
});

async function makeCoveredTask(attemptCount = 0): Promise<string> {
  const task = await getPrisma().task.create({
    data: {
      featureId,
      repo: 'demo-server',
      side: 'server',
      title: 'Add endpoint',
      description: 'POST /items',
      specRefs: ['API endpoints'],
      dependsOn: [],
      status: 'pending',
      coveredByTestPlan: true,
      testsWritten: true,
      attemptCount,
    },
  });
  return task.id;
}

describe('devJob acceptance check', () => {
  beforeEach(() => {
    // By default: test agent wrote 1 test file
    mockGetAuthoredTestFilesForTask.mockReturnValue(['src/__tests__/items.test.ts']);
    // Container exec: probe (json cmd + cat), npm test, acceptance (json cmd + cat)
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // probe json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cat probe report
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // npm test (pre-commit)
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }) // acceptance json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' }); // cat acceptance report
    mockParseTestOutput
      .mockReturnValueOnce({
        passed: 1,
        failed: 0,
        tests: [],
        authoredPassed: 0,
        authoredFailed: 0,
        parseError: null,
      }) // probe
      .mockReturnValue({
        passed: 0,
        failed: 1,
        tests: [{ test_name: 'POST /items should return 201', status: 'failed', authored: true }],
        authoredPassed: 0,
        authoredFailed: 1,
        parseError: null,
      });
  });

  it('resets task to pending on first dev attempt when acceptance tests fail', async () => {
    const taskId = await makeCoveredTask(0);
    await runDevJob(featureId, taskId, 'job-1');
    const task = await getPrisma().task.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('pending');
    const events = await getPrisma().event.findMany({ where: { featureId } });
    expect(events.some((e) => e.type === 'gate.opened')).toBe(false);
  });

  it('parks task and opens task_acceptance_gate on second dev attempt', async () => {
    // Second attempt: attemptCount was already 1 before devJob incremented it
    const taskId = await makeCoveredTask(1);
    await getPrisma().task.update({ where: { id: taskId }, data: { attemptCount: 1 } });

    // Container exec: probe (json cmd + cat), npm test, acceptance (json cmd + cat)
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // probe json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cat probe report
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // npm test
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }) // acceptance json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' }); // cat acceptance report

    await runDevJob(featureId, taskId, 'job-2');

    const task = await getPrisma().task.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('parked');

    const events = await getPrisma().event.findMany({ where: { featureId } });
    const gate = events.find((e) => e.type === 'gate.opened');
    expect(gate).not.toBeUndefined();
    expect((gate!.payload as { gate: string }).gate).toBe('task_acceptance_gate');
  });

  it('completes task normally when acceptance tests pass', async () => {
    const taskId = await makeCoveredTask(0);
    // Probe (json cmd + cat), npm test, acceptance (json cmd + cat) — all pass
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // probe json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cat probe report
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // npm test
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // acceptance json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' }); // cat acceptance report
    mockParseTestOutput.mockReturnValue({
      passed: 1,
      failed: 0,
      tests: [{ test_name: 'POST /items should return 201', status: 'passed', authored: true }],
      authoredPassed: 1,
      authoredFailed: 0,
      parseError: null,
    });

    await runDevJob(featureId, taskId, 'job-1');

    const task = await getPrisma().task.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('completed');
    const events = await getPrisma().event.findMany({ where: { featureId } });
    expect(events.some((e) => e.type === 'gate.opened')).toBe(false);
  });

  it('uncovered task skips acceptance check and completes normally', async () => {
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Run migration',
        description: 'DB migration',
        specRefs: [],
        dependsOn: [],
        status: 'pending',
        coveredByTestPlan: false, // NOT covered
        testsWritten: false,
      },
    });
    // probe + npm test (no acceptance check since not covered)
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // probe
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // npm test

    await runDevJob(featureId, task.id, 'job-1');

    const updated = await getPrisma().task.findUnique({ where: { id: task.id } });
    expect(updated?.status).toBe('completed');
    // parseTestOutput should NOT have been called (no acceptance check for uncovered tasks)
    expect(mockGetAuthoredTestFilesForTask).not.toHaveBeenCalled();
  });
});

describe('devJob — orientation block', () => {
  beforeEach(() => {
    mockGetAuthoredTestFilesForTask.mockReturnValue(['src/__tests__/items.test.ts']);
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // probe json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cat probe report
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // npm test
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // acceptance json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' }); // cat acceptance report
    mockParseTestOutput
      .mockReturnValueOnce({
        passed: 1,
        failed: 0,
        tests: [],
        authoredPassed: 0,
        authoredFailed: 0,
        parseError: null,
      }) // probe
      .mockReturnValue({
        passed: 1,
        failed: 0,
        tests: [{ test_name: 'passes', status: 'passed', authored: true }],
        authoredPassed: 1,
        authoredFailed: 0,
        parseError: null,
      });
  });

  it('passes a non-empty orientationBlock into the agent context', async () => {
    const taskId = await makeCoveredTask(0);
    await runDevJob(featureId, taskId, 'job-orientation-1');

    expect(mockRunDevAgent).toHaveBeenCalled();
    const ctx = mockRunDevAgent.mock.calls[0]![2] as { orientationBlock?: string };
    expect(typeof ctx.orientationBlock).toBe('string');
    expect(ctx.orientationBlock!.length).toBeGreaterThan(0);
  });

  it('prompt-size log includes an orientation figure', async () => {
    const taskId = await makeCoveredTask(0);
    await runDevJob(featureId, taskId, 'job-orientation-2');

    const events = await getPrisma().event.findMany({ where: { featureId } });
    const sizeLog = events.find(
      (e) =>
        e.type === 'agent.log' && (e.payload as { text?: string }).text?.includes('prompt size:'),
    );
    expect(sizeLog).not.toBeUndefined();
    expect((sizeLog!.payload as { text: string }).text).toContain('orientation=');
  });

  it('orientation is generated after the worktree reset', async () => {
    const { execFileSync } = await import('node:child_process');
    const execFileSyncMock = vi.mocked(execFileSync);
    mockGenerateOrientation.mockClear();
    execFileSyncMock.mockClear();

    const taskId = await makeCoveredTask(0);
    await runDevJob(featureId, taskId, 'job-orientation-3');

    // Both must have been called
    expect(execFileSyncMock).toHaveBeenCalled();
    expect(mockGenerateOrientation).toHaveBeenCalled();

    // The last git reset call (checkout .) must have a lower invocation order than orientation
    const resetCalls = execFileSyncMock.mock.invocationCallOrder.filter((_order, idx) => {
      const args = execFileSyncMock.mock.calls[idx]!;
      return Array.isArray(args[1]) && (args[1] as string[]).includes('checkout');
    });
    const lastResetOrder = Math.max(...resetCalls);
    const orientationOrder = mockGenerateOrientation.mock.invocationCallOrder[0]!;
    expect(orientationOrder).toBeGreaterThan(lastResetOrder);
  });
});

describe('devJob — bootstrap install routing', () => {
  beforeEach(() => {
    vi.mocked(runBootstrapInstall).mockClear().mockResolvedValue(undefined);
    vi.mocked(runHostInstall).mockClear().mockResolvedValue(undefined);
    mockGetAuthoredTestFilesForTask.mockReturnValue([]);
    // probe (json cmd + cat) + npm test succeed; no acceptance check for uncovered tasks
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // probe json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cat probe report
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // npm test
    mockParseTestOutput.mockReturnValueOnce({
      passed: 1,
      failed: 0,
      tests: [],
      authoredPassed: 0,
      authoredFailed: 0,
      parseError: null,
    }); // probe
  });

  async function makeUncoveredTask(): Promise<string> {
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Bootstrap routing test task',
        description: 'task',
        specRefs: [],
        dependsOn: [],
        status: 'pending',
        coveredByTestPlan: false,
        testsWritten: false,
      },
    });
    return task.id;
  }

  it('runs bootstrap command when bootstrap field is set, not runHostInstall', async () => {
    mockYamlLoad.mockReturnValueOnce({
      repos: [
        {
          id: 'demo-server',
          side: 'server',
          active: true,
          url: 'https://example.com/demo-server.git',
          default_branch: 'main',
          description: 'Demo',
          install_timeout_ms: 10_000,
          exec_timeout_ms: 10_000,
          bootstrap: 'echo | ./custom-install.sh',
        },
      ],
    });
    const taskId = await makeUncoveredTask();
    await runDevJob(featureId, taskId, 'job-bootstrap-1');

    expect(vi.mocked(runBootstrapInstall)).toHaveBeenCalledWith(
      expect.any(String),
      'echo | ./custom-install.sh',
      expect.any(String),
      10_000,
    );
    expect(vi.mocked(runHostInstall)).not.toHaveBeenCalled();
  });

  it('runs runHostInstall when no bootstrap field is set', async () => {
    // default mockYamlLoad has no bootstrap field
    const taskId = await makeUncoveredTask();
    await runDevJob(featureId, taskId, 'job-bootstrap-2');

    expect(vi.mocked(runHostInstall)).toHaveBeenCalled();
    expect(vi.mocked(runBootstrapInstall)).not.toHaveBeenCalled();
  });

  it('bootstrap failure is fatal — runDevJob rejects', async () => {
    mockYamlLoad.mockReturnValueOnce({
      repos: [
        {
          id: 'demo-server',
          side: 'server',
          active: true,
          url: 'https://example.com/demo-server.git',
          default_branch: 'main',
          description: 'Demo',
          install_timeout_ms: 10_000,
          exec_timeout_ms: 10_000,
          bootstrap: 'echo | ./custom-install.sh',
        },
      ],
    });
    vi.mocked(runBootstrapInstall).mockRejectedValueOnce(new Error('bootstrap script failed'));

    const taskId = await makeUncoveredTask();
    await expect(runDevJob(featureId, taskId, 'job-bootstrap-3')).rejects.toThrow();
  });
});

describe('devJob — container lifecycle', () => {
  // Reset mockParseTestOutput so state from earlier describe blocks doesn't leak.
  // Without this, assessProbeResult sees a retained parseError:null implementation
  // and misclassifies the probe-failure path as "probe ok" (silent false positive).
  beforeEach(() => {
    mockParseTestOutput.mockReset();
  });

  async function makeUncoveredTask(): Promise<string> {
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Lifecycle test task',
        description: 'task',
        specRefs: [],
        dependsOn: [],
        status: 'pending',
        coveredByTestPlan: false,
        testsWritten: false,
      },
    });
    return task.id;
  }

  it('stops the container after a successful job', async () => {
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // probe json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cat probe report
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // npm test
    const probeResult = {
      passed: 1,
      failed: 0,
      tests: [],
      authoredPassed: 0,
      authoredFailed: 0,
      parseError: null,
    };
    mockParseTestOutput
      .mockReturnValueOnce(probeResult) // assessProbeResult
      .mockReturnValueOnce(probeResult); // baseline capture

    const taskId = await makeUncoveredTask();
    await runDevJob(featureId, taskId, 'job-lifecycle-ok');

    expect(mockContainerStop).toHaveBeenCalled();
  });

  it('stops the container when runDevAgent throws', async () => {
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // probe json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // cat probe report
    const probeResult2 = {
      passed: 1,
      failed: 0,
      tests: [],
      authoredPassed: 0,
      authoredFailed: 0,
      parseError: null,
    };
    mockParseTestOutput
      .mockReturnValueOnce(probeResult2) // assessProbeResult
      .mockReturnValueOnce(probeResult2); // baseline capture
    mockRunDevAgent.mockRejectedValueOnce(new Error('agent internal error'));

    const taskId = await makeUncoveredTask();
    await expect(runDevJob(featureId, taskId, 'job-lifecycle-throw')).rejects.toThrow(
      'agent internal error',
    );

    expect(mockContainerStop).toHaveBeenCalled();
  });

  it('stops the container on probe failure', async () => {
    // probe json cmd runs but the runner never writes the report file →
    // assessProbeResult calls parseTestOutput on empty cat output → sees parseError → returns !ok
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'sh: npx: not found' }) // probe json cmd
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }); // cat (no report file written)
    // Make parseTestOutput indicate that the cat output is not valid JSON,
    // so assessProbeResult classifies this as a toolchain failure.
    mockParseTestOutput.mockReturnValueOnce({
      passed: 0,
      failed: 0,
      tests: [],
      authoredPassed: 0,
      authoredFailed: 0,
      parseError: 'not valid vitest JSON output',
    });

    const taskId = await makeUncoveredTask();
    await expect(runDevJob(featureId, taskId, 'job-lifecycle-probe')).rejects.toThrow();

    expect(mockContainerStop).toHaveBeenCalled();
  });
});

describe('devJob — max_turns threading', () => {
  beforeEach(() => {
    mockGetAuthoredTestFilesForTask.mockReturnValue(['src/__tests__/items.test.ts']);
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // probe json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cat probe report
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // npm test
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // acceptance json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' }); // cat acceptance report
    mockParseTestOutput
      .mockReturnValueOnce({
        passed: 1,
        failed: 0,
        tests: [],
        authoredPassed: 0,
        authoredFailed: 0,
        parseError: null,
      }) // probe
      .mockReturnValue({
        passed: 1,
        failed: 0,
        tests: [{ test_name: 'passes', status: 'passed', authored: true }],
        authoredPassed: 1,
        authoredFailed: 0,
        parseError: null,
      });
  });

  it('passes max_turns from manifest into agent context', async () => {
    mockYamlLoad.mockReturnValueOnce({
      repos: [
        {
          id: 'demo-server',
          side: 'server',
          active: true,
          url: 'https://example.com/demo-server.git',
          default_branch: 'main',
          description: 'Demo server',
          exec_timeout_ms: 10_000,
          install_timeout_ms: 10_000,
          max_turns: 5,
        },
      ],
    });
    const taskId = await makeCoveredTask(0);
    await runDevJob(featureId, taskId, 'job-maxturns-1');
    expect(mockRunDevAgent).toHaveBeenCalled();
    const ctx = mockRunDevAgent.mock.calls[0]![2] as { maxTurns?: number };
    expect(ctx.maxTurns).toBe(5);
  });

  it('uses the default 40-turn cap when manifest has no max_turns', async () => {
    const taskId = await makeCoveredTask(0);
    await runDevJob(featureId, taskId, 'job-maxturns-2');
    expect(mockRunDevAgent).toHaveBeenCalled();
    const ctx = mockRunDevAgent.mock.calls[0]![2] as { maxTurns?: number };
    // effectiveCap = Math.max(1, Math.min(40, 150)) = 40
    expect(ctx.maxTurns).toBe(40);
  });
});

// ── R9: gate baseline-diff — fail only on new failures ────────────────────────

describe('devJob — baseline-diff gate (R9)', () => {
  async function makeUncoveredTask(): Promise<string> {
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Baseline test task',
        description: 'R9 baseline test',
        specRefs: [],
        dependsOn: [],
        status: 'pending',
        coveredByTestPlan: false,
      },
    });
    return task.id;
  }

  it('completes when verify fails but all failures are pre-existing (R9 gate delta)', async () => {
    const preExisting = {
      test_name: 'legacy broken test',
      status: 'failed' as const,
      authored: false,
    };

    // probe cmd, cat probe, verify cmd (fails!), cat verify
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' });

    // All parse calls return the same pre-existing failure — baseline = verify = same failure
    mockParseTestOutput.mockReturnValue({
      passed: 0,
      failed: 1,
      tests: [preExisting],
      authoredPassed: 0,
      authoredFailed: 0,
    });

    const taskId = await makeUncoveredTask();
    await runDevJob(featureId, taskId, 'job-baseline-1');

    const updated = await getPrisma().task.findUniqueOrThrow({ where: { id: taskId } });
    expect(updated.status).toBe('completed');
  });

  it('throws when verify finds a failure not present in the baseline', async () => {
    // probe cmd, cat probe, verify cmd (fails), cat verify
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' });

    // Probe: all pass. Baseline capture: all pass. Verify: new failure.
    mockParseTestOutput
      .mockReturnValueOnce({
        passed: 1,
        failed: 0,
        tests: [],
        authoredPassed: 0,
        authoredFailed: 0,
      })
      .mockReturnValueOnce({
        passed: 1,
        failed: 0,
        tests: [],
        authoredPassed: 0,
        authoredFailed: 0,
      })
      .mockReturnValueOnce({
        passed: 0,
        failed: 1,
        tests: [{ test_name: 'newly broken test', status: 'failed' as const, authored: false }],
        authoredPassed: 0,
        authoredFailed: 0,
      });

    const taskId = await makeUncoveredTask();
    await expect(runDevJob(featureId, taskId, 'job-baseline-2')).rejects.toThrow('Tests failed');
  });
});

// ── R-13: environmental failures do not advance attempt counter ───────────────

import { checkBedrockWithRetry } from '../lib/connectivity.js';

describe('devJob — Bedrock unreachable (R-13)', () => {
  async function makeTask(attemptCount = 1): Promise<string> {
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Bedrock test task',
        description: 'task',
        specRefs: [],
        dependsOn: [],
        status: 'pending',
        coveredByTestPlan: false,
        attemptCount,
      },
    });
    return task.id;
  }

  beforeEach(() => {
    vi.mocked(checkBedrockWithRetry).mockResolvedValue(false);
  });

  afterEach(() => {
    vi.mocked(checkBedrockWithRetry).mockResolvedValue(true);
  });

  it('parks task with parkReason bedrock_unreachable, not failure', async () => {
    const taskId = await makeTask(1);
    await runDevJob(featureId, taskId, 'job-bedrock-1');
    const task = await getPrisma().task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('parked');
    expect(task.parkReason).toBe('bedrock_unreachable');
  });

  it('clears bullJobId on park so the task is visible to reconciler and dispatch', async () => {
    const taskId = await makeTask(1);
    await runDevJob(featureId, taskId, 'job-bedrock-1b');
    const task = await getPrisma().task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.bullJobId).toBeNull();
  });

  it('does not advance the attempt counter (counter rolled back to pre-run value)', async () => {
    const taskId = await makeTask(1); // DB starts at attemptCount=1
    await runDevJob(featureId, taskId, 'job-bedrock-2');
    const task = await getPrisma().task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.attemptCount).toBe(1); // must stay at 1, not advance to 2
  });

  it('emits task.failed with final:false (recoverable)', async () => {
    const taskId = await makeTask(0);
    await runDevJob(featureId, taskId, 'job-bedrock-3');
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const failedEvt = events.find((e) => e.type === 'task.failed');
    expect(failedEvt).not.toBeUndefined();
    expect((failedEvt!.payload as { final: boolean }).final).toBe(false);
  });

  it('emits agent.status:failed for unified operator visibility', async () => {
    const taskId = await makeTask(0);
    await runDevJob(featureId, taskId, 'job-bedrock-4');
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const agentFailed = events.find(
      (e) => e.type === 'agent.status' && (e.payload as { status: string }).status === 'failed',
    );
    expect(agentFailed).not.toBeUndefined();
  });
});

// ── R-25: covered task without testsWritten must not reach completed ──────────

describe('devJob — awaiting_tests guard (R-25)', () => {
  async function makeCoveredNoTests(): Promise<string> {
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Awaiting tests task',
        description: 'task covered but not yet written',
        specRefs: [],
        dependsOn: [],
        status: 'pending',
        coveredByTestPlan: true,
        testsWritten: false,
        attemptCount: 0,
      },
    });
    return task.id;
  }

  it('sets status to awaiting_tests (not completed) when covered and testsWritten=false', async () => {
    // Container execs for the pre-commit verify (no acceptance check since testsWritten=false)
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // probe json cmd
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cat probe report
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // npm test (pre-commit)
    const taskId = await makeCoveredNoTests();
    await runDevJob(featureId, taskId, 'job-await-1');
    const task = await getPrisma().task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('awaiting_tests');
    expect(task.commitSha).toBeTruthy();
  });

  it('emits agent.status:waiting when entering awaiting_tests', async () => {
    mockContainerExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const taskId = await makeCoveredNoTests();
    await runDevJob(featureId, taskId, 'job-await-2');
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const waiting = events.find(
      (e) => e.type === 'agent.status' && (e.payload as { status: string }).status === 'waiting',
    );
    expect(waiting).not.toBeUndefined();
  });
});
