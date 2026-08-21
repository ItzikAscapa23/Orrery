import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { createMessageStream } from '../lib/anthropic.js';
import type { UsageRecord } from '../lib/anthropic.js';

// ── Manifest schema ───────────────────────────────────────────────────────────

const RepoEntrySchema = z.object({
  id: z.string(),
  side: z.enum(['server', 'client']),
  // Defaults to false: entries without the field are treated as inactive.
  active: z.boolean().default(false),
  // Defaults to 'full': entries without the field use the full pipeline.
  path: z.enum(['light', 'full']).default('full'),
  url: z.string(),
  default_branch: z.string(),
  description: z.string(),
});

const ManifestSchema = z.object({ repos: z.array(RepoEntrySchema) });

type RepoEntry = z.infer<typeof RepoEntrySchema>;

export function loadActiveRepos(manifestPath = MANIFEST_PATH): RepoEntry[] {
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  const manifest = ManifestSchema.parse(yaml.load(raw));
  return manifest.repos.filter((r) => r.active);
}

// ── Output schema ─────────────────────────────────────────────────────────────

const PlanTaskSchema = z.object({
  repo: z.string(),
  side: z.enum(['server', 'client']),
  title: z.string(),
  description: z.string(),
  spec_refs: z.array(z.string()),
  depends_on: z.array(z.string()),
});

const PlanOutputSchema = z.object({
  contract_yaml: z.string().min(1),
  tasks: z.array(PlanTaskSchema),
});

export type PlanOutput = z.infer<typeof PlanOutputSchema>;
export type PlanTask = z.infer<typeof PlanTaskSchema>;

// ── Paths ─────────────────────────────────────────────────────────────────────

const MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/agents/repo-manifest.yaml',
);

// ── Prompt ────────────────────────────────────────────────────────────────────

export function buildSystemPrompt(
  selectedRepos: string[] = [],
  manifestPath = MANIFEST_PATH,
): string {
  const allActive = loadActiveRepos(manifestPath);
  // When selectedRepos is non-empty, restrict to the operator's chosen set.
  // Empty = legacy row; fall back to all active repos.
  const repos =
    selectedRepos.length > 0 ? allActive.filter((r) => selectedRepos.includes(r.id)) : allActive;
  const manifestSection = repos
    .map((r) => `- id: ${r.id}\n  side: ${r.side}\n  description: ${r.description.trim()}`)
    .join('\n');
  return (
    'You are a senior software architect producing an implementation plan for a feature.\n\n' +
    '## Repository manifest (selected repos)\n' +
    manifestSection +
    '\n\n' +
    '## Output contract\n' +
    'Return ONLY valid JSON — no prose, no markdown fences — matching:\n' +
    '{ "contract_yaml": "<OpenAPI YAML string>", "tasks": [ { "repo": "<id from manifest>", ' +
    '"side": "server"|"client", "title": "<short title>", "description": "<implementation ' +
    'instructions>", "spec_refs": ["<heading>"], "depends_on": ["<task title>"] } ] }\n\n' +
    'Rules:\n' +
    '- contract_yaml must be a valid OpenAPI 3.0 YAML document as a JSON string.\n' +
    '- Every task must reference a repo id from the selected repos.\n' +
    '- depends_on lists task titles this task must wait for (empty array if none).\n' +
    '- Emit each distinct task once. Do not invent tasks not implied by the spec.\n' +
    '- Granularity: the test planner will later decide which tasks need acceptance tests; ' +
    'each covered task triggers one full test-agent run. Split tasks only when they have ' +
    'distinct acceptance criteria testable in isolation. Merge tasks that share the same ' +
    'observable behaviour — one endpoint, one mutation, one screen — into a single task. ' +
    'Do not split a single behaviour across multiple tasks just to create smaller units of work.'
  );
}

function parseResponse(text: string): PlanOutput | null {
  let json: unknown;
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json|yaml)?\n?/, '')
      .replace(/\n?```$/, '');
    json = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const result = PlanOutputSchema.safeParse(json);
  return result.success ? result.data : null;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runPlannerAgent(
  featureId: string,
  featureName: string,
  specMarkdown: string,
  onUsage?: (u: UsageRecord) => void | Promise<void>,
  revisionContext?: { priorPlan: string; comment: string },
  selectedRepos: string[] = [],
): Promise<PlanOutput> {
  const systemPrompt = buildSystemPrompt(selectedRepos);
  const userContent = revisionContext
    ? [
        `Feature: ${featureName}`,
        '',
        'Approved spec:',
        '',
        specMarkdown,
        '',
        '---',
        '',
        'Previous plan (the plan you are revising):',
        '',
        revisionContext.priorPlan,
        '',
        '---',
        '',
        `The developer reviewed the previous plan and requires: ${revisionContext.comment}`,
        '',
        'Produce a revised plan that addresses this requirement. Keep everything else stable unless the change requires it.',
      ].join('\n')
    : `Feature: ${featureName}\n\nApproved spec:\n\n${specMarkdown}`;
  const usageCb = onUsage ? (u: UsageRecord) => void onUsage(u) : undefined;

  const first = await (
    await createMessageStream(
      {
        model: 'claude-sonnet-5',
        max_tokens: 8192, // raised from 4096: two-sided plans include full OpenAPI + task lists
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      },
      featureId,
      usageCb,
    )
  ).finalMessage();

  if (first.stop_reason === 'max_tokens') {
    console.error(
      JSON.stringify({
        event: 'planner_agent_truncated',
        featureId,
        attempt: 1,
        stop_reason: first.stop_reason,
      }),
    );
  }

  const firstText = first.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const firstParsed = parseResponse(firstText);
  if (firstParsed) return firstParsed;

  // Retry once. Do NOT echo the prior response: if it was truncated it would
  // consume most of the token budget, leaving no room for the actual output.
  // Send only the parse error and ask for a fresh attempt.
  const retryContent =
    `${userContent}\n\n` +
    `Your previous response could not be parsed as valid JSON matching the required schema. ` +
    `Return ONLY valid JSON — no prose, no markdown fences — matching the output contract in the system prompt.`;

  const second = await (
    await createMessageStream(
      {
        model: 'claude-sonnet-5',
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: retryContent }],
      },
      featureId,
      usageCb,
    )
  ).finalMessage();

  if (second.stop_reason === 'max_tokens') {
    console.error(
      JSON.stringify({
        event: 'planner_agent_truncated',
        featureId,
        attempt: 2,
        stop_reason: second.stop_reason,
      }),
    );
  }

  const secondText = second.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const secondParsed = parseResponse(secondText);
  if (secondParsed) return secondParsed;

  throw new Error(
    `Planner agent parse failure after retry. Last response: ${secondText.slice(0, 200)}`,
  );
}
