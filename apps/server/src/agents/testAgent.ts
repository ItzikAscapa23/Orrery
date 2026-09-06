import path from 'node:path';
import fs from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { createMessageStream, withLastMessageCached } from '../lib/anthropic.js';
import type { UsageRecord } from '../lib/anthropic.js';
import { MetacharViolationError, checkMetachar, metaCharGuidance } from '../lib/container.js';
import type { ContainerHandle } from '../lib/container.js';
import type { ToolCallInfo } from './devAgent.js';
import { summarizeBashTestRun } from '../lib/testOutputSummary.js';
import { checkNonProgress } from '../lib/nonProgressError.js';
import { env } from '../lib/env.js';

// ── Own resolveWorktreePath (decoupled from serverDevAgent) ───────────────────

function resolveWorktreePath(worktreeRoot: string, requestedPath: string): string {
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

// ── Test-Agent-specific bash enforcement ──────────────────────────────────────
//
// Narrower than the shared dev-agent allowlist in container.ts: only test-runner
// commands are permitted. Defined here so widening the shared list never silently
// expands the Test Agent's attack surface. cat/ls/find/grep are explicitly blocked
// even though they appear on the shared allowlist.

const TEST_BASH_ALLOWED_PREFIXES: readonly string[] = [
  'npm test',
  'npm run test',
  'npx vitest run',
  'npx jest --ci',
];

export class TestAllowlistViolationError extends Error {
  constructor(command: string) {
    super(`Command not on test-agent allowlist: "${command.slice(0, 120)}"`);
    this.name = 'TestAllowlistViolationError';
  }
}

export class TestMetacharViolationError extends MetacharViolationError {
  constructor(command: string, char: string) {
    super(command, char);
    this.name = 'TestMetacharViolationError';
  }
}

// Exported for unit tests.
export function checkTestBashAllowed(command: string): void {
  try {
    checkMetachar(command);
  } catch (err) {
    if (err instanceof MetacharViolationError) {
      throw new TestMetacharViolationError(command, err.char);
    }
    throw err;
  }
  const trimmed = command.trim();
  const ok = TEST_BASH_ALLOWED_PREFIXES.some(
    (p) => trimmed === p.trimEnd() || trimmed.startsWith(p.trimEnd() + ' '),
  );
  if (!ok) {
    throw new TestAllowlistViolationError(command);
  }
}

const TEST_BASH_ALLOWED_HINT = TEST_BASH_ALLOWED_PREFIXES.map((p) => `  ${p.trim()}`).join('\n');

// ── Tool definitions ──────────────────────────────────────────────────────────

const BASH_TOOL: Anthropic.Tool = {
  name: 'bash',
  description:
    'Run a single test-runner command. ' +
    `Allowed: ${TEST_BASH_ALLOWED_PREFIXES.join(', ')}. ` +
    'NO cat, ls, find, grep, npm install, git, or arbitrary scripts. ' +
    'No shell operators (;, |, &, $, >, <). Use list_files to browse test files.',
  input_schema: {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'Test-runner command to run.' },
    },
    required: ['command'],
  },
};

const WRITE_FILE_TOOL: Anthropic.Tool = {
  name: 'write_file',
  description:
    'Create a new test file, or replace a test file entirely when most of it changes. ' +
    'To change part of an existing file use edit_file. Path must be inside the test directory.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to repo root — must be inside the test directory.',
      },
      content: { type: 'string', description: 'Full file content to write.' },
    },
    required: ['path', 'content'],
  },
};

const EDIT_FILE_TOOL: Anthropic.Tool = {
  name: 'edit_file',
  description:
    'Change part of an EXISTING test file. Prefer this over write_file for any file that already ' +
    'exists — it costs a fraction of the tokens and keeps the conversation short. ' +
    'Path must be inside the test directory.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to repo root — must be inside the test directory.',
      },
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
    'Read a permitted file. You may ONLY read: spec.md, contract.yaml (artifact paths), ' +
    'CLAUDE.md, package.json, tsconfig.json, and files inside the test directory. ' +
    'Reading implementation directories (src/, lib/, app/) is not permitted. ' +
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

