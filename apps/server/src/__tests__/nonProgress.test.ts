import { describe, it, expect } from 'vitest';
import { checkNonProgress, NonProgressError } from '../lib/nonProgressError.js';

const result = (text: string) => [{ content: text, is_error: false }];
const N = 3;

describe('checkNonProgress', () => {
  it('fires after N consecutive runs of the same command', () => {
    const buf: string[] = [];
    expect(
      checkNonProgress(buf, result('TESTS: 0 failed'), N, 'bash', 'TESTS: 0 failed'),
    ).toBeNull();
    expect(
      checkNonProgress(buf, result('TESTS: 0 failed'), N, 'bash', 'TESTS: 0 failed'),
    ).toBeNull();
    const err = checkNonProgress(buf, result('TESTS: 0 failed'), N, 'bash', 'TESTS: 0 failed');
    expect(err).toBeInstanceOf(NonProgressError);
    expect(err?.message).toContain("'bash'");
    expect(err?.message).toContain('3 times');
  });

  it('does not fire after N-1 runs of the same command', () => {
    const buf: string[] = [];
    for (let i = 0; i < N - 1; i++) {
      expect(checkNonProgress(buf, result('same output'), N, 'bash', 'same output')).toBeNull();
    }
  });

  it('a different command breaks the sequence — N-1 cmd-A + 1 cmd-B + 1 cmd-A does not fire', () => {
    const buf: string[] = [];
    for (let i = 0; i < N - 1; i++) {
      checkNonProgress(buf, result('error'), N, 'bash', 'error');
    }
    // One different command breaks the bash streak
    expect(checkNonProgress(buf, result('error'), N, 'npx jest', 'error')).toBeNull();
    // One more bash — buf = [H_bash, H_jest, H_bash], not all same → no fire
    expect(checkNonProgress(buf, result('error'), N, 'bash', 'error')).toBeNull();
  });

  it('write_file between identical bash results does NOT reset buffer — edit-run loop is caught', () => {
    const buf: string[] = [];
    // Simulate edit-run-edit-run-edit-run: writes are transparent; only bash results counted
    checkNonProgress(buf, result('TESTS: 22 passed'), N, 'bash', 'TESTS: 22 passed');
    checkNonProgress(buf, result('Written probe.test.js (50 bytes)'), N, 'write_file', 'Written');
    checkNonProgress(buf, result('TESTS: 22 passed'), N, 'bash', 'TESTS: 22 passed');
    checkNonProgress(buf, result('Written probe.test.js (50 bytes)'), N, 'write_file', 'Written');
    // Third identical bash result crosses the threshold — loop is caught
    const err = checkNonProgress(buf, result('TESTS: 22 passed'), N, 'bash', 'TESTS: 22 passed');
    expect(err).toBeInstanceOf(NonProgressError);
  });

  it('three distinct commands with identical content do not fire — phase 37 invariant', () => {
    const buf: string[] = [];
    const content = 'TESTS: 5 passed, 1 failed';
    // Each call uses a different command name — hashes must differ
    expect(checkNonProgress(buf, result(content), N, 'bash', content)).toBeNull();
    expect(checkNonProgress(buf, result(content), N, 'npx jest', content)).toBeNull();
    expect(checkNonProgress(buf, result(content), N, 'npm test', content)).toBeNull();
    // Buffer has 3 entries but all have different hashes → no fire
  });

  it('repeated command with varying output fires — task 134 case', () => {
    const buf: string[] = [];
    // Same command, different output each time (as seen on feature 1b6e3d8c)
    checkNonProgress(buf, result('output size 338'), N, 'npx jest --ci', 'output size 338');
    checkNonProgress(buf, result('output size 344'), N, 'npx jest --ci', 'output size 344');
    const err = checkNonProgress(
      buf,
      result('output size 350'),
      N,
      'npx jest --ci',
      'output size 350',
    );
    expect(err).toBeInstanceOf(NonProgressError);
  });

  it('passing result no longer clears buffer — N repeated green results fire', () => {
    const buf: string[] = [];
    const passing = 'TESTS: 97 passed, 0 failed';
    for (let i = 0; i < N - 1; i++) {
      expect(checkNonProgress(buf, result(passing), N, 'npm test', passing)).toBeNull();
    }
    // Nth call fires — green result does not clear the buffer
    const err = checkNonProgress(buf, result(passing), N, 'npm test', passing);
    expect(err).toBeInstanceOf(NonProgressError);
  });

  it('N-1 red then 1 green fires — passing no longer resets mid-sequence', () => {
    const buf: string[] = [];
    const failing = 'TESTS: 0 passed, 1 failed';
    for (let i = 0; i < N - 1; i++) {
      checkNonProgress(buf, result(failing), N, 'bash', failing);
    }
    // The Nth call with a passing result still fires — same command N times
    const err = checkNonProgress(
      buf,
      result('TESTS: 97 passed, 0 failed'),
      N,
      'bash',
      'TESTS: 97 passed, 0 failed',
    );
    expect(err).toBeInstanceOf(NonProgressError);
  });

  it('tool_use_id differences do not cause false negatives — only command is hashed', () => {
    const buf2: string[] = [];
    for (let i = 0; i < N - 1; i++) {
      expect(checkNonProgress(buf2, result('error: cannot find module'), N, 'bash', '')).toBeNull();
    }
    expect(
      checkNonProgress(buf2, result('error: cannot find module'), N, 'bash', ''),
    ).toBeInstanceOf(NonProgressError);
  });
});
