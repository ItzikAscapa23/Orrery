import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type Anthropic from '@anthropic-ai/sdk';
import { createMessageStream, withLastMessageCached } from '../lib/anthropic.js';
import type { UsageRecord } from '../lib/anthropic.js';
import type { ContainerHandle } from '../lib/container.js';
import {
  AllowlistViolationError,
  MetacharViolationError,
  ALLOWED_COMMANDS_HINT,
  metaCharGuidance,
} from '../lib/container.js';
import { summarizeBashTestRun } from '../lib/testOutputSummary.js';
import { checkNonProgress } from '../lib/nonProgressError.js';
import { env } from '../lib/env.js';

// ── Test-file authorship guard ────────────────────────────────────────────────

/**
 * Returns the set of repo-relative file paths that were committed with the
 * X-Orrery-Agent: test trailer (i.e. authored by the test agent).
 * Returns an empty set when git fails or no such commits exist yet.
 */
export function getTestAuthoredSet(worktreePath: string): Set<string> {
  try {
    const out = execFileSync(
      'git',
      [
        '-C',
        worktreePath,
        'log',
        '--grep=^X-Orrery-Agent: test',
        '--diff-filter=A',
        '--name-only',
        '--pretty=format:',
      ],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return new Set(
      out
        .trim()
        .split('\n')
        .filter((f) => f.trim() !== ''),
    );
  } catch {
    return new Set();
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const BASH_TOOL: Anthropic.Tool = {
  name: 'bash',
  description:
    'Run a single allowlisted shell command (npm, git, read-only exploration). ' +
    'No shell operators. Use write_file to create/edit code — not bash redirection.',
  input_schema: {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'Shell command to run.' },
    },
    required: ['command'],
  },
};

const WRITE_FILE_TOOL: Anthropic.Tool = {
  name: 'write_file',
  description:
    'Create a NEW file, or replace a file entirely when most of it changes. ' +
    'To change part of an existing file use edit_file.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to repo root, e.g. src/routes/uptime.ts',
      },
      content: { type: 'string', description: 'Full file content to write.' },
    },
    required: ['path', 'content'],
  },
};

const EDIT_FILE_TOOL: Anthropic.Tool = {
  name: 'edit_file',
  description:
    'Change part of an EXISTING file. Prefer this over write_file for any file that already ' +
    'exists — it costs a fraction of the tokens and keeps the conversation short.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'File path relative to repo root.' },
      old_str: {
        type: 'string',
        description:
          'Exact text to replace, including surrounding whitespace/newlines. ' +
          'Must match the file EXACTLY in ONE place.',
      },
      new_str: {
        type: 'string',
        description: 'Replacement text. Empty string to delete the matched text.',
      },
    },
    required: ['path', 'old_str', 'new_str'],
  },
};

const READ_FILE_TOOL: Anthropic.Tool = {
  name: 'read_file',
  description:
    'Read a file from the repository worktree. ' +
    'Use this to inspect existing source files before editing them. ' +
    'Supply start_line / end_line to read a specific section (1-based, inclusive). ' +
    'Returns the whole file with 1-based line numbers. ' +
    'For files over 500 lines, only the first 500 lines are returned — use start_line/end_line to read the rest.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'File path relative to repo root.' },
      start_line: {
        type: 'number',
        description: 'First line to return (1-based, inclusive). Omit for whole file.',
      },
      end_line: {
        type: 'number',
        description:
          'Last line to return (1-based, inclusive). Omitted or beyond EOF → last line of file.',
      },
    },
    required: ['path'],
  },
};

export const PROPOSE_AMENDMENT_TOOL: Anthropic.Tool = {
  name: 'propose_amendment',
  description:
    'Propose a revision to contract.yaml when the current contract is genuinely insufficient ' +
    'to implement this task (e.g. a required endpoint or schema is missing). ' +
    'The orchestrator will pause all tasks and present the proposal to the operator. ' +
    'ONLY call this if the contract is truly incomplete — do not use it to avoid implementing ' +
    'the task. Provide the complete replacement contract.yaml, not a partial diff. ' +
    "Example trigger: your task says to display response.pollutant but the contract's " +
    'response schema has no pollutant field → propose adding it rather than inventing the field.',
  input_schema: {
    type: 'object' as const,
    properties: {
      contract_yaml: {
        type: 'string',
        description: 'Complete replacement contract.yaml content (valid OpenAPI 3.0 YAML).',
      },
      rationale: {
        type: 'string',
        description: 'One-paragraph explanation of what is missing and why the change is required.',
      },
    },
    required: ['contract_yaml', 'rationale'],
  },
};

const MAX_TURNS = 40;
const _BUDGET_WARNING_TURN = 31; // inject nudge at this turn so 10 turns remain
const MAX_VIOLATIONS = 3;
const OUTPUT_MAX_BYTES = 8 * 1024;
const OUTPUT_MAX_LINES = 200;
const READ_FILE_MAX_LINES = 500;
const READ_FILE_MAX_BYTES = 40 * 1024;