const LIST_FILES_TOOL: Anthropic.Tool = {
  name: 'list_files',
  description:
    'List file names inside the test directory (shallow, names only). ' +
    'Use this instead of ls or find to discover existing test files.',
  input_schema: {
    type: 'object' as const,
    properties: {
      dir: {
        type: 'string',
        description:
          'Directory path relative to repo root — must be inside the test directory or equal to it.',
      },
    },
    required: ['dir'],
  },
};

// ── Path jail ─────────────────────────────────────────────────────────────────

// Implementation directories that the Test Agent must never read.
// Checked after case-folding so 'Src/' is caught alongside 'src/'.
const IMPL_BLOCKLIST_DIRS = ['src', 'lib', 'app', 'dist', 'build'];

// Root-level files the Test Agent is allowed to read.
const ALLOWED_ROOT_FILES = new Set([
  'spec.md',
  'contract.yaml',
  'CLAUDE.md',
  'package.json',
  'tsconfig.json',
]);

/**
 * Resolve a path, then apply fs.realpathSync.native to collapse symlinks.
 * When the full path does not exist yet (write_file target not yet created),
 * resolve the parent directory with realpathSync instead and re-append the
 * basename. This ensures write_file targets are in real-path space even before
 * they are created, so the comparison with the realpathSync'd absTestDir works.
 */
