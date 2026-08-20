/**
 * Light-path dev job: dispatched for LIGHT_IMPLEMENTING features.
 *
 * Unlike devJob, there is no Task row, no contract.yaml, no test runner.
 * Context: spec + repo orientation. Commit guard: syntax probe by file type.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { createWorktree } from '../lib/worktree.js';
import { generateRepoOrientation } from '../lib/repoOrientation.js';
import { runLightDevAgent } from '../agents/devAgent.js';
import {
  getAnyRepoEntry,
  readClaudeMdFromDefaultBranch,
  gitCommit,
  CommitStepError,
  pushBranch,
} from './devJob.js';
import { EXEC_MAX_BUFFER } from '../lib/container.js';
import { maybeAdvanceLightToReview } from '../lib/maybeAdvance.js';
import { usageEventPayload } from '../lib/usageEvent.js';
import { checkBedrockConnectivity } from '../lib/connectivity.js';

function git(worktreePath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: EXEC_MAX_BUFFER,
  });
}

function buildLightSystemPrompt(
  repoDescription: string,
  repoClaudeMd: string,
  orientationBlock: string | undefined,
  specMarkdown: string,
): string {
  return [
    `You are a senior software engineer making a configuration or contract change in ${repoDescription || 'a configuration repository'}.`,
    '',
    '## Repository conventions (CLAUDE.md)',
    repoClaudeMd,
    ...(orientationBlock ? ['', orientationBlock] : []),
    '',
    '## Specification',
    specMarkdown,
    '',
    '## Your task',
    'Apply the configuration or contract change described in the specification above.',
    'Use write_file or edit_file to modify the relevant files.',
    'When your changes are complete, call end_turn.',
    '',
    '## Rules',
    '- Implement only what the specification describes. Do not introduce unrelated changes.',
    '- You have three tools: write_file, edit_file, read_file.',
    '  Use read_file to inspect existing files before editing.',
    '  Use edit_file to change part of an existing file.',
    '  Use write_file only for new files or complete rewrites.',
    '- Never run any commands — this is a configuration-only change.',
    '- When done, call end_turn.',
  ].join('\n');
}

/**
 * Probe a file by extension and throw CommitStepError if it is malformed.
 * Returns the probe type that ran, or 'none' if no probe applies.
 */
export function probeSyntax(
  filePath: string,
  content: string,
): 'yaml' | 'env-json' | 'env-kv' | 'none' {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();

  if (ext === '.yml' || ext === '.yaml') {
    try {
      yaml.load(content);
    } catch (err) {
      throw new CommitStepError(
        `YAML syntax error in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return 'yaml';
  }

  if (base === '.env' || base.startsWith('.env.') || ext === '.env') {
    const firstChar = content.trimStart()[0];
    if (firstChar === '{' || firstChar === '[') {
      try {
        JSON.parse(content);
      } catch (err) {
        throw new CommitStepError(
          `Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return 'env-json';
    }
    const lines = content.split('\n');
    for (const [i, line] of lines.entries()) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      if (!/^[A-Z_][A-Z0-9_]*=.*/i.test(trimmed)) {
        throw new CommitStepError(
          `Invalid .env format in ${filePath} at line ${i + 1}: "${trimmed}". ` +
            `Expected KEY=value format.`,
        );
      }
    }
    return 'env-kv';
  }

  return 'none';
}

