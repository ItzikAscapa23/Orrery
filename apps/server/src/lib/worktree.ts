import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface WorktreeInfo {
  repoId: string; // repo manifest id (e.g. 'demo-server')
  bareRepoPath: string; // absolute path to the bare clone (<slug>-<repoId>.git)
  worktreePath: string; // absolute path to the checked-out worktree (<slug>-<repoId>-work)
  branch: string; // feature/<slug> — same across repos, each bare clone is independent
}

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Clone the repo as a bare repository, add a worktree off the default branch,
 * and create a feature branch for the agent to work on.
 *
 * Idempotent: if the worktree already exists (e.g. after a server restart),
 * returns the existing paths without re-cloning.
 */
export function createWorktree(
  repoUrl: string,
  slug: string,
  defaultBranch: string,
  repoId: string,
): WorktreeInfo {
  // Read at call time so tests can override process.env['WORKTREES_ROOT'] in beforeEach.
  // A module-level const would be frozen before any test setup runs.
  const worktreesRoot = process.env['WORKTREES_ROOT'] ?? '/tmp/orrery-worktrees';

  // Key paths by (slug, repoId) so server and client repos for the same feature
  // get distinct bare clones and worktrees. Without repoId the second repo's
  // createWorktree call would find the first repo's bare clone already on disk
  // and silently return it — causing the client agent to write into the server repo.
  const bareRepoPath = path.join(worktreesRoot, `${slug}-${repoId}.git`);
  const worktreePath = path.join(worktreesRoot, `${slug}-${repoId}-work`);
  const branch = `feature/${slug}`;

  fs.mkdirSync(worktreesRoot, { recursive: true });

  // Validate that an existing bare-repo directory is actually a git repo.
  // A stale non-repo directory (e.g. left by a crashed session before git clone
  // completed) makes git commands fail with "fatal: not a git repository",
  // exhausting retry slots before parking. Remove and re-clone if invalid.
  if (fs.existsSync(bareRepoPath)) {
    try {
      git('rev-parse --git-dir', bareRepoPath);
    } catch {
      fs.rmSync(bareRepoPath, { recursive: true, force: true });
    }
  }
  if (!fs.existsSync(bareRepoPath)) {
    git(`clone --bare ${repoUrl} ${bareRepoPath}`, worktreesRoot);
  }

  // Same validation for the worktree path.
  if (fs.existsSync(worktreePath)) {
    try {
      git('rev-parse --is-inside-work-tree', worktreePath);
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }
  if (!fs.existsSync(worktreePath)) {
    git(`worktree add ${worktreePath} ${defaultBranch}`, bareRepoPath);
  }

  // Create feature branch if it doesn't exist yet
  try {
    git(`show-ref --verify --quiet refs/heads/${branch}`, bareRepoPath);
    // Branch exists — check it out in the worktree
    git(`checkout ${branch}`, worktreePath);
  } catch {
    // Branch doesn't exist — create it
    git(`checkout -b ${branch}`, worktreePath);
  }

  return { repoId, bareRepoPath, worktreePath, branch };
}

/**
 * Remove the worktree and its bare clone directory.
 * Safe to call even if the directories don't exist.
 */
export function removeWorktree(info: WorktreeInfo): void {
  if (fs.existsSync(info.bareRepoPath)) {
    try {
      git(`worktree remove --force ${info.worktreePath}`, info.bareRepoPath);
    } catch {
      // Non-fatal: worktree may already be gone
    }
    fs.rmSync(info.bareRepoPath, { recursive: true, force: true });
  }
  if (fs.existsSync(info.worktreePath)) {
    fs.rmSync(info.worktreePath, { recursive: true, force: true });
  }
}
