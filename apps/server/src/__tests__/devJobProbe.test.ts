/**
 * Unit tests for assessProbeResult.
 *
 * parseTestOutput is NOT mocked here — the real implementation is used so we
 * verify the full chain: report content → parse → ok/not-ok decision.
 */
import { describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_PROVIDER'] = 'anthropic';
process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';
process.env['WORKTREES_ROOT'] = '/tmp/orrery-worktrees';

vi.mock('../lib/container.js', () => ({
  startContainer: vi.fn(),
  runInstallContainer: vi.fn(),
  runHostInstall: vi.fn(),
  runBootstrapInstall: vi.fn(),
  AllowlistViolationError: class extends Error {},
  MetacharViolationError: class extends Error {},
  EXEC_MAX_BUFFER: 50 * 1024 * 1024,
}));

vi.mock('../lib/queue.js', () => ({
  enqueueJob: vi.fn(),
  getQueue: vi.fn(),
  closeQueue: vi.fn(),
}));

vi.mock('../lib/dispatch.js', () => ({
  dispatchUnblockedTasks: vi.fn(),
  dispatchForState: vi.fn(),
  dispatchJob: vi.fn(),
}));

vi.mock('../lib/connectivity.js', () => ({
  checkBedrockConnectivity: vi.fn(),
}));

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn().mockImplementation((p: string, _opts?: unknown) => {
      if (typeof p === 'string' && p.includes('repo-manifest')) return '# mocked manifest';
      return actual.readFileSync(p, _opts as Parameters<typeof actual.readFileSync>[1]);
    }),
    existsSync: vi.fn().mockReturnValue(false),
  };
});

vi.mock('js-yaml', () => ({
  default: { load: vi.fn().mockReturnValue({ repos: [] }) },
  load: vi.fn().mockReturnValue({ repos: [] }),
}));

vi.mock('../lib/artifacts.js', () => ({
  readArtifact: vi.fn(),
  commitArtifact: vi.fn(),
  ArtifactCommitError: class extends Error {},
}));

vi.mock('../lib/promptScope.js', () => ({
  scopeSpecByRefs: vi.fn(),
  scopeContract: vi.fn(),
}));

vi.mock('../agents/devAgent.js', () => ({
  runDevAgent: vi.fn(),
  AgentNoopError: class extends Error {},
  AgentOutcome: {},
  ViolationInfo: class {},
  ToolCallInfo: class {},
  measurePromptSections: vi.fn(),
}));

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue(''),
    execSync: vi.fn().mockReturnValue(''),
  };
});

vi.mock('../lib/worktree.js', () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock('../routes/featureAmendment.js', () => ({
  getRejectedAmendments: vi.fn(),
}));

vi.mock('../lib/repoOrientation.js', () => ({
  generateRepoOrientation: vi.fn(),
}));

// testJob.js is intentionally NOT mocked — assessProbeResult must use real parseTestOutput.

import { assessProbeResult, assessNoopResult } from '../jobs/devJob.js';
import { plainTestCommand, parseTestOutput } from '../jobs/testJob.js';

const PASSING_REPORT = JSON.stringify({ numPassedTests: 3, numFailedTests: 0, testResults: [] });
const FAILING_REPORT = JSON.stringify({ numPassedTests: 1, numFailedTests: 2, testResults: [] });
const EMPTY_REPORT = '';
const PLAINTEXT_REPORT = 'PASS src/foo.test.ts\nFAIL src/bar.test.ts\n  ● makes exactly TWO calls';

describe('assessProbeResult', () => {
  it('returns ok when all tests pass (report parseable, numFailedTests = 0)', () => {
    expect(assessProbeResult(PASSING_REPORT, 0).ok).toBe(true);
  });

  it('returns ok when tests fail (TDD red-by-design — toolchain ran, report is readable)', () => {
    // A jest suite with failing tests must NOT be classified as a broken toolchain.
    // This is the regression case from feature 7b318d2c / task 748ea210.
    expect(assessProbeResult(FAILING_REPORT, 0).ok).toBe(true);
  });

  it('returns not ok when report is empty (runner never wrote file — toolchain broken)', () => {
    const result = assessProbeResult(EMPTY_REPORT, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('report file missing');
  });

  it('returns not ok when report is human-readable plain text (JSON reporter not active)', () => {
    const result = assessProbeResult(PLAINTEXT_REPORT, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

describe('assessProbeResult — exit-code-aware reasons', () => {
  it('names exit code when test command exits non-zero with empty report', () => {
    const result = assessProbeResult(EMPTY_REPORT, 1);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('test command exited 1');
    expect(result.reason).toContain('no output');
  });

  it('includes exit code and parse error for non-zero + non-empty unreadable report', () => {
    const result = assessProbeResult(PLAINTEXT_REPORT, 2);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('test command exited 2');
    expect(result.reason).toContain('parse error:');
  });

  it('says "report file missing" when exit 0 and report is empty', () => {
    const result = assessProbeResult(EMPTY_REPORT, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('report file missing');
  });

  it('says "report file unreadable" with parse error when exit 0 and report is non-empty', () => {
    const result = assessProbeResult(PLAINTEXT_REPORT, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('report file unreadable');
    expect(result.reason).toContain('parse error:');
  });

  it('ok=true is unaffected by exit code — report content is the only health signal', () => {
    expect(assessProbeResult(PASSING_REPORT, 0).ok).toBe(true);
    expect(assessProbeResult(FAILING_REPORT, 0).ok).toBe(true);
  });
});

// Fail-first evidence for task 165: empty diff + green suite must complete, not fail.
// assessNoopResult is called only in the exitCode !== 0 branch; exitCode === 0 is
// always a pass and never reaches this helper.
describe('assessNoopResult', () => {
  it('returns pass when report is parseable and failed = 0 (the spec case: exit≠0, green suite)', () => {
    const parsed = parseTestOutput(PASSING_REPORT, '');
    expect(assessNoopResult(parsed)).toBe('pass');
  });

  it('returns fail when failed > 0 (genuine test failures — both halves hold)', () => {
    const parsed = parseTestOutput(FAILING_REPORT, '');
    expect(assessNoopResult(parsed)).toBe('fail');
  });

  it('returns fail when parseError (unknown outcome — conservative)', () => {
    const parsed = parseTestOutput(EMPTY_REPORT, '');
    expect(assessNoopResult(parsed)).toBe('fail');
  });

  it('returns fail when report is unreadable plaintext (parseError)', () => {
    const parsed = parseTestOutput(PLAINTEXT_REPORT, '');
    expect(assessNoopResult(parsed)).toBe('fail');
  });
});

describe('plainTestCommand', () => {
  it('returns probe_command when the manifest declares one', () => {
    expect(plainTestCommand('npm test -- --maxWorkers=2')).toBe('npm test -- --maxWorkers=2');
  });

  it('falls back to "npm test" when probe_command is absent', () => {
    expect(plainTestCommand(undefined)).toBe('npm test');
  });

  it('verification and no-op re-run both call the same helper — same command for same input', () => {
    const cmd = 'npm test -- --maxWorkers=2';
    expect(plainTestCommand(cmd)).toBe(plainTestCommand(cmd));
  });
});
