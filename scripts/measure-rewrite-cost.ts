/**
 * Measures how much of the test agent's output token spend went to rewriting
 * files that already existed in the same job, vs first authorship.
 *
 * Run: npx tsx scripts/measure-rewrite-cost.ts
 * Requires DATABASE_URL in env (or .env file loaded separately).
 */
import { PrismaClient } from '@prisma/client';
import path from 'node:path';

process.env['ANTHROPIC_API_KEY'] ??= 'placeholder';
process.env['ARTIFACTS_REPO_PATH'] ??= '/tmp';
process.env['WORKTREES_ROOT'] ??= '/tmp';

// ── Inline env load (script context, not server context) ─────────────────────
import { readFileSync } from 'node:fs';
try {
  const dotenv = readFileSync(
    new URL('../apps/server/.env', import.meta.url).pathname,
    'utf-8',
  );
  for (const line of dotenv.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, '');
  }
} catch {
  // no .env — DATABASE_URL must already be in env
}

const prisma = new PrismaClient();

interface WriteEvent {
  turn: number;
  file: string;
}

function parseWriteFileLine(text: string): WriteEvent | null {
  // Format: "◦ turn 21 · write_file orderCardClubsListStrongId.test.js (2304 chars content)"
  const m = text.match(/turn\s+(\d+)\s+·\s+write_file\s+(\S+)/);
  if (!m) return null;
  return { turn: Number(m[1]), file: path.basename(m[2]!) };
}

async function measureFeature(featureId: string): Promise<void> {
  // Query agent.log events for write_file calls from test agent
  const logEvents = await prisma.event.findMany({
    where: {
      featureId,
      type: 'agent.log',
      agent: 'test',
    },
    select: { payload: true },
    orderBy: { seq: 'asc' },
  });

  // Query usage.recorded events for test agent
  const usageEvents = await prisma.event.findMany({
    where: {
      featureId,
      type: 'usage.recorded',
      agent: 'test',
    },
    select: { payload: true },
  });

  if (usageEvents.length === 0) {
    console.log(`  ${featureId}: no test-agent usage events`);
    return;
  }

  // Parse write_file calls
  const writes: WriteEvent[] = [];
  for (const ev of logEvents) {
    const p = ev.payload as Record<string, unknown>;
    const text = typeof p['text'] === 'string' ? p['text'] : '';
    if (!text.includes('write_file')) continue;
    const parsed = parseWriteFileLine(text);
    if (parsed) writes.push(parsed);
  }

  // Count rewrite turns: files written on >1 distinct turn
  const fileToTurns = new Map<string, Set<number>>();
  for (const w of writes) {
    const turns = fileToTurns.get(w.file) ?? new Set<number>();
    turns.add(w.turn);
    fileToTurns.set(w.file, turns);
  }

  let rewriteTurns = 0;
  for (const turns of fileToTurns.values()) {
    if (turns.size > 1) rewriteTurns += turns.size - 1; // first write is authorship; rest are rewrites
  }

  // Sum output tokens and count total turns
  let totalOutputTokens = 0;
  for (const ev of usageEvents) {
    const p = ev.payload as Record<string, unknown>;
    totalOutputTokens += Number(p['output_tokens'] ?? 0);
  }
  const totalTurns = usageEvents.length;

  // Estimate rewrite tokens (assumes equal tokens per turn)
  const rewriteFraction = totalTurns > 0 ? rewriteTurns / totalTurns : 0;
  const rewriteTokens = Math.round(rewriteFraction * totalOutputTokens);
  const pct = (rewriteFraction * 100).toFixed(1);

  const fileRewrites = [...fileToTurns.entries()]
    .filter(([, turns]) => turns.size > 1)
    .map(([f, turns]) => `${f}(×${turns.size})`)
    .join(', ');

  console.log(
    `  ${featureId.slice(0, 8)} | output: ${totalOutputTokens.toLocaleString()} | rewrite: ${rewriteTokens.toLocaleString()} (${pct}%) | turns: ${totalTurns} | rewrote: ${fileRewrites || 'none'}`,
  );
}

async function main(): Promise<void> {
  console.log('Test-agent rewrite cost measurement');
  console.log('  featureId | output tokens | rewrite tokens (%) | turns | rewritten files');
  console.log('  ' + '-'.repeat(80));

  // Feature from the plan spec
  const TARGET_FEATURE = 'f78613cd';

  // Recent features with test-agent usage
  const recentUsage = await prisma.event.findMany({
    where: { type: 'usage.recorded', agent: 'test' },
    select: { featureId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    distinct: ['featureId'],
    take: 6,
  });

  const featureIds = [
    TARGET_FEATURE,
    ...recentUsage.map((e) => e.featureId).filter((id) => id !== TARGET_FEATURE),
  ].slice(0, 6);

  for (const id of featureIds) {
    await measureFeature(id);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