export interface DevTask {
  id: string;
  title: string;
  description: string;
  specRefs: string[];
}

export interface DevContext {
  specMarkdown: string;
  contractYaml: string;
  repoClaudeMd: string;
  // Optional: overrides the "TypeScript API repository" opener in the system prompt.
  // Populated from the manifest description field so the agent knows the repo type.
  repoDescription?: string;
  // Optional: operator rulings from prior rejected amendments for this feature.
  // When present, injected as ## Rejected amendments so agents do not re-propose
  // the same contract change that the operator already declined.
  rejectedAmendments?: Array<{ rationaleSummary: string; operatorReason: string }>;
  // Optional: generated host-side by generateRepoOrientation(). Injected after
  // CLAUDE.md and before the contract so it sits inside the cached prefix.
  orientationBlock?: string;
  // Optional: per-repo turn cap from the manifest. Defaults to MAX_TURNS (40) when absent.
  maxTurns?: number;
  // Optional: manifest probe_command for this repo. When set, its extra flags
  // (e.g. --maxWorkers=2) are grafted onto every agent-issued test command.
  probeCommand?: string;
  // When true, the test agent has already authored acceptance tests for this
  // task. The dev agent must not write new test files — its job is to make the
  // existing acceptance tests pass.
  coveredByTestPlan?: boolean;
}

