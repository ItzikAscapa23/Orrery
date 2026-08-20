/**
 * Verifies that the worktree reset (git checkout . && git clean -fd) applied
 * in serverDevJob produces a clean state before every attempt.
 *
 * Uses a real temp git repo — no mocks needed since this is testing the git
 * command behaviour, not the job orchestration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-reset-test-'));
  git('init', repoDir);
  git('config user.email "test@test.com"', repoDir);
  git('config user.name "Test"', repoDir);
  // Create initial committed files including the linux-native lockfile
  fs.writeFileSync(path.join(repoDir, 'index.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(repoDir, 'package-lock.json'), '{"lockfileVersion":3}');
  git('add index.ts package-lock.json', repoDir);
  git('commit -m "initial scaffold with linux-native lockfile"', repoDir);
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

function resetWorktree(cwd: string): void {
  // Mirrors serverDevJob.ts: execFileSync with arg arrays, no shell
  execFileSync('git', ['-C', cwd, 'checkout', '.'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  execFileSync('git', ['-C', cwd, 'clean', '-fd'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('worktree reset — git checkout . && git clean -fd', () => {
  it('removes untracked files left by a prior agent attempt', () => {
    // Simulate: agent wrote a new file (and its parent dir) but did not commit
    fs.mkdirSync(path.join(repoDir, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'routes', 'uptime.ts'), 'half-baked code');
    expect(fs.existsSync(path.join(repoDir, 'routes', 'uptime.ts'))).toBe(true);

    resetWorktree(repoDir);

    expect(fs.existsSync(path.join(repoDir, 'routes', 'uptime.ts'))).toBe(false);
  });

  it('reverts modified tracked files to committed content', () => {
    // Simulate: agent modified index.ts but did not commit
    fs.writeFileSync(path.join(repoDir, 'index.ts'), 'MODIFIED by prior attempt\n');
    expect(fs.readFileSync(path.join(repoDir, 'index.ts'), 'utf-8')).toBe(
      'MODIFIED by prior attempt\n',
    );

    resetWorktree(repoDir);

    expect(fs.readFileSync(path.join(repoDir, 'index.ts'), 'utf-8')).toBe('export const x = 1;\n');
  });

  it('removes untracked directories (e.g. src/routes/ written by agent)', () => {
    fs.mkdirSync(path.join(repoDir, 'src', 'routes'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'routes', 'uptime.ts'), 'code');

    resetWorktree(repoDir);

    expect(fs.existsSync(path.join(repoDir, 'src'))).toBe(false);
  });

  it('preserves committed package-lock.json across resets (linux-native lockfile)', () => {
    // The lockfile is now committed to the demo repo, so git clean leaves it intact.
    // This is the key invariant: npm ci sees the correct lockfile on every attempt.
    fs.writeFileSync(path.join(repoDir, 'untracked-agent-file.ts'), 'should go');

    resetWorktree(repoDir);

    // Committed lockfile must survive
    expect(fs.existsSync(path.join(repoDir, 'package-lock.json'))).toBe(true);
    expect(fs.readFileSync(path.join(repoDir, 'package-lock.json'), 'utf-8')).toContain(
      'lockfileVersion',
    );
    // Untracked files still cleaned
    expect(fs.existsSync(path.join(repoDir, 'untracked-agent-file.ts'))).toBe(false);
  });

  it('commit step excludes node_modules even on a worktree without .gitignore', () => {
    // Simulate what happens on a worktree with no .gitignore and node_modules present.
    // The orchestrator's git add -A -- ':!node_modules' ':!node_modules/**' must
    // exclude node_modules entirely.
    fs.mkdirSync(path.join(repoDir, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'node_modules', '.bin', 'vitest'), '#!/bin/sh\n');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'uptime.ts'), 'export {};\n');

    // Run the same add command the orchestrator uses
    execFileSync('git', ['-C', repoDir, 'add', '-A', '--', ':!node_modules', ':!node_modules/**'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const staged = execFileSync('git', ['-C', repoDir, 'diff', '--cached', '--name-only'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')
      .filter(Boolean);

    // Only src/uptime.ts must be staged — node_modules/.bin/vitest must not appear
    expect(staged).toContain('src/uptime.ts');
    expect(staged.some((f) => f.startsWith('node_modules'))).toBe(false);
  });

  it('preserves committed files — clean state is the last commit, not empty repo', () => {
    fs.writeFileSync(path.join(repoDir, 'untracked.ts'), 'should be removed');

    resetWorktree(repoDir);

    // index.ts was committed — must survive
    expect(fs.existsSync(path.join(repoDir, 'index.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(repoDir, 'index.ts'), 'utf-8')).toBe('export const x = 1;\n');
    // untracked.ts was not committed — must be gone
    expect(fs.existsSync(path.join(repoDir, 'untracked.ts'))).toBe(false);
  });
});
