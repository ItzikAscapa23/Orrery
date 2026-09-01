import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { RepoEntry } from '../jobs/devJob.js';
import { detectJsonCommand } from '../jobs/testJob.js';

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
 * For every active full-path repo in the manifest, verifies that
 * detectJsonCommand can build a reporter command from the declared probe.
 * Uses the actual downstream consumer as the validation criterion rather than
 * a string pattern — so any probe that works in production passes here.
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

    try {
      // Pass an empty CLAUDE.md — runner detection uses CLAUDE.md content at
      // job time, not at boot. We only need to confirm a command can be built.
      detectJsonCommand('', repo.probe_command);
    } catch {
      const probe = repo.probe_command ?? '(missing)';
      throw new Error(
        `Repo '${repo.id}' probe_command '${probe}' cannot be used to build a reporter command. ` +
          `Set probe_command in repo-manifest.yaml (e.g. 'npm test', 'npx vitest run', 'npx jest').`,
      );
    }
  }
}
