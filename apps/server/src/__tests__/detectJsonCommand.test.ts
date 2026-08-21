import { describe, expect, it } from 'vitest';
import { detectJsonCommand, parseTestOutput, TEST_REPORT_FILE } from '../jobs/testJob.js';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';
process.env['WORKTREES_ROOT'] = '/tmp/test-worktrees';

describe('detectJsonCommand — no probeCommand (fallback inference)', () => {
  it('returns vitest command by default', () => {
    expect(detectJsonCommand('# CLAUDE.md\nnpm test\n')).toBe(
      `npx vitest run --reporter=json --outputFile=${TEST_REPORT_FILE}`,
    );
  });

  it('returns jest command when jest appears but not vitest', () => {
    expect(detectJsonCommand('test: npx jest --coverage')).toBe(
      `npx jest --json --outputFile=${TEST_REPORT_FILE}`,
    );
  });

  it('returns vitest command when both appear', () => {
    // vitest takes priority over jest when both keywords present
    expect(detectJsonCommand('vitest and jest both listed')).toBe(
      `npx vitest run --reporter=json --outputFile=${TEST_REPORT_FILE}`,
    );
  });

  it('vitest command includes --outputFile flag', () => {
    expect(detectJsonCommand('npm test')).toContain('--outputFile=');
  });

  it('jest command includes --outputFile flag', () => {
    expect(detectJsonCommand('npx jest --coverage')).toContain('--outputFile=');
  });

  it('undefined probeCommand falls back to jest inference', () => {
    expect(detectJsonCommand('npx jest --coverage', undefined)).toBe(
      `npx jest --json --outputFile=${TEST_REPORT_FILE}`,
    );
  });

  it('undefined probeCommand falls back to vitest inference', () => {
    expect(detectJsonCommand('npx vitest run', undefined)).toBe(
      `npx vitest run --reporter=json --outputFile=${TEST_REPORT_FILE}`,
    );
  });
});

describe('detectJsonCommand — with probeCommand (manifest entry takes precedence)', () => {
  it('jest repo: appends JSON flags to probe_command, preserving existing flags', () => {
    // bff manifest: probe_command = "npm test -- --maxWorkers=2"
    expect(detectJsonCommand('npx jest --coverage', 'npm test -- --maxWorkers=2')).toBe(
      `npm test -- --maxWorkers=2 --json --outputFile=${TEST_REPORT_FILE}`,
    );
  });

  it('jest repo: deduplicates --json if probe_command already contains it', () => {
    expect(detectJsonCommand('npx jest', 'npm test -- --json --maxWorkers=2')).toBe(
      `npm test -- --maxWorkers=2 --json --outputFile=${TEST_REPORT_FILE}`,
    );
  });

  it('vitest repo: replaces reporter flags in probe_command with canonical ones', () => {
    // demo-server manifest: probe_command already has --reporter=json
    expect(
      detectJsonCommand('npx vitest run', 'npx vitest run --reporter=json --passWithNoTests'),
    ).toBe(`npx vitest run --passWithNoTests --reporter=json --outputFile=${TEST_REPORT_FILE}`);
  });

  it('vitest repo: appends reporter flags when probe_command has none', () => {
    // demo-client manifest: probe_command = "npm test -- --passWithNoTests"
    // CLAUDE.md does not mention vitest, so vitest is the default
    expect(detectJsonCommand('npm test', 'npm test -- --passWithNoTests')).toBe(
      `npm test -- --passWithNoTests --reporter=json --outputFile=${TEST_REPORT_FILE}`,
    );
  });

  it('vitest repo: deduplicates --outputFile if probe_command already contains it', () => {
    expect(detectJsonCommand('vitest', `npx vitest run --outputFile=${TEST_REPORT_FILE}`)).toBe(
      `npx vitest run --reporter=json --outputFile=${TEST_REPORT_FILE}`,
    );
  });
});

// ── parseTestOutput — C-4 regression: interleaved stdout ─────────────────────

describe('parseTestOutput — interleaved stdout (C-4 regression)', () => {
  it('two concatenated JSON documents produce a parseError — proves we must read from file', () => {
    const appLog = '{"log_group":"/bank/login-count-service","level":"info"}';
    const vitestJson = JSON.stringify({
      numPassedTests: 3,
      numFailedTests: 0,
      testResults: [],
    });
    const result = parseTestOutput(appLog + '\n' + vitestJson, '');
    expect(result.parseError).toBeDefined();
    expect(result.passed).toBeNull();
  });
});
