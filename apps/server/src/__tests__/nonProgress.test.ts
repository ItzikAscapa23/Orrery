import { describe, it, expect } from 'vitest';
import { checkNonProgress, NonProgressError } from '../lib/nonProgressError.js';

const result = (text: string) => [{ content: text, is_error: false }];
const N = 3;
const CMD = 'npx jest --ci';

describe('checkNonProgress', () => {
  // --- task 143 fail-first: bash-only rule ---

  it('list_files calls do not contribute to the stop — bash-only rule', () => {
    const buf: string[] = [];
    for (let i = 0; i < N; i++) {
      expect(
        checkNonProgress(buf, result('file.ts'), N, 'list_files', '/src', 'file.ts'),
      ).toBeNull();
    }
  });

  it('three identical list_files on the same path do not fire — bash-only rule', () => {
    const buf: string[] = [];
    for (let i = 0; i < N; i++) {
      expect(
        checkNonProgress(buf, result('file.ts'), N, 'list_files', '/src/same', 'file.ts'),
      ).toBeNull();
    }
  });

  it('read_file calls do not contribute to the stop — bash-only rule', () => {
    const buf: string[] = [];
    for (let i = 0; i < N; i++) {
      expect(
        checkNonProgress(buf, result('content'), N, 'read_file', '/src/index.ts', 'content'),
      ).toBeNull();
    }
  });

  // --- task 142 fail-first: full command including arguments ---

  it('bash with different arguments do not fire — full-command hash (task 142)', () => {
    const buf: string[] = [];
    expect(
      checkNonProgress(buf, result(''), N, 'bash', 'npx jest --testPathPattern=foo', ''),
    ).toBeNull();
    expect(
      checkNonProgress(buf, result(''), N, 'bash', 'npx jest --testPathPattern=bar', ''),
    ).toBeNull();
    expect(
      checkNonProgress(buf, result(''), N, 'bash', 'npx jest --testPathPattern=baz', ''),
    ).toBeNull();
  });

  // --- existing tests (updated to new 6-param signature) ---

  it('fires after N consecutive runs of the same bash command', () => {
    const buf: string[] = [];
    expect(
      checkNonProgress(buf, result('TESTS: 0 failed'), N, 'bash', CMD, 'TESTS: 0 failed'),
    ).toBeNull();
    expect(
      checkNonProgress(buf, result('TESTS: 0 failed'), N, 'bash', CMD, 'TESTS: 0 failed'),
    ).toBeNull();
    const err = checkNonProgress(buf, result('TESTS: 0 failed'), N, 'bash', CMD, 'TESTS: 0 failed');
    expect(err).toBeInstanceOf(NonProgressError);
    expect(err?.message).toContain(CMD);
    expect(err?.message).toContain('3 times');
  });

  it('does not fire after N-1 runs of the same command', () => {
    const buf: string[] = [];
    for (let i = 0; i < N - 1; i++) {
      expect(
        checkNonProgress(buf, result('same output'), N, 'bash', CMD, 'same output'),
      ).toBeNull();
    }
  });

  it('a different command breaks the sequence — N-1 cmd-A + 1 cmd-B + 1 cmd-A does not fire', () => {
    const buf: string[] = [];
    for (let i = 0; i < N - 1; i++) {
      checkNonProgress(buf, result('error'), N, 'bash', 'npx jest --a', 'error');
    }
    expect(checkNonProgress(buf, result('error'), N, 'bash', 'npx jest --b', 'error')).toBeNull();
    expect(checkNonProgress(buf, result('error'), N, 'bash', 'npx jest --a', 'error')).toBeNull();
  });

  it('write_file between identical bash results does NOT reset buffer — edit-run loop is caught', () => {
    const buf: string[] = [];
    checkNonProgress(buf, result('TESTS: 22 passed'), N, 'bash', CMD, 'TESTS: 22 passed');
    checkNonProgress(
      buf,
      result('Written probe.test.js'),
      N,
      'write_file',
      'probe.test.js',
      'Written',
    );
    checkNonProgress(buf, result('TESTS: 22 passed'), N, 'bash', CMD, 'TESTS: 22 passed');
    checkNonProgress(
      buf,
      result('Written probe.test.js'),
      N,
      'write_file',
      'probe.test.js',
      'Written',
    );
    const err = checkNonProgress(
      buf,
      result('TESTS: 22 passed'),
      N,
      'bash',
      CMD,
      'TESTS: 22 passed',
    );
    expect(err).toBeInstanceOf(NonProgressError);
  });

  it('three distinct bash commands with identical content do not fire — phase 37 invariant', () => {
    const buf: string[] = [];
    const content = 'TESTS: 5 passed, 1 failed';
    expect(checkNonProgress(buf, result(content), N, 'bash', 'npx jest --a', content)).toBeNull();
    expect(checkNonProgress(buf, result(content), N, 'bash', 'npx jest --b', content)).toBeNull();
    expect(checkNonProgress(buf, result(content), N, 'bash', 'npm test', content)).toBeNull();
  });

  it('repeated bash command with varying output fires — task 134 case', () => {
    const buf: string[] = [];
    const loopCmd = 'npx jest --ci --testPathPattern="orderCardClubsListDebug" 2>&1';
    checkNonProgress(buf, result('output size 338'), N, 'bash', loopCmd, 'output size 338');
    checkNonProgress(buf, result('output size 344'), N, 'bash', loopCmd, 'output size 344');
    const err = checkNonProgress(
      buf,
      result('output size 350'),
      N,
      'bash',
      loopCmd,
      'output size 350',
    );
    expect(err).toBeInstanceOf(NonProgressError);
  });

  it('passing result no longer clears buffer — N repeated green results fire', () => {
    const buf: string[] = [];
    const passing = 'TESTS: 97 passed, 0 failed';
    for (let i = 0; i < N - 1; i++) {
      expect(checkNonProgress(buf, result(passing), N, 'bash', 'npm test', passing)).toBeNull();
    }
    const err = checkNonProgress(buf, result(passing), N, 'bash', 'npm test', passing);
    expect(err).toBeInstanceOf(NonProgressError);
  });

  it('N-1 red then 1 green fires — passing no longer resets mid-sequence', () => {
    const buf: string[] = [];
    const failing = 'TESTS: 0 passed, 1 failed';
    for (let i = 0; i < N - 1; i++) {
      checkNonProgress(buf, result(failing), N, 'bash', CMD, failing);
    }
    const err = checkNonProgress(
      buf,
      result('TESTS: 97 passed, 0 failed'),
      N,
      'bash',
      CMD,
      'TESTS: 97 passed, 0 failed',
    );
    expect(err).toBeInstanceOf(NonProgressError);
  });

  it('tool_use_id differences do not cause false negatives — only command is hashed', () => {
    const buf: string[] = [];
    for (let i = 0; i < N - 1; i++) {
      expect(
        checkNonProgress(buf, result('error: cannot find module'), N, 'bash', CMD, ''),
      ).toBeNull();
    }
    expect(checkNonProgress(buf, result('error'), N, 'bash', CMD, '')).toBeInstanceOf(
      NonProgressError,
    );
  });

  // --- task 176 fail-first: modified file does not trigger stop ---

  it('repeated command against modified file does not increment counter — phase 55 fix', () => {
    const buf: string[] = [];
    // Each run uses a different lastWrittenHash (file was rewritten between runs) — should never fire.
    expect(
      checkNonProgress(
        buf,
        result('TESTS: 0 passed, 1 failed'),
        N,
        'bash',
        CMD,
        'TESTS: 0 passed, 1 failed',
        'hash-v1',
      ),
    ).toBeNull();
    expect(
      checkNonProgress(
        buf,
        result('TESTS: 0 passed, 1 failed'),
        N,
        'bash',
        CMD,
        'TESTS: 0 passed, 1 failed',
        'hash-v2',
      ),
    ).toBeNull();
    expect(
      checkNonProgress(
        buf,
        result('TESTS: 0 passed, 1 failed'),
        N,
        'bash',
        CMD,
        'TESTS: 0 passed, 1 failed',
        'hash-v3',
      ),
    ).toBeNull();
  });

  it('repeated command against unmodified file still fires — N consecutive with same lastWrittenHash', () => {
    const buf: string[] = [];
    // Same command, same lastWrittenHash each time (file was not modified) — should fire.
    for (let i = 0; i < N - 1; i++) {
      expect(
        checkNonProgress(
          buf,
          result('TESTS: 0 passed, 1 failed'),
          N,
          'bash',
          CMD,
          'TESTS: 0 passed, 1 failed',
          'hash-v1',
        ),
      ).toBeNull();
    }
    const err = checkNonProgress(
      buf,
      result('TESTS: 0 passed, 1 failed'),
      N,
      'bash',
      CMD,
      'TESTS: 0 passed, 1 failed',
      'hash-v1',
    );
    expect(err).toBeInstanceOf(NonProgressError);
  });
});
