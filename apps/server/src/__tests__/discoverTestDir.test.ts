import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverTestDir } from '../jobs/testJob.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-discovertestdir-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function touch(rel: string) {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '');
}

describe('discoverTestDir', () => {
  it('returns src/__tests__ when tests live there', () => {
    touch('src/__tests__/foo.test.ts');
    const result = discoverTestDir(tmpRoot);
    expect(result.dir).toBe('src/__tests__');
    expect(result.method).toBe('candidate');
  });

  it('returns test when tests live at root test/', () => {
    touch('test/bar.test.ts');
    const result = discoverTestDir(tmpRoot);
    expect(result.dir).toBe('test');
    expect(result.method).toBe('candidate');
  });

  it('returns src/__tests__ over empty root __tests__/ (content check, not existence)', () => {
    // empty root-level __tests__ — existence alone should not win
    fs.mkdirSync(path.join(tmpRoot, '__tests__'));
    touch('src/__tests__/baz.test.ts');
    const result = discoverTestDir(tmpRoot);
    expect(result.dir).toBe('src/__tests__');
    expect(result.method).toBe('candidate');
  });

  it('returns __tests__ with method=fallback when no test files exist anywhere', () => {
    const result = discoverTestDir(tmpRoot);
    expect(result.dir).toBe('__tests__');
    expect(result.method).toBe('fallback');
  });

  it('throws when worktreePath does not exist', () => {
    expect(() => discoverTestDir('/nonexistent/orrery-worktree-path')).toThrow('does not exist');
  });

  it('returns test when tests live two subdirectories deep inside test/ (BFF layout)', () => {
    // test/scenarios/auth/login.test.ts is 2 subdirs inside the 'test' candidate;
    // requires maxDepth=3 in findTestFiles to reach it.
    touch('test/scenarios/auth/login.test.ts');
    const result = discoverTestDir(tmpRoot);
    expect(result.dir).toBe('test');
    expect(result.method).toBe('candidate');
  });

  it('returns __tests__ with method=fallback when a test file sits at worktree root (empty deep-scan dir)', () => {
    // deep-scan would produce dir='' for a file at the root — must fall through to fallback
    touch('root.test.ts');
    const result = discoverTestDir(tmpRoot);
    expect(result.dir).toBe('__tests__');
    expect(result.method).toBe('fallback');
  });
});
