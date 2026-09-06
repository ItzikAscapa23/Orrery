import { describe, it, expect } from 'vitest';
import type { ContainerHandle, ContainerExecResult } from '../lib/container.js';
import {
  isTestCommand,
  toJsonReporterCommand,
  formatTestSummary,
  summarizeBashTestRun,
  TEST_COMMAND_PREFIXES,
} from '../lib/testOutputSummary.js';
import type { ParsedTestOutput } from '../jobs/testJob.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeContainer(
  handler: (cmd: string) => ContainerExecResult | Promise<ContainerExecResult>,
): ContainerHandle {
  return {
    name: 'test-container',
    exec: (cmd: string) => Promise.resolve(handler(cmd)),
    stop: async () => {},
  };
}

function makePassingJson(passed: number, failed = 0): string {
  const assertions = Array.from({ length: passed }, (_, i) => ({
    fullName: `passing test ${i}`,
    status: 'passed',
    duration: 10,
  }));
  return JSON.stringify({
    numPassedTests: passed,
    numFailedTests: failed,
    testResults: [{ assertionResults: assertions }],
  });
}

function makeFailingJson(
  passed: number,
  failures: Array<{ name: string; message: string }>,
): string {
  const assertions = [
    ...Array.from({ length: passed }, (_, i) => ({
      fullName: `passing test ${i}`,
      status: 'passed',
      duration: 10,
    })),
    ...failures.map((f) => ({
      fullName: f.name,
      status: 'failed',
      duration: 5,
      failureMessages: [f.message],
    })),
  ];
  return JSON.stringify({
    numPassedTests: passed,
    numFailedTests: failures.length,
    testResults: [{ assertionResults: assertions }],
  });
}

// ── isTestCommand ──────────────────────────────────────────────────────────

describe('isTestCommand', () => {
  it('returns true for each prefix in TEST_COMMAND_PREFIXES', () => {
    for (const prefix of TEST_COMMAND_PREFIXES) {
      expect(isTestCommand(prefix), `prefix: ${prefix}`).toBe(true);
      expect(isTestCommand(prefix + ' --extra'), `prefix + args: ${prefix}`).toBe(true);
    }
  });

  it('returns true for npm test', () => {
    expect(isTestCommand('npm test')).toBe(true);
  });

  it('returns true for npm run test with extra flags', () => {
    expect(isTestCommand('npm run test -- --watch')).toBe(true);
  });

  it('returns true for npx vitest run', () => {
    expect(isTestCommand('npx vitest run')).toBe(true);
  });

  it('returns true for npx jest --ci', () => {
    expect(isTestCommand('npx jest --ci')).toBe(true);
  });

  it('returns false for ls src/', () => {
    expect(isTestCommand('ls src/')).toBe(false);
  });

  it('returns false for npm install', () => {
    expect(isTestCommand('npm install')).toBe(false);
  });

  it('returns false for npx vitest without run', () => {
    // npx vitest (watch mode) is NOT intercepted — only `npx vitest run`
    expect(isTestCommand('npx vitest')).toBe(false);
  });

  it('returns false for cat package.json', () => {
    expect(isTestCommand('cat package.json')).toBe(false);
  });

  it('handles leading/trailing whitespace', () => {
    expect(isTestCommand('  npm test  ')).toBe(true);
  });
});

// ── toJsonReporterCommand ──────────────────────────────────────────────────

describe('toJsonReporterCommand', () => {
  it('maps npm test to vitest JSON reporter command', () => {
    expect(toJsonReporterCommand('npm test')).toBe(
      'npx vitest run --reporter=json --outputFile=/tmp/test-report.json',
    );
  });

  it('maps npm run test to vitest JSON reporter command', () => {
    expect(toJsonReporterCommand('npm run test')).toBe(
      'npx vitest run --reporter=json --outputFile=/tmp/test-report.json',
    );
  });

  it('maps npx vitest run to vitest JSON reporter command', () => {
    expect(toJsonReporterCommand('npx vitest run')).toBe(
      'npx vitest run --reporter=json --outputFile=/tmp/test-report.json',
    );
  });

  it('maps npx jest --ci to jest JSON reporter command', () => {
    expect(toJsonReporterCommand('npx jest --ci')).toBe(
      'npx jest --json --outputFile=/tmp/test-report.json',
    );
  });

  it('respects a custom reportFile path', () => {
    expect(toJsonReporterCommand('npm test', '/custom/report.json')).toBe(
      'npx vitest run --reporter=json --outputFile=/custom/report.json',
    );
  });
});

// ── formatTestSummary ──────────────────────────────────────────────────────

