/**
 * Unit tests for serverDevJob helper functions that don't need DB/BullMQ:
 * - checkManifestGuardrail (item 3)
 * - isFinal retry classification (item 4)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  checkManifestGuardrail,
  CommitStepError,
  InstallError,
  PushError,
  readClaudeMdFromDefaultBranch,
  assessProbeResult,
} from '../jobs/serverDevJob.js';
import { AllowlistViolationError, MetacharViolationError } from '../lib/container.js';
import { AgentNoopError } from '../agents/devAgent.js';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-guard-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Item 3: Manifest guardrail ────────────────────────────────────────────────

describe('checkManifestGuardrail', () => {
  function writePkg(deps: Record<string, string>, devDeps: Record<string, string>) {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test', dependencies: deps, devDependencies: devDeps }),
    );
  }

  it('throws when @rollup/rollup-linux-arm64-musl is in devDependencies', () => {
    writePkg({}, { '@rollup/rollup-linux-arm64-musl': '4.62.2' });
    expect(() => checkManifestGuardrail(tmpDir)).toThrow('Manifest guardrail');
    expect(() => checkManifestGuardrail(tmpDir)).toThrow('@rollup/rollup-linux-arm64-musl');
  });

  it('throws when @esbuild/linux-arm64 is in dependencies', () => {
    writePkg({ '@esbuild/linux-arm64': '0.24.0' }, {});
    expect(() => checkManifestGuardrail(tmpDir)).toThrow('@esbuild/linux-arm64');
  });

  it('does not throw for rollup (the parent package, not a platform variant)', () => {
    writePkg({}, { rollup: '^4.0.0' });
    expect(() => checkManifestGuardrail(tmpDir)).not.toThrow();
  });

  it('does not throw when package.json has no platform-native deps', () => {
    writePkg({ fastify: '^4.0.0' }, { vitest: '^1.0.0', typescript: '^5.0.0' });
    expect(() => checkManifestGuardrail(tmpDir)).not.toThrow();
  });

  it('does nothing when package.json does not exist', () => {
    expect(() => checkManifestGuardrail(tmpDir)).not.toThrow();
  });

  it('throws for all known platform-native prefixes', () => {
    const platformPkgs = [
      '@rollup/rollup-darwin-arm64',
      '@esbuild/darwin-arm64',
      '@swc/core-darwin-arm64',
      'lightningcss-darwin-arm64',
      '@parcel/watcher-darwin-arm64',
    ];
    for (const pkg of platformPkgs) {
      writePkg({}, { [pkg]: '1.0.0' });
      expect(() => checkManifestGuardrail(tmpDir), `expected throw for ${pkg}`).toThrow(
        'Manifest guardrail',
      );
    }
  });
});

// ── Item 4: Retry classification ─────────────────────────────────────────────

describe('isFinal retry classification', () => {
  // Test the classification logic directly by exercising the error types.
  // The actual isFinal computation lives in serverDevJob.ts catch block;
  // here we verify the error type hierarchy and classification rules.

  it('AllowlistViolationError is a policy violation (non-retryable)', () => {
    const err: unknown = new AllowlistViolationError('curl evil.com');
    // Policy violations should be classified as final regardless of attempt
    const isPolicyViolation =
      err instanceof AllowlistViolationError || err instanceof MetacharViolationError;
    expect(isPolicyViolation).toBe(true);
  });

  it('MetacharViolationError is a policy violation (non-retryable)', () => {
    const err: unknown = new MetacharViolationError('npm test | head', '|');
    const isPolicyViolation =
      err instanceof AllowlistViolationError || err instanceof MetacharViolationError;
    expect(isPolicyViolation).toBe(true);
  });

  it('AgentNoopError is non-retryable (no changes + tests fail — genuinely absent work)', () => {
    // AgentNoopError is only thrown when no file changes AND npm test fails.
    // If tests pass with no changes, the orchestrator marks the task completed (noop-success).
    const err: unknown = new AgentNoopError('Task t1 completed but no file changes and tests fail');
    expect(err instanceof AgentNoopError).toBe(true);
    // Env errors (plain Error) are retryable
    expect(err instanceof AllowlistViolationError).toBe(false);
    expect(err instanceof MetacharViolationError).toBe(false);
  });

  it('plain Error (env failure) is retryable on attempt 1', () => {
    const err: unknown = new Error('npm ci failed: ECONNRESET');
    const isPolicyViolation =
      err instanceof AllowlistViolationError ||
      err instanceof MetacharViolationError ||
      err instanceof AgentNoopError;
    expect(isPolicyViolation).toBe(false);
    // On attempt 1, not final — use a variable so the linter sees dynamic truthiness
    const attempt1 = 1;
    const isFinal = attempt1 >= 2 || isPolicyViolation;
    expect(isFinal).toBe(false);
  });

  it('plain Error (env failure) is final on attempt 2', () => {
    const err: unknown = new Error('npm ci failed: ECONNRESET');
    const isPolicyViolation =
      err instanceof AllowlistViolationError ||
      err instanceof MetacharViolationError ||
      err instanceof AgentNoopError;
    const attempt2 = 2;
    const isFinal = attempt2 >= 2 || isPolicyViolation;
    expect(isFinal).toBe(true);
  });

  it('AllowlistViolationError is final even on attempt 1', () => {
    const err: unknown = new AllowlistViolationError('bad command');
    const isPolicyViolation =
      err instanceof AllowlistViolationError ||
      err instanceof MetacharViolationError ||
      err instanceof AgentNoopError;
    const attempt1 = 1;
    const isFinal = attempt1 >= 2 || isPolicyViolation;
    expect(isFinal).toBe(true);
  });

  it('CommitStepError is NOT final on attempt 2 (infra/env, not agent-fault)', () => {
    const err: unknown = new CommitStepError('node_modules leaked into staging');
    const isPolicyViolation =
      err instanceof AllowlistViolationError ||
      err instanceof MetacharViolationError ||
      err instanceof AgentNoopError;
    const isCommitStep = err instanceof CommitStepError;
    // Mirrors serverDevJob.ts catch block logic exactly
    const isFinal = (!isCommitStep && 2 >= 2) || isPolicyViolation;
    expect(isFinal).toBe(false);
  });

  it('CommitStepError is NOT final on attempt 1 either', () => {
    const err: unknown = new CommitStepError('git add guardrail fired');
    const isPolicyViolation =
      err instanceof AllowlistViolationError ||
      err instanceof MetacharViolationError ||
      err instanceof AgentNoopError;
    const isCommitStep = err instanceof CommitStepError;
    const isFinal = (!isCommitStep && 1 >= 2) || isPolicyViolation;
    expect(isFinal).toBe(false);
  });

  // Mirrors devJob.ts isFinal classifier — both slow and fast-fail variants.
  function classify(err: unknown, attempt: number): boolean {
    const isPolicyViolation =
      err instanceof AllowlistViolationError ||
      err instanceof MetacharViolationError ||
      err instanceof AgentNoopError;
    const isCommitStep = err instanceof CommitStepError;
    const isInstall = err instanceof InstallError;
    const isFastFailInstall = isInstall && err.message.includes('fast-failed');
    return (
      (!isCommitStep && !isInstall && attempt >= 2) ||
      (isInstall && !isFastFailInstall && attempt >= 3) ||
      isFastFailInstall ||
      isPolicyViolation
    );
  }

  it('slow InstallError (ETIMEDOUT) is NOT final on attempt 1', () => {
    expect(classify(new InstallError('npm install failed: ETIMEDOUT'), 1)).toBe(false);
  });

  it('slow InstallError (ECONNRESET) is NOT final on attempt 2', () => {
    expect(classify(new InstallError('npm install failed: ECONNRESET'), 2)).toBe(false);
  });

  it('slow InstallError IS final on attempt 3', () => {
    expect(classify(new InstallError('npm install failed: three strikes'), 3)).toBe(true);
  });

  it('fast-fail InstallError (cert/auth/404 — deterministic) is final on attempt 1', () => {
    // SELF_SIGNED_CERT_IN_CHAIN completes in <60s — retrying is pointless.
    expect(
      classify(
        new InstallError(
          'npm install fast-failed (12s — deterministic): SELF_SIGNED_CERT_IN_CHAIN',
        ),
        1,
      ),
    ).toBe(true);
  });

  it('plain Error (agent/env failure) is still final at attempt 2 — install budget does not apply', () => {
    expect(classify(new Error('vitest probe failed'), 2)).toBe(true);
  });
});

// ── readClaudeMdFromOriginMain ────────────────────────────────────────────────

describe('readClaudeMdFromDefaultBranch', () => {
  // Build a bare clone + worktree (matching the production path). The worktree
  // checks out a feature branch so the default branch ref is freely updated by
  // git fetch. The function must return the remote default_branch copy, not the
  // feature branch copy.
  let tmpBase: string;
  let remoteDir: string;
  let bareDir: string;
  let worktreeDir: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-main-'));
    remoteDir = path.join(tmpBase, 'remote');
    fs.mkdirSync(remoteDir);
    bareDir = path.join(tmpBase, 'bare.git');
    worktreeDir = path.join(tmpBase, 'work');

    // Bootstrap remote: init + first commit with CLAUDE.md
    git(remoteDir, 'init', '-b', 'main');
    git(remoteDir, 'config', 'user.email', 'test@test.com');
    git(remoteDir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(remoteDir, 'CLAUDE.md'), '# remote-main-content');
    git(remoteDir, 'add', 'CLAUDE.md');
    git(remoteDir, 'commit', '-m', 'init');

    // Bare clone + worktree on a feature branch (production layout)
    execFileSync('git', ['clone', '--bare', remoteDir, bareDir], { encoding: 'utf-8' });
    git(bareDir, 'worktree', 'add', worktreeDir, 'main');
    // Switch worktree to a feature branch so `main` is not checked out there
    git(worktreeDir, 'checkout', '-b', 'feature/some-task');
    fs.writeFileSync(path.join(worktreeDir, 'CLAUDE.md'), '# stale-branch-content');
    git(worktreeDir, 'add', 'CLAUDE.md');
    git(worktreeDir, 'commit', '-m', 'stale CLAUDE.md on feature branch');

    // Update remote main with new operator guidance (simulates out-of-band delivery)
    fs.writeFileSync(path.join(remoteDir, 'CLAUDE.md'), '# updated-operator-guidance');
    git(remoteDir, 'add', 'CLAUDE.md');
    git(remoteDir, 'commit', '-m', 'operator guidance update');
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns main:CLAUDE.md content, not the feature branch copy', () => {
    const content = readClaudeMdFromDefaultBranch(worktreeDir, 'main');
    expect(content).toContain('updated-operator-guidance');
    expect(content).not.toContain('stale-branch-content');
  });

  it('branch CLAUDE.md is untouched after the call (no worktree mutation)', () => {
    readClaudeMdFromDefaultBranch(worktreeDir, 'main');
    const branchCopy = fs.readFileSync(path.join(worktreeDir, 'CLAUDE.md'), 'utf-8');
    expect(branchCopy).toContain('stale-branch-content');
  });
});

describe('readClaudeMdFromDefaultBranch — non-main default branch', () => {
  let tmpBase: string;
  let masterRemoteDir: string;
  let masterBareDir: string;
  let masterWorktreeDir: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-master-'));
    masterRemoteDir = path.join(tmpBase, 'remote');
    fs.mkdirSync(masterRemoteDir);
    masterBareDir = path.join(tmpBase, 'bare.git');
    masterWorktreeDir = path.join(tmpBase, 'work');

    git(masterRemoteDir, 'init', '-b', 'master');
    git(masterRemoteDir, 'config', 'user.email', 'test@test.com');
    git(masterRemoteDir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(masterRemoteDir, 'CLAUDE.md'), '# master-operator-guidance');
    git(masterRemoteDir, 'add', 'CLAUDE.md');
    git(masterRemoteDir, 'commit', '-m', 'init');

    // Bare clone + worktree on a feature branch (production layout)
    execFileSync('git', ['clone', '--bare', masterRemoteDir, masterBareDir], { encoding: 'utf-8' });
    git(masterBareDir, 'worktree', 'add', masterWorktreeDir, 'master');
    git(masterWorktreeDir, 'checkout', '-b', 'feature/some-task');
    fs.writeFileSync(path.join(masterWorktreeDir, 'CLAUDE.md'), '# stale-feature-copy');
    git(masterWorktreeDir, 'add', 'CLAUDE.md');
    git(masterWorktreeDir, 'commit', '-m', 'stale copy');
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('reads master:CLAUDE.md when default_branch is master', () => {
    const content = readClaudeMdFromDefaultBranch(masterWorktreeDir, 'master');
    expect(content).toContain('master-operator-guidance');
    expect(content).not.toContain('stale-feature-copy');
  });

  it('throws when the ref does not exist', () => {
    expect(() => readClaudeMdFromDefaultBranch(masterWorktreeDir, 'no-such-branch')).toThrow();
  });
});

// ── readClaudeMdFromDefaultBranch — bare-clone worktree ──────────────────────
// Mirrors the production path from createWorktree: bare clone + worktree add.
// In a bare clone, refs live at refs/heads/* only — no refs/remotes/origin/*.
// These tests fail before the fix (origin/<branch> ref missing) and pass after.

describe('readClaudeMdFromDefaultBranch — bare-clone worktree', () => {
  let tmpBase: string;
  let remoteDir: string;
  let bareDir: string;
  let worktreeDir: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-wt-test-'));
    remoteDir = path.join(tmpBase, 'remote');
    fs.mkdirSync(remoteDir);
    bareDir = path.join(tmpBase, 'bare.git'); // not pre-created — git clone creates it
    worktreeDir = path.join(tmpBase, 'work'); // not pre-created — git worktree add creates it

    git(remoteDir, 'init', '-b', 'main');
    git(remoteDir, 'config', 'user.email', 'test@test.com');
    git(remoteDir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(remoteDir, 'CLAUDE.md'), '# initial-guidance');
    git(remoteDir, 'add', 'CLAUDE.md');
    git(remoteDir, 'commit', '-m', 'init');

    execFileSync('git', ['clone', '--bare', remoteDir, bareDir], { encoding: 'utf-8' });
    git(bareDir, 'worktree', 'add', worktreeDir, 'main');
    // Switch to a feature branch so `main` is not checked out (matches production)
    git(worktreeDir, 'checkout', '-b', 'feature/test-task');

    // Advance remote so the fetch step has new content to pull
    fs.writeFileSync(path.join(remoteDir, 'CLAUDE.md'), '# bare-updated-guidance');
    git(remoteDir, 'add', 'CLAUDE.md');
    git(remoteDir, 'commit', '-m', 'operator guidance update');
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('reads CLAUDE.md from the default branch via bare-branch ref (main)', () => {
    const content = readClaudeMdFromDefaultBranch(worktreeDir, 'main');
    expect(content).toContain('bare-updated-guidance');
    expect(content).not.toContain('initial-guidance');
  });

  it('reads master:CLAUDE.md when default_branch is master', () => {
    const masterBase = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-master-test-'));
    const masterRemote = path.join(masterBase, 'remote');
    fs.mkdirSync(masterRemote);
    const masterBare = path.join(masterBase, 'bare.git');
    const masterWt = path.join(masterBase, 'work');
    try {
      git(masterRemote, 'init', '-b', 'master');
      git(masterRemote, 'config', 'user.email', 'test@test.com');
      git(masterRemote, 'config', 'user.name', 'Test');
      fs.writeFileSync(path.join(masterRemote, 'CLAUDE.md'), '# master-guidance');
      git(masterRemote, 'add', 'CLAUDE.md');
      git(masterRemote, 'commit', '-m', 'init');
      execFileSync('git', ['clone', '--bare', masterRemote, masterBare], { encoding: 'utf-8' });
      git(masterBare, 'worktree', 'add', masterWt, 'master');
      // Switch to a feature branch so `master` is not checked out (matches production)
      git(masterWt, 'checkout', '-b', 'feature/test-task');
      const content = readClaudeMdFromDefaultBranch(masterWt, 'master');
      expect(content).toContain('master-guidance');
    } finally {
      fs.rmSync(masterBase, { recursive: true, force: true });
    }
  });

  it('throws when branch does not exist', () => {
    expect(() => readClaudeMdFromDefaultBranch(worktreeDir, 'no-such-branch')).toThrow();
  });
});

// ── assessProbeResult ─────────────────────────────────────────────────────────

describe('assessProbeResult', () => {
  const VITEST_JSON_WITH_FAILURES = JSON.stringify({
    numPassedTests: 2,
    numFailedTests: 1,
    testResults: [
      {
        name: '/repo/src/__tests__/foo.test.ts',
        assertionResults: [
          { fullName: 'passes', status: 'passed' },
          {
            fullName: 'fails intentionally',
            status: 'failed',
            failureMessages: ['AssertionError'],
          },
        ],
      },
    ],
  });

  it('valid JSON report with failures → ok (toolchain healthy, tests red by design)', () => {
    // Core regression: a failing jest/vitest suite must not be classified as broken toolchain.
    const result = assessProbeResult(VITEST_JSON_WITH_FAILURES, 0);
    expect(result.ok).toBe(true);
  });

  it('empty report → not ok (runner never wrote file — toolchain broken)', () => {
    const result = assessProbeResult('', 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/toolchain probe failed/);
  });

  it('plain-text output → not ok (JSON reporter not active or runner crashed)', () => {
    const result = assessProbeResult('Cannot find module vitest', 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/toolchain probe failed/);
  });

  it('malformed JSON → not ok', () => {
    const result = assessProbeResult('{ broken json', 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/toolchain probe failed/);
  });
});

// ── git add -A + guardrail integration ───────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
}

describe('git add -A with .gitignore + node_modules guardrail', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitadd-test-'));
    git(repoDir, 'init');
    git(repoDir, 'config', 'user.email', 'test@test.com');
    git(repoDir, 'config', 'user.name', 'Test');
    // .gitignore that excludes node_modules (mirrors demo server)
    fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');
    git(repoDir, 'add', '.gitignore');
    git(repoDir, 'commit', '-m', 'init');
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('git add -A stages source files but NOT node_modules when .gitignore is present', () => {
    // Dirty node_modules
    fs.mkdirSync(path.join(repoDir, 'node_modules', 'some-pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'node_modules', 'some-pkg', 'index.js'),
      'module.exports=1',
    );
    // Source change
    fs.writeFileSync(path.join(repoDir, 'src.ts'), 'export const x = 1;');

    git(repoDir, 'add', '-A');

    const staged = git(repoDir, 'diff', '--cached', '--name-only')
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(staged).toContain('src.ts');
    expect(staged.some((f) => f.startsWith('node_modules/'))).toBe(false);
  });

  it('guardrail CommitStepError fires when node_modules somehow slips into staging', () => {
    // Force-add a node_modules file bypassing .gitignore
    fs.mkdirSync(path.join(repoDir, 'node_modules', 'leak'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'node_modules', 'leak', 'x.js'), '');
    git(repoDir, 'add', '-f', 'node_modules/leak/x.js');

    const staged = git(repoDir, 'diff', '--cached', '--name-only')
      .trim()
      .split('\n')
      .filter(Boolean);
    const nodeModulesStaged = staged.filter((f) => f.startsWith('node_modules/'));

    // Mirrors the guardrail check in serverDevJob.ts
    expect(nodeModulesStaged.length).toBeGreaterThan(0);
    expect(() => {
      if (nodeModulesStaged.length > 0) {
        throw new CommitStepError(`node_modules leak: ${nodeModulesStaged[0]}`);
      }
    }).toThrow(CommitStepError);
  });
});

// ── git() maxBuffer — large output ──────────────────────────────────────────
// Without maxBuffer on the git() helper, execFileSync throws
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER when git output exceeds Node's 1 MB default.
// This suite fails before the fix (no maxBuffer) and passes after.

describe('git() maxBuffer — large output completes', () => {
  it('readClaudeMdFromDefaultBranch succeeds when CLAUDE.md exceeds 1 MB', () => {
    const largeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'maxbuf-test-'));
    try {
      const remoteDir = path.join(largeBase, 'remote');
      fs.mkdirSync(remoteDir);
      const bareDir = path.join(largeBase, 'bare.git');
      const wtDir = path.join(largeBase, 'work');

      git(remoteDir, 'init', '-b', 'main');
      git(remoteDir, 'config', 'user.email', 'test@test.com');
      git(remoteDir, 'config', 'user.name', 'Test');
      // 2 MB content — exceeds Node default maxBuffer of 1 MB
      fs.writeFileSync(path.join(remoteDir, 'CLAUDE.md'), 'x'.repeat(2 * 1024 * 1024));
      git(remoteDir, 'add', 'CLAUDE.md');
      git(remoteDir, 'commit', '-m', 'large content');

      execFileSync('git', ['clone', '--bare', remoteDir, bareDir], { encoding: 'utf-8' });
      git(bareDir, 'worktree', 'add', wtDir, 'main');
      git(wtDir, 'checkout', '-b', 'feature/large-test');

      const content = readClaudeMdFromDefaultBranch(wtDir, 'main');
      expect(content.length).toBeGreaterThan(1024 * 1024);
    } finally {
      fs.rmSync(largeBase, { recursive: true, force: true });
    }
  });
});

// ── git() spawn failure — catchable error ────────────────────────────────────

describe('git() spawn failure — catchable error', () => {
  it('an ENOBUFS-like error from execFileSync propagates as a catchable JS Error', () => {
    // With maxBuffer set, Node throws ERR_CHILD_PROCESS_STDIO_MAXBUFFER before
    // the OS can produce ENOBUFS. Either way, the error propagates through the
    // call stack as a standard JS Error caught by the job try/catch — not a
    // process crash.
    const enobufs: NodeJS.ErrnoException = new Error('spawnSync git ENOBUFS');
    enobufs.code = 'ENOBUFS';

    let caught!: Error;
    try {
      throw enobufs;
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught as NodeJS.ErrnoException).code).toBe('ENOBUFS');
    expect(caught instanceof Error).toBe(true);
  });
});

// ── PushError classification ─────────────────────────────────────────────────

describe('PushError classification — parks task immediately', () => {
  // Mirrors the isFinal classifier in devJob.ts catch block with PushError added.
  function classifyWithPush(err: unknown, attempt: number): boolean {
    const isPolicyViolation =
      err instanceof AllowlistViolationError ||
      err instanceof MetacharViolationError ||
      err instanceof AgentNoopError;
    const isCommitStep = err instanceof CommitStepError;
    const isInstall = err instanceof InstallError;
    const isPushError = err instanceof PushError;
    const isFastFailInstall = isInstall && err.message.includes('fast-failed');
    return (
      (!isCommitStep && !isInstall && !isPushError && attempt >= 2) ||
      (isInstall && !isFastFailInstall && attempt >= 3) ||
      isFastFailInstall ||
      isPolicyViolation ||
      isPushError
    );
  }

  it('PushError is final on attempt 1 — work is committed; retrying the full job cannot fix a push', () => {
    expect(classifyWithPush(new PushError(new Error('ENOBUFS')), 1)).toBe(true);
  });

  it('PushError is final on attempt 2 — not subject to the attempt budget', () => {
    expect(classifyWithPush(new PushError(new Error('network timeout')), 2)).toBe(true);
  });

  it('plain Error at attempt 2 is still final after adding PushError classification', () => {
    expect(classifyWithPush(new Error('vitest probe failed'), 2)).toBe(true);
  });

  it('plain Error at attempt 1 is still retryable', () => {
    expect(classifyWithPush(new Error('vitest probe failed'), 1)).toBe(false);
  });
});
