import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import type { FeatureStatus } from '@prisma/client';
import { applyTransition } from '../lib/orchestrator.js';
import { dispatchForState, dispatchJob } from '../lib/dispatch.js';
import { readArtifact, commitArtifact } from '../lib/artifacts.js';
import { loadHarnessBrief, HARNESS_BRIEF_WRITE_INSTRUCTION } from '../lib/harnessbrief.js';
import { gateOpenedCount } from '../lib/reviewCycle.js';
import { getTestRound } from '../lib/reviewCycle.js';
import {
  runTestAgent,
  TestViolationInfo,
  measurePromptSections as measureTestPromptSections,
} from '../agents/testAgent.js';
import type { ToolCallInfo } from '../agents/devAgent.js';
import { getRepoEntry } from './devJob.js';
import { createSyntheticFixTasks } from '../lib/syntheticTasks.js';
import {
  startContainer,
  AllowlistViolationError,
  MetacharViolationError,
  EXEC_MAX_BUFFER,
} from '../lib/container.js';
import { checkBedrockConnectivity } from '../lib/connectivity.js';
import { readClaudeMdFromDefaultBranch, routeInstall } from './devJob.js';
import { createWorktree } from '../lib/worktree.js';
import { formatTestSummary } from '../lib/testOutputSummary.js';
import type { TestFinding, TestRow } from '@orrery/shared';
import { usageEventPayload } from '../lib/usageEvent.js';
import { scopeSpecByRefs, scopeContract } from '../lib/promptScope.js';
import { generateRepoOrientation } from '../lib/repoOrientation.js';

const GIT_AUTHOR_NAME = process.env['BOT_GIT_NAME'] ?? 'Orrery';
const GIT_AUTHOR_EMAIL = process.env['BOT_GIT_EMAIL'] ?? 'orrery-bot@example.com';

function git(worktreePath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: EXEC_MAX_BUFFER,
  });
}

function gitCommit(worktreePath: string, message: string): void {
  execFileSync(
    'git',
    [
      '-C',
      worktreePath,
      '-c',
      `user.name=${GIT_AUTHOR_NAME}`,
      '-c',
      `user.email=${GIT_AUTHOR_EMAIL}`,
      'commit',
      '-m',
      message,
    ],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: EXEC_MAX_BUFFER },
  );
}

function pushBranch(worktreePath: string, branch: string): void {
  git(worktreePath, 'push', 'origin', branch);
}

const TEST_FILE_RE = /\.(test|spec)\./;

export function getAuthoredTestFilesForTask(
  worktreePath: string,
  testDir: string,
  taskId: string,
): string[] {
  try {
    const out = git(
      worktreePath,
      'log',
      `--grep=^X-Orrery-Task: ${taskId}`,
      '--diff-filter=A',
      '--name-only',
      '--pretty=format:',
      '--',
      testDir,
    );
    return out
      .trim()
      .split('\n')
      .filter((f) => f && TEST_FILE_RE.test(f));
  } catch {
    return [];
  }
}

export function getAuthoredTestFiles(worktreePath: string, testDir: string): string[] {
  const out = git(
    worktreePath,
    'log',
    '--grep=^X-Orrery-Agent: test',
    '--diff-filter=A',
    '--name-only',
    '--pretty=format:',
    '--',
    testDir,
  );
  return out
    .trim()
    .split('\n')
    .filter((f) => f && TEST_FILE_RE.test(f));
}

