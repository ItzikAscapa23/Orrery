/**
 * Verifies that task commits are authored as the configured bot identity, not the
 * operator's global git identity.
 *
 * gitCommit() in devJob.ts passes -c user.name/email flags scoped to
 * the single invocation so the bot identity overrides whatever global config
 * the host machine has.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

let repoDir: string;

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-identity-test-'));
  git('init', repoDir);
  // Set a deliberately wrong local identity to confirm -c flags override it
  git('config user.email "wrong@example.com"', repoDir);
  git('config user.name "Wrong Identity"', repoDir);
  fs.writeFileSync(path.join(repoDir, 'file.ts'), 'export const x = 1;\n');
  git('add file.ts', repoDir);
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('gitCommit identity', () => {
  it('task commit author uses BOT_GIT_NAME/BOT_GIT_EMAIL regardless of local git config', () => {
    const botName = process.env['BOT_GIT_NAME'] ?? 'Orrery';
    const botEmail = process.env['BOT_GIT_EMAIL'] ?? 'orrery-bot@example.com';
    // Mirror the gitCommit() implementation from devJob.ts exactly
    execFileSync(
      'git',
      [
        '-C',
        repoDir,
        '-c',
        `user.name=${botName}`,
        '-c',
        `user.email=${botEmail}`,
        'commit',
        '-m',
        'feat(task-123): test task',
      ],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const authorEmail = git('log -1 --format=%ae', repoDir).trim();
    const authorName = git('log -1 --format=%an', repoDir).trim();

    expect(authorEmail).toBe(botEmail);
    expect(authorName).toBe(botName);
  });

  it('without -c flags the local config identity would be used (documents the problem)', () => {
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'feat(task-456): no identity override'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const authorEmail = git('log -1 --format=%ae', repoDir).trim();
    // Local config was set to "wrong@example.com" — without -c it bleeds through
    expect(authorEmail).toBe('wrong@example.com');
    expect(authorEmail).not.toBe(process.env['BOT_GIT_EMAIL'] ?? 'orrery-bot@example.com');
  });
});