describe('formatTestSummary', () => {
  it('returns single line for all-passing run', () => {
    const parsed: ParsedTestOutput = {
      passed: 782,
      failed: 0,
      tests: [],
      authoredPassed: 0,
      authoredFailed: 0,
    };
    expect(formatTestSummary(parsed)).toBe('TESTS: 782 passed, 0 failed');
  });

  it('includes FAILURES block for failing run', () => {
    const parsed: ParsedTestOutput = {
      passed: 780,
      failed: 2,
      tests: [
        { test_name: 'should return 200', status: 'passed' },
        {
          test_name: 'rejects invalid token',
          status: 'failed',
          message: 'AssertionError: expected 200 got 401',
        },
        {
          test_name: 'handles missing body',
          status: 'failed',
          message: 'TypeError: Cannot read property id',
        },
      ],
      authoredPassed: 0,
      authoredFailed: 0,
    };
    const result = formatTestSummary(parsed);
    expect(result).toContain('TESTS: 780 passed, 2 failed');
    expect(result).toContain('FAILURES:');
    expect(result).toContain('· "rejects invalid token" — AssertionError: expected 200 got 401');
    expect(result).toContain('· "handles missing body" — TypeError: Cannot read property id');
  });

  it('does not include passing test names in failures block', () => {
    const parsed: ParsedTestOutput = {
      passed: 1,
      failed: 1,
      tests: [
        { test_name: 'passing test should NOT appear', status: 'passed' },
        { test_name: 'failing test', status: 'failed', message: 'boom' },
      ],
      authoredPassed: 0,
      authoredFailed: 0,
    };
    const result = formatTestSummary(parsed);
    expect(result).not.toContain('passing test should NOT appear');
    expect(result).toContain('failing test');
  });

  it('truncates failure messages at 200 chars', () => {
    const longMessage = 'x'.repeat(300);
    const parsed: ParsedTestOutput = {
      passed: 0,
      failed: 1,
      tests: [{ test_name: 'foo', status: 'failed', message: longMessage }],
      authoredPassed: 0,
      authoredFailed: 0,
    };
    const result = formatTestSummary(parsed);
    // The failure line should contain the truncated message (200 chars of x)
    expect(result).toContain('x'.repeat(200));
    expect(result).not.toContain('x'.repeat(201));
  });

  it('formats a failure without a message', () => {
    const parsed: ParsedTestOutput = {
      passed: 0,
      failed: 1,
      tests: [{ test_name: 'nameless failure', status: 'failed' }],
      authoredPassed: 0,
      authoredFailed: 0,
    };
    const result = formatTestSummary(parsed);
    expect(result).toContain('· "nameless failure"');
  });

  it('includes file count in header when fileCount is set', () => {
    const parsed: ParsedTestOutput = {
      passed: 100,
      failed: 0,
      tests: [],
      authoredPassed: 0,
      authoredFailed: 0,
      fileCount: 7,
    };
    expect(formatTestSummary(parsed)).toBe('TESTS: 100 passed, 0 failed (7 files)');
  });

  it('uses singular "file" when fileCount is 1', () => {
    const parsed: ParsedTestOutput = {
      passed: 5,
      failed: 0,
      tests: [],
      authoredPassed: 0,
      authoredFailed: 0,
      fileCount: 1,
    };
    expect(formatTestSummary(parsed)).toBe('TESTS: 5 passed, 0 failed (1 file)');
  });

  it('omits file count when fileCount is not set', () => {
    const parsed: ParsedTestOutput = {
      passed: 10,
      failed: 0,
      tests: [],
      authoredPassed: 0,
      authoredFailed: 0,
    };
    expect(formatTestSummary(parsed)).toBe('TESTS: 10 passed, 0 failed');
  });
});

// ── summarizeBashTestRun ───────────────────────────────────────────────────