export function extractDescribeBlocks(worktreePath: string, relPath: string): string[] {
  try {
    const content = fs.readFileSync(path.join(worktreePath, relPath), 'utf-8');
    const titles: string[] = [];
    const re = /^describe\s*\(\s*['"`]([^'"`]+)['"`]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      // m[1] is always defined — the capture group is required in the regex
      titles.push(m[1]!);
    }
    return titles;
  } catch {
    return [];
  }
}

export function getExistingTestFilesWithDescribes(
  worktreePath: string,
  testDir: string,
): { path: string; describes: string[] }[] {
  return getAuthoredTestFiles(worktreePath, testDir)
    .map((p) => ({ path: p, describes: extractDescribeBlocks(worktreePath, p) }))
    .filter((f) => f.describes.length > 0);
}

function findTestFiles(dir: string, maxDepth: number): string[] {
  if (maxDepth === 0) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      results.push(full);
    } else if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...findTestFiles(full, maxDepth - 1));
    }
  }
  return results;
}

export interface DiscoverTestDirResult {
  dir: string;
  method: 'candidate' | 'deep-scan' | 'fallback';
}

// Nested locations first so src/__tests__ wins over an empty root __tests__/.
// A candidate must exist AND contain at least one test file.
export function discoverTestDir(worktreePath: string): DiscoverTestDirResult {
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`discoverTestDir: worktree path does not exist: ${worktreePath}`);
  }
  const candidates = [
    'src/__tests__',
    'src/test',
    'src/tests',
    '__tests__',
    'test',
    'tests',
    'spec',
  ];
  for (const candidate of candidates) {
    const abs = path.join(worktreePath, candidate);
    if (fs.existsSync(abs) && findTestFiles(abs, 3).length > 0) {
      return { dir: candidate, method: 'candidate' };
    }
  }
  // No candidate matched — deep scan up to 3 levels.
  const found = findTestFiles(worktreePath, 3);
  if (found.length > 0) {
    const dir = path.relative(worktreePath, path.dirname(found[0]!));
    // Empty string means the file sits at the worktree root — git log -- '' throws
    // "fatal: '/' is outside repository". Fall through to the conventional fallback.
    if (dir === '') return { dir: '__tests__', method: 'fallback' };
    return { dir, method: 'deep-scan' };
  }
  // Nothing found anywhere — return the conventional fallback; caller emits agent.log.
  return { dir: '__tests__', method: 'fallback' };
}

// ── Stable finding ID ─────────────────────────────────────────────────────────

// djb2 hash of the test name — stable across bounce-back rounds so
// finding.upsert by id does not collide with unrelated tests.
function stableId(testName: string): string {
  let h = 5381;
  for (let i = 0; i < testName.length; i++) {
    h = ((h << 5) + h + testName.charCodeAt(i)) >>> 0;
  }
  return `tf-${h.toString(36)}`;
}

// ── Structured JSON parser ────────────────────────────────────────────────────

export interface ParsedTestOutput {
  passed: number | null;
  failed: number | null;
  tests: TestRow[];
  authoredPassed: number;
  authoredFailed: number;
  parseError?: string;
}

interface JestAssertionResult {
  fullName: string;
  status: string;
  duration?: number | null;
  failureMessages?: string[];
}

interface JestTestResult {
  name?: string; // vitest: absolute file path of the test file
  assertionResults: JestAssertionResult[];
}

interface JestJson {
  numPassedTests: number;
  numFailedTests: number;
  testResults: JestTestResult[];
}

/**
 * Parse test runner JSON output (vitest --reporter=json or jest --json).
 * Returns structured counts and per-test rows tagged with `authored` when
 * the row's source file appears in `stagedFiles`.
 * Returns { passed: null, failed: null, parseError } when output is not valid JSON.
 * Never fabricates counts.
 */
export function parseTestOutput(
  stdout: string,
  _stderr: string,
  stagedFiles: string[] = [],
): ParsedTestOutput {
  // Both vitest --reporter=json and jest --json write a JSON object to stdout.
  // Find the first '{' to skip any prefix noise (e.g. console.log lines).
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    return {
      passed: null,
      failed: null,
      tests: [],
      authoredPassed: 0,
      authoredFailed: 0,
      parseError: 'JSON parse failed: no JSON object found in stdout',
    };
  }

  let json: JestJson;
  try {
    json = JSON.parse(stdout.slice(jsonStart)) as JestJson;
  } catch (e) {
    return {
      passed: null,
      failed: null,
      tests: [],
      authoredPassed: 0,
      authoredFailed: 0,
      parseError: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (
    typeof json.numPassedTests !== 'number' ||
    typeof json.numFailedTests !== 'number' ||
    !Array.isArray(json.testResults)
  ) {
    return {
      passed: null,
      failed: null,
      tests: [],
      authoredPassed: 0,
      authoredFailed: 0,
      parseError: 'JSON parse failed: missing numPassedTests/numFailedTests/testResults fields',
    };
  }

  const tests: TestRow[] = [];
  let authoredPassed = 0;
  let authoredFailed = 0;

  for (const suite of json.testResults) {
    if (!Array.isArray(suite.assertionResults)) continue;
    // vitest sets suite.name to the absolute file path; match against staged entries.
    const suiteName = suite.name ?? '';
    const authored =
      stagedFiles.length > 0 &&
      stagedFiles.some((f) => suiteName.endsWith('/' + f) || suiteName === f);

    for (const t of suite.assertionResults) {
      if (t.status !== 'passed' && t.status !== 'failed') continue;
      const row: TestRow = {
        test_name: (t.fullName ?? '(unnamed)').trim(),
        status: t.status,
        ...(typeof t.duration === 'number' && t.duration >= 0
          ? { duration_ms: Math.round(t.duration) }
          : {}),
        authored: authored,
      };
      if (row.status === 'failed' && t.failureMessages && t.failureMessages.length > 0) {
        row.message = t.failureMessages[0]!.slice(0, 300);
      }
      if (authored) {
        if (row.status === 'passed') authoredPassed++;
        else authoredFailed++;
      }
      tests.push(row);
    }
  }

  return {
    passed: json.numPassedTests,
    failed: json.numFailedTests,
    tests,
    authoredPassed,
    authoredFailed,
  };
}

/**
 * Derive TestFinding[] from the tests array (failure rows only).
 * IDs are stable hashes of test_name so bounce-back rounds don't collide.
 */
export function findingsFromTests(tests: TestRow[]): TestFinding[] {
  return tests
    .filter((t) => t.status === 'failed')
    .map((t) => ({
      id: stableId(t.test_name),
      severity: 'blocker' as const,
      test_name: t.test_name,
      section: 'acceptance tests',
      issue: t.message ?? `Test failed: ${t.test_name}`,
      ...(t.duration_ms !== undefined ? { duration_ms: t.duration_ms } : {}),
    }));
}

/**
 * Return the JSON-reporter test command based on what the repo uses.
 * When probeCommand is provided (from the manifest), it is used as the base
 * so that flags like --maxWorkers=2 are preserved. JSON reporter flags are
 * grafted onto it (deduplicating any already present).
 * When probeCommand is absent, the runner is inferred from repoClaudeMd keywords.
 * The command writes the report to TEST_REPORT_FILE so stdout interleaving
 * from the app-under-test cannot corrupt the JSON (backlog C-4).
 */
export const TEST_REPORT_FILE = '/tmp/test-report.json';

export function detectJsonCommand(repoClaudeMd: string, probeCommand?: string): string {
  const lower = repoClaudeMd.toLowerCase();
  const isJest = lower.includes('jest') && !lower.includes('vitest');

  if (probeCommand) {
    if (isJest) {
      const base = probeCommand.replace(/\s+--json\b/g, '');
      return `${base} --json --outputFile=${TEST_REPORT_FILE}`;
    } else {
      const base = probeCommand
        .replace(/\s+--reporter=\S+/g, '')
        .replace(/\s+--outputFile=\S+/g, '');
      return `${base} --reporter=json --outputFile=${TEST_REPORT_FILE}`;
    }
  }

  if (isJest) {
    return `npx jest --json --outputFile=${TEST_REPORT_FILE}`;
  }
  return `npx vitest run --reporter=json --outputFile=${TEST_REPORT_FILE}`;
}

export function plainTestCommand(probeCommand?: string): string {
  return probeCommand ?? 'npm test';
}

export async function runTestJob(featureId: string, jobId?: string): Promise<void> {
  const feature = await getPrisma().feature.findUniqueOrThrow({
    where: { id: featureId },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      simulatedRun: true,
      currentBranches: true,
      proposedSpec: true,
    },
  });

  if (feature.status !== 'TESTING') {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: `◦ test job skipped — feature is in ${feature.status}, not TESTING`,
    });
    return;
  }

  const currentBranches = (feature.currentBranches as Record<string, string>) ?? {};
  const repos = Object.keys(currentBranches);

  await appendEvent(getPrisma(), featureId, {
    type: 'test.started',
    agent: 'test',
    repos,
  });
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.status',
    agent: 'test',
    status: 'working',
  });

  const priorTestRounds = await getTestRound(featureId);
  const specRev = (await gateOpenedCount(featureId)) - 1;

  // Verify connectivity before any container work
  if (!(await checkBedrockConnectivity())) {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'test',
      status: 'failed',
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'test',
      severity: 'muted',
      text: '· test agent parked — Bedrock unreachable; check VPN / aws sso login. Use POST /retry-test to resume.',
    });
    return;
  }

  const rawSpec = readArtifact(feature.slug, 'spec.md') ?? '(spec not found)';
  const rawContract = readArtifact(feature.slug, 'contract.yaml') ?? '(contract not found)';

  // Run the test agent per repo. For now, pick the first server repo.
  // Multi-repo extension: iterate repos, run an agent per repo.
  const repoId =
    repos.find((r) => {
      try {
        const entry = getRepoEntry(r);
        return entry.side === 'server';
      } catch {
        return false;
      }
    }) ?? repos[0];

  if (!repoId) {
    // No repos — the gate observed nothing. Emit a scar and stop.
    // A skipped gate is not a pass; the operator must approve via POST /approve-test.
    await appendEvent(getPrisma(), featureId, {
      type: 'test.report',
      agent: 'test',
      spec_rev: specRev,
      passed: null,
      failed: null,
      findings: [],
      skipped: true,
      skip_reason: 'no repos in currentBranches — test agent did not run',
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'test',
      severity: 'muted',
      text: '· no repos in currentBranches — test gate skipped (no observation); use POST /approve-test to advance',
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'test',
      status: 'done',
    });
    return;
  }

  const featureBranch = currentBranches[repoId]!;

  let repoEntry;
  try {
    repoEntry = getRepoEntry(repoId);
  } catch (err) {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'test',
      severity: 'muted',
      text: `· repo '${repoId}' not in manifest — test agent cannot run`,
    });
    await _handleTestError(featureId, err instanceof Error ? err.message : String(err));
    return;
  }

  const worktreeInfo = createWorktree(
    repoEntry.url,
    feature.slug,
    repoEntry.default_branch,
    repoEntry.id,
  );
  const worktreePath = worktreeInfo.worktreePath;
  git(worktreePath, 'checkout', '.');
  git(worktreePath, 'clean', '-fd');
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'muted',
    text: `◦ worktree reset to clean branch HEAD (${worktreeInfo.branch})`,
  });

  // Scope spec to the union of specRefs across all tasks for this repo's side.
  // scopeSpecByRefs falls back to the full spec when the union covers >75% of sections.
  const allTasks = await getPrisma().task.findMany({ where: { featureId } });
  const sideRefs = [
    ...new Set(
      allTasks.filter((t) => t.side === repoEntry.side).flatMap((t) => t.specRefs as string[]),
    ),
  ];
  const specContent = scopeSpecByRefs(rawSpec, sideRefs);
  const contractContent = scopeContract(rawContract, {
    side: repoEntry.side as 'server' | 'client',
    refs: sideRefs,
    taskDescription: '', // testJob has no single task description; token matching relies on refs
    onFallback: (reason) => {
      void appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'test',
        severity: 'muted',
        text: `◦ contract scoping: full contract used — ${reason}`,
      });
    },
  });

  const imageTag = process.env['AGENT_CONTAINER_IMAGE'] ?? 'node:20-alpine';
  const installStrategy = process.env['INSTALL_STRATEGY'] ?? 'host';
  const cafile = process.env['NODE_EXTRA_CA_CERTS'] ?? '';
  const installTimeoutMs = repoEntry.install_timeout_ms ?? 300_000;
  const execTimeoutMs = repoEntry.exec_timeout_ms ?? 120_000;
  const maxTurns = repoEntry.max_turns;

  let repoClaudeMd: string;
  try {
    repoClaudeMd = readClaudeMdFromDefaultBranch(worktreePath, repoEntry.default_branch);
  } catch {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      repo: repoId,
      severity: 'muted',
      text: `◦ CLAUDE.md not found on ${repoEntry.default_branch}:CLAUDE.md — using stub`,
    });
    repoClaudeMd = `# ${repoId}\n## Commands\nnpm test\n`;
  }

  const { dir: testDir, method: testDirMethod } = discoverTestDir(worktreePath);
  if (testDirMethod === 'fallback' || testDir === '') {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'info',
      text: `⚠ discoverTestDir: no test files found under ${worktreePath} — falling back to '__tests__'. Verify the repo has a test directory.`,
    });
  }

  const orientationBlock = generateRepoOrientation(worktreePath);
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'muted',
    text: `◦ repo orientation: ${orientationBlock.length} chars`,
  });

  const testSections = measureTestPromptSections({
    specMarkdown: specContent,
    contractYaml: contractContent,
    repoClaudeMd,
    testDir,
    orientationBlock,
    ...(repoEntry.description ? { repoDescription: repoEntry.description } : {}),
  });
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'test',
    severity: 'muted',
    text: `◦ prompt size: ${testSections.total} chars (claudeMd=${testSections.claudeMd}, contract=${testSections.contract}, spec=${testSections.spec}, orientation=${testSections.orientation}, rules=${testSections.rules})`,
  });

  const installDesc = repoEntry.bootstrap ? 'bootstrap' : `${installStrategy}, linux/arm64/musl`;
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'muted',
    text: `◦ test-agent: install started (${installDesc})`,
  });

  try {
    await routeInstall(repoEntry, worktreePath, imageTag, cafile, installTimeoutMs);
  } catch (installErr) {
    const msg = installErr instanceof Error ? installErr.message : String(installErr);
    await _handleTestError(featureId, `npm install failed: ${msg.slice(0, 200)}`);
    return;
  }

  const harnessBrief = await loadHarnessBrief(feature.slug, worktreePath, featureId);
  const harnessSection =
    harnessBrief === null
      ? HARNESS_BRIEF_WRITE_INSTRUCTION
      : `\n\n## Test Harness Brief\n${harnessBrief.replace(/<!--[\s\S]*?-->\n?/, '').trim()}\n` +
        `Do not re-read the files listed above — this brief already captures what you need.`;

  const container = startContainer(
    worktreePath,
    `${featureId}-test`,
    imageTag,
    () => {
      void appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'muted',
        text: '⚠ AGENT_UNSAFE_HOST_EXEC active — container sandbox bypassed',
      });
    },
    execTimeoutMs,
  );

  try {
    void appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: `◦ container started — ${container.name}`,
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'test',
      severity: 'action',
      text: `▸ test agent running — writing acceptance tests to ${testDir}/`,
    });

    const existingTestFiles = getExistingTestFilesWithDescribes(worktreePath, testDir);
    await runTestAgent(
      featureId,
      {
        specMarkdown: specContent + harnessSection,
        contractYaml: contractContent,
        repoClaudeMd,
        testDir,
        orientationBlock,
        ...(repoEntry.description ? { repoDescription: repoEntry.description } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(repoEntry.probe_command ? { probeCommand: repoEntry.probe_command } : {}),
        ...(existingTestFiles.length > 0 ? { existingTestFiles } : {}),
      },
      container,
      worktreePath,
      async (usage) => {
        await appendEvent(getPrisma(), featureId, usageEventPayload(usage, 'test', { jobId }));
      },
      async (info: TestViolationInfo) => {
        const truncCmd = info.command.length > 80 ? info.command.slice(0, 80) + '…' : info.command;
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'test',
          severity: 'muted',
          text: `⚠ violation ${info.count}/${info.max}: ${info.rule} — ${truncCmd}`,
        });
      },
      async (info: ToolCallInfo) => {
        let text: string;
        if (info.toolName === 'read_file') {
          text = `◦ turn ${info.turn} · read_file ${info.path} (${info.range}, ${info.resultSize} chars)`;
        } else if (info.toolName === 'bash') {
          text = `◦ turn ${info.turn} · bash ${info.command ?? ''} (${info.resultSize} chars)`;
        } else if (info.toolName === 'write_file') {
          text = `◦ turn ${info.turn} · write_file ${info.path} (${info.contentLength} chars content)`;
        } else {
          text = `◦ turn ${info.turn} · ${info.toolName} (${info.resultSize} chars)`;
        }
        if (info.resultFirstLine) text += ` → ${info.resultFirstLine}`;
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'test',
          severity: 'muted',
          text,
        });
      },
    );

    // Commit harness brief if agent produced it (mirrors taskTestJob.ts behaviour)
    const briefFilePath = path.join(worktreePath, '__orrery_harness_brief.md');
    if (fs.existsSync(briefFilePath)) {
      const briefContent = fs.readFileSync(briefFilePath, 'utf-8');
      commitArtifact(feature.slug, 'test-harness-brief.md', briefContent, 'test-harness-brief');
      fs.unlinkSync(briefFilePath);
      void appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'muted',
        text: '◦ harness brief committed as artifact',
      });
    }

    // ── Host-side verification ─────────────────────────────────────────────
    // Run with --outputFile so the JSON report lands in a file; read it back
    // with cat. This prevents stdout interleaving from the app-under-test from
    // corrupting the reporter output (backlog C-4).
    const jsonCmd = detectJsonCommand(repoClaudeMd, repoEntry.probe_command);
    let testResult = await container.exec(jsonCmd);
    void appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: `◦ test exec: ${jsonCmd} (exit ${testResult.exitCode})${testResult.stderr ? ` stderr: ${testResult.stderr.slice(0, 300)}` : ''}`,
    });
    const catResult = await container.exec(`cat ${TEST_REPORT_FILE}`);
    void appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: `◦ cat ${TEST_REPORT_FILE}: exit ${catResult.exitCode}, ${catResult.stdout.length} bytes`,
    });
    let reportSource = catResult.stdout;
    let parsed = parseTestOutput(reportSource, '');

    if (parsed.parseError) {
      // File not written or unreadable — fall back to npm test for exit code.
      // We do NOT re-parse npm test stdout (plain text, not JSON). parsed keeps
      // its parseError so the report is honest about the missing counts (C-5).
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'muted',
        text: `◦ JSON report file unreadable (exit ${catResult.exitCode}, ${catResult.stdout.length} bytes, ${parsed.parseError.slice(0, 80)}) — retrying with ${plainTestCommand(repoEntry.probe_command)}`,
      });
      testResult = await container.exec(plainTestCommand(repoEntry.probe_command));
    }

    if (testResult.exitCode !== 0) {
      // Tests failed — derive findings from parser output (stable IDs).
      const findings = findingsFromTests(parsed.tests);
      const failed = parsed.failed ?? Math.max(findings.length, 1);
      const passed = parsed.passed ?? null;

      // Diagnostic: mismatch between numFailedTests and findings count indicates
      // pending/todo tests being mapped to 'failed' in parseTestOutput.
      // Likely cause: jest workers OOM-killed under oversubscription → in-flight
      // tests reported as 'pending' rather than 'failed' in assertionResults.
      if (
        parsed.failed !== null &&
        parsed.failed !== undefined &&
        findings.length !== parsed.failed
      ) {
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'muted',
          text: `◦ findings/summary mismatch: ${findings.length} findings but numFailedTests=${parsed.failed} — likely pending/todo tests in JSON report`,
        });
      }

      await appendEvent(getPrisma(), featureId, {
        type: 'test.report',
        agent: 'test',
        spec_rev: specRev,
        passed,
        failed,
        findings,
        tests: parsed.tests.length > 0 ? parsed.tests : undefined,
        ...(parsed.parseError ? { parse_error: parsed.parseError } : {}),
      });

      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'test',
        severity: 'action',
        text: parsed.parseError
          ? `· ${failed} test failure(s) after agent run (JSON report unavailable)`
          : formatTestSummary(parsed),
      });

      if (priorTestRounds >= 1) {
        // Round cap: human gate
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'test',
          severity: 'action',
          text: '· round cap reached — escalating to human gate',
        });

        // Persist findings for dismiss/accept routes
        if (findings.length > 0) {
          await getPrisma().finding.createMany({
            data: findings.map((f) => ({
              id: f.id,
              featureId,
              specRev,
              severity: f.severity,
              section: f.section,
              issue: f.issue,
              suggestedText: null,
            })),
            skipDuplicates: true,
          });
        }

        await appendEvent(getPrisma(), featureId, {
          type: 'gate.opened',
          gate: 'test_report',
          summary: `${failed} test failure(s) after revision round — human review required`,
          revision: specRev,
          counts: { blockers: failed, warnings: 0, suggestions: 0 },
        });
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.status',
          agent: 'test',
          status: 'waiting',
        });
      } else {
        // Round 0: bounce-back
        let nextState: FeatureStatus | null = null;
        await getPrisma().$transaction(async (tx) => {
          const next = await applyTransition(tx, featureId, 'TESTING', 'TEST_FAIL');
          if (next) {
            nextState = next;
            await appendEvent(tx, featureId, { type: 'phase.changed', from: 'TESTING', to: next });
          }
        });

        const fallbackRepos = repos.length > 0 ? repos : [repoId];
        const created = await createSyntheticFixTasks(featureId, findings, fallbackRepos);

        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'info',
          text: `↻ bounce-back: ${failed} test failure(s) — dispatching synthetic fix task(s) (${created.map((c) => c.repo).join(', ')})`,
        });
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.status',
          agent: 'test',
          status: 'done',
        });

        if (nextState) {
          await dispatchForState(featureId, nextState, {
            simulated_run: feature.simulatedRun,
          });
        }
      }
      return;
    }

    // ── Tests pass: commit test files host-side ────────────────────────────
    let stagedLines: string[] = [];
    const statusOut = git(worktreePath, 'status', '--porcelain').trim();
    if (statusOut !== '') {
      git(worktreePath, 'add', '-A');
      stagedLines = git(worktreePath, 'diff', '--cached', '--name-only')
        .trim()
        .split('\n')
        .filter(Boolean);

      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'muted',
        text:
          `◦ staged ${stagedLines.length} test file(s): ` +
          `${stagedLines.slice(0, 10).join(', ')}` +
          (stagedLines.length > 10 ? ` … (+${stagedLines.length - 10} more)` : ''),
      });

      gitCommit(worktreePath, `test: acceptance tests for feature\n\nX-Orrery-Agent: test`);
      pushBranch(worktreePath, featureBranch);

      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'ok',
        text: `✓ test files committed and pushed to ${featureBranch}`,
      });
    }

    // Compute the durable authored set from git log (files added by the orchestrator
    // identity in testDir across all rounds). This survives a clean worktree in round 1+
    // where stagedLines is empty but the tests were committed in a prior round.
    let authoredFiles: string[];
    try {
      authoredFiles = getAuthoredTestFiles(worktreePath, testDir);
    } catch (gitErr) {
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'error',
        text: `getAuthoredTestFiles failed — git resolution error: ${gitErr instanceof Error ? gitErr.message : String(gitErr)}`,
      });
      await _handleNoAuthoredTests(
        featureId,
        specRev,
        {
          passed: null,
          failed: null,
          tests: [],
          authoredPassed: 0,
          authoredFailed: 0,
          parseError: 'git-resolution-error',
        },
        priorTestRounds,
        repos,
        repoId,
        feature,
      );
      return;
    }
    // Use reportSource (file contents) so authoredParsed uses the same clean
    // JSON as parsed — never testResult.stdout which may be interleaved (C-5).
    const authoredParsed = parseTestOutput(reportSource, '', authoredFiles);

    // Only fire the no-authored-tests gate when we have a real zero —
    // not when the JSON file was unreadable (parseError). An unreadable
    // report means "unknown" not "zero"; surfacing a false blocker here
    // was backlog C-5.
    if (authoredParsed.authoredPassed === 0 && !authoredParsed.parseError) {
      await _handleNoAuthoredTests(
        featureId,
        specRev,
        authoredParsed,
        priorTestRounds,
        repos,
        repoId,
        feature,
      );
      return;
    }

    // Zero total tests ran — degenerate result, not a clean pass. Guard here so
    // _advanceTestPass never emits "✓ all acceptance tests pass (0 passed, 0 failed)".
    if ((authoredParsed.passed ?? 0) === 0 && !authoredParsed.parseError) {
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'error',
        text: '· zero tests executed — cannot confirm acceptance gate',
      });
      await _handleNoAuthoredTests(
        featureId,
        specRev,
        authoredParsed,
        priorTestRounds,
        repos,
        repoId,
        feature,
      );
      return;
    }

    await _advanceTestPass(featureId, specRev, {
      passed: authoredParsed.passed,
      tests: authoredParsed.tests,
      authoredPassed: authoredParsed.authoredPassed,
      authoredFailed: authoredParsed.authoredFailed,
      ...(authoredParsed.parseError !== undefined && { parseError: authoredParsed.parseError }),
    });
  } catch (err: unknown) {
    const isPolicyViolation =
      err instanceof AllowlistViolationError || err instanceof MetacharViolationError;
    const msg = err instanceof Error ? err.message : String(err);
    const isBedrock403 = msg.includes('403') || msg.includes('security token');

    if (isBedrock403) {
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.status',
        agent: 'test',
        status: 'failed',
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'test',
        severity: 'muted',
        text: `· Bedrock 403 — STS token expired. Run: aws sso login --profile ai-devtools-dev. Then POST /features/${featureId}/retry-test`,
      });
      return;
    }

    if (isPolicyViolation) {
      await _handleTestError(featureId, `Policy violation: ${msg}`);
    } else {
      await _handleTestError(featureId, msg.slice(0, 300));
    }
  } finally {
    void appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: `◦ container stopped — ${container.name}`,
    });
    await container.stop();
  }
}

