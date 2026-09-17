import { SHELL_METACHAR_RE } from './container.js';
import type { ContainerHandle } from './container.js';
import { parseTestOutput, TEST_REPORT_FILE } from '../jobs/testJob.js';
import type { ParsedTestOutput } from '../jobs/testJob.js';

export const TEST_COMMAND_PREFIXES: readonly string[] = [
  'npm test',
  'npm run test',
  'npx vitest run',
  'npx jest',
];

export function isTestCommand(command: string): boolean {
  const trimmed = command.trim();
  return TEST_COMMAND_PREFIXES.some((p) => trimmed === p || trimmed.startsWith(p + ' '));
}

// Strips the base command prefix and `--` separator from probe_command, then
// removes reporter flags already added by the rewrite. Returns only extra
// flags like --maxWorkers=2 that should be grafted onto every test invocation.
export function extractProbeFlags(probeCommand: string): string {
  const prefix = TEST_COMMAND_PREFIXES.find(
    (p) => probeCommand.trim() === p || probeCommand.trim().startsWith(p + ' '),
  );
  if (!prefix) return '';
  let rest = probeCommand.trim().slice(prefix.length).trim();
  if (rest.startsWith('-- ')) rest = rest.slice(3).trim();
  else if (rest === '--') return '';
  return rest
    .replace(/--json\b\s*/g, '')
    .replace(/--outputFile=\S+\s*/g, '')
    .replace(/--reporter=\S+\s*/g, '')
    .trim();
}

export function toJsonReporterCommand(
  command: string,
  reportFile: string = TEST_REPORT_FILE,
  probeCommand?: string,
): string {
  const trimmed = command.trim().replace(/2>&1/g, '').trim();
  const probeFlags = probeCommand ? extractProbeFlags(probeCommand) : '';
  // Preserve the agent's own flags by applying the same stripping logic as
  // extractProbeFlags — strip only the three reporter flags we inject ourselves.
  const agentArgs = extractProbeFlags(trimmed);

  if (trimmed.startsWith('npx jest')) {
    const parts = ['npx jest'];
    if (probeFlags) parts.push(probeFlags);
    if (agentArgs) parts.push(agentArgs);
    parts.push(`--json --outputFile=${reportFile}`);
    return parts.join(' ');
  }

  const parts = ['npx vitest run'];
  if (probeFlags) parts.push(probeFlags);
  if (agentArgs) parts.push(agentArgs);
  parts.push(`--reporter=json --outputFile=${reportFile}`);
  return parts.join(' ');
}

export interface TestRunSummary {
  summary: string;
  resolvedCommand: string;
  reportPath: string;
}

export function formatTestSummary(parsed: ParsedTestOutput): string {
  const passed = parsed.passed ?? 0;
  const failed = parsed.failed ?? 0;
  const filePart =
    parsed.fileCount !== undefined
      ? ` (${parsed.fileCount} ${parsed.fileCount === 1 ? 'file' : 'files'})`
      : '';
  const header = `TESTS: ${passed} passed, ${failed} failed${filePart}`;
  if (failed === 0) return header;

  const failures = parsed.tests
    .filter((t) => t.status === 'failed')
    .map((t) => {
      if (t.message) {
        // Scale cap by failure count: a one-failure run gets 4000 chars so the
        // full assertion message is visible; high-failure runs stay compact.
        return `· "${t.test_name}" — ${t.message.slice(0, failed <= 3 ? 4000 : 200)}`;
      }
      return `· "${t.test_name}"`;
    })
    .join('\n');

  return `${header}\nFAILURES:\n${failures}`;
}

const CONSOLE_TAIL_CHARS = 2048;

function tailWithTruncationNotice(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `(truncated — showing last ${cap} of ${text.length} chars)\n` + text.slice(-cap);
}

/**
 * Extract console output from a test run.
 * Jest prints console to stdout (rawCombined); vitest writes to the JSON report
 * file and stdout is empty — collect per-file `message` fields from the report JSON.
 */
