/**
 * Generic dev-agent job — parameterized by DevJobProfile so server and client
 * instances share one implementation with no copy-paste.
 *
 * Finding 7 parameterization points resolved here:
 *   1. DEMO_SERVER_CLAUDE_MD_PATH constant → reads CLAUDE.md from worktree root
 *      (claudeMdFallback is the default when the file is absent)
 *   2. "TypeScript API repository" opener → repoEntry.description
 *   3. Pre-flights (binary sentinel, probe command) → already profile-driven (A2)
 *   4. dispatchUnblockedTasks side param → task.side
 *   5. Job type ('server-dev'|'client-dev') → repoEntry.side
 *   6. AgentJobPayload 'client-dev' type → queue.ts (B3)
 *   7. feature.currentBranch → currentBranches JSON map (T-4c-1 resolved in 4e)
 */

import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { checkSpendGuard } from '../lib/spendGuard.js';
import { readArtifact } from '../lib/artifacts.js';
import { createWorktree } from '../lib/worktree.js';
import type { WorktreeInfo } from '../lib/worktree.js';
import {
  startContainer,
  runInstallContainer,
  runHostInstall,
  runBootstrapInstall,
  AllowlistViolationError,
  MetacharViolationError,
  EXEC_MAX_BUFFER,
} from '../lib/container.js';
import { dispatchUnblockedTasks, dispatchForState } from '../lib/dispatch.js';
import { getRejectedAmendments } from '../routes/featureAmendment.js';
import { maybeAdvanceToReview } from '../lib/maybeAdvance.js';
import { checkBedrockWithRetry } from '../lib/connectivity.js';
import { parkTaskOnBedrockFailure, isEnvironmentalBedrockError } from '../lib/bedrockPark.js';
import {
  runDevAgent,
  AgentNoopError,
  AgentOutcome,
  ViolationInfo,
  ToolCallInfo,
  measurePromptSections,
} from '../agents/devAgent.js';
import { NonProgressError } from '../lib/nonProgressError.js';
import yaml from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { usageEventPayload } from '../lib/usageEvent.js';
import { scopeSpecByRefs, scopeContract } from '../lib/promptScope.js';
import {
  getAuthoredTestFilesForTask,
  discoverTestDir,
  parseTestOutput,
  detectJsonCommand,
  findingsFromTests,
  TEST_REPORT_FILE,
} from './testJob.js';
import { formatTestSummary } from '../lib/testOutputSummary.js';
import { generateRepoOrientation } from '../lib/repoOrientation.js';

const MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/agents/repo-manifest.yaml',
);

// ── Error classes ─────────────────────────────────────────────────────────────

export class CommitStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitStepError';
  }
}

// Thrown when npm install fails (ETIMEDOUT, ECONNRESET, 503, etc.).
// Classified as infra — never agent-fault — and gets 3 attempts (not 2)
// because cold-cache ratcheting legitimately needs more tries on a large
// dep tree through a TLS-inspecting proxy.
export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

// Thrown when git push fails inside completeTask. Always final: the work is
// committed; re-running the full agent job won't fix the push. Surfaces a
// parked task rather than crashing the server process.
export class PushError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'PushError';
  }
}

// ── Manifest ──────────────────────────────────────────────────────────────────

export interface RepoEntry {
  id: string;
  side: string;
  active: boolean;
  path?: 'light' | 'full'; // 'light' repos use the light pipeline; absent defaults to 'full'
  url: string;
  default_branch: string;
  description?: string;
  binary_sentinel?: string;
  probe_command?: string;
  exec_timeout_ms?: number;
  install_timeout_ms?: number;
  bootstrap?: string; // custom install command; when set, replaces the npm ci path
  max_turns?: number;
  review_charter?: string; // path to operator charter file; absence skips AWS review
}

export function getRepoEntry(repoId: string): RepoEntry {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  const manifest = yaml.load(raw) as { repos: RepoEntry[] };
  const entry = manifest.repos.find((r) => r.id === repoId);
  if (!entry) throw new Error(`Repo '${repoId}' not found in manifest`);
  if (!entry.active) throw new Error(`Repo '${repoId}' is inactive in manifest`);
  return entry;
}

/** Like getRepoEntry but does not require active:true — for light-path repos that may be inactive. */
export function getAnyRepoEntry(repoId: string): RepoEntry {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  const manifest = yaml.load(raw) as { repos: RepoEntry[] };
  const entry = manifest.repos.find((r) => r.id === repoId);
  if (!entry) throw new Error(`Repo '${repoId}' not found in manifest`);
  return entry;
}

/**
 * Shared install router used by every job that installs dependencies.
 * Priority: bootstrap (manifest-declared shell command) > container npm ci > host npm ci.
 * Security: bootstrap is operator config only — never API-settable.
 */
