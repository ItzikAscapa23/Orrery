import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readArtifact } from './artifacts.js';
import { appendEvent } from './events.js';
import { getPrisma } from './prisma.js';

export const HARNESS_BRIEF_SOURCES_RE = /<!--\s*orrery-sources:\s*(\{[\s\S]*?\})\s*-->/;

// Agent writes paths without hashes; orchestrator computes the hashes and rewrites the header.
export const HARNESS_BRIEF_PATHS_RE = /<!--\s*orrery-sources-paths:\s*(\[[\s\S]*?\])\s*-->/;

export const HARNESS_BRIEF_WRITE_INSTRUCTION =
  `\n\n## Harness Brief (write this on first test-task only)\n` +
  `After your initial discovery reads (mocks, test directory, existing test file), write a file\n` +
  `named \`__orrery_harness_brief.md\` at the repository root (NOT inside the test directory).\n` +
  `The file must begin with exactly this comment on the first line:\n` +
  `<!-- orrery-sources-paths: ["<path-relative-to-repo-root>", "<path2>"] -->\n` +
  `listing every file you read while exploring test infrastructure (paths only — no hashes).\n` +
  `Then include three sections:\n` +
  `1. ## Mocks — each mock file path and what it stubs or provides\n` +
  `2. ## Test Directory Layout — directory tree under the test folder (one level deep)\n` +
  `3. ## Example Pattern — a minimal test file showing the house style (describe/it, imports, mocking)`;

/**
 * Reads paths from the agent-written `orrery-sources-paths` header, computes their SHA-256
 * hashes from disk, and rewrites the header to the `orrery-sources` format that
 * `checkHarnessBriefFreshness` can verify. Returns the updated content.
 * If no `orrery-sources-paths` header is found, returns the content unchanged.
 */
export function injectHarnessBriefHashes(worktreePath: string, content: string): string {
  const match = HARNESS_BRIEF_PATHS_RE.exec(content);
  if (!match) return content;
  let paths: string[];
  try {
    paths = JSON.parse(match[1]!) as string[];
  } catch {
    return content;
  }
  const hashes: Record<string, string> = {};
  for (const relPath of paths) {
    if (typeof relPath !== 'string') continue;
    const absPath = path.join(worktreePath, relPath);
    if (!fs.existsSync(absPath)) continue;
    hashes[relPath] = createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  }
  const header = `<!-- orrery-sources: ${JSON.stringify(hashes)} -->`;
  return content.replace(match[0], header);
}

export function checkHarnessBriefFreshness(worktreePath: string, content: string): string | null {
  const match = HARNESS_BRIEF_SOURCES_RE.exec(content);
  if (!match) return null;
  let sources: Record<string, string>;
  try {
    sources = JSON.parse(match[1]!) as Record<string, string>;
  } catch {
    return null;
  }
  for (const [relPath, expectedHash] of Object.entries(sources)) {
    const absPath = path.join(worktreePath, relPath);
    if (!fs.existsSync(absPath)) return null;
    const actual = createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
    if (actual !== expectedHash) return null;
  }
  return content;
}

export async function loadHarnessBrief(
  slug: string,
  worktreePath: string,
  featureId: string,
): Promise<string | null> {
  const raw = readArtifact(slug, 'test-harness-brief.md');
  if (raw === null) {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: '◦ harness brief not found — first test-task; will write brief if agent produces one',
    });
    return null;
  }
  const fresh = checkHarnessBriefFreshness(worktreePath, raw);
  if (fresh === null) {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: '◦ harness brief stale (source files changed) — regenerating',
    });
    return null;
  }
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'muted',
    text: `◦ harness brief loaded (${fresh.length} chars) — skipping rediscovery reads`,
  });
  return fresh;
}
