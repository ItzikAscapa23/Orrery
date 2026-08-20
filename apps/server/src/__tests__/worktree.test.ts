/**
 * Tests that createWorktree keys paths by (slug, repoId) so two repos
 * for the same feature get distinct bare clones and worktrees.
 *
 * Uses real git repos in a temp directory — no mocks needed for path-isolation
 * since git init --bare is fast and side-effect-free outside the test dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createWorktree } from '../lib/worktree.js';

let tmpRoot: string;
let serverBare: string;
let clientBare: string;

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-path-test-'));
  process.env['WORKTREES_ROOT'] = tmpRoot;

  // Create two minimal bare repos to clone from
  serverBare = path.join(tmpRoot, 'server-origin.git');
  clientBare = path.join(tmpRoot, 'client-origin.git');

  for (const bare of [serverBare, clientBare]) {
    fs.mkdirSync(bare);
    git('init --bare', bare);
    // Push a commit so the default branch exists and worktrees can be added
    const src = path.join(tmpRoot, `src-${path.basename(bare)}`);
    fs.mkdirSync(src);
    git('init', src);
    git('config user.email "test@test.com"', src);
    git('config user.name "Test"', src);
    fs.writeFileSync(path.join(src, 'README.md'), '# test\n');
    git('add README.md', src);
    git('commit -m "init"', src);
    git(`remote add origin ${bare}`, src);
    git('push origin HEAD:main', src);
    fs.rmSync(src, { recursive: true, force: true });
  }
});

afterEach(() => {
  delete process.env['WORKTREES_ROOT'];
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('createWorktree — (slug, repoId) path isolation', () => {
  it('includes repoId in bareRepoPath and worktreePath', () => {
    const info = createWorktree(serverBare, 'my-feature', 'main', 'demo-server');
    expect(info.repoId).toBe('demo-server');
    expect(info.bareRepoPath).toContain('my-feature');
    expect(info.bareRepoPath).toContain('demo-server');
    expect(info.worktreePath).toContain('my-feature');
    expect(info.worktreePath).toContain('demo-server');
  });

  it('server and client repos for the same slug produce distinct paths', () => {
    const server = createWorktree(serverBare, 'my-feature', 'main', 'demo-server');
    const client = createWorktree(clientBare, 'my-feature', 'main', 'demo-client');

    // Bare repo paths must be distinct
    expect(server.bareRepoPath).not.toBe(client.bareRepoPath);
    // Worktree paths must be distinct
    expect(server.worktreePath).not.toBe(client.worktreePath);
    // Branch name is the same (feature/<slug>) — each bare clone is independent
    expect(server.branch).toBe('feature/my-feature');
    expect(client.branch).toBe('feature/my-feature');
  });

  it('is idempotent — calling twice returns the same paths without re-cloning', () => {
    const first = createWorktree(serverBare, 'my-feature', 'main', 'demo-server');
    const second = createWorktree(serverBare, 'my-feature', 'main', 'demo-server');

    expect(first.bareRepoPath).toBe(second.bareRepoPath);
    expect(first.worktreePath).toBe(second.worktreePath);
    expect(first.branch).toBe(second.branch);
  });
});
