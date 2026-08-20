import { z } from 'zod';
import { createMessageStream } from '../lib/anthropic.js';
import type { UsageRecord } from '../lib/anthropic.js';

// ── Output schema ─────────────────────────────────────────────────────────────

const CoverageEntrySchema = z.object({
  taskId: z.string(),
  covered: z.boolean(),
  behaviour: z.string().optional(), // what to test (when covered)
  skipReason: z.string().optional(), // why skipped (when not covered)
});

const TestPlanOutputSchema = z.object({
  coverage: z.array(CoverageEntrySchema),
});

export type CoverageEntry = z.infer<typeof CoverageEntrySchema>;
export type TestPlanOutput = z.infer<typeof TestPlanOutputSchema>;

export interface TaskSummary {
  id: string;
  title: string;
  specRefs: string[];
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return (
    'You are a QA lead deciding test coverage for a software feature.\n\n' +
    'You will receive: the approved spec, the API contract, and a task list ' +
    'with only task IDs, titles, and spec section references — never implementation ' +
    'descriptions. Your job is to decide which tasks warrant acceptance tests.\n\n' +
    '## Coverage rules\n' +
    '- Mark a task COVERED if it exposes observable public behaviour: an HTTP ' +
    'endpoint, a UI screen, a data mutation visible via the API, or a business rule ' +
    'testable from the outside.\n' +
    '- Mark a task SKIPPED if it has no public surface: database migrations, shared ' +
    'utility functions, type definitions, logging helpers, configuration files, or ' +
    'internal refactors. State the reason explicitly.\n' +
    '- When several tasks in a dependency chain contribute to ONE observable behaviour — ' +
    'for example, helper computations or sub-routines that are only externally visible ' +
    'through a single endpoint, resolver, or mutation — cover the task at which that ' +
    'behaviour first becomes observable (usually the last integration/composition task ' +
    'in the chain) and skip the intermediate tasks. A skipped intermediate task MUST ' +
    'name the covering task: use the form "Covered by acceptance test for <task-id> — ' +
    '<task-title>". A silent omission is not acceptable. Do NOT apply this rule across ' +
    'independently observable behaviours — two endpoints are two behaviours even if one ' +
    'task implements both; only collapse within a single observable surface.\n' +
    '- Do not invent requirements beyond the spec and contract.\n' +
    '- Every task in the list must appear in the output — do not silently omit any.\n\n' +
    '## Output contract\n' +
    'Return ONLY valid JSON — no prose, no markdown fences — matching:\n' +
    '{ "coverage": [ { "taskId": "<id>", "covered": true|false, ' +
    '"behaviour": "<what to test — required when covered>", ' +
    '"skipReason": "<why skipped — required when not covered>" } ] }'
  );
}

function buildUserContent(
  specMarkdown: string,
  contractYaml: string,
  tasks: TaskSummary[],
): string {
  const taskList = tasks
    .map(
      (t) =>
        `- id: ${t.id}\n  title: ${t.title}\n  specRefs: [${t.specRefs.join(', ')}]`,
    )
    .join('\n');
  return [
    '## Spec',
    '',
    specMarkdown,
    '',
    '## Contract',
    '',
    '```yaml',
    contractYaml,
    '```',
    '',
    '## Task list (IDs, titles, spec references only)',
    '',
    taskList,
  ].join('\n');
}

function parseResponse(text: string): TestPlanOutput | null {
  let json: unknown;
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '');
    json = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const result = TestPlanOutputSchema.safeParse(json);
  return result.success ? result.data : null;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runTestPlannerAgent(
  featureId: string,
  specMarkdown: string,
  contractYaml: string,
  tasks: TaskSummary[],
  onUsage?: (u: UsageRecord) => void | Promise<void>,
): Promise<TestPlanOutput> {
  const systemPrompt = buildSystemPrompt();
  const userContent = buildUserContent(specMarkdown, contractYaml, tasks);
  const usageCb = onUsage ? (u: UsageRecord) => void onUsage(u) : undefined;

  const response = await (
    await createMessageStream(
      {
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      },
      featureId,
      usageCb,
    )
  ).finalMessage();

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const parsed = parseResponse(text);
  if (parsed) return parsed;

  // Fallback: cover all tasks so the feature is never bricked by a parse failure.
  console.error(
    JSON.stringify({
      event: 'test_planner_parse_failure',
      featureId,
      rawLength: text.length,
      raw: text.slice(0, 500),
    }),
  );
  return {
    coverage: tasks.map((t) => ({
      taskId: t.id,
      covered: true,
      behaviour: 'Fallback: parser could not read coverage plan — treating as covered',
    })),
  };
}
