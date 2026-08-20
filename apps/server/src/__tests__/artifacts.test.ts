/**
 * Unit tests for commitArtifact using a real temp git repo.
 * Verifies the no-op guard (identical content), successful commit, and
 * ArtifactCommitError on genuine git failures.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { commitArtifact, ArtifactCommitError } from '../lib/artifacts.js';

let repoDir: string;
let originalArtifactsPath: string | undefined;

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-test-'));
  git('init', repoDir);
  git('config user.email "test@test.com"', repoDir);
  git('config user.name "Test"', repoDir);
  // Create an initial commit so HEAD is valid
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
  git('add README.md', repoDir);
  git('commit -m "init"', repoDir);

  originalArtifactsPath = process.env['ARTIFACTS_REPO_PATH'];
  process.env['ARTIFACTS_REPO_PATH'] = repoDir;
});

afterEach(() => {
  process.env['ARTIFACTS_REPO_PATH'] = originalArtifactsPath;
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('commitArtifact', () => {
  it('writes and commits a new file, returns correct SHA', () => {
    const result = commitArtifact('my-feature', 'contract.yaml', 'openapi: "3.0.0"\n');
    expect(result.path).toBe('features/my-feature/contract.yaml');
    expect(result.commit).toHaveLength(7);
    expect(result.message).toBe('plan: my-feature contract.yaml');

    // File exists on disk
    const written = fs.readFileSync(
      path.join(repoDir, 'features', 'my-feature', 'contract.yaml'),
      'utf-8',
    );
    expect(written).toBe('openapi: "3.0.0"\n');

    // Commit is in git log
    const log = git('log --oneline -1', repoDir);
    expect(log).toContain('plan: my-feature contract.yaml');
  });

  it('second call with identical content returns HEAD SHA without creating a new commit', () => {
    const first = commitArtifact('my-feature', 'contract.yaml', 'openapi: "3.0.0"\n');
    const before = git('rev-list --count HEAD', repoDir).trim();

    const second = commitArtifact('my-feature', 'contract.yaml', 'openapi: "3.0.0"\n');
    const after = git('rev-list --count HEAD', repoDir).trim();

    // Same SHA — no new commit
    expect(second.commit).toBe(first.commit);
    expect(after).toBe(before);
  });

  it('second call with different content creates a new commit', () => {
    const first = commitArtifact('my-feature', 'contract.yaml', 'openapi: "3.0.0"\n');
    const second = commitArtifact('my-feature', 'contract.yaml', 'openapi: "3.1.0"\n');

    expect(second.commit).not.toBe(first.commit);
    const count = parseInt(git('rev-list --count HEAD', repoDir).trim(), 10);
    expect(count).toBeGreaterThanOrEqual(3); // init + first + second
  });

  it('throws ArtifactCommitError when git commit fails for a genuine reason', () => {
    // Write file and stage it, then make the index lock by writing the lock file
    // so git commit exits non-zero even though there is staged content.
    // Simpler approach: corrupt the .git/HEAD to make commit fail.
    // Even simpler: create content, verify staging works, then make repo read-only.

    // Write and stage content manually
    const featureDir = path.join(repoDir, 'features', 'err-feature');
    fs.mkdirSync(featureDir, { recursive: true });
    const filePath = path.join(featureDir, 'contract.yaml');
    fs.writeFileSync(filePath, 'content\n');
    git('add features/err-feature/contract.yaml', repoDir);

    // Now corrupt git config so commit fails (invalid user.email triggers an error)
    git('config user.email ""', repoDir);
    git('config user.name ""', repoDir);
    // git refuses to commit with empty name/email in strict mode
    // Use a more reliable approach: corrupt the objects dir
    // Actually the most reliable: remove write permission on COMMIT_EDITMSG path
    const gitDir = path.join(repoDir, '.git');
    const commitEditmsg = path.join(gitDir, 'COMMIT_EDITMSG');
    // Pre-create the file read-only
    fs.writeFileSync(commitEditmsg, '');
    fs.chmodSync(commitEditmsg, 0o444);

    // commitArtifact will write the file again (same content or new) and try to commit
    // Since we already staged, the diff --cached will be non-empty on a fresh file write
    // Actually let's use a simpler forced failure: write new content and make objects dir read-only
    fs.chmodSync(path.join(gitDir, 'objects'), 0o444);

    try {
      expect(() => commitArtifact('err-feature', 'contract.yaml', 'new content\n')).toThrow(
        ArtifactCommitError,
      );
    } finally {
      // Restore permissions so cleanup works
      fs.chmodSync(path.join(gitDir, 'objects'), 0o755);
      fs.chmodSync(commitEditmsg, 0o644);
    }
  });
});