describe('summarizeBashTestRun', () => {
  it('returns null for a non-test command', async () => {
    const container = makeContainer(() => {
      throw new Error('should not be called');
    });
    const result = await summarizeBashTestRun('ls src/', container);
    expect(result).toBeNull();
  });

  it('returns compact passing summary for a clean run', async () => {
    const reportJson = makePassingJson(5);
    const container = makeContainer((cmd) => {
      if (cmd.startsWith('npx vitest run --reporter=json'))
        return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd.startsWith('cat ')) return { exitCode: 0, stdout: reportJson, stderr: '' };
      throw new Error(`unexpected command: ${cmd}`);
    });
    const result = await summarizeBashTestRun('npm test', container);
    // makePassingJson produces 1 testResults entry → (1 file)
    expect(result?.summary).toBe('TESTS: 5 passed, 0 failed (1 file)');
    expect(result?.resolvedCommand).toContain('npx vitest run');
    expect(result?.reportPath).toMatch(/^\/tmp\/test-report-/);
  });

  it('returns failures block for a failing run', async () => {
    const reportJson = makeFailingJson(3, [
      {
        name: 'should return 200 for valid token',
        message: 'AssertionError: expected 200 got 401',
      },
      { name: 'rejects missing body', message: 'TypeError: Cannot read property id' },
    ]);
    const container = makeContainer((cmd) => {
      if (cmd.startsWith('npx vitest run --reporter=json'))
        return { exitCode: 1, stdout: '', stderr: 'FAIL' };
      if (cmd.startsWith('cat ')) return { exitCode: 0, stdout: reportJson, stderr: '' };
      throw new Error(`unexpected command: ${cmd}`);
    });
    const result = await summarizeBashTestRun('npm test', container);
    expect(result).not.toBeNull();
    expect(result?.summary).toContain('TESTS: 3 passed, 2 failed');
    expect(result?.summary).toContain('FAILURES:');
    expect(result?.summary).toContain('· "should return 200 for valid token"');
    expect(result?.summary).toContain('AssertionError: expected 200 got 401');
    expect(result?.summary).not.toContain('passing test 0');
    expect(result?.resolvedCommand).toContain('npx vitest run');
    expect(result?.reportPath).toMatch(/^\/tmp\/test-report-/);
  });

  it('falls back to raw output with label when JSON is unparseable', async () => {
    const container = makeContainer((cmd) => {
      if (cmd.startsWith('npx vitest run --reporter=json'))
        return { exitCode: 1, stdout: 'FAIL 3 tests\n', stderr: 'some error' };
      if (cmd.startsWith('cat ')) return { exitCode: 1, stdout: 'not json garbage', stderr: '' };
      throw new Error(`unexpected command: ${cmd}`);
    });
    const result = await summarizeBashTestRun('npm test', container);
    expect(result).not.toBeNull();
    expect(result?.summary).toContain('[raw output — JSON summary unavailable]');
    expect(result?.summary).toContain('FAIL 3 tests');
  });

  it('summary is materially smaller than 8192 chars for a 2-failure run', async () => {
    const reportJson = makeFailingJson(700, [
      { name: 'fails A', message: 'AssertionError: expected 200 got 401' },
      { name: 'fails B', message: 'TypeError: Cannot read property id' },
    ]);
    const container = makeContainer((cmd) => {
      if (cmd.startsWith('npx vitest run --reporter=json'))
        return { exitCode: 1, stdout: '', stderr: '' };
      if (cmd.startsWith('cat ')) return { exitCode: 0, stdout: reportJson, stderr: '' };
      throw new Error(`unexpected command: ${cmd}`);
    });
    const result = await summarizeBashTestRun('npm test', container);
    expect(result).not.toBeNull();
    expect(result!.summary.length).toBeLessThan(400);
    // Confirm the full raw JSON would have been much larger
    expect(reportJson.length).toBeGreaterThan(8192);
  });

  it('uses the jest command for npx jest --ci', async () => {
    const reportJson = makePassingJson(10);
    const execCmds: string[] = [];
    const container = makeContainer((cmd) => {
      execCmds.push(cmd);
      if (cmd.startsWith('npx jest --json')) return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd.startsWith('cat ')) return { exitCode: 0, stdout: reportJson, stderr: '' };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await summarizeBashTestRun('npx jest --ci', container);
    // First call is the rewritten jest command; second is cat
    expect(execCmds[0]).toContain('npx jest --json');
  });

  it('summarises npm test 2>&1 (2>&1 is not a metachar violation)', async () => {
    const reportJson = makePassingJson(3);
    const container = makeContainer((cmd) => {
      if (cmd.startsWith('npx vitest run --reporter=json'))
        return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd.startsWith('cat ')) return { exitCode: 0, stdout: reportJson, stderr: '' };
      throw new Error(`unexpected command: ${cmd}`);
    });
    const result = await summarizeBashTestRun('npm test 2>&1', container);
    expect(result).not.toBeNull();
    expect(result?.summary).toContain('3 passed');
  });

  it('summarises npx jest foo.test.js 2>&1', async () => {
    const reportJson = makePassingJson(1);
    const execCmds: string[] = [];
    const container = makeContainer((cmd) => {
      execCmds.push(cmd);
      if (cmd.startsWith('npx jest --json')) return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd.startsWith('cat ')) return { exitCode: 0, stdout: reportJson, stderr: '' };
      throw new Error(`unexpected command: ${cmd}`);
    });
    const result = await summarizeBashTestRun('npx jest foo.test.js 2>&1', container);
    expect(result).not.toBeNull();
    expect(result?.summary).toContain('1 passed');
    expect(execCmds[0]).toContain('npx jest --json');
  });

  it("returns raw output labeled 'zero tests reported' when JSON reports zero total", async () => {
    const reportJson = makePassingJson(0);
    const container = makeContainer((cmd) => {
      if (cmd.startsWith('npx vitest run --reporter=json'))
        return { exitCode: 0, stdout: 'some runner output', stderr: '' };
      if (cmd.startsWith('cat ')) return { exitCode: 0, stdout: reportJson, stderr: '' };
      throw new Error(`unexpected command: ${cmd}`);
    });
    const result = await summarizeBashTestRun('npm test', container);
    expect(result).not.toBeNull();
    expect(result?.summary).toContain('[raw output — zero tests reported]');
    expect(result?.summary).toContain('some runner output');
    expect(result?.summary).not.toContain('TESTS:');
  });

  it('returns null for a command with a real pipe (| is still blocked)', async () => {
    const container = makeContainer(() => {
      throw new Error('should not be called');
    });
    const result = await summarizeBashTestRun('npm test | grep PASS', container);
    expect(result).toBeNull();
  });

  it('grafts --maxWorkers=2 from probe_command onto npx jest foo.test.js', async () => {
    const reportJson = makePassingJson(3);
    const execCmds: string[] = [];
    const container = makeContainer((cmd) => {
      execCmds.push(cmd);
      if (cmd.startsWith('npx jest')) return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd.startsWith('cat ')) return { exitCode: 0, stdout: reportJson, stderr: '' };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await summarizeBashTestRun('npx jest foo.test.js', container, 'npm test -- --maxWorkers=2');
    expect(execCmds[0]).toContain('--maxWorkers=2');
    expect(execCmds[0]).toContain('foo.test.js');
    expect(execCmds[0]).toMatch(/^npx jest\b/);
    expect(execCmds[0]).toContain('--json');
  });

  it('npm test with no probe_command is unaffected (no --maxWorkers injected)', async () => {
    const reportJson = makePassingJson(2);
    const execCmds: string[] = [];
    const container = makeContainer((cmd) => {
      execCmds.push(cmd);
      if (cmd.startsWith('npx vitest run')) return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd.startsWith('cat ')) return { exitCode: 0, stdout: reportJson, stderr: '' };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await summarizeBashTestRun('npm test', container);
    expect(execCmds[0]).not.toContain('--maxWorkers');
  });

  it('preserves positional path arg from npx jest foo.test.js without probe_command', async () => {
    const reportJson = makePassingJson(1);
    const execCmds: string[] = [];
    const container = makeContainer((cmd) => {
      execCmds.push(cmd);
      if (cmd.startsWith('npx jest')) return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd.startsWith('cat ')) return { exitCode: 0, stdout: reportJson, stderr: '' };
      throw new Error(`unexpected command: ${cmd}`);
    });
    await summarizeBashTestRun('npx jest foo.test.js', container);
    expect(execCmds[0]).toContain('foo.test.js');
    expect(execCmds[0]).toContain('npx jest --json');
  });

  it('stale report from prior run is not returned — per-invocation path prevents false all-clear', async () => {
    // A vitest run fails (wrong runner). The per-invocation path was never written,
    // so cat returns empty → parse error → raw fallback. No stale data possible.
    const container = makeContainer((cmd) => {
      if (cmd.startsWith('npx vitest run --reporter=json'))
        return { exitCode: 1, stdout: 'vitest: command not found\n', stderr: '' };
      if (cmd.startsWith('cat '))
        return { exitCode: 1, stdout: '', stderr: 'No such file or directory' };
      throw new Error(`unexpected command: ${cmd}`);
    });
    const result = await summarizeBashTestRun('npm test', container);
    expect(result).not.toBeNull();
    expect(result?.summary).not.toContain('passed');
    expect(result?.summary).toContain('[raw output — JSON summary unavailable]');
    expect(result?.summary).toContain('vitest: command not found');
  });

  it('per-invocation paths are distinct across successive calls', async () => {
    const reportJson = makePassingJson(1);
    const catPaths: string[] = [];
    const container = makeContainer((cmd) => {
      if (cmd.startsWith('npx vitest run')) return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd.startsWith('cat ')) {
        catPaths.push(cmd.split(' ')[1]!);
        return { exitCode: 0, stdout: reportJson, stderr: '' };
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    await summarizeBashTestRun('npm test', container);
    await summarizeBashTestRun('npm test', container);
    expect(catPaths).toHaveLength(2);
    expect(catPaths[0]).not.toBe(catPaths[1]);
  });
});