async function _advanceTestPass(
  featureId: string,
  specRev: number,
  counts: {
    passed: number | null;
    tests?: TestRow[];
    authoredPassed?: number;
    authoredFailed?: number;
    parseError?: string;
  },
): Promise<void> {
  await appendEvent(getPrisma(), featureId, {
    type: 'test.report',
    agent: 'test',
    spec_rev: specRev,
    passed: counts.passed,
    failed: 0,
    findings: [],
    ...(counts.tests && counts.tests.length > 0 ? { tests: counts.tests } : {}),
    ...(counts.authoredPassed !== undefined ? { authored_passed: counts.authoredPassed } : {}),
    ...(counts.authoredFailed !== undefined ? { authored_failed: counts.authoredFailed } : {}),
    ...(counts.parseError ? { parse_error: counts.parseError } : {}),
  });
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'test',
    severity: 'ok',
    text: `✓ all acceptance tests pass (${counts.passed ?? '?'} passed, 0 failed)`,
  });
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.status',
    agent: 'test',
    status: 'done',
  });

  const feature = await getPrisma().feature.findUniqueOrThrow({
    where: { id: featureId },
    select: { status: true, simulatedRun: true },
  });

  let nextState: FeatureStatus | null = null;
  await getPrisma().$transaction(async (tx) => {
    const next = await applyTransition(tx, featureId, 'TESTING', 'TEST_PASS');
    if (next) {
      nextState = next;
      await appendEvent(tx, featureId, { type: 'phase.changed', from: 'TESTING', to: next });
    }
  });

  if (nextState) {
    await dispatchForState(featureId, nextState, {
      simulated_run: feature.simulatedRun,
    });
  }
}