function resolveReal(worktreeRoot: string, requestedPath: string): string {
  const abs = resolveWorktreePath(worktreeRoot, requestedPath);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    // abs doesn't exist yet — resolve its parent, then re-append the basename.
    try {
      return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

/**
 * Verify that a read_file path is on the Test Agent whitelist.
 * - Whitelisted root files: spec.md, contract.yaml, CLAUDE.md, package.json, tsconfig.json.
 * - Whitelisted: any path equal to or inside the test directory.
 * - Blocklisted: first path component matches IMPL_BLOCKLIST_DIRS (case-insensitive).
 * - Everything else is rejected.
 */
export function checkReadAllowed(
  worktreeRoot: string,
  requestedPath: string,
  testDir: string,
): string {
  // Realpath worktreeRoot so path.relative comparisons are in real-path space
  // (matters on macOS where os.tmpdir() returns /var/... but realpathSync
  // gives /private/var/...).
  let realRoot = worktreeRoot;
  try {
    realRoot = fs.realpathSync.native(worktreeRoot);
  } catch {
    /* use as-is */
  }

  const abs = resolveReal(realRoot, requestedPath);
  const rel = path.relative(realRoot, abs);
  const parts = rel.split(path.sep);
  const partsLower = rel.toLowerCase().split(path.sep);

  // Whitelist: known root-level config files (case-sensitive exact match)
  if (parts.length === 1 && ALLOWED_ROOT_FILES.has(parts[0]!)) {
    return abs;
  }

  // Whitelist: equal to or inside the test directory
  // absTestDir goes through the same realpathSync as the candidate so symlinked
  // test directories compare correctly (e.g. macOS /var → /private/var).
  let absTestDir = path.resolve(realRoot, testDir);
  try {
    absTestDir = fs.realpathSync.native(absTestDir);
  } catch {
    /* testDir may not exist yet */
  }
  const testDirWithSep = absTestDir.endsWith(path.sep) ? absTestDir : absTestDir + path.sep;
  if (abs === absTestDir || abs.startsWith(testDirWithSep)) {
    return abs;
  }

  // Blocklist: first path component matches an implementation directory (case-insensitive)
  if (partsLower.length > 0 && IMPL_BLOCKLIST_DIRS.includes(partsLower[0]!)) {
    throw new Error(
      `Path '${requestedPath}' is inside an implementation directory ('${parts[0]}/'). ` +
        `The Test Agent may only read: spec.md, contract.yaml, CLAUDE.md, package.json, tsconfig.json, ` +
        `and files inside the test directory.`,
    );
  }

  throw new Error(
    `Path '${requestedPath}' is not on the Test Agent read whitelist. ` +
      `Permitted: spec.md, contract.yaml, CLAUDE.md, package.json, tsconfig.json, ` +
      `and files inside the test directory ('${testDir}/').`,
  );
}

/**
 * Verify that a write_file path is inside (or equal to) the test directory.
 */
export function checkWriteAllowed(
  worktreeRoot: string,
  requestedPath: string,
  testDir: string,
): string {
  let realRoot = worktreeRoot;
  try {
    realRoot = fs.realpathSync.native(worktreeRoot);
  } catch {
    /* use as-is */
  }

  const abs = resolveReal(realRoot, requestedPath);
  // Allow the harness brief at the repo root (written on first test-task only).
  if (path.relative(realRoot, abs) === '__orrery_harness_brief.md') {
    return abs;
  }
  let absTestDir = path.resolve(realRoot, testDir);
  try {
    absTestDir = fs.realpathSync.native(absTestDir);
  } catch {
    /* testDir may not exist yet */
  }
  const testDirWithSep = absTestDir.endsWith(path.sep) ? absTestDir : absTestDir + path.sep;
  if (!abs.startsWith(testDirWithSep) && abs !== absTestDir) {
    throw new Error(
      `Path '${requestedPath}' is outside the test directory ('${testDir}/'). ` +
        `The Test Agent may only write test files.`,
    );
  }
  return abs;
}

/**
 * Validate and execute the list_files operation.
 * Exported for integration tests.
 */
export function checkListFilesTarget(worktreeRoot: string, dir: string, testDir: string): string {
  const absTarget = checkReadAllowed(worktreeRoot, dir, testDir);
  if (!fs.existsSync(absTarget) || !fs.statSync(absTarget).isDirectory()) {
    throw new Error(
      `list_files: '${dir}' is not an existing directory. ` +
        `Pass the test directory path (e.g. '${testDir}').`,
    );
  }
  return fs.readdirSync(absTarget).join('\n');
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_TURNS = 30;
const _BUDGET_WARNING_TURN = 22;
const MAX_VIOLATIONS = 3;
const OUTPUT_MAX_BYTES = 8 * 1024;
const OUTPUT_MAX_LINES = 200;
const READ_FILE_MAX_LINES = 500;
const READ_FILE_MAX_BYTES = 40 * 1024;

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

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface TestAgentContext {
  specMarkdown: string;
  contractYaml: string;
  repoClaudeMd: string;
  testDir: string; // relative path to test directory, e.g. '__tests__' or 'test'
  repoDescription?: string;
  // Optional: generated host-side by generateRepoOrientation(). Injected after
  // CLAUDE.md and before the contract so it sits inside the cached prefix.
  orientationBlock?: string;
  // Optional: per-repo turn cap from the manifest. Defaults to MAX_TURNS (30) when absent.
  maxTurns?: number;
  // Optional: manifest probe_command for this repo. When set, its extra flags
  // (e.g. --maxWorkers=2) are grafted onto every agent-issued test command.
  probeCommand?: string;
  // Optional: test files already authored by the test agent for this feature.
  // When populated, the system prompt instructs the agent to extend rather than duplicate.
  existingTestFiles?: { path: string; describes: string[] }[];
}

export type TestAgentOutcome = { kind: 'completed' };

// ── System prompt ─────────────────────────────────────────────────────────────

export function buildSystemPrompt(ctx: TestAgentContext): string {
  const repoLine = ctx.repoDescription
    ? `You are a test engineer writing acceptance tests for: ${ctx.repoDescription}`
    : 'You are a test engineer writing acceptance tests for a TypeScript repository.';
  return [
    repoLine,
    '',
    '## Your mandate',
    'Write black-box acceptance tests that verify the behavior promised in the spec',
    'and contract. Tests must:',
    '- Exercise every contract operation (HTTP endpoint / component interaction).',
    '- Cover every acceptance criterion in the spec.',
    '- NOT test implementation internals (no imports from src/, lib/, app/).',
    '- NOT duplicate unit tests the dev agent wrote.',
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
    ...(ctx.existingTestFiles && ctx.existingTestFiles.length > 0
      ? [
          '## Existing test coverage',
          'The following test files were already authored by the test agent for this feature.',
          'Extend them (using edit_file) rather than creating new files that duplicate their describe blocks:',
          ...ctx.existingTestFiles.map(
            (f) => `- ${f.path}: [${f.describes.map((d) => `"${d}"`).join(', ')}]`,
          ),
          '',
        ]
      : []),
    '## Rules',
    `- Write test files ONLY to the test directory: ${ctx.testDir}/`,
    '- Do not import from src/, lib/, app/, or any implementation directory.',
    '- Run the test suite after writing tests. Fix failures.',
    '- When all tests pass, call end_turn.',
    '- The orchestrator commits your test files after verifying the suite passes.',
    '- You do not git commit.',
    '- The container working directory is /workspace — run commands directly. Never prefix with `cd /workspace &&` or any `cd <path> &&`.',
    "- Use edit_file to modify existing test files. Use write_file only to create new files or when replacing most of a file's content. Rewriting a whole file to change a few lines wastes context and slows every later turn.",
    '- Before calling end_turn, delete any debug or scratch test files you created (files whose names contain "debug" or "scratch") — they must not reach the commit.',
    '- A test asserts exactly one response shape. Do not write `result.fieldA ?? result.fieldB` or `result.items ?? []` as fixture fallbacks — they mask the wrong-branch case where execution took an unexpected path and the field is absent. Assert the exact field the handler returns; let the test fail loudly if it is absent.',
    '',
    '## Tools',
    '',
    '**read_file(path, start_line?, end_line?)** — Read a permitted file.',
    `Allowed paths: spec.md, contract.yaml, CLAUDE.md, package.json, tsconfig.json, ${ctx.testDir}/ (any file inside).`,
    'Implementation directories (src/, lib/, app/) are BLOCKED at the path-jail layer.',
    'Supply start_line and end_line (1-based, inclusive) to read a slice — slices are returned in full.',
    '',
    '**write_file(path, content)** — Create a new test file, or replace a file entirely when most of it changes.',
    `Path must be inside ${ctx.testDir}/. All other paths are BLOCKED.`,
    '',
    `**edit_file(path, old_str, new_str)** — Change part of an existing test file. Prefer this over write_file for any file that already exists — it costs a fraction of the tokens. old_str must match EXACTLY in ONE place. new_str replaces it; pass new_str="" to delete matched text. Path must be inside ${ctx.testDir}/.`,
    '',
    '**list_files(dir)** — List file names in the test directory (use instead of ls/find).',
    '',
    '**bash(command)** — Run a test-runner command only.',
    `Allowed: ${TEST_BASH_ALLOWED_PREFIXES.join(', ')}.`,
    'NO cat, ls, find, grep. NO npm install. NO git. No shell operators (;, |, &, $, >, <).',
    `Three violations permanently fail the task.\n\nAllowed commands:\n${TEST_BASH_ALLOWED_HINT}`,
    '',
    'Output capture rules:',
    '- stdout AND stderr are captured automatically — never use pipes (|), chaining (;, &&, ||), or file redirection (> file, 2> file); 2>&1 is permitted',
    '- node_modules is off-limits — read package.json and tsconfig.json instead.',
  ].join('\n');
}

// ── Prompt measurement ────────────────────────────────────────────────────────

export interface TestPromptSections {
  claudeMd: number;
  contract: number;
  spec: number;
  orientation: number;
  rules: number;
  total: number;
}

/**
 * Return per-section character counts for the system prompt that would be built
 * from `ctx`. `rules` is derived by subtraction so the measurement stays accurate
 * automatically as buildSystemPrompt evolves.
 */
export function measurePromptSections(ctx: TestAgentContext): TestPromptSections {
  const claudeMd = ctx.repoClaudeMd.length;
  const contract = ctx.contractYaml.length;
  const spec = ctx.specMarkdown.length;
  const orientation = ctx.orientationBlock?.length ?? 0;
  const fullPrompt = buildSystemPrompt(ctx);
  return {
    claudeMd,
    contract,
    spec,
    orientation,
    rules: fullPrompt.length - claudeMd - contract - spec - orientation,
    total: fullPrompt.length,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface TestViolationInfo {
  rule: 'metachar' | 'allowlist';
  command: string;
  count: number;
  max: number;
  char?: string;
}

export async function runTestAgent(
  featureId: string,
  ctx: TestAgentContext,
  container: ContainerHandle,
  worktreePath: string,
  onUsage?: (u: UsageRecord) => void | Promise<void>,
  onViolation?: (info: TestViolationInfo) => void | Promise<void>,
  onToolCall?: (info: ToolCallInfo) => void | Promise<void>,
): Promise<TestAgentOutcome> {
  const systemPrompt = buildSystemPrompt(ctx);
  const usageCb = onUsage ? (u: UsageRecord) => void onUsage(u) : undefined;

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content:
        'Write acceptance tests for this feature. The spec and contract are already in ' +
        'your system prompt above — do not call read_file for spec.md or contract.yaml. ' +
        `Write tests to ${ctx.testDir}/, run them, fix any failures, then call end_turn.`,
    },
  ];

  const maxTurns = ctx.maxTurns ?? MAX_TURNS;
  const budgetWarningTurn = maxTurns - 8; // warn when 9 turns remain (including current)

  let turn = 0;
  let violationCount = 0;
  const nonProgressThreshold = env.NON_PROGRESS_THRESHOLD;
  const recentToolHashes: string[] = [];

  while (turn < maxTurns) {
    turn++;
    let violationsThisTurn = 0;

    if (turn === budgetWarningTurn) {
      messages.push({
        role: 'user',
        content: `[System] ${maxTurns - budgetWarningTurn + 1} turns remain. If tests are passing, call end_turn now. If not, make the minimum change to get them passing.`,
      });
    }

    const stream = await createMessageStream(
      {
        model: 'claude-sonnet-5',
        // 16384: test agent writes multi-file test suites; plannerAgent uses 8192 for
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
        tools: [BASH_TOOL, WRITE_FILE_TOOL, EDIT_FILE_TOOL, READ_FILE_TOOL, LIST_FILES_TOOL],
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
            // Test-local check fires first — blocks cat/ls/find/grep and enforces
            // the narrower metachar set before the shared container.exec check.
            checkTestBashAllowed(command);
            // After allowlist check passes, attempt JSON-reporter intercept.
            const testRunSummary = await summarizeBashTestRun(command, container, ctx.probeCommand);
            if (testRunSummary !== null) {
              result = testRunSummary.summary;
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
                ...(testRunSummary !== null
                  ? {
                      resolvedCommand: testRunSummary.resolvedCommand,
                      reportPath: testRunSummary.reportPath,
                    }
                  : {}),
              });
            continue;
          } else if (block.name === 'write_file') {
            const { path: filePath = '', content = '' } = block.input as {
              path?: string;
              content?: string;
            };
            callPath = filePath;
            callContentLength = content.length;
            const absPath = checkWriteAllowed(worktreePath, filePath, ctx.testDir);
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
            const absPath = checkWriteAllowed(worktreePath, filePath, ctx.testDir);
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
            callRange =
              start_line !== undefined ? `lines ${start_line}–${end_line ?? '?'}` : 'full';
            const absPath = checkReadAllowed(worktreePath, filePath, ctx.testDir);
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
          } else if (block.name === 'list_files') {
            const { dir = '' } = block.input as { dir?: string };
            result = checkListFilesTarget(worktreePath, dir || ctx.testDir, ctx.testDir);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            if (onToolCall)
              await onToolCall({
                turn,
                toolName: 'list_files',
                resultSize: result.length,
                resultFirstLine: (result.split('\n')[0] ?? '').slice(0, 120),
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
          if (block.name === 'bash') {
            if (err instanceof TestMetacharViolationError) {
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
                metaCharGuidance(err.char) + `\nAllowed commands:\n${TEST_BASH_ALLOWED_HINT}`;
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
            if (err instanceof TestAllowlistViolationError) {
              if (violationsThisTurn === 0) violationCount++;
              violationsThisTurn++;
              const allowCmd = (block.input as { command?: string }).command ?? '';
              if (onViolation)
                await onViolation({
                  rule: 'allowlist',
                  command: allowCmd,
                  count: violationCount,
                  max: MAX_VIOLATIONS,
                });
              if (violationCount >= MAX_VIOLATIONS) throw err;
              const errContent =
                `Command not on test-agent allowlist. No cat, ls, find, grep, ` +
                `npm install, or git. One command per call.\nAllowed commands:\n${TEST_BASH_ALLOWED_HINT}`;
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
                  command: allowCmd.slice(0, 120),
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
    throw new Error(`Test Agent hit ${maxTurns}-turn safety cap without completing`);
  }

  return { kind: 'completed' };
}