function extractConsoleOutput(
  resolvedCommand: string,
  rawCombined: string,
  reportJson: string,
): string {
  if (resolvedCommand.startsWith('npx jest')) {
    const trimmed = rawCombined.trim();
    return trimmed ? tailWithTruncationNotice(trimmed, CONSOLE_TAIL_CHARS) : '';
  }
  // vitest: extract message fields from JSON report testResults entries.
  try {
    const jsonStart = reportJson.indexOf('{');
    if (jsonStart === -1) return '';
    const json = JSON.parse(reportJson.slice(jsonStart)) as {
      testResults?: Array<{ message?: string }>;
    };
    const messages = (json.testResults ?? [])
      .map((r) => (r.message ?? '').trim())
      .filter(Boolean)
      .join('\n');
    return messages ? tailWithTruncationNotice(messages, CONSOLE_TAIL_CHARS) : '';
  } catch {
    return '';
  }
}

/**
 * Intercept a test-runner bash command and return a TestRunSummary.
 * Returns null when `command` is not a test runner command (caller should run normally).
 * Returns a fallback summary prefixed with [raw output — JSON summary unavailable]
 * if the JSON report cannot be parsed.
 *
 * Each call uses a fresh per-invocation path so no prior run's report can be
 * read as current. rm is not in the agent allowlist and must not be injected.
 */
export async function summarizeBashTestRun(
  command: string,
  container: ContainerHandle,
  probeCommand?: string,
): Promise<TestRunSummary | null> {
  // Bail out for commands with shell metachars — they must go through
  // container.exec so the MetacharViolationError path fires normally.
  // Strip the same exemptions as checkMetachar: trailing | head/tail -N and 2>&1.
  const sanitized = command
    .trim()
    .replace(/\s*\|\s*(?:head|tail)\s+(?:-n\s+)?-?\d+\s*$/i, '')
    .replace(/2>&1/g, '');
  if (SHELL_METACHAR_RE.test(sanitized)) return null;
  if (!isTestCommand(command)) return null;

  // Fresh path per invocation — the file doesn't exist before the command runs,
  // so a stale read is structurally impossible without any rm.
  const invocationPath = `/tmp/test-report-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  const jsonCmd = toJsonReporterCommand(command, invocationPath, probeCommand);

  // Run the JSON-reporter variant; stdout may be dirty (interleaved app output)
  // so we read the report file separately — same two-exec pattern as testJob.ts.
  const execResult = await container.exec(jsonCmd);
  const rawCombined = [execResult.stdout, execResult.stderr].filter(Boolean).join('\n');

  const catResult = await container.exec(`cat ${invocationPath}`);
  const parsed = parseTestOutput(catResult.stdout, '');

  if (parsed.parseError) {
    const raw = rawCombined || '(no output)';
    return {
      summary: `[raw output — JSON summary unavailable]\n${raw.slice(-8192)}`,
      resolvedCommand: jsonCmd,
      reportPath: invocationPath,
    };
  }

  if ((parsed.passed ?? 0) + (parsed.failed ?? 0) === 0) {
    const raw = rawCombined || '(no output)';
    // Truncate to 8192 chars — same limit as the parse-error fallback above — so the
    // agent receives the runner's combined stdout+stderr directly, without a label prefix
    // that names the case but hides the actual diagnostic evidence.
    return {
      summary: raw.slice(-8192),
      resolvedCommand: jsonCmd,
      reportPath: invocationPath,
    };
  }

  const baseSummary = formatTestSummary(parsed);

  // Append a tail of console output so the agent can read runtime values without
  // building a probe file. Jest prints console to stdout (rawCombined); vitest writes
  // everything to the JSON report file and stdout is empty — extract per-file message
  // fields from the already-fetched report JSON instead.
  const consoleOutput = extractConsoleOutput(jsonCmd, rawCombined, catResult.stdout);
  const summary = consoleOutput ? `${baseSummary}\nCONSOLE:\n${consoleOutput}` : baseSummary;

  return {
    summary,
    resolvedCommand: jsonCmd,
    reportPath: invocationPath,
  };
}
