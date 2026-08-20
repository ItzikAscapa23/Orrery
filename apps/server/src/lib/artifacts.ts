import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface CommitResult {
  path: string;
  commit: string;
  message: string;
}

// Thrown when a git operation fails on the artifacts repo for a reason other than
// "nothing to commit" (which is handled as a transparent no-op). Callers that must
// guarantee persistence (plannerJob) re-throw this to park the job rather than
// silently advancing to a gate with uncommitted content.
export class ArtifactCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactCommitError';
  }
}

/**
 * Read a previously committed artifact file from the artifacts repo.
 * Returns null if ARTIFACTS_REPO_PATH is unset or the file does not exist.
 */
export function readArtifact(slug: string, filename: string): string | null {
  const repoPath = process.env['ARTIFACTS_REPO_PATH'];
  if (!repoPath) return null;
  const filePath = path.join(repoPath, 'features', slug, filename);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * List artifact filenames for a feature, optionally filtered by a filename prefix.
 * Returns [] if ARTIFACTS_REPO_PATH is unset or the feature directory does not exist.
 */
export function listArtifacts(slug: string, prefix?: string): string[] {
  const repoPath = process.env['ARTIFACTS_REPO_PATH'];
  if (!repoPath) return [];
  const featureDir = path.join(repoPath, 'features', slug);
  if (!fs.existsSync(featureDir)) return [];
  const entries = fs.readdirSync(featureDir);
  return prefix ? entries.filter((e) => e.startsWith(prefix)) : entries;
}

/**
 * Write any artifact file to the artifacts repo and commit it.
 * Used by the Planner to commit contract.yaml and plan.md alongside spec.md.
 */
export function commitArtifact(
  slug: string,
  filename: string,
  content: string,
  messagePrefix = 'plan',
): CommitResult {
  const repoPath = process.env['ARTIFACTS_REPO_PATH'];
  if (!repoPath) throw new Error('ARTIFACTS_REPO_PATH env var is not set');
  if (!fs.existsSync(repoPath)) throw new Error(`ARTIFACTS_REPO_PATH does not exist: ${repoPath}`);

  const featureDir = path.join(repoPath, 'features', slug);
  fs.mkdirSync(featureDir, { recursive: true });
  const filePath = path.join('features', slug, filename);
  fs.writeFileSync(path.join(repoPath, filePath), content, 'utf-8');

  try {
    execSync(`git -C "${repoPath}" add "${filePath}"`, { encoding: 'utf-8', stdio: 'pipe' });
  } catch (err) {
    throw new ArtifactCommitError(
      `git add failed for ${slug}/${filename}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const commitMessage = `${messagePrefix}: ${slug} ${filename}`;

  // Check whether staging actually changed anything. If the file content is
  // byte-for-byte identical to what is already committed, git add is a no-op
  // and git commit would exit 1 with "nothing to commit". Return HEAD SHA directly
  // — the committed state already reflects the correct content.
  const staged = execSync(`git -C "${repoPath}" diff --cached --name-only`, {
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

  if (staged === '') {
    const sha = execSync(`git -C "${repoPath}" rev-parse --short HEAD`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return { path: filePath, commit: sha, message: commitMessage };
  }

  try {
    execSync(`git -C "${repoPath}" commit -m "${commitMessage}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    throw new ArtifactCommitError(
      `git commit failed for ${slug}/${filename}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const sha = execSync(`git -C "${repoPath}" rev-parse --short HEAD`, {
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

  return { path: filePath, commit: sha, message: commitMessage };
}

/**
 * Commit spec.md to the artifacts repo at the moment it is proposed (on write,
 * not on approval). The commit message encodes the review-cycle revision so
 * multiple drafts within one feature are distinguishable in git log.
 *
 * Called from the specProposed callback (featureMessages, request-changes) and
 * from the simulator before gate.opened fires. Returns the CommitResult so
 * callers can embed the SHA in the gate.opened event.
 */
export function commitSpecDraft(slug: string, specMarkdown: string, rev: number): CommitResult {
  const repoPath = process.env['ARTIFACTS_REPO_PATH'];
  if (!repoPath) {
    throw new Error('ARTIFACTS_REPO_PATH env var is not set');
  }
  if (!fs.existsSync(repoPath)) {
    throw new Error(`ARTIFACTS_REPO_PATH does not exist: ${repoPath}`);
  }

  const featureDir = path.join(repoPath, 'features', slug);
  fs.mkdirSync(featureDir, { recursive: true });
  const filePath = path.join('features', slug, 'spec.md');
  fs.writeFileSync(path.join(repoPath, filePath), specMarkdown, 'utf-8');

  try {
    execSync(`git -C "${repoPath}" add "${filePath}"`, { encoding: 'utf-8', stdio: 'pipe' });
  } catch (err) {
    throw new ArtifactCommitError(
      `git add failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const commitMessage = `spec: ${slug} draft r${rev}`;

  const staged = execSync(`git -C "${repoPath}" diff --cached --name-only`, {
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

  if (staged === '') {
    const sha = execSync(`git -C "${repoPath}" rev-parse --short HEAD`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return { path: filePath, commit: sha, message: commitMessage };
  }

  try {
    execSync(`git -C "${repoPath}" commit -m "${commitMessage}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    throw new ArtifactCommitError(
      `git commit failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const sha = execSync(`git -C "${repoPath}" rev-parse --short HEAD`, {
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

  return { path: filePath, commit: sha, message: commitMessage };
}
