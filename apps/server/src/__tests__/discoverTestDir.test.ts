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
    expect(discoverTestDir(tmpRoot)).toBe('src/__tests__');
  });

  it('returns test when tests live at root test/', () => {
    touch('test/bar.test.ts');
    expect(discoverTestDir(tmpRoot)).toBe('test');
  });

  it('returns src/__tests__ over empty root __tests__/ (content check, not existence)', () => {
    // empty root-level __tests__ — existence alone should not win
    fs.mkdirSync(path.join(tmpRoot, '__tests__'));
    touch('src/__tests__/baz.test.ts');
    expect(discoverTestDir(tmpRoot)).toBe('src/__tests__');
  });

  it('returns __tests__ and logs when no test files exist anywhere', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = discoverTestDir(tmpRoot);
    expect(result).toBe('__tests__');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toMatch(/falling back/);
  });

  it('throws when worktreePath does not exist', () => {
    expect(() => discoverTestDir('/nonexistent/orrery-worktree-path')).toThrow('does not exist');
  });
});