async function _handleNoAuthoredTests(
  featureId: string,
  specRev: number,
  parsed: ParsedTestOutput,
  priorTestRounds: number,
  _repos: string[],
  _repoId: string,
  _feature: { simulatedRun: boolean },
): Promise<void> {
  const syntheticFinding: import('@orrery/shared').TestFinding = {
    id: 'no-authored-tests',
    severity: 'blocker',
    test_name: '(no authored tests)',
    section: 'acceptance tests',
    issue: 'Test suite passed but agent wrote no new test files — acceptance tests are required.',
  };

  await appendEvent(getPrisma(), featureId, {
    type: 'test.report',
    agent: 'test',
    spec_rev: specRev,
    passed: parsed.passed,
    failed: 1,
    authored_passed: 0,
    authored_failed: 0,
    findings: [syntheticFinding],
    ...(parsed.tests && parsed.tests.length > 0 ? { tests: parsed.tests } : {}),
  });

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'test',
    severity: 'action',
    text: '· test suite passed but no authored test files detected — bounce-back to IMPLEMENTING',
  });

  if (priorTestRounds >= 1) {
    await appendEvent(getPrisma(), featureId, {
      type: 'gate.opened',
      gate: 'test_report',
      summary: 'Test suite passed but agent wrote no new test files — human review required',
      revision: specRev,
      counts: { blockers: 1, warnings: 0, suggestions: 0 },
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'test',
      status: 'waiting',
    });
    return;
  }

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'test',
    severity: 'action',
    text: '· no authored test files detected — re-dispatching test agent (round 0 of 1); the gate requires at least one new test file committed by the test agent',
  });
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.status',
    agent: 'test',
    status: 'done',
  });

  await dispatchJob(featureId, 'test');
}

async function _handleTestError(featureId: string, reason: string): Promise<void> {
  console.error(JSON.stringify({ event: 'test_job_error', featureId, error: reason }));
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.status',
    agent: 'test',
    status: 'failed',
  });
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'test',
    severity: 'muted',
    text: `· test agent failed — ${reason}. Use POST /features/${featureId}/retry-test to retry.`,
  });
}
