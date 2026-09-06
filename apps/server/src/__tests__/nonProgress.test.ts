import { describe, it, expect } from 'vitest';
import { checkNonProgress, NonProgressError } from '../lib/nonProgressError.js';

const result = (text: string) => [{ content: text, is_error: false }];
const N = 3;

describe('checkNonProgress', () => {
  it('fires after exactly N consecutive identical results', () => {
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

  it('does not fire after N-1 identical results', () => {
    const buf: string[] = [];
    for (let i = 0; i < N - 1; i++) {
      expect(checkNonProgress(buf, result('same output'), N, 'bash', 'same output')).toBeNull();
    }
  });

  it('resets on a different result — no false positive after N-1 + 1 different + 1 same', () => {
    const buf: string[] = [];
    for (let i = 0; i < N - 1; i++) {
      checkNonProgress(buf, result('same'), N, 'bash', 'same');
    }
    // One different result resets
    expect(checkNonProgress(buf, result('different'), N, 'bash', 'different')).toBeNull();
    // One more same — buffer only has 2 entries now (different + same), not N
    expect(checkNonProgress(buf, result('same'), N, 'bash', 'same')).toBeNull();
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

  it('three distinct commands with identical content do not fire — command is in hash', () => {
    const buf: string[] = [];
    const content = 'TESTS: 5 passed, 1 failed';
    // Each call uses a different command name — hashes must differ
    expect(checkNonProgress(buf, result(content), N, 'bash', content)).toBeNull();
    expect(checkNonProgress(buf, result(content), N, 'npx jest', content)).toBeNull();
    expect(checkNonProgress(buf, result(content), N, 'npm test', content)).toBeNull();
    // Buffer has 3 entries but all have different hashes → no fire
  });

  it('a passing result (0 failed) clears the buffer — repeated green checks never fire', () => {
    const buf: string[] = [];
    const passing = 'TESTS: 97 passed, 0 failed';
    for (let i = 0; i < N * 3; i++) {
      expect(checkNonProgress(buf, result(passing), N, 'npm test', passing)).toBeNull();
      expect(buf).toHaveLength(0);
    }
  });

  it('passing result clears buffer mid-sequence — N-1 failures then pass then 1 failure does not fire', () => {
    const buf: string[] = [];
    const failing = 'TESTS: 0 passed, 1 failed';
    for (let i = 0; i < N - 1; i++) {
      checkNonProgress(buf, result(failing), N, 'bash', failing);
    }
    // Passing result clears the buffer
    checkNonProgress(
      buf,
      result('TESTS: 97 passed, 0 failed'),
      N,
      'bash',
      'TESTS: 97 passed, 0 failed',
    );
    expect(buf).toHaveLength(0);
    // One more failing result — buffer has only 1 entry, must not fire
    expect(checkNonProgress(buf, result(failing), N, 'bash', failing)).toBeNull();
  });

  it('tool_use_id differences do not cause false negatives — only content is hashed', () => {
    // Simulate identical content with the same two separate calls (content-hash equality)
    const buf: string[] = [];
    for (let i = 0; i < N; i++) {
      checkNonProgress(
        buf,
        result('error: cannot find module'),
        N,
        'bash',
        'error: cannot find module',
      );
    }
    // The loop above fires on the Nth call; confirm by doing it explicitly
    const buf2: string[] = [];
    for (let i = 0; i < N - 1; i++) {
      expect(checkNonProgress(buf2, result('error: cannot find module'), N, 'bash', '')).toBeNull();
    }
    expect(
      checkNonProgress(buf2, result('error: cannot find module'), N, 'bash', ''),
    ).toBeInstanceOf(NonProgressError);
  });
});