export async function runLightDevJob(
  featureId: string,
  repoId: string,
  bullJobId: string,
): Promise<void> {
  const feature = await getPrisma().feature.findUniqueOrThrow({
    where: { id: featureId },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      proposedSpec: true,
      featurePath: true,
    },
  });

  if (feature.status !== 'LIGHT_IMPLEMENTING') {
    console.error(
      JSON.stringify({
        event: 'light_dev_job_wrong_state',
        featureId,
        repoId,
        status: feature.status,
      }),
    );
    return;
  }

  if (!feature.proposedSpec) {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'server',
      repo: repoId,
      severity: 'muted',
      text: '· no spec found — light dev job skipped',
    });
    return;
  }

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.status',
    agent: 'server',
    status: 'working',
  });

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'server',
    repo: repoId,
    severity: 'action',
    text: `▸ light dev job started for ${repoId}`,
  });

  // Connectivity probe (same pattern as devJob — fail fast before worktree setup)
  const connectivityOk = await checkBedrockConnectivity();
  if (!connectivityOk) {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'server',
      status: 'failed',
    });
    return;
  }

  const repoEntry = getAnyRepoEntry(repoId);
  const maxTurns = repoEntry.max_turns;

  let worktreeInfo;
  try {
    worktreeInfo = createWorktree(repoEntry.url, feature.slug, repoEntry.default_branch, repoId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ event: 'light_dev_worktree_error', featureId, repoId, error: msg }),
    );
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'server',
      status: 'failed',
    });
    throw err;
  }

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'muted',
    text: `◦ worktree ready at ${worktreeInfo.worktreePath} (branch ${worktreeInfo.branch})`,
  });

  // Record the branch for the review job
  await getPrisma().feature.update({
    where: { id: featureId },
    data: {
      currentBranches: {
        ...((
          await getPrisma().feature.findUniqueOrThrow({
            where: { id: featureId },
            select: { currentBranches: true },
          })
        ).currentBranches as Record<string, string>),
        [repoId]: worktreeInfo.branch,
      },
    },
  });

  const repoClaudeMd = await (async () => {
    try {
      return readClaudeMdFromDefaultBranch(worktreeInfo.worktreePath, repoEntry.default_branch);
    } catch {
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        repo: repoId,
        severity: 'muted',
        text: `◦ CLAUDE.md not found on ${repoEntry.default_branch}:CLAUDE.md — using stub`,
      });
      return '(CLAUDE.md not found)';
    }
  })();

  const orientationBlock = (() => {
    try {
      return generateRepoOrientation(worktreeInfo.worktreePath);
    } catch {
      return undefined;
    }
  })();

  const systemPrompt = buildLightSystemPrompt(
    repoEntry.description ?? repoId,
    repoClaudeMd,
    orientationBlock,
    feature.proposedSpec,
  );

  const initialMessage = `Apply the configuration change described in the specification. Use write_file or edit_file on the relevant files, then call end_turn.`;

  try {
    await runLightDevAgent(
      featureId,
      systemPrompt,
      initialMessage,
      worktreeInfo.worktreePath,
      async (usage) => {
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, usageEventPayload(usage, 'server', { jobId: bullJobId })),
        );
      },
      async (info) => {
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'server',
          repo: repoId,
          severity: 'muted',
          text: `◦ ${info.toolName}${info.path ? ` ${info.path}` : ''}`,
        });
      },
      maxTurns,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ event: 'light_dev_agent_error', featureId, repoId, error: msg }),
    );
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'server',
      repo: repoId,
      severity: 'muted',
      text: `· agent error: ${msg.slice(0, 200)}`,
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'server',
      status: 'failed',
    });
    throw err;
  }

  // ── Syntax probe commit guard ─────────────────────────────────────────────

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'info',
    text: '◦ running syntax probe before commit',
  });

  const statusOut = git(worktreeInfo.worktreePath, 'status', '--porcelain').trim();

  if (statusOut === '') {
    // No changes: treat as success (the spec may have already been applied)
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'ok',
      text: '✓ no file changes — treating as no-op success',
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'light_dev.completed',
      repo_id: repoId,
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'server',
      status: 'done',
    });
    const next = await maybeAdvanceLightToReview(featureId);
    if (next) {
      const { dispatchForState } = await import('../lib/dispatch.js');
      const feat = await getPrisma().feature.findUniqueOrThrow({
        where: { id: featureId },
        select: { simulatedRun: true },
      });
      await dispatchForState(featureId, next, { simulated_run: feat.simulatedRun });
    }
    return;
  }

  git(worktreeInfo.worktreePath, 'add', '-A');

  let stagedLines = git(worktreeInfo.worktreePath, 'diff', '--cached', '--name-only')
    .trim()
    .split('\n')
    .filter(Boolean);

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'muted',
    text:
      `◦ staged ${stagedLines.length} file(s): ${stagedLines.slice(0, 20).join(', ')}` +
      (stagedLines.length > 20 ? ` … (+${stagedLines.length - 20} more)` : ''),
  });

  // Syntax probe per staged file
  try {
    for (const relPath of stagedLines) {
      const absPath = path.join(worktreeInfo.worktreePath, relPath);
      if (!fs.existsSync(absPath)) continue; // deleted file — no probe needed
      const content = fs.readFileSync(absPath, 'utf-8');
      const probeType = probeSyntax(relPath, content);
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'muted',
        text: `◦ probe(${probeType}) ${relPath} — ok`,
      });
    }
  } catch (err) {
    git(worktreeInfo.worktreePath, 'reset', 'HEAD');
    const msg = err instanceof Error ? err.message : String(err);
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: `· syntax probe failed — retrying with agent: ${msg.slice(0, 200)}`,
    });

    // ── One-round retry: feed error back to agent so it can fix the file ─────
    try {
      await runLightDevAgent(
        featureId,
        systemPrompt,
        `The syntax probe rejected a file you wrote. Fix the issue and call end_turn when done.\n\nProbe error: ${msg}\n\nYour working-tree changes are still present. Read the affected file, correct the content, rewrite it, then call end_turn.`,
        worktreeInfo.worktreePath,
        async (usage) => {
          await getPrisma().$transaction((tx) =>
            appendEvent(tx, featureId, usageEventPayload(usage, 'server', { jobId: bullJobId })),
          );
        },
        async (info) => {
          await appendEvent(getPrisma(), featureId, {
            type: 'agent.log',
            agent: 'server',
            repo: repoId,
            severity: 'muted',
            text: `◦ retry:${info.toolName}${info.path ? ` ${info.path}` : ''}`,
          });
        },
        maxTurns,
      );
    } catch (agentErr) {
      const agentMsg = agentErr instanceof Error ? agentErr.message : String(agentErr);
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'server',
        repo: repoId,
        severity: 'muted',
        text: `· retry agent error: ${agentMsg.slice(0, 200)}`,
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.status',
        agent: 'server',
        status: 'failed',
      });
      throw agentErr;
    }

    // Re-stage and re-probe after retry (second failure = park)
    git(worktreeInfo.worktreePath, 'add', '-A');
    stagedLines = git(worktreeInfo.worktreePath, 'diff', '--cached', '--name-only')
      .trim()
      .split('\n')
      .filter(Boolean);

    try {
      for (const relPath of stagedLines) {
        const absPath = path.join(worktreeInfo.worktreePath, relPath);
        if (!fs.existsSync(absPath)) continue;
        const content = fs.readFileSync(absPath, 'utf-8');
        const probeType = probeSyntax(relPath, content);
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'muted',
          text: `◦ probe(${probeType}) ${relPath} — ok`,
        });
      }
    } catch (retryErr) {
      git(worktreeInfo.worktreePath, 'reset', 'HEAD');
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'muted',
        text: `· syntax probe failed after retry — commit aborted: ${retryMsg.slice(0, 200)}`,
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.status',
        agent: 'server',
        status: 'failed',
      });
      throw retryErr;
    }
  }

  gitCommit(worktreeInfo.worktreePath, `feat(light): ${feature.name} — ${repoId}`);
  const commitSha = git(worktreeInfo.worktreePath, 'rev-parse', 'HEAD').trim();

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'ok',
    text: `✓ committed ${commitSha.slice(0, 8)} — ${stagedLines.length} file(s)`,
  });

  pushBranch(worktreeInfo.worktreePath, worktreeInfo.branch);
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'ok',
    text: `✓ branch ${worktreeInfo.branch} pushed to ${repoId}`,
  });

  await appendEvent(getPrisma(), featureId, {
    type: 'light_dev.completed',
    repo_id: repoId,
    commit_sha: commitSha,
  });

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.status',
    agent: 'server',
    status: 'done',
  });

  const next = await maybeAdvanceLightToReview(featureId);
  if (next) {
    const { dispatchForState } = await import('../lib/dispatch.js');
    const feat = await getPrisma().feature.findUniqueOrThrow({
      where: { id: featureId },
      select: { simulatedRun: true },
    });
    await dispatchForState(featureId, next, { simulated_run: feat.simulatedRun });
  }
}
