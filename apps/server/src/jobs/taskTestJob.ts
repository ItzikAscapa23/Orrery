import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { checkSpendGuard } from '../lib/spendGuard.js';
import { readArtifact, commitArtifact } from '../lib/artifacts.js';
import { startContainer, MetacharViolationError, EXEC_MAX_BUFFER } from '../lib/container.js';
import { dispatchUnblockedTasks } from '../lib/dispatch.js';
import { checkBedrockWithRetry } from '../lib/connectivity.js';
import { parkTaskOnBedrockFailure, isEnvironmentalBedrockError } from '../lib/bedrockPark.js';
import { NonProgressError } from '../lib/nonProgressError.js';
import { readClaudeMdFromDefaultBranch, getRepoEntry, routeInstall } from './devJob.js';
import { createWorktree } from '../lib/worktree.js';
import {
  discoverTestDir,
  getAuthoredTestFilesForTask,
  getExistingTestFilesWithDescribes,
  isSharedInfraPath,
  SCRATCH_FILE_RE,
} from './testJob.js';
import {
  runTestAgent,
  TestViolationInfo,
  TestAllowlistViolationError,
  measurePromptSections as measureTestPromptSections,
} from '../agents/testAgent.js';
import type { ToolCallInfo } from '../agents/devAgent.js';
import { usageEventPayload } from '../lib/usageEvent.js';
import { scopeSpecByRefs, scopeContract } from '../lib/promptScope.js';
import {
  loadHarnessBrief,
  HARNESS_BRIEF_WRITE_INSTRUCTION,
  injectHarnessBriefHashes,
} from '../lib/harnessbrief.js';

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

