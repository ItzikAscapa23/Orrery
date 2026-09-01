import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { RepoEntry } from '../jobs/devJob.js';

const DEFAULT_MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/agents/repo-manifest.yaml',
);

/**
 * Returns 'vitest' | 'jest' | null (null = ambiguous / unrecognised runner).
 * Exported for unit testing.
 */
export function inferRunner(cmd: string): 'vitest' | 'jest' | null {
  const lower = cmd.toLowerCase();
  if (lower.includes('vitest') && !lower.includes('jest')) return 'vitest';
  if (lower.includes('jest') && !lower.includes('vitest')) return 'jest';
  return null;
}

/**
 * For every active full-path repo in the manifest, verifies:
 *   1. probe_command is declared.
 *   2. probe_command names an explicit runner ('vitest' or 'jest').
 *
 * Throws with repo id and offending command on the first violation.
 * Returns without error when the manifest file is absent.
 * Injectable manifestPath for tests.
 */
export function validateProbeCommands(manifestPath = DEFAULT_MANIFEST_PATH): void {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch {
    return; // no manifest → nothing to validate
  }

  const manifest = yaml.load(raw) as { repos: RepoEntry[] };
  if (!manifest?.repos) return;

  for (const repo of manifest.repos) {
    if (!repo.active) continue;
    if (repo.path === 'light') continue;

    if (!repo.probe_command) {
      throw new Error(
        `Repo '${repo.id}' is active (full-path) but has no probe_command in repo-manifest.yaml`,
      );
    }

    if (inferRunner(repo.probe_command) === null) {
      throw new Error(
        `Repo '${repo.id}' probe_command '${repo.probe_command}' does not name an explicit runner ` +
          `(vitest or jest). Use 'npx vitest run' or 'npx jest' explicitly.`,
      );
    }
  }
}
