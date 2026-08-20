import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readArtifact } from './artifacts.js';
import { appendEvent } from './events.js';
import { getPrisma } from './prisma.js';

export const HARNESS_BRIEF_SOURCES_RE = /<!--\s*orrery-sources:\s*(\{[\s\S]*?\})\s*-->/;

export const HARNESS_BRIEF_WRITE_INSTRUCTION =
  `\n\n## Harness Brief (write this on first test-task only)\n` +
  `After your initial discovery reads (mocks, test directory, existing test file), write a file\n` +
  `named \`__orrery_harness_brief.md\` at the repository root (NOT inside the test directory).\n` +
  `The file must begin with exactly this comment on the first line:\n` +
  `<!-- orrery-sources: { "<path-relative-to-repo-root>": "<sha256-hex>" } -->\n` +
  `listing every file you read while exploring test infrastructure, with its SHA-256 hex hash.\n` +
  `Then include three sections:\n` +
  `1. ## Mocks — each mock file path and what it stubs or provides\n` +
  `2. ## Test Directory Layout — directory tree under the test folder (one level deep)\n` +
  `3. ## Example Pattern — a minimal test file showing the house style (describe/it, imports, mocking)`;

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