// Discriminated union returned by runDevAgent (formerly runServerDevAgent).
// 'completed' = normal end_turn path (max_tokens turns are recovered and loop continues);
// 'amendment_proposed' = agent called propose_amendment and the orchestrator must pause all tasks and open a gate.
export type AgentOutcome =
  | { kind: 'completed' }
  | { kind: 'amendment_proposed'; contractYaml: string; rationale: string; taskId: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a model-supplied path against the worktree root.
 * Rejects absolute paths and any traversal that escapes the root.
 */
export function resolveWorktreePath(worktreeRoot: string, requestedPath: string): string {
  if (path.isAbsolute(requestedPath)) {
    throw new Error(
      `Path '${requestedPath}' is absolute — paths must be relative to the repo root.`,
    );
  }
  const resolved = path.resolve(worktreeRoot, requestedPath);
  const root = worktreeRoot.endsWith(path.sep) ? worktreeRoot : worktreeRoot + path.sep;
  if (!resolved.startsWith(root) && resolved !== worktreeRoot) {
    throw new Error(
      `Path '${requestedPath}' escapes the worktree — '..' traversal is not allowed.`,
    );
  }
  return resolved;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let start = 0;
  while ((start = haystack.indexOf(needle, start)) !== -1) {
    count++;
    start += needle.length;
  }
  return count;
}

function truncateOutput(raw: string): string {
  const lines = raw.split('\n');
  if (raw.length <= OUTPUT_MAX_BYTES && lines.length <= OUTPUT_MAX_LINES) return raw;
  const kept = lines.slice(-OUTPUT_MAX_LINES);
  const truncatedBy = lines.length - kept.length;
  const prefix =
    truncatedBy > 0 ? `(truncated — showing last ${kept.length} of ${lines.length} lines)\n` : '';
  return prefix + kept.join('\n').slice(-OUTPUT_MAX_BYTES);
}

function truncateFileOutput(raw: string): string {
  const lines = raw.split('\n');
  const numbered = lines.map((l, i) => `${i + 1}\t${l}`);
  if (raw.length <= READ_FILE_MAX_BYTES && lines.length <= READ_FILE_MAX_LINES) {
    return numbered.join('\n');
  }
  const kept = numbered.slice(0, READ_FILE_MAX_LINES);
  return (
    kept.join('\n') +
    `\n(showing first ${READ_FILE_MAX_LINES} of ${lines.length} lines — use start_line/end_line to read the rest)`
  );
}

export function buildSystemPrompt(task: DevTask, ctx: DevContext): string {
  const repoLine = ctx.repoDescription
    ? `You are a senior software engineer implementing a feature in the following repository: ${ctx.repoDescription}`
    : 'You are a senior software engineer implementing a feature in a TypeScript API repository.';
  return [
    repoLine,
    '',
    '## Repository conventions (CLAUDE.md)',
    ctx.repoClaudeMd,
    '',
    ...(ctx.orientationBlock ? [ctx.orientationBlock, ''] : []),
    '## OpenAPI contract (contract.yaml)',
    ctx.contractYaml,
    '',
    '## Relevant spec sections',
    ctx.specMarkdown,
    '',
    '## Your task',
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    task.specRefs.length > 0 ? `Spec refs: ${task.specRefs.join(', ')}` : '',
    '',
    ...(ctx.coveredByTestPlan
      ? [
          '## Test-first task',
          'The test agent has already written acceptance tests for this task.',
          'Do NOT write new test files or author acceptance tests — the test files already exist.',
          'Your job is to implement production code so that the existing acceptance tests pass.',
          'Run `npm test`. When acceptance tests pass, call end_turn.',
          '',
        ]
      : []),
    '## Rules',
    '- Implement only what this task requires. Do not change unrelated code.',
    '- Run `npm test` after implementation. Fix all failures.',
    '- When tests pass, your work is done — call end_turn. Do not make further changes.',
    '- The orchestrator commits your changes after verifying tests. You do not git commit.',
    '- The container working directory is /workspace — run commands directly. Never prefix with `cd /workspace &&` or any `cd <path> &&`.',
    "- Use edit_file to modify existing files. Use write_file only to create new files or when replacing most of a file's content. Rewriting a whole file to change a few lines wastes context and slows every later turn.",
    ...(ctx.orientationBlock
      ? [
          '- The repository layout, dependencies and compiler options are given above.' +
            ' Do not run find, ls, or cat to rediscover them.' +
            ' Read a file only when you need its contents.',
        ]
      : []),
    '',
    '## Contract authority',
    'contract.yaml is the sole authority on API request/response shapes.',
    'Task descriptions describe intent; the contract defines truth.',
    'If your task requires a field the contract does not define — or conflicts with the',
    'contract in any direction — do NOT invent fields and do NOT silently drop requirements:',
    'call the propose_amendment tool with the schema change you need and why.',
    'Implementing against a field the contract lacks is a defect, not initiative.',
    '',
    ...(ctx.rejectedAmendments && ctx.rejectedAmendments.length > 0
      ? [
          '## Rejected amendments',
          'The operator has already ruled on the following contract change requests for this feature.',
          'Do NOT re-propose amendments for the same need. Implement within the existing contract',
          'per the ruling, adapting or omitting task requirements that depend on the rejected change.',
          '',
          ...ctx.rejectedAmendments.map(
            (r, i) =>
              `${i + 1}. Need: "${r.rationaleSummary}"\n   Ruling: "${r.operatorReason || 'rejected — implement within the existing contract'}"`,
          ),
          '',
        ]
      : []),
    '## Tools',
    'You have three tools:',
    '',
    '**write_file(path, content)** — Create a new file, or replace a file entirely when most of it changes.',
    'Path is relative to the repository root (e.g. src/routes/uptime.ts).',
    '',
    '**edit_file(path, old_str, new_str)** — Change part of an existing file. Prefer this over',
    'write_file for any file that already exists — it costs a fraction of the tokens.',
    'old_str must match the file EXACTLY in ONE place (whitespace and newlines included).',
    'new_str replaces it. Pass new_str="" to delete matched text.',
    '',
    '**read_file(path, start_line?, end_line?)** — Read an existing file. Use this to inspect code before',
    'editing it. Supply start_line and end_line (1-based, inclusive) to read a slice — slices are returned in full.',
    'Whole-file output is capped at 200 lines / 8 KB.',
    '',
    '**bash(command)** — Run a single shell command. Use only for: npm test,',
    'npm run lint, npm run typecheck, read-only exploration',
    '(cat, ls, find, grep, head, tail, wc, pwd), and running scripts with node <file>.',
    'git is NOT available — the orchestrator handles all version control.',
    'No shell operators (;, &&, ||, |, $, >, <, backticks). One command per call.',
    'Backslash (\\) is allowed for grep alternation: grep "pattern1\\|pattern2" file',
    'Three violations end the task permanently.',
    '',
    'Output capture rules (violations waste your violation budget):',
    '- stdout AND stderr are captured and returned together automatically — never use pipes (|), chaining (;, &&, ||), or file redirection (> file, 2> file); 2>&1 is permitted',
    '- Output is ALWAYS auto-truncated to a safe length — you never need | head, | tail, or | grep to shrink it.' +
      ' Any command containing | > < ; & fails, every time, with no exception.',
    '- To run a short script: write_file the script first, then bash("node path/to/script.js")',
    '- Never use node -e "..." — the inline code contains shell metacharacters',
    '- When exploring: use read_file for specific files, a single grep or find for searches.' +
      " node_modules is off-limits for exploration — read package.json and the repo's own src/ instead." +
      ' Answers about installed packages, available types, and JSX support are in package.json and tsconfig.json — never spelunk node_modules.',
    '',
    'Allowed bash commands:',
    ALLOWED_COMMANDS_HINT,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// ── Prompt measurement ────────────────────────────────────────────────────────

export interface DevPromptSections {
  claudeMd: number;
  contract: number;
  spec: number;
  task: number;
  orientation: number;
  rules: number;
  total: number;
}

/**
 * Return per-section character counts for the system prompt that would be built
 * from `task` and `ctx`. `rules` is derived by subtraction so the measurement
 * stays accurate automatically as buildSystemPrompt evolves.
 */
export function measurePromptSections(task: DevTask, ctx: DevContext): DevPromptSections {
  const claudeMd = ctx.repoClaudeMd.length;
  const contract = ctx.contractYaml.length;
  const spec = ctx.specMarkdown.length;
  const orientation = ctx.orientationBlock?.length ?? 0;
  const taskText = [
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    task.specRefs.length > 0 ? `Spec refs: ${task.specRefs.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const taskLen = taskText.length;
  const fullPrompt = buildSystemPrompt(task, ctx);
  return {
    claudeMd,
    contract,
    spec,
    task: taskLen,
    orientation,
    rules: fullPrompt.length - claudeMd - contract - spec - taskLen - orientation,
    total: fullPrompt.length,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface ViolationInfo {
  rule: 'metachar' | 'allowlist';
  command: string;
  count: number;
  max: number;
  char?: string;
}

export interface ToolCallInfo {
  turn: number;
  toolName: string;
  resultSize: number;
  resultFirstLine?: string;
  path?: string;
  range?: string;
  command?: string;
  contentLength?: number;
  oldStrLength?: number;
  newStrLength?: number;
}

export async function runDevAgent(
  featureId: string,
  task: DevTask,
  ctx: DevContext,
  container: ContainerHandle,
  worktreePath: string,
  onUsage?: (u: UsageRecord) => void | Promise<void>,
  onViolation?: (info: ViolationInfo) => void | Promise<void>,
  onToolCall?: (info: ToolCallInfo) => void | Promise<void>,
): Promise<AgentOutcome> {
  const systemPrompt = buildSystemPrompt(task, ctx);
  const usageCb = onUsage ? (u: UsageRecord) => void onUsage(u) : undefined;

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Implement task ${task.id}: ${task.title}. Follow the rules in the system prompt.`,
    },
  ];

  const maxTurns = ctx.maxTurns ?? MAX_TURNS;
  const budgetWarningTurn = maxTurns - 9; // warn when 10 turns remain (including current)

  const testAuthoredFiles = getTestAuthoredSet(worktreePath);

  let turn = 0;
  let violationCount = 0;
  const nonProgressThreshold = env.NON_PROGRESS_THRESHOLD;
  const recentToolHashes: string[] = [];

  while (turn < maxTurns) {
    turn++;
    let violationsThisTurn = 0;

    // Budget warning: inject a user nudge at turn budgetWarningTurn so the agent
    // knows it is running low and should stop exploring and commit what it has.
    // Injected as a user message so the assistant sees it as an instruction.
    if (turn === budgetWarningTurn) {
      messages.push({
        role: 'user',
        content: `[System] ${maxTurns - budgetWarningTurn + 1} turns remain (including this one). Prioritize: if tests pass, call end_turn now. If not, make the minimum change needed to get tests passing and call end_turn — do not start new exploration.`,
      });
    }

    const stream = await createMessageStream(
      {
        model: 'claude-sonnet-5',
        // 16384: dev agent writes multi-file implementations; plannerAgent uses 8192 for
        // single-shot plan generation — the two differ deliberately, not by accident.
        max_tokens: 16384,
        system: [
          // cache_control is absent from TextBlockParam in SDK ^0.26 (beta field not yet typed)
          {
            type: 'text' as const,
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          } as Anthropic.TextBlockParam,
        ],
        tools: [BASH_TOOL, WRITE_FILE_TOOL, EDIT_FILE_TOOL, READ_FILE_TOOL, PROPOSE_AMENDMENT_TOOL],
        messages: withLastMessageCached(messages),
      },
      featureId,
      usageCb,
    );
    const response = await stream.finalMessage();

    const assistantContent: Anthropic.ContentBlock[] = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    if (response.stop_reason === 'end_turn') {
      break;
    }

    if (response.stop_reason === 'max_tokens') {
      // The model filled the output window mid-response. The partial assistant
      // message must NOT remain in the conversation — the API rejects a trailing
      // assistant turn that ends without end_turn or tool_use. Pop it, then inject
      // a user nudge so the next turn recovers with a clean slate.
      messages.pop();
      messages.push({
        role: 'user',
        content:
          '[System] Your last response was cut off because it hit the output limit. ' +
          'Resume from where you left off. If you were writing a file, re-emit it in full with write_file. ' +
          'If you were running a command, re-issue it. Continue the task normally.',
      });
      continue;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue;

        let result: string;
        // Hoisted so the error-fallthrough onToolCall below can include them
        // even when the tool branch throws before reaching its own onToolCall.
        let callPath: string | undefined;
        let callRange: string | undefined;
        let callCommand: string | undefined;
        let callContentLength: number | undefined;
        let callOldStrLength: number | undefined;
        let callNewStrLength: number | undefined;
        try {
          if (block.name === 'bash') {
            const { command = '' } = block.input as { command?: string };
            callCommand = command.slice(0, 120);
            const summary = await summarizeBashTestRun(command, container, ctx.probeCommand);
            if (summary !== null) {
              result = summary;
            } else {
              const execResult = await container.exec(command);
              const raw =
                [execResult.stdout, execResult.stderr].filter(Boolean).join('\n') || '(no output)';
              result = truncateOutput(raw);
            }
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            if (onToolCall)
              await onToolCall({
                turn,
                toolName: 'bash',
                resultSize: result.length,
                resultFirstLine: (result.split('\n')[0] ?? '').slice(0, 120),
                command: command.slice(0, 120),
              });
            continue;
          } else if (block.name === 'write_file') {
            const { path: filePath = '', content = '' } = block.input as {
              path?: string;
              content?: string;
            };
            callPath = filePath;
            callContentLength = content.length;
            if (testAuthoredFiles.has(filePath)) {
              const errContent =
                `${filePath} is read-only: authored by the test agent ` +
                `(X-Orrery-Agent: test). The dev agent must not modify acceptance tests.`;
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                is_error: true,
                content: errContent,
              });
              continue;
            }
            const absPath = resolveWorktreePath(worktreePath, filePath);
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, content, 'utf-8');
            result = `Written ${filePath} (${content.length} bytes)`;
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            if (onToolCall)
              await onToolCall({
                turn,
                toolName: 'write_file',
                resultSize: result.length,
                resultFirstLine: (result.split('\n')[0] ?? '').slice(0, 120),
                path: filePath,
                contentLength: content.length,
              });
            continue;
          } else if (block.name === 'edit_file') {
            const {
              path: filePath = '',
              old_str = '',
              new_str = '',
            } = block.input as { path?: string; old_str?: string; new_str?: string };
            callPath = filePath;
            callOldStrLength = old_str.length;
            callNewStrLength = new_str.length;
            if (testAuthoredFiles.has(filePath)) {
              const errContent =
                `${filePath} is read-only: authored by the test agent ` +
                `(X-Orrery-Agent: test). The dev agent must not modify acceptance tests.`;
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                is_error: true,
                content: errContent,
              });
              continue;
            }
            const absPath = resolveWorktreePath(worktreePath, filePath);
            const current = fs.readFileSync(absPath, 'utf-8');
            const matchCount = countOccurrences(current, old_str);
            if (matchCount === 0) {
              const errContent = `old_str not found in ${filePath}`;
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                is_error: true,
                content: errContent,
              });
              if (onToolCall)
                await onToolCall({
                  turn,
                  toolName: 'edit_file',
                  resultSize: errContent.length,
                  resultFirstLine: (errContent.split('\n')[0] ?? '').slice(0, 120),
                  path: filePath,
                  oldStrLength: old_str.length,
                  newStrLength: new_str.length,
                });
              continue;
            }
            if (matchCount > 1) {
              const errContent = `old_str matches ${matchCount} times in ${filePath}; include surrounding lines to make it unique.`;
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                is_error: true,
                content: errContent,
              });
              if (onToolCall)
                await onToolCall({
                  turn,
                  toolName: 'edit_file',
                  resultSize: errContent.length,
                  resultFirstLine: (errContent.split('\n')[0] ?? '').slice(0, 120),
                  path: filePath,
                  oldStrLength: old_str.length,
                  newStrLength: new_str.length,
                });
              continue;
            }
            fs.writeFileSync(absPath, current.replace(old_str, new_str), 'utf-8');
            result = `Edited ${filePath} (${old_str.length} → ${new_str.length} chars)`;
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            if (onToolCall)
              await onToolCall({
                turn,
                toolName: 'edit_file',
                resultSize: result.length,
                resultFirstLine: (result.split('\n')[0] ?? '').slice(0, 120),
                path: filePath,
                oldStrLength: old_str.length,
                newStrLength: new_str.length,
              });
            continue;
          } else if (block.name === 'read_file') {
            const {
              path: filePath = '',
              start_line,
              end_line,
            } = block.input as {
              path?: string;
              start_line?: number;
              end_line?: number;
            };
            callPath = filePath;
            // Compute range from input params only — available even if readFileSync throws.
            callRange =
              start_line !== undefined ? `lines ${start_line}–${end_line ?? '?'}` : 'full';
            const absPath = resolveWorktreePath(worktreePath, filePath);
            const raw = fs.readFileSync(absPath, 'utf-8');
            let range: string;
            if (start_line !== undefined) {
              const allLines = raw.split('\n');
              const totalLines = allLines.length;
              if (start_line > totalLines) {
                result = `ERROR: file has ${totalLines} lines; start_line ${start_line} is out of range.`;
                range = `lines ${start_line}–${end_line ?? '?'}`;
              } else {
                const s = start_line - 1;
                const e = end_line !== undefined ? Math.min(end_line, totalLines) : totalLines;
                result = allLines
                  .slice(s, e)
                  .map((l, i) => `${s + i + 1}\t${l}`)
                  .join('\n');
                range = `lines ${start_line}–${end_line ?? totalLines}`;
              }
            } else {
              result = truncateFileOutput(raw);
              range = 'full';
            }
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            if (onToolCall)
              await onToolCall({
                turn,
                toolName: 'read_file',
                resultSize: result.length,
                resultFirstLine: (result.split('\n')[0] ?? '').slice(0, 120),
                path: filePath,
                range,
              });
            continue;
          } else if (block.name === 'propose_amendment') {
            const { contract_yaml = '', rationale = '' } = block.input as {
              contract_yaml?: string;
              rationale?: string;
            };
            // Distinguished early-exit: acknowledge the proposal so the model
            // does not retry, flush the tool result, then return immediately.
            const amendContent =
              'Amendment proposal received. The orchestrator will pause all tasks and ' +
              'present the proposal to the operator.';
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: amendContent,
            });
            if (onToolCall)
              await onToolCall({
                turn,
                toolName: 'propose_amendment',
                resultSize: amendContent.length,
                resultFirstLine: (amendContent.split('\n')[0] ?? '').slice(0, 120),
              });
            messages.push({ role: 'user', content: toolResults });
            return {
              kind: 'amendment_proposed',
              contractYaml: contract_yaml,
              rationale,
              taskId: task.id,
            };
          } else {
            result = `Unknown tool: ${block.name}`;
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            if (onToolCall)
              await onToolCall({
                turn,
                toolName: block.name,
                resultSize: result.length,
                resultFirstLine: (result.split('\n')[0] ?? '').slice(0, 120),
              });
            continue;
          }
        } catch (err) {
          if (block.name === 'bash') {
            if (err instanceof MetacharViolationError) {
              if (violationsThisTurn === 0) violationCount++;
              violationsThisTurn++;
              if (onViolation) {
                const metaCmd = (block.input as { command?: string }).command ?? '';
                await onViolation({
                  rule: 'metachar',
                  command: metaCmd,
                  count: violationCount,
                  max: MAX_VIOLATIONS,
                  char: err.char,
                });
              }
              if (violationCount >= MAX_VIOLATIONS) throw err;
              const errContent =
                metaCharGuidance(err.char) + `\nAllowed commands:\n${ALLOWED_COMMANDS_HINT}`;
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                is_error: true,
                content: errContent,
              });
              const metaCmd = (block.input as { command?: string }).command ?? '';
              if (onToolCall)
                await onToolCall({
                  turn,
                  toolName: 'bash',
                  resultSize: errContent.length,
                  resultFirstLine: (errContent.split('\n')[0] ?? '').slice(0, 120),
                  command: metaCmd.slice(0, 120),
                });
              continue;
            }
            if (err instanceof AllowlistViolationError) {
              if (violationsThisTurn === 0) violationCount++;
              violationsThisTurn++;
              // Detect git commands specifically and give a more helpful message.
              const cmd = (block.input as { command?: string }).command ?? '';
              if (onViolation)
                await onViolation({
                  rule: 'allowlist',
                  command: cmd,
                  count: violationCount,
                  max: MAX_VIOLATIONS,
                });
              if (violationCount >= MAX_VIOLATIONS) throw err;
              const isGit = cmd.trimStart().startsWith('git ');
              const errContent = isGit
                ? `git is not available in the container. ` +
                  `The orchestrator commits your changes after tests pass. ` +
                  `Use write_file to create/modify files, then call end_turn when done.`
                : `Command not on allowlist. ` +
                  `One command per call, no shell operators.\n` +
                  `Allowed commands:\n${ALLOWED_COMMANDS_HINT}`;
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                is_error: true,
                content: errContent,
              });
              if (onToolCall)
                await onToolCall({
                  turn,
                  toolName: 'bash',
                  resultSize: errContent.length,
                  resultFirstLine: (errContent.split('\n')[0] ?? '').slice(0, 120),
                  command: cmd.slice(0, 120),
                });
              continue;
            }
          }
          result = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
        if (onToolCall)
          await onToolCall({
            turn,
            toolName: block.name,
            resultSize: result.length,
            resultFirstLine: (result.split('\n')[0] ?? '').slice(0, 120),
            ...(callPath !== undefined && { path: callPath }),
            ...(callRange !== undefined && { range: callRange }),
            ...(callCommand !== undefined && { command: callCommand }),
            ...(callContentLength !== undefined && { contentLength: callContentLength }),
            ...(callOldStrLength !== undefined && { oldStrLength: callOldStrLength }),
            ...(callNewStrLength !== undefined && { newStrLength: callNewStrLength }),
          });
      }

      // Non-progress guard: reset on write/edit; detect N consecutive identical results.
      const hadWrite = assistantContent.some(
        (b) => b.type === 'tool_use' && (b.name === 'write_file' || b.name === 'edit_file'),
      );
      const lastToolBlock = assistantContent.find((b) => b.type === 'tool_use');
      const cmdName = lastToolBlock?.type === 'tool_use' ? lastToolBlock.name : 'unknown';
      const lastResult = toolResults[toolResults.length - 1];
      const rawContent = lastResult?.content;
      const resultText =
        typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent
                .filter((b): b is { type: 'text'; text: string } => b?.type === 'text')
                .map((b) => b.text)
                .join('\n')
            : '';
      const firstLine = resultText.split('\n').find((l) => l.trim()) ?? resultText.slice(0, 120);
      const npErr = checkNonProgress(
        recentToolHashes,
        toolResults,
        hadWrite,
        nonProgressThreshold,
        cmdName,
        firstLine,
      );
      if (npErr) throw npErr;

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
  }

  if (turn >= maxTurns) {
    throw new Error(`Agent hit ${maxTurns}-turn safety cap without completing task ${task.id}`);
  }

  return { kind: 'completed' };
}

