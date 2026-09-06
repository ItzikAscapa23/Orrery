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

// Collects non-flag tokens (positional file paths) from the agent's command
// after stripping the base prefix and 2>&1.
function extractPositionalArgs(command: string, prefix: string): string {
  const rest = command.trim().replace(/2>&1/g, '').trim().slice(prefix.length).trim();
  return rest
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('--') && t !== '--')
    .join(' ');
}

export function toJsonReporterCommand(
  command: string,
  reportFile: string = TEST_REPORT_FILE,
  probeCommand?: string,
): string {
  const trimmed = command.trim().replace(/2>&1/g, '').trim();
  const extraFlags = probeCommand ? extractProbeFlags(probeCommand) : '';

  if (trimmed.startsWith('npx jest')) {
    const pathArgs = extractPositionalArgs(trimmed, 'npx jest');
    const parts = ['npx jest'];
    if (extraFlags) parts.push(extraFlags);
    parts.push(`--json --outputFile=${reportFile}`);
    if (pathArgs) parts.push(pathArgs);
    return parts.join(' ');
  }

  const parts = ['npx vitest run'];
  if (extraFlags) parts.push(extraFlags);
  parts.push(`--reporter=json --outputFile=${reportFile}`);
  return parts.join(' ');
}

export function formatTestSummary(parsed: ParsedTestOutput): string {
  const passed = parsed.passed ?? 0;
  const failed = parsed.failed ?? 0;
  const header = `TESTS: ${passed} passed, ${failed} failed`;
  if (failed === 0) return header;

  const failures = parsed.tests
    .filter((t) => t.status === 'failed')
    .map((t) => {
      if (t.message) {
        return `· "${t.test_name}" — ${t.message.slice(0, 200)}`;
      }
      return `· "${t.test_name}"`;
    })
    .join('\n');

  return `${header}\nFAILURES:\n${failures}`;
}

/**
 * Intercept a test-runner bash command and return a compact summary string.
 * Returns null when `command` is not a test runner command (caller should run normally).
 * Returns a fallback string prefixed with [raw output — JSON summary unavailable]
 * if the JSON report cannot be parsed.
 */
export async function summarizeBashTestRun(
  command: string,
  container: ContainerHandle,
  reportFilePath: string = TEST_REPORT_FILE,
  probeCommand?: string,
): Promise<string | null> {
  // Bail out for commands with shell metachars — they must go through
  // container.exec so the MetacharViolationError path fires normally.
  // Strip the same exemptions as checkMetachar: trailing | head/tail -N and 2>&1.
  const sanitized = command
    .trim()
    .replace(/\s*\|\s*(?:head|tail)\s+(?:-n\s+)?-?\d+\s*$/i, '')
    .replace(/2>&1/g, '');
  if (SHELL_METACHAR_RE.test(sanitized)) return null;
  if (!isTestCommand(command)) return null;

  const jsonCmd = toJsonReporterCommand(command, reportFilePath, probeCommand);

  // Pre-delete the report file so a stale result from a prior run is never
  // returned. If the rewritten command fails (e.g. wrong runner for this repo),
  // `cat` will return empty and parseTestOutput fires parseError → raw fallback.
  await container.exec(`rm -f ${reportFilePath}`);

  // Run the JSON-reporter variant; stdout may be dirty (interleaved app output)
  // so we read the report file separately — same two-exec pattern as testJob.ts.
  const execResult = await container.exec(jsonCmd);
  const rawCombined = [execResult.stdout, execResult.stderr].filter(Boolean).join('\n');

  const catResult = await container.exec(`cat ${reportFilePath}`);
  const parsed = parseTestOutput(catResult.stdout, '');

  if (parsed.parseError) {
    const raw = rawCombined || '(no output)';
    return `[raw output — JSON summary unavailable]\n${raw.slice(-8192)}`;
  }

  if ((parsed.passed ?? 0) + (parsed.failed ?? 0) === 0) {
    const raw = rawCombined || '(no output)';
    return `[raw output — zero tests reported]\n${raw.slice(-8192)}`;
  }

  return formatTestSummary(parsed);
}