export async function routeInstall(
  repoEntry: RepoEntry,
  worktreePath: string,
  imageTag: string,
  cafile: string,
  installTimeoutMs: number,
): Promise<void> {
  const installStrategy = process.env['INSTALL_STRATEGY'] ?? 'host';
  if (repoEntry.bootstrap) {
    await runBootstrapInstall(worktreePath, repoEntry.bootstrap, cafile, installTimeoutMs);
  } else if (installStrategy === 'container') {
    await runInstallContainer(worktreePath, imageTag, cafile, installTimeoutMs);
  } else {
    await runHostInstall(worktreePath, cafile, installTimeoutMs);
  }
}

// ── Manifest guardrail ────────────────────────────────────────────────────────

const PLATFORM_NATIVE_RE = /^(@rollup\/rollup-|@esbuild\/|@swc\/|lightningcss-|@parcel\/watcher)/;

export function checkManifestGuardrail(worktreePath: string): void {
  const pkgPath = path.join(worktreePath, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const violations = Object.keys(allDeps).filter((k) => PLATFORM_NATIVE_RE.test(k));
  if (violations.length > 0) {
    throw new Error(
      `Manifest guardrail: ${violations.join(', ')} listed as direct dep(s) in package.json. ` +
        `Platform-native packages belong in package-lock.json as optional entries only ` +
        `(removing them from direct deps prevents cross-platform install failures). ` +
        `Remove from package.json dependencies/devDependencies.`,
    );
  }
}

// ── Toolchain probe assessment ────────────────────────────────────────────────

/**
 * Determine whether a probe result indicates a broken toolchain.
 *
 * reportContent is the output of `cat /tmp/test-report.json` after running the
 * JSON-reporter form of the probe command (via detectJsonCommand).
 *
 * report parseable (no parseError) → healthy; tests may be red by design under TDD
 * report missing or unparseable    → broken toolchain (compile error, missing binary, etc.)
 */
export function assessProbeResult(
  reportContent: string,
  execExitCode: number,
): { ok: boolean; reason?: string } {
  const parsed = parseTestOutput(reportContent, '');
  if (!parsed.parseError) return { ok: true };
  const byteCount = reportContent.length;
  const reason =
    execExitCode !== 0
      ? `toolchain probe failed: test command exited ${execExitCode} (report ${byteCount} bytes${byteCount ? `, parse error: ${parsed.parseError}` : ', no output'})`
      : `toolchain probe failed: report file ${byteCount === 0 ? 'missing' : 'unreadable'} (${byteCount} bytes${byteCount ? `, parse error: ${parsed.parseError}` : ''})`;
  return { ok: false, reason };
}

// ── Host-side git operations ──────────────────────────────────────────────────

const GIT_AUTHOR_NAME = process.env['BOT_GIT_NAME'] ?? 'Orrery';
const GIT_AUTHOR_EMAIL = process.env['BOT_GIT_EMAIL'] ?? 'orrery-bot@example.com';

function git(worktreePath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: EXEC_MAX_BUFFER,
  });
}

// Reads CLAUDE.md from the default branch, not the feature branch in the worktree.
// Operator guidance is delivered out-of-band; reading from the manifest's
// default_branch prevents agent rewrites on the feature branch from overriding it.
// Use the branch name, not FETCH_HEAD. FETCH_HEAD is overwritten by every fetch on
// any branch, so it is not stable under concurrent jobs that share a bare clone.
// `git clone --bare` from a local path sets no fetch refspec, so a plain
// `git fetch origin <branch>` only writes FETCH_HEAD and leaves
// refs/heads/<branch> stale. Supplying an explicit destination refspec
// (+<branch>:<branch>) writes directly to refs/heads/<branch>; the + forces
// the update even for non-fast-forward cases. Bare repos have no working tree,
// so updating the HEAD branch is safe.
export function readClaudeMdFromDefaultBranch(worktreePath: string, defaultBranch: string): string {
  git(worktreePath, 'fetch', 'origin', `+${defaultBranch}:${defaultBranch}`);
  return git(worktreePath, 'show', `${defaultBranch}:CLAUDE.md`);
}

export function gitCommit(worktreePath: string, message: string): void {
  // Pass author identity via -c flags so the bot's identity is used regardless
  // of the operator's global git config. Scoped to this single invocation —
  // no config file is modified, no residue left in the worktree.
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

export function pushBranch(worktreePath: string, branch: string): void {
  git(worktreePath, 'push', 'origin', branch);
}

// ── Install mutex ─────────────────────────────────────────────────────────────
// Shared across all runDevJob calls — host installs serialize on one ~/.npm.

let _installChain: Promise<unknown> = Promise.resolve();

function withInstallLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _installChain.then(fn);
  _installChain = next.catch(() => undefined);
  return next;
}

// ── Complete-and-dispatch helper ──────────────────────────────────────────────

interface TaskRow {
  id: string;
  repo: string;
  side: string;
  title: string;
}

