import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const DEFAULT_MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/agents/repo-manifest.yaml',
);

/**
 * Returns the path of the first review_charter found among the given repo IDs,
 * or undefined if none of the repos declare a charter.
 *
 * First-charter-found semantics: in practice all repos at an organisation share
 * one charter. If two repos declare different charters, the first repo in the
 * list wins.
 *
 * manifestPath is injectable for testing — pass a path to a temp fixture file.
 * When the manifest is absent, returns undefined (no charter) rather than throwing.
 */
export function resolveCharterPath(
  repoIds: string[],
  manifestPath = DEFAULT_MANIFEST_PATH,
): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch {
    return undefined;
  }
  const manifest = yaml.load(raw) as { repos: Array<{ id: string; review_charter?: string }> };
  if (!manifest?.repos) return undefined;
  for (const id of repoIds) {
    const entry = manifest.repos.find((r) => r.id === id);
    if (!entry?.review_charter) continue;
    const charterPath = entry.review_charter;
    try {
      fs.readFileSync(charterPath, 'utf-8');
    } catch {
      throw new Error(
        `Repo '${id}' declares review_charter '${charterPath}' but the file could not be read`,
      );
    }
    return charterPath;
  }
  return undefined;
}