export async function runTaskTestJob(
  featureId: string,
  taskId: string,
  jobId: string,
  side: 'server' | 'client',
): Promise<void> {
  const [task, feature] = await Promise.all([
    getPrisma().task.findUnique({ where: { id: taskId } }),
    getPrisma().feature.findUniqueOrThrow({
      where: { id: featureId },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        simulatedRun: true,
      },
    }),
  ]);

  if (!task) {
    console.error(JSON.stringify({ event: 'task_test_job_task_not_found', featureId, taskId }));
    return;
  }

  if (!task.coveredByTestPlan || task.testsWritten) {
    // Not covered or already written — nothing to do.
    return;
  }

  if (feature.status !== 'IMPLEMENTING') {
    return;
  }

  const sg = await checkSpendGuard(featureId, taskId, task.title);
  if (sg.parked) return;
  const spendGuardRemainingBudget = sg.remainingBudget;

  await getPrisma().task.update({
    where: { id: taskId },
    data: { status: 'running', testTaskAttempts: { increment: 1 } },
  });

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.status',
    agent: 'test',
    status: 'working',
  });
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'test',
    severity: 'action',
    text: `▸ writing acceptance tests for task: ${task.title}`,
  });

  if (!(await checkBedrockWithRetry(2, 15_000))) {
    // Environmental failure after 3 probes (~30s). Roll back testTaskAttempts so the
    // next dispatch re-routes to the test-task job rather than skipping to dev.
    // Set parked (not pending) so the stale bullJobId is cleared and the row is
    // visible to gate handling and the retry-bounce path.
    await parkTaskOnBedrockFailure({
      featureId,
      taskId,
      repo: task.repo,
      agentName: 'test',
      retryPath: `POST /features/${featureId}/retry-bounce`,
      attemptRollback: { testTaskAttempts: { decrement: 1 } },
      attempt: task.testTaskAttempts + 1,
    });
    return;
  }

  const rawSpec = readArtifact(feature.slug, 'spec.md') ?? '(spec not found)';
  const rawContract = readArtifact(feature.slug, 'contract.yaml') ?? '(contract not found)';
  const specRefs = task.specRefs as string[];
  const specContent = scopeSpecByRefs(rawSpec, specRefs);
  const contractContent = scopeContract(rawContract, {
    side,
    refs: specRefs,
    taskDescription: '',
    onFallback: () => {},
  });

  let repoEntry;
  try {
    repoEntry = getRepoEntry(task.repo);
  } catch {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'test',
      severity: 'muted',
      text: `· repo '${task.repo}' not in manifest — task-test agent cannot run`,
    });
    await getPrisma().task.update({ where: { id: taskId }, data: { status: 'pending' } });
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

  const imageTag = process.env['AGENT_CONTAINER_IMAGE'] ?? 'node:20-alpine';
  const _installStrategy = process.env['INSTALL_STRATEGY'] ?? 'host';
  const cafile = process.env['NODE_EXTRA_CA_CERTS'] ?? '';
  const installTimeoutMs = repoEntry.install_timeout_ms ?? 300_000;
  const execTimeoutMs = repoEntry.exec_timeout_ms ?? 120_000;
  const TEST_AGENT_DEFAULT_MAX_TURNS = 30; // mirrors testAgent.ts MAX_TURNS
  const effectiveCap = Math.max(
    1,
    Math.min(repoEntry.max_turns ?? TEST_AGENT_DEFAULT_MAX_TURNS, spendGuardRemainingBudget),
  );

  let repoClaudeMd: string;
  try {
    repoClaudeMd = readClaudeMdFromDefaultBranch(worktreePath, repoEntry.default_branch);
  } catch {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      repo: task.repo,
      severity: 'muted',
      text: `◦ CLAUDE.md not found on ${repoEntry.default_branch}:CLAUDE.md — using stub`,
    });
    repoClaudeMd = `# ${task.repo}\n## Commands\nnpm test\n`;
  }

  const { dir: testDir, method: testDirMethod } = discoverTestDir(worktreePath);
  if (testDirMethod === 'fallback') {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      repo: task.repo,
      severity: 'info',
      text: `⚠ discoverTestDir: no test files found — falling back to '__tests__'. Verify the repo has a test directory.`,
    });
  }

  const harnessBrief = await loadHarnessBrief(feature.slug, worktreePath, featureId);
  const isFirstTestTask = harnessBrief === null;

  const testSections = measureTestPromptSections({
    specMarkdown: specContent,
    contractYaml: contractContent,
    repoClaudeMd,
    testDir,
    ...(repoEntry.description ? { repoDescription: repoEntry.description } : {}),
  });
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'test',
    severity: 'muted',
    text: `◦ task-test prompt size: ${testSections.total} chars`,
  });

  try {
    await routeInstall(repoEntry, worktreePath, imageTag, cafile, installTimeoutMs);
  } catch (installErr) {
    const msg = installErr instanceof Error ? installErr.message : String(installErr);
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'test',
      severity: 'muted',
      text: `· task-test install failed: ${msg.slice(0, 200)}`,
    });
    await getPrisma().task.update({ where: { id: taskId }, data: { status: 'pending' } });
    return;
  }

  const container = startContainer(
    worktreePath,
    taskId,
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
    void appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: '◦ probe skipped — test agent writes only to the test directory; a broken tree does not block test authoring',
    });
    // Inject the task title into the test agent context. The test agent must NOT
    // read implementation source files — it writes tests from the spec only.
    let taskContext =
      `\n\n## This run: write acceptance tests for one task only\n` +
      `Task title: ${task.title}\n` +
      `Spec references: ${specRefs.join(', ') || '(none)'}\n` +
      `Do NOT read implementation source files. Write tests from the spec and contract only.`;

    if (isFirstTestTask) {
      taskContext += HARNESS_BRIEF_WRITE_INSTRUCTION;
    } else {
      const strippedBrief = harnessBrief.replace(/<!--[\s\S]*?-->\n?/, '').trim();
      taskContext +=
        `\n\n## Test Harness Brief\n${strippedBrief}\n` +
        `Do not re-read the files listed above — this brief already captures what you need.`;
    }

    taskContext +=
      `\n\n## Iterating on test files\n` +
      `If you need to update a test file you have already written in this session, ` +
      `read its current contents first and make targeted edits with write_file rather ` +
      `than writing the whole file from scratch. Rewriting from scratch loses the ` +
      `red→green iteration context and spends turns on unchanged boilerplate.`;

    const existingTestFiles = getExistingTestFilesWithDescribes(worktreePath, testDir);
    const taskSharedInfraChanges: string[] = [];
    await runTestAgent(
      featureId,
      {
        specMarkdown: specContent + taskContext,
        contractYaml: contractContent,
        repoClaudeMd,
        testDir,
        ...(repoEntry.description ? { repoDescription: repoEntry.description } : {}),
        maxTurns: effectiveCap,
        ...(existingTestFiles.length > 0 ? { existingTestFiles } : {}),
      },
      container,
      worktreePath,
      async (usage) => {
        await appendEvent(
          getPrisma(),
          featureId,
          usageEventPayload(usage, 'test', { jobId, taskId }),
        );
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
          if (info.resolvedCommand) {
            text += `\n  ∟ resolved: ${info.resolvedCommand}`;
            if (info.reportPath) text += ` @ ${info.reportPath}`;
          }
        } else if (info.toolName === 'write_file') {
          text = `◦ turn ${info.turn} · write_file ${info.path} (${info.contentLength} chars content)`;
        } else {
          text = `◦ turn ${info.turn} · ${info.toolName} (${info.resultSize} chars)`;
        }
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'test',
          severity: 'muted',
          text,
        });
        // Detect edits to shared test infrastructure (e.g. __mocks__ directories).
        if (
          (info.toolName === 'write_file' || info.toolName === 'edit_file') &&
          info.path !== undefined &&
          isSharedInfraPath(info.path)
        ) {
          taskSharedInfraChanges.push(info.path);
          await appendEvent(getPrisma(), featureId, {
            type: 'test.shared_infra_changed',
            path: info.path,
            tool: info.toolName,
          });
          void appendEvent(getPrisma(), featureId, {
            type: 'agent.log',
            agent: 'test',
            severity: 'action',
            text: `⚠ test agent modified shared infrastructure: ${info.path}`,
          });
        }
      },
    );

    // Harness brief: capture if agent produced it, then remove before the test commit so it
    // stays out of the feature branch and is stored only in the artifacts repo.
    const briefFilePath = path.join(worktreePath, '__orrery_harness_brief.md');
    if (fs.existsSync(briefFilePath)) {
      const rawBrief = fs.readFileSync(briefFilePath, 'utf-8');
      const briefContent = injectHarnessBriefHashes(worktreePath, rawBrief);
      commitArtifact(feature.slug, 'test-harness-brief.md', briefContent, 'test-harness-brief');
      fs.unlinkSync(briefFilePath);
      void appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'muted',
        text: '◦ harness brief committed as artifact',
      });
    } else if (isFirstTestTask) {
      void appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'muted',
        text: '◦ agent did not write harness brief — next task will try again',
      });
    }

    // Commit any new test files.
    // Red suite is expected — do NOT check exit code here.
    const statusOut = git(worktreePath, 'status', '--porcelain').trim();
    if (statusOut !== '') {
      git(worktreePath, 'add', '-A');

      const LOCKFILE_NAMES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
      const rawStaged = git(worktreePath, 'diff', '--cached', '--name-only')
        .trim()
        .split('\n')
        .filter(Boolean);
      const lockfilesStaged = rawStaged.filter((f) =>
        LOCKFILE_NAMES.some((n) => f === n || f.endsWith('/' + n)),
      );
      if (lockfilesStaged.length > 0) {
        git(worktreePath, 'reset', 'HEAD', '--', ...lockfilesStaged);
        void appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'muted',
          text: `◦ unstaged ${lockfilesStaged.length} lockfile(s) from agent commit: ${lockfilesStaged.join(', ')}`,
        });
      }

      const BRIEF_NAME = '__orrery_harness_brief.md';
      const scratchOrBriefStaged = rawStaged.filter(
        (f) => path.basename(f) === BRIEF_NAME || SCRATCH_FILE_RE.test(path.basename(f)),
      );
      if (scratchOrBriefStaged.length > 0) {
        git(worktreePath, 'reset', 'HEAD', '--', ...scratchOrBriefStaged);
        void appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'muted',
          text: `◦ unstaged ${scratchOrBriefStaged.length} scratch/brief file(s) from agent commit: ${scratchOrBriefStaged.join(', ')}`,
        });
      }

      const commitMessage = [
        `test: acceptance tests for task ${taskId}`,
        '',
        `X-Orrery-Agent: test`,
        `X-Orrery-Task: ${taskId}`,
      ].join('\n');
      gitCommit(worktreePath, commitMessage);
    }

    // Find what was committed.
    const authoredFiles = getAuthoredTestFilesForTask(worktreePath, testDir, taskId);

    if (authoredFiles.length === 0) {
      // Agent ran but committed no test files — park so the operator can REDISPATCH.
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'test',
        severity: 'muted',
        text: `· task-test agent wrote no files for task ${taskId} — parking (use REDISPATCH to retry)`,
      });
      await getPrisma().task.update({
        where: { id: taskId },
        data: { status: 'parked', parkReason: 'no_tests_authored', bullJobId: null },
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'task.failed',
        repo: task.repo,
        task_id: taskId,
        reason: 'test agent wrote no acceptance test files',
        attempt: task.testTaskAttempts + 1,
        final: false,
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.status',
        agent: 'test',
        status: 'failed',
      });
      return;
    }

    await appendEvent(getPrisma(), featureId, {
      type: 'task.tests_written',
      task_id: taskId,
      files: authoredFiles,
    });

    await getPrisma().task.update({
      where: { id: taskId },
      data: { testsWritten: true, status: 'pending', bullJobId: null },
    });

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'test',
      severity: 'ok',
      text: `✓ acceptance tests written for task ${taskId} (${authoredFiles.length} file(s)) — suite may be red until implementation`,
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'test',
      status: 'done',
    });

    // Re-dispatch so the dev job picks up this task now that testsWritten = true.
    await dispatchUnblockedTasks(featureId, side);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'task_test_job_error', featureId, taskId, error: msg }));

    const isViolation =
      err instanceof TestAllowlistViolationError || err instanceof MetacharViolationError;
    const isNonProgress = err instanceof NonProgressError;
    // Credential expiry or Bedrock outage during the agent run — same canonical
    // handler as the pre-agent probe, with attempt rollback so the retry goes
    // back through the test-task path instead of skipping to dev.
    const isBedrockError = isEnvironmentalBedrockError(err);

    if (isBedrockError) {
      await parkTaskOnBedrockFailure({
        featureId,
        taskId,
        repo: task.repo,
        agentName: 'test',
        retryPath: `POST /features/${featureId}/retry-bounce`,
        attemptRollback: { testTaskAttempts: { decrement: 1 } },
        attempt: task.testTaskAttempts + 1,
      });
      return;
    }

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'test',
      severity: 'muted',
      text: `· task-test agent error: ${msg.slice(0, 200)}`,
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'test',
      status: 'failed',
    });

    if (isViolation) {
      // Park — violations leave testsWritten unset so the task stays in the
      // test-first path on REDISPATCH; the dev job does not run untested code.
      await getPrisma().task.update({
        where: { id: taskId },
        data: { status: 'parked', parkReason: 'allowlist_violation', bullJobId: null },
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'task.failed',
        repo: task.repo,
        task_id: taskId,
        reason: msg.slice(0, 300),
        attempt: task.testTaskAttempts + 1,
        final: false,
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'test',
        severity: 'muted',
        text: `· test agent parked (allowlist violation) — use REDISPATCH to retry`,
      });
    } else if (isNonProgress) {
      // Orchestrator-side stop — not agent misconduct. Park so the operator can
      // inspect the repeated command, then REDISPATCH once the loop cause is known.
      await getPrisma().task.update({
        where: { id: taskId },
        data: { status: 'parked', parkReason: 'non_progress', bullJobId: null },
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'task.failed',
        repo: task.repo,
        task_id: taskId,
        reason: msg.slice(0, 300),
        attempt: task.testTaskAttempts + 1,
        final: false,
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'test',
        severity: 'muted',
        text: `· test agent parked (non-progress: repeated command) — use REDISPATCH to retry`,
      });
    } else {
      const refreshed = await getPrisma().task.findUniqueOrThrow({ where: { id: taskId } });
      if (refreshed.testTaskAttempts >= 1) {
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'test',
          severity: 'muted',
          text: `· task-test agent failed after ${refreshed.testTaskAttempts} attempt(s) — parked (use REDISPATCH to retry)`,
        });
        await getPrisma().task.update({
          where: { id: taskId },
          data: { status: 'parked', parkReason: 'test_agent_failed', bullJobId: null },
        });
        await appendEvent(getPrisma(), featureId, {
          type: 'task.failed',
          repo: task.repo,
          task_id: taskId,
          reason: msg.slice(0, 300),
          attempt: refreshed.testTaskAttempts,
          final: false,
        });
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'test',
          severity: 'muted',
          text: `· test agent parked after failure — use REDISPATCH to retry`,
        });
      } else {
        await getPrisma().task.update({ where: { id: taskId }, data: { status: 'pending' } });
      }
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