export async function completeTask(
  featureId: string,
  taskId: string,
  task: TaskRow,
  worktreeInfo: WorktreeInfo,
  commitSha: string | undefined,
): Promise<'completed'> {
  const noopSuccess = commitSha === undefined;
  const side = task.side as 'server' | 'client';
  const agentName = side;

  await getPrisma().task.update({
    where: { id: taskId },
    data: { status: 'completed', ...(commitSha ? { commitSha } : {}) },
  });

  await appendEvent(getPrisma(), featureId, {
    type: 'task.completed',
    repo: task.repo,
    task_id: task.id,
    ...(commitSha ? { commit: commitSha } : {}),
  });

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: agentName,
    repo: task.repo,
    severity: 'ok',
    text: noopSuccess
      ? `✓ task ${task.id} noop-success — expected work already present, tests pass`
      : `✓ task ${task.id} complete — commit ${commitSha}`,
  });

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.status',
    agent: agentName,
    repo: task.repo,
    status: 'done',
  });

  // Re-evaluate dispatch for both sides: a task completing on one side can
  // satisfy cross-side dependencies (e.g. a client task that depends on a
  // server task ID). Without this, the cross-side task would stall pending.
  await Promise.all([
    dispatchUnblockedTasks(featureId, 'server'),
    dispatchUnblockedTasks(featureId, 'client'),
  ]);

  const remaining = await getPrisma().task.count({
    where: { featureId, side, status: { not: 'completed' } },
  });
  if (remaining === 0) {
    try {
      pushBranch(worktreeInfo.worktreePath, worktreeInfo.branch);
    } catch (cause) {
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'action',
        text: `push failed for ${worktreeInfo.branch}: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      throw new PushError(cause);
    }
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'ok',
      text: `✓ branch ${worktreeInfo.branch} pushed to ${task.repo}`,
    });
  }

  const newState = await maybeAdvanceToReview(featureId);
  if (newState === 'CODE_REVIEW') {
    // Real run stopped at CODE_REVIEW — dispatch the PR-creation job.
    // Simulated runs auto-advance to DONE inside maybeAdvanceToReview; no dispatch needed.
    await dispatchForState(featureId, 'CODE_REVIEW', { simulated_run: false });
  }

  return 'completed';
}

// ── Generic job handler ────────────────────────────────────────────────────────

export async function runDevJob(
  featureId: string,
  taskId: string,
  bullJobId: string,
): Promise<'completed' | 'parked'> {
  const [task, feature] = await Promise.all([
    getPrisma().task.findUnique({ where: { id: taskId } }),
    getPrisma().feature.findUniqueOrThrow({ where: { id: featureId } }),
  ]);

  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status === 'completed' || task.status === 'parked') {
    return 'parked';
  }

  const sg = await checkSpendGuard(featureId, taskId, task.title);
  if (sg.parked) return 'parked';
  const spendGuardRemainingBudget = sg.remainingBudget;

  const attempt = task.attemptCount + 1;

  await appendEvent(getPrisma(), featureId, {
    type: 'task.started',
    repo: task.repo,
    task_id: task.id,
    attempt,
  });

  await getPrisma().task.update({
    where: { id: taskId },
    data: { status: 'running', attemptCount: attempt },
  });

  const rawSpec = feature.proposedSpec ?? '';
  const rawContract = readArtifact(feature.slug, 'contract.yaml') ?? '';

  const repoEntry = getRepoEntry(task.repo);
  const specMarkdown = scopeSpecByRefs(rawSpec, task.specRefs as string[]);
  const contractYaml = scopeContract(rawContract, {
    side: repoEntry.side as 'server' | 'client',
    refs: task.specRefs as string[],
    taskDescription: task.description,
    onFallback: (reason) => {
      void appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: task.side,
        repo: task.repo,
        severity: 'muted',
        text: `◦ contract scoping: full contract used — ${reason}`,
      });
    },
  });

  // Load CLAUDE.md from the worktree root (finding 7: kill the server-specific
  // scaffold constant — each repo carries its own CLAUDE.md). Fallback to a
  // minimal stub if the file is absent (shouldn't happen once repo passes
  // the readiness checklist, but never crash).
  const worktreeInfo = createWorktree(
    repoEntry.url,
    feature.slug,
    repoEntry.default_branch,
    repoEntry.id,
  );

  // Upsert this repo's branch into the per-repo map.
  const existingBranches = (feature.currentBranches as Record<string, string>) ?? {};
  if (existingBranches[repoEntry.id] !== worktreeInfo.branch) {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: {
        currentBranches: { ...existingBranches, [repoEntry.id]: worktreeInfo.branch },
      },
    });
  }

  git(worktreeInfo.worktreePath, 'checkout', '.');
  git(worktreeInfo.worktreePath, 'clean', '-fd');
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'muted',
    text: `◦ worktree reset to clean branch HEAD (${worktreeInfo.branch})`,
  });

  const orientationBlock = generateRepoOrientation(worktreeInfo.worktreePath);
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'muted',
    text: `◦ repo orientation: ${orientationBlock.length} chars`,
  });

  if (!(await checkBedrockWithRetry(2, 15_000))) {
    // Environmental failure after 3 probes (~30s). Does not consume a retry slot.
    // Roll back the attempt increment so the slot is preserved for the real agent run.
    await parkTaskOnBedrockFailure({
      featureId,
      taskId,
      repo: task.repo,
      agentName: task.side,
      retryPath: `POST /features/${featureId}/retry-bounce`,
      attemptRollback: { attemptCount: task.attemptCount },
      attempt,
    });
    return 'parked';
  }

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'muted',
    text: '◦ bedrock-probe passed',
  });

  const imageTag = process.env['AGENT_CONTAINER_IMAGE'] ?? 'node:20-alpine';
  const installStrategy = process.env['INSTALL_STRATEGY'] ?? 'host';
  const cafile = process.env['NODE_EXTRA_CA_CERTS'] ?? '';
  const installTimeoutMs = repoEntry.install_timeout_ms ?? 300_000;
  const execTimeoutMs = repoEntry.exec_timeout_ms ?? 120_000;
  const DEV_AGENT_DEFAULT_MAX_TURNS = 40; // mirrors devAgent.ts MAX_TURNS
  const effectiveCap = Math.max(
    1,
    Math.min(repoEntry.max_turns ?? DEV_AGENT_DEFAULT_MAX_TURNS, spendGuardRemainingBudget),
  );

  const installStart = Date.now();
  const installDesc = repoEntry.bootstrap
    ? `bootstrap`
    : `${installStrategy}, platform-override linux/arm64/musl`;
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'muted',
    text: `◦ install started (${installDesc}, cap ${Math.round(installTimeoutMs / 1000)}s)`,
  });

  const installPhaseStart = Date.now();
  await withInstallLock(async () => {
    try {
      await routeInstall(repoEntry, worktreeInfo.worktreePath, imageTag, cafile, installTimeoutMs);
    } catch (installErr: unknown) {
      // util.promisify(exec) rejects with a ChildProcessError whose npm output
      // lives on .stderr/.stdout, NOT in .message (.message is only the short
      // "Command failed: npm ci ..." header). Capture the TAIL of stderr — the
      // actual npm error lines (cert errors, 404s, auth failures) are always last,
      // buried after hundreds of deprecation warnings at the top.
      const e = installErr as { stderr?: string; stdout?: string; message?: string };
      const rawOutput = [e.stderr, e.stdout].filter(Boolean).join('\n');
      const lines = rawOutput.split('\n');
      const tail = lines.slice(-30).join('\n');
      const detail =
        tail || (installErr instanceof Error ? installErr.message : String(installErr));

      // Fast-fail heuristic: if install exits in <60s it's deterministic (cert
      // error, registry 404, auth failure) — retrying wastes 3×60s and produces
      // the same error every time. Park immediately with the full tail surfaced.
      const elapsedMs = Date.now() - installPhaseStart;
      const isFastFail = elapsedMs < 60_000;
      if (isFastFail) {
        throw new InstallError(
          `npm install fast-failed (${Math.round(elapsedMs / 1000)}s — deterministic): ${detail}`,
        );
      }
      throw new InstallError(`npm install failed: ${detail}`);
    }
  });

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'muted',
    text: `◦ install completed in ${Math.round((Date.now() - installStart) / 1000)}s`,
  });

  checkManifestGuardrail(worktreeInfo.worktreePath);

  const pkgJsonPath = path.join(worktreeInfo.worktreePath, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
    if ('prisma' in allDeps || '@prisma/client' in allDeps) {
      const schemaPath = path.join(worktreeInfo.worktreePath, 'prisma', 'schema.prisma');
      const hasBinaryTargets =
        fs.existsSync(schemaPath) &&
        fs.readFileSync(schemaPath, 'utf-8').includes('linux-musl-arm64');
      if (!hasBinaryTargets) {
        throw new CommitStepError(
          `Repo readiness: prisma dependency detected but binaryTargets does not include ` +
            `"linux-musl-arm64" in prisma/schema.prisma. ` +
            `Fix: add binaryTargets = ["native", "linux-musl-arm64"] to the generator block ` +
            `and provide PRISMA_ENGINES_MIRROR=file:// on a bind-mounted path.`,
        );
      }
    }
  }

  if (repoEntry.binary_sentinel) {
    const sentinelPath = path.join(worktreeInfo.worktreePath, repoEntry.binary_sentinel);
    if (!fs.existsSync(sentinelPath)) {
      try {
        execSync('npm cache verify', {
          cwd: worktreeInfo.worktreePath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: EXEC_MAX_BUFFER,
        });
      } catch {
        // non-fatal
      }
      throw new Error(
        `${repoEntry.binary_sentinel} absent after install — ` +
          'npm install skipped the optional dep (proxy 503 or corrupted cache). Cache cleared; retry will re-download.',
      );
    }
  }

  const container = startContainer(
    worktreeInfo.worktreePath,
    task.id,
    imageTag,
    () => {
      void appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'muted',
        text: '⚠ AGENT_UNSAFE_HOST_EXEC active — container sandbox bypassed; commands run on host with full network access',
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

    let repoClaudeMd: string;
    try {
      repoClaudeMd = readClaudeMdFromDefaultBranch(
        worktreeInfo.worktreePath,
        repoEntry.default_branch,
      );
    } catch {
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: task.side,
        repo: task.repo,
        severity: 'muted',
        text: `◦ CLAUDE.md not found on ${repoEntry.default_branch}:CLAUDE.md — using stub`,
      });
      repoClaudeMd = `# ${repoEntry.id}\n## Commands\nnpm test\nnpm run lint\n`;
    }

    const probeJsonCmd = detectJsonCommand(repoClaudeMd, repoEntry.probe_command);
    const probeExecResult = await container.exec(probeJsonCmd);
    void appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: `◦ probe exec: ${probeJsonCmd} (exit ${probeExecResult.exitCode})${probeExecResult.stderr ? ` stderr: ${probeExecResult.stderr.slice(0, 300)}` : ''}`,
    });
    const probeCatResult = await container.exec(`cat ${TEST_REPORT_FILE}`);
    const probeAssessment = assessProbeResult(probeCatResult.stdout, probeExecResult.exitCode);
    if (!probeAssessment.ok) {
      const reason = probeAssessment.reason!;
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'muted',
        text: `✗ toolchain probe failed — ${reason.slice(0, 200)}`,
      });
      const stderrLine = probeExecResult.stderr?.split('\n')[0]?.trim() ?? '';
      throw new Error(stderrLine ? `${reason}: ${stderrLine}` : reason);
    }

    // Baseline: names of tests already failing before the agent touched anything (R9).
    // Verification later filters to only NEW failures — pre-existing ones are not the agent's fault.
    const baselineParsed = parseTestOutput(probeCatResult.stdout, '');
    const baselineFailedNames = new Set(
      baselineParsed.tests.filter((t) => t.status === 'failed').map((t) => t.test_name),
    );

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: task.side,
      repo: task.repo,
      status: 'working',
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: task.side,
      repo: task.repo,
      severity: 'action',
      text: `▸ implementing task ${task.id}: ${task.title}`,
    });

    const rejectedAmendments = await getRejectedAmendments(featureId);

    const sections = measurePromptSections(
      {
        id: task.id,
        title: task.title,
        description: task.description,
        specRefs: task.specRefs as string[],
      },
      {
        specMarkdown,
        contractYaml,
        repoClaudeMd,
        orientationBlock,
        ...(repoEntry.description ? { repoDescription: repoEntry.description } : {}),
        ...(rejectedAmendments.length > 0 ? { rejectedAmendments } : {}),
        ...(task.coveredByTestPlan ? { coveredByTestPlan: true } : {}),
      },
    );
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: task.side,
      repo: task.repo,
      severity: 'muted',
      text: `◦ prompt size: ${sections.total} chars (claudeMd=${sections.claudeMd}, contract=${sections.contract}, spec=${sections.spec}, task=${sections.task}, orientation=${sections.orientation}, rules=${sections.rules})`,
    });

    const agentOutcome: AgentOutcome = await runDevAgent(
      featureId,
      {
        id: task.id,
        title: task.title,
        description: task.description,
        specRefs: task.specRefs as string[],
      },
      {
        specMarkdown,
        contractYaml,
        repoClaudeMd,
        orientationBlock,
        ...(repoEntry.description ? { repoDescription: repoEntry.description } : {}),
        ...(rejectedAmendments.length > 0 ? { rejectedAmendments } : {}),
        maxTurns: effectiveCap,
        ...(repoEntry.probe_command ? { probeCommand: repoEntry.probe_command } : {}),
        ...(task.coveredByTestPlan ? { coveredByTestPlan: true } : {}),
      },
      container,
      worktreeInfo.worktreePath,
      async (usage) => {
        await appendEvent(
          getPrisma(),
          featureId,
          usageEventPayload(usage, task.side, { jobId: bullJobId, taskId }),
        );
      },
      async (info: ViolationInfo) => {
        const truncCmd = info.command.length > 80 ? info.command.slice(0, 80) + '…' : info.command;
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: task.side,
          repo: task.repo,
          severity: 'muted',
          text: `⚠ violation ${info.count}/${info.max}: ${info.rule} — ${truncCmd}`,
        });
      },
      async (info: ToolCallInfo) => {
        let text: string;
        if (info.toolName === 'read_file') {
          text = `◦ turn ${info.turn} · read_file ${info.path} (${info.range}, ${info.resultSize} chars)`;
          if (info.resultFirstLine) text += ` → ${info.resultFirstLine}`;
        } else if (info.toolName === 'bash') {
          text = `◦ turn ${info.turn} · bash ${info.command ?? ''} (${info.resultSize} chars)`;
          if (info.resultFirstLine) text += ` → ${info.resultFirstLine}`;
          if (info.resolvedCommand) {
            text += `\n  ∟ resolved: ${info.resolvedCommand}`;
            if (info.reportPath) text += ` @ ${info.reportPath}`;
          }
        } else if (info.toolName === 'write_file') {
          text = `◦ turn ${info.turn} · write_file ${info.path} (${info.contentLength} chars content)`;
          if (info.resultFirstLine) text += ` → ${info.resultFirstLine}`;
        } else {
          text = `◦ turn ${info.turn} · ${info.toolName} (${info.resultSize} chars)`;
          if (info.resultFirstLine) text += ` → ${info.resultFirstLine}`;
        }
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: task.side,
          repo: task.repo,
          severity: 'muted',
          text,
        });
      },
    );

    // Amendment path: agent proposed a contract revision.
    // Pause the proposing task + all pending tasks on both sides, open a gate.
    // Does NOT consume an attempt — roll back the attemptCount increment.
    // Return 'completed' (not 'parked') so the worker emits job_complete, not
    // job_failed — the agent succeeded at its job by proposing the amendment.
    if (agentOutcome.kind === 'amendment_proposed') {
      // Dedup guard: if this rationale matches a prior operator rejection for this
      // feature, park the task instead of re-pausing everyone and reopening a gate.
      // The prompt injection (## Rejected amendments) is the proactive guard; this
      // is the reactive backstop for agents that ignored or forgot the ruling.
      const normalizeRationale = (s: string): string =>
        s
          .slice(0, 80)
          .toLowerCase()
          .replace(/[^a-z0-9 ]/g, '')
          .trim();
      const newNorm = normalizeRationale(agentOutcome.rationale);
      const matchedRejection = rejectedAmendments.find(
        (r) => normalizeRationale(r.rationaleSummary) === newNorm,
      );

      if (matchedRejection) {
        const ruling =
          matchedRejection.operatorReason || 'rejected — implement within existing contract';
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: task.side,
          repo: task.repo,
          severity: 'muted',
          text: `◦ duplicate amendment suppressed — prior ruling: "${ruling}"`,
        });
        const finalAttempt = task.attemptCount + 1;
        await getPrisma().task.update({
          where: { id: taskId },
          data: { status: 'parked', parkReason: 'failure', attemptCount: finalAttempt },
        });
        await appendEvent(getPrisma(), featureId, {
          type: 'task.failed',
          repo: task.repo,
          task_id: task.id,
          reason: `Duplicate amendment proposal suppressed. Operator ruling: "${ruling}". Task cannot proceed without a contract change.`,
          attempt: finalAttempt,
          final: true,
        });
        return 'parked';
      }

      // Roll back the attempt increment — this is not a failure.
      await getPrisma().task.update({
        where: { id: taskId },
        data: { status: 'amendment_paused', attemptCount: task.attemptCount },
      });

      // Pause all OTHER pending tasks on this feature (both sides).
      // Currently-running tasks on the other side are left running: they complete,
      // but their downstream won't dispatch because those tasks are amendment_paused.
      // This is the ratified between-tasks-only pause design.
      await getPrisma().task.updateMany({
        where: { featureId, status: 'pending' },
        data: { status: 'amendment_paused' },
      });

      await appendEvent(getPrisma(), featureId, {
        type: 'contract.amendment.proposed',
        repo: task.repo,
        task_id: task.id,
        proposed_contract_yaml: agentOutcome.contractYaml,
        rationale: agentOutcome.rationale,
      });

      await appendEvent(getPrisma(), featureId, {
        type: 'gate.opened',
        gate: 'amendment',
        summary: `${task.repo}: ${agentOutcome.rationale.slice(0, 160)}`,
        revision: 0,
      });

      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: task.side,
        repo: task.repo,
        severity: 'muted',
        text: `◦ amendment proposed — all pending tasks paused, awaiting operator decision`,
      });

      // The feature stays in IMPLEMENTING — operator resolves via approve/reject endpoints.
      return 'completed';
    }

    // Protected-test block: agent cannot resolve the finding without touching a read-only
    // acceptance test. Park the task so the operator can investigate.
    if (agentOutcome.kind === 'blocked_by_protected_test') {
      const finalAttempt = task.attemptCount + 1;
      await getPrisma().task.update({
        where: { id: taskId },
        data: {
          status: 'parked',
          parkReason: 'blocked_by_protected_test',
          attemptCount: finalAttempt,
        },
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: task.side,
        repo: task.repo,
        severity: 'action',
        text: `⊘ blocked by protected test\n  finding: ${agentOutcome.findingId}\n  file: ${agentOutcome.testFile}\n  assertion: ${agentOutcome.conflictingAssertion.slice(0, 200)}`,
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'task.failed',
        repo: task.repo,
        task_id: task.id,
        reason: `Agent blocked by protected acceptance test: ${agentOutcome.testFile} — ${agentOutcome.conflictingAssertion.slice(0, 200)}`,
        attempt: finalAttempt,
        final: false,
      });
      return 'parked';
    }

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: task.side,
      repo: task.repo,
      severity: 'info',
      text: '◦ verifying tests before host-side commit',
    });
    const testResult = await container.exec(
      detectJsonCommand(repoClaudeMd, repoEntry.probe_command),
    );
    if (testResult.exitCode !== 0) {
      const verifyCatResult = await container.exec(`cat ${TEST_REPORT_FILE}`);
      const verifyParsed = parseTestOutput(verifyCatResult.stdout, testResult.stderr);
      if (verifyParsed.parseError) {
        throw new Error(
          `Tests failed:\n${`${testResult.stdout}\n${testResult.stderr}`.slice(0, 800)}`,
        );
      }
      const newFailures = verifyParsed.tests.filter(
        (t) => t.status === 'failed' && !baselineFailedNames.has(t.test_name),
      );
      if (newFailures.length > 0) {
        throw new Error(
          `Tests failed:\n${formatTestSummary({ ...verifyParsed, tests: newFailures, failed: newFailures.length })}`,
        );
      }
    }

    checkManifestGuardrail(worktreeInfo.worktreePath);

    const statusOut = git(worktreeInfo.worktreePath, 'status', '--porcelain').trim();
    if (statusOut === '') {
      const noopTestResult = await container.exec(
        detectJsonCommand(repoClaudeMd, repoEntry.probe_command),
      );
      if (noopTestResult.exitCode === 0) {
        if (task.coveredByTestPlan && !task.testsWritten) {
          await getPrisma().task.update({
            where: { id: taskId },
            data: { status: 'awaiting_tests' },
          });
          await appendEvent(getPrisma(), featureId, {
            type: 'agent.log',
            agent: task.side,
            repo: task.repo,
            severity: 'info',
            text: `◦ task ${task.id} noop-success — awaiting acceptance tests`,
          });
          await appendEvent(getPrisma(), featureId, {
            type: 'agent.status',
            agent: task.side,
            repo: task.repo,
            status: 'waiting',
          });
          return 'completed';
        }
        return completeTask(featureId, taskId, task, worktreeInfo, undefined);
      }
      const noopCatResult = await container.exec(`cat ${TEST_REPORT_FILE}`);
      const noopParsed = parseTestOutput(noopCatResult.stdout, noopTestResult.stderr);
      const noopDetail = noopParsed.parseError
        ? `${noopTestResult.stdout}\n${noopTestResult.stderr}`.slice(0, 800)
        : formatTestSummary(noopParsed);
      throw new AgentNoopError(
        `Task ${task.id} completed but no file changes detected in worktree and tests fail — ` +
          `expected work is genuinely absent\n${noopDetail}`,
      );
    }

    git(worktreeInfo.worktreePath, 'add', '-A');

    const LOCKFILE_NAMES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
    const rawStaged = git(worktreeInfo.worktreePath, 'diff', '--cached', '--name-only')
      .trim()
      .split('\n')
      .filter(Boolean);
    const lockfilesStaged = rawStaged.filter((f) =>
      LOCKFILE_NAMES.some((n) => f === n || f.endsWith('/' + n)),
    );
    if (lockfilesStaged.length > 0) {
      git(worktreeInfo.worktreePath, 'reset', 'HEAD', '--', ...lockfilesStaged);
      void appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'muted',
        text: `◦ unstaged ${lockfilesStaged.length} lockfile(s) from agent commit: ${lockfilesStaged.join(', ')}`,
      });
    }

    const stagedLines = git(worktreeInfo.worktreePath, 'diff', '--cached', '--name-only')
      .trim()
      .split('\n')
      .filter(Boolean);
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text:
        `◦ staged ${stagedLines.length} file(s):` +
        ` ${stagedLines.slice(0, 20).join(', ')}` +
        (stagedLines.length > 20 ? ` … (+${stagedLines.length - 20} more)` : ''),
    });
    const nodeModulesStaged = stagedLines.filter((f) => f.startsWith('node_modules/'));
    if (nodeModulesStaged.length > 0) {
      git(worktreeInfo.worktreePath, 'reset', 'HEAD');
      throw new CommitStepError(
        `Commit guardrail: ${nodeModulesStaged.length} node_modules path(s) staged — ` +
          `.gitignore exclusion failed. First: ${nodeModulesStaged[0]}. Commit aborted.`,
      );
    }
    const STAGED_FILE_LIMIT = 50;
    if (stagedLines.length > STAGED_FILE_LIMIT) {
      git(worktreeInfo.worktreePath, 'reset', 'HEAD');
      throw new CommitStepError(
        `Commit guardrail: ${stagedLines.length} files staged for task ${task.id} ` +
          `(limit ${STAGED_FILE_LIMIT}). First 20: ${stagedLines.slice(0, 20).join(', ')}. ` +
          `Likely a missing .gitignore or stray directory leak. Commit aborted.`,
      );
    }

    gitCommit(worktreeInfo.worktreePath, `feat(${task.id}): ${task.title}`);
    const commitSha = git(worktreeInfo.worktreePath, 'rev-parse', 'HEAD').trim();

    // ── Per-task acceptance check ──────────────────────────────────────────────
    // Only runs for tasks that had acceptance tests written before implementation.
    // Uses the X-Orrery-Task trailer to scope to this task's authored files.
    if (task.coveredByTestPlan && task.testsWritten) {
      const testDir = discoverTestDir(worktreeInfo.worktreePath).dir;
      const taskTestFiles = getAuthoredTestFilesForTask(
        worktreeInfo.worktreePath,
        testDir,
        task.id,
      );
      if (taskTestFiles.length > 0) {
        const jsonCmd = detectJsonCommand(repoClaudeMd, repoEntry.probe_command);
        await container.exec(jsonCmd);
        const acceptCatResult = await container.exec(`cat ${TEST_REPORT_FILE}`);
        const parsed = parseTestOutput(acceptCatResult.stdout, '', taskTestFiles);
        const acceptanceFailed = parsed.authoredFailed > 0 || parsed.authoredPassed === 0;

        if (acceptanceFailed) {
          const findings = findingsFromTests(
            parsed.tests.filter((t) => t.status === 'failed' && t.authored === true),
          );

          await appendEvent(getPrisma(), featureId, {
            type: 'agent.log',
            agent: task.side,
            repo: task.repo,
            severity: 'action',
            text: `· acceptance tests failed for task ${task.id} (attempt ${attempt}/2)`,
          });

          if (attempt < 2) {
            // One retry: reset to pending so dispatchUnblockedTasks re-dispatches dev.
            await getPrisma().task.update({
              where: { id: taskId },
              data: { status: 'pending', attemptCount: attempt },
            });
            await dispatchUnblockedTasks(featureId, task.side as 'server' | 'client');
            return 'completed';
          }

          // Cap reached: park the task and open a human gate.
          await getPrisma().task.update({
            where: { id: taskId },
            data: { status: 'parked', parkReason: 'failure', attemptCount: attempt },
          });
          await appendEvent(getPrisma(), featureId, {
            type: 'gate.opened',
            gate: 'task_acceptance_gate',
            revision: 0,
            taskId: task.id,
            taskTitle: task.title,
            summary: `Acceptance tests still failing after ${attempt} dev attempt(s)`,
            findings: findings.map((f) => ({ id: f.id, issue: f.issue })),
          });
          await appendEvent(getPrisma(), featureId, {
            type: 'agent.status',
            agent: task.side,
            status: 'waiting',
          });
          return 'parked';
        }
      }
    }
    // ── End acceptance check ───────────────────────────────────────────────────

    // Guard: covered task committed code but test task hasn't written tests yet.
    // Hold in awaiting_tests so the task never counts as completed prematurely and
    // doesn't trigger a branch push or review advance until tests exist.
    if (task.coveredByTestPlan && !task.testsWritten) {
      await getPrisma().task.update({
        where: { id: taskId },
        data: { status: 'awaiting_tests', commitSha },
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: task.side,
        repo: task.repo,
        severity: 'info',
        text: `◦ task ${task.id} awaiting acceptance tests — test agent will trigger re-dispatch`,
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.status',
        agent: task.side,
        repo: task.repo,
        status: 'waiting',
      });
      return 'completed';
    }

    return completeTask(featureId, taskId, task, worktreeInfo, commitSha);
  } catch (err: unknown) {
    // Environmental Bedrock failure mid-run (credential expiry or proxy 503):
    // park without consuming an attempt — same semantics as the pre-probe check.
    if (isEnvironmentalBedrockError(err)) {
      await parkTaskOnBedrockFailure({
        featureId,
        taskId,
        repo: task.repo,
        agentName: task.side,
        retryPath: `POST /features/${featureId}/retry-bounce`,
        attemptRollback: { attemptCount: task.attemptCount },
        attempt,
      });
      return 'parked';
    }

    const isPolicyViolation =
      err instanceof AllowlistViolationError ||
      err instanceof MetacharViolationError ||
      err instanceof AgentNoopError ||
      err instanceof NonProgressError; // orchestrator-side stop; final like other policy violations
    const isCommitStep = err instanceof CommitStepError;
    const isInstall = err instanceof InstallError;
    // PushError: work is committed but push failed — retrying the full agent job
    // won't fix a push; park immediately so the operator can recover manually.
    const isPushError = err instanceof PushError;
    // Fast-fail InstallError (cert/auth/404 — deterministic): park immediately.
    // Slow InstallError (ETIMEDOUT, ECONNRESET — transient): 3 attempts so the
    // npm cache ratchets forward across tries.
    const isFastFailInstall = isInstall && err.message.includes('fast-failed');
    const isFinal =
      (!isCommitStep && !isInstall && !isPushError && attempt >= 2) ||
      (isInstall && !isFastFailInstall && attempt >= 3) ||
      isFastFailInstall ||
      isPolicyViolation ||
      isPushError;
    const reason = err instanceof Error ? err.message : String(err);

    console.error(
      JSON.stringify({
        event: 'dev_job_error',
        featureId,
        taskId,
        side: task.side,
        attempt,
        isFinal,
        error: reason,
      }),
    );

    await appendEvent(getPrisma(), featureId, {
      type: 'task.failed',
      repo: task.repo,
      task_id: task.id,
      reason: reason.slice(0, 300),
      attempt,
      final: isFinal,
    });

    if (isFinal) {
      await getPrisma().task.update({
        where: { id: taskId },
        data: { status: 'parked', parkReason: 'failure' },
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.status',
        agent: task.side,
        repo: task.repo,
        status: 'failed',
      });
      return 'parked';
    } else {
      await getPrisma().task.update({ where: { id: taskId }, data: { status: 'pending' } });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: task.side,
        repo: task.repo,
        severity: 'muted',
        text: `· task ${task.id} attempt ${attempt} failed — BullMQ will retry`,
      });
      throw err;
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