/**
 * Thrown when the agent reaches end_turn with no file changes in the worktree.
 * Non-retryable: a fresh attempt would burn the same budget with the same result.
 */
export class AgentNoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentNoopError';
  }
}

/**
 * Light-path dev agent: no container, no bash, no propose_amendment.
 * For YAML/env-only repos where the agent just needs write_file/edit_file/read_file.
 * Returns when the model calls end_turn.
 */
export async function runLightDevAgent(
  featureId: string,
  systemPrompt: string,
  initialUserMessage: string,
  worktreePath: string,
  onUsage?: (u: UsageRecord) => void | Promise<void>,
  onToolCall?: (info: ToolCallInfo) => void | Promise<void>,
  maxTurnsOverride?: number,
): Promise<void> {
  const usageCb = onUsage ? (u: UsageRecord) => void onUsage(u) : undefined;

  const maxTurns = maxTurnsOverride ?? MAX_TURNS;
  const budgetWarningTurn = maxTurns - 9;

  const testAuthoredFiles = getTestAuthoredSet(worktreePath);

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: initialUserMessage }];

  const nonProgressThreshold = env.NON_PROGRESS_THRESHOLD;
  const recentToolHashes: string[] = [];

  let turn = 0;

  while (turn < maxTurns) {
    turn++;

    if (turn === budgetWarningTurn) {
      messages.push({
        role: 'user',
        content: `[System] ${maxTurns - budgetWarningTurn + 1} turns remain. Finalize your changes and call end_turn.`,
      });
    }

    const stream = await createMessageStream(
      {
        model: 'claude-sonnet-5',
        max_tokens: 16384,
        system: [
          {
            type: 'text' as const,
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          } as Anthropic.TextBlockParam,
        ],
        tools: [WRITE_FILE_TOOL, EDIT_FILE_TOOL, READ_FILE_TOOL],
        messages: withLastMessageCached(messages),
      },
      featureId,
      usageCb,
    );
    const response = await stream.finalMessage();

    const assistantContent: Anthropic.ContentBlock[] = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'max_tokens') {
      messages.pop();
      messages.push({
        role: 'user',
        content:
          '[System] Your last response was cut off. Resume from where you left off and continue the task.',
      });
      continue;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue;

        let result: string;
        try {
          if (block.name === 'write_file') {
            const { path: filePath = '', content = '' } = block.input as {
              path?: string;
              content?: string;
            };
            if (testAuthoredFiles.has(filePath)) {
              result =
                `${filePath} is read-only: authored by the test agent ` +
                `(X-Orrery-Agent: test). The dev agent must not modify acceptance tests.`;
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                is_error: true,
                content: result,
              });
              continue;
            }
            const absPath = resolveWorktreePath(worktreePath, filePath);
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, content, 'utf-8');
            result = `Written ${filePath} (${content.length} bytes)`;
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            if (onToolCall)
              await onToolCall({
                turn,
                toolName: 'write_file',
                resultSize: result.length,
                resultFirstLine: (result.split('\n')[0] ?? '').slice(0, 120),
                path: filePath,
                contentLength: content.length,
              });
            continue;
          } else if (block.name === 'edit_file') {
            const {
              path: filePath = '',
              old_str = '',
              new_str = '',
            } = block.input as { path?: string; old_str?: string; new_str?: string };
            if (testAuthoredFiles.has(filePath)) {
              result =
                `${filePath} is read-only: authored by the test agent ` +
                `(X-Orrery-Agent: test). The dev agent must not modify acceptance tests.`;
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                is_error: true,
                content: result,
              });
              continue;
            }
            const absPath = resolveWorktreePath(worktreePath, filePath);
            const current = fs.readFileSync(absPath, 'utf-8');
            const matchCount = countOccurrences(current, old_str);
            if (matchCount === 0) {
              result = `old_str not found in ${filePath}`;
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                is_error: true,
                content: result,
              });
              if (onToolCall)
                await onToolCall({
                  turn,
                  toolName: 'edit_file',
                  resultSize: result.length,
                  resultFirstLine: (result.split('\n')[0] ?? '').slice(0, 120),
                  path: filePath,
                  oldStrLength: old_str.length,
                  newStrLength: new_str.length,
                });
              continue;
            }
            if (matchCount > 1) {
              result = `old_str matches ${matchCount} times in ${filePath}; include surrounding lines to make it unique.`;
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                is_error: true,
                content: result,
              });
              if (onToolCall)
                await onToolCall({
                  turn,
                  toolName: 'edit_file',
                  resultSize: result.length,
                  resultFirstLine: (result.split('\n')[0] ?? '').slice(0, 120),
                  path: filePath,
                  oldStrLength: old_str.length,
                  newStrLength: new_str.length,
                });
              continue;
            }
            fs.writeFileSync(absPath, current.replace(old_str, new_str), 'utf-8');
            result = `Edited ${filePath} (${old_str.length} → ${new_str.length} chars)`;
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            if (onToolCall)
              await onToolCall({
                turn,
                toolName: 'edit_file',
                resultSize: result.length,
                resultFirstLine: (result.split('\n')[0] ?? '').slice(0, 120),
                path: filePath,
                oldStrLength: old_str.length,
                newStrLength: new_str.length,
              });
            continue;
          } else if (block.name === 'read_file') {
            const {
              path: filePath = '',
              start_line,
              end_line,
            } = block.input as { path?: string; start_line?: number; end_line?: number };
            const absPath = resolveWorktreePath(worktreePath, filePath);
            const raw = fs.readFileSync(absPath, 'utf-8');
            let range: string;
            if (start_line !== undefined) {
              const allLines = raw.split('\n');
              const totalLines = allLines.length;
              if (start_line > totalLines) {
                result = `ERROR: file has ${totalLines} lines; start_line ${start_line} is out of range.`;
                range = `lines ${start_line}–${end_line ?? '?'}`;
              } else {
                const s = start_line - 1;
                const e = end_line !== undefined ? Math.min(end_line, totalLines) : totalLines;
                result = allLines
                  .slice(s, e)
                  .map((l, i) => `${s + i + 1}\t${l}`)
                  .join('\n');
                range = `lines ${start_line}–${end_line ?? totalLines}`;
              }
            } else {
              result = truncateFileOutput(raw);
              range = 'full';
            }
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            if (onToolCall)
              await onToolCall({
                turn,
                toolName: 'read_file',
                resultSize: result.length,
                resultFirstLine: (result.split('\n')[0] ?? '').slice(0, 120),
                path: filePath,
                range,
              });
            continue;
          } else {
            result = `Unknown tool: ${block.name}`;
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            if (onToolCall)
              await onToolCall({
                turn,
                toolName: block.name,
                resultSize: result.length,
                resultFirstLine: (result.split('\n')[0] ?? '').slice(0, 120),
              });
            continue;
          }
        } catch (err) {
          result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            is_error: true,
            content: result,
          });
          continue;
        }
      }

      // Non-progress guard (light agent only has write/edit/read — reset on write/edit).
      const hadWriteLight = assistantContent.some(
        (b) => b.type === 'tool_use' && (b.name === 'write_file' || b.name === 'edit_file'),
      );
      const lastToolBlockLight = assistantContent.find((b) => b.type === 'tool_use');
      const cmdNameLight =
        lastToolBlockLight?.type === 'tool_use' ? lastToolBlockLight.name : 'unknown';
      const lastResultLight = toolResults[toolResults.length - 1];
      const rawContentLight = lastResultLight?.content;
      const resultTextLight =
        typeof rawContentLight === 'string'
          ? rawContentLight
          : Array.isArray(rawContentLight)
            ? rawContentLight
                .filter((b): b is { type: 'text'; text: string } => b?.type === 'text')
                .map((b) => b.text)
                .join('\n')
            : '';
      const firstLineLight =
        resultTextLight.split('\n').find((l) => l.trim()) ?? resultTextLight.slice(0, 120);
      const npErrLight = checkNonProgress(
        recentToolHashes,
        toolResults,
        hadWriteLight,
        nonProgressThreshold,
        cmdNameLight,
        firstLineLight,
      );
      if (npErrLight) throw npErrLight;

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
  }

  if (turn >= maxTurns) {
    throw new Error(`Light dev agent hit ${maxTurns}-turn safety cap`);
  }
}
