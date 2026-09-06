import { execFileSync } from 'node:child_process';
import { EXEC_MAX_BUFFER } from '../lib/container.js';
import { checkBedrockWithRetry } from '../lib/connectivity.js';
import { parkFeatureAgentOnBedrockFailure } from '../lib/bedrockPark.js';
import path from 'node:path';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { dispatchForState } from '../lib/dispatch.js';
import { readArtifact } from '../lib/artifacts.js';
import { gateOpenedCount, getReviewRound } from '../lib/reviewCycle.js';
import { runReviewAgent } from '../agents/reviewAgent.js';
import { getRepoEntry } from './devJob.js';
import { createSyntheticFixTasks } from '../lib/syntheticTasks.js';
import { persistFindings } from '../lib/persistFindings.js';
import { usageEventPayload } from '../lib/usageEvent.js';

const DIFF_BUDGET_BYTES = 60 * 1024; // 60 KB total across all repos
const DIFF_MIN_PER_REPO = 4 * 1024; // 4 KB floor per repo

function getDiff(worktreePath: string, defaultBranch: string, featureBranch: string): string {
  try {
    return execFileSync(
      'git',
      ['-C', worktreePath, 'diff', `${defaultBranch}...${featureBranch}`],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );
  } catch (err) {
    return `[diff unavailable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

export async function runReviewJob(featureId: string, jobId?: string): Promise<void> {
  const feature = await getPrisma().feature.findUniqueOrThrow({
    where: { id: featureId },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      simulatedRun: true,
      featurePath: true,
      currentBranches: true,
    },
  });
  const isLight = feature.featurePath === 'LIGHT';

  if (feature.status !== 'CODE_REVIEW') {
    // Already advanced or wrong state — nothing to do
    return;
  }

  // Pre-flight: park rather than skip the gate on Bedrock credential failure.
  // 3 probes ~30s apart so a transient blip does not force operator intervention.
  if (!(await checkBedrockWithRetry(2, 15_000))) {
    await parkFeatureAgentOnBedrockFailure({
      featureId,
      agentName: 'review',
      retryPath: `POST /features/${featureId}/retry-review`,
    });
    return;
  }

  const currentBranches = (feature.currentBranches as Record<string, string>) ?? {};
  const repos = Object.keys(currentBranches);

  await appendEvent(getPrisma(), featureId, {
    type: 'review.started',
    agent: 'review',
    repos,
  });
  await appendEvent(getPrisma(), featureId, {
    type: 'agent.status',
    agent: 'review',
    status: 'working',
  });

  const priorReviewRounds = await getReviewRound(featureId);
  const specRev = (await gateOpenedCount(featureId)) - 1;
  const worktreesRoot = process.env['WORKTREES_ROOT'] ?? '/tmp/orrery-worktrees';
  const simulatedRun = feature.simulatedRun;

  try {
    // ── Diff acquisition ────────────────────────────────────────────────────
    const perRepoBudget =
      repos.length > 0
        ? Math.max(DIFF_MIN_PER_REPO, Math.floor(DIFF_BUDGET_BYTES / repos.length))
        : DIFF_BUDGET_BYTES;

    const diffSections: string[] = [];
    for (const repoId of repos) {
      const featureBranch = currentBranches[repoId]!;
      let repoDefaultBranch = 'main';
      try {
        const entry = getRepoEntry(repoId);
        repoDefaultBranch = entry.default_branch;
      } catch (err) {
        console.error(
          JSON.stringify({
            event: 'review_job_manifest_miss',
            featureId,
            repoId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }

      const worktreePath = path.join(worktreesRoot, `${feature.slug}-${repoId}-work`);
      let diff = getDiff(worktreePath, repoDefaultBranch, featureBranch);

      if (Buffer.byteLength(diff, 'utf-8') > perRepoBudget) {
        const truncated = Buffer.from(diff, 'utf-8').subarray(0, perRepoBudget).toString('utf-8');
        diff =
          truncated +
          `\n[... diff truncated at ${perRepoBudget} bytes — no findings emitted for this repo ...]`;
      }

      diffSections.push(`## Diff: ${repoId}\n${diff}`);
    }

    if (repos.length === 0) {
      console.error(
        JSON.stringify({
          event: 'review_job_no_branches',
          featureId,
          warning: 'currentBranches is empty — no diffs to review',
        }),
      );
    }

    // ── Prompt assembly ─────────────────────────────────────────────────────
    const specContent = readArtifact(feature.slug, 'spec.md') ?? '(spec not found)';

    // Light features have no contract.yaml — omit it to prevent the review agent
    // from fabricating CONFORMANCE findings against a non-existent contract.
    const contractSection = isLight
      ? []
      : [
          '---',
          '# Contract',
          readArtifact(feature.slug, 'contract.yaml') ?? '(contract not found)',
        ];

    // ── Prior findings (round ≥ 1 only) ─────────────────────────────────────
    // Read before persistFindings overwrites them. specRev is stable between
    // review rounds (only spec_approval/plan_approval gates advance it), so
    // round 1 findings sit at (featureId, specRev) until persistFindings in
    // this round replaces them.
    const priorFindings =
      priorReviewRounds >= 1
        ? await getPrisma().finding.findMany({
            where: { featureId, specRev },
            select: { id: true, severity: true, section: true, issue: true },
          })
        : [];

    const priorFindingsSection =
      priorFindings.length > 0
        ? [
            '---',
            '# Prior round findings',
            'For each finding below, report its status in the `prior_finding_statuses` array: ' +
              '`{ id, status: "fixed"|"still_present"|"withdrawn", reason }`.',
            ...priorFindings.map(
              (f) =>
                `## Finding ${f.id} (${f.severity})\n- Section: ${f.section}\n- Issue: ${f.issue}`,
            ),
          ]
        : [];

    const userPrompt = [
      '# Spec',
      specContent,
      ...contractSection,
      ...priorFindingsSection,
      '---',
      '# Diffs',
      ...diffSections,
    ].join('\n\n');

    // ── API call ────────────────────────────────────────────────────────────
    const { findings, priorFindingStatuses } = await runReviewAgent(
      featureId,
      userPrompt,
      async (usage) => {
        await appendEvent(getPrisma(), featureId, usageEventPayload(usage, 'review', { jobId }));
      },
    );

    // ── Persist findings to DB (required for accept/dismiss routes) ─────────
    // persistFindings: deletes orphans from prior rounds, upserts current ones,
    // and emits a muted log event for any cleared operator resolution (C-1/C-2).
    await persistFindings(featureId, specRev, findings, 'review');

    const blockers = findings.filter((f) => f.severity === 'blocker').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;

    await appendEvent(getPrisma(), featureId, {
      type: 'review.findings',
      agent: 'review',
      spec_rev: specRev,
      findings,
    });

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'review',
      severity: 'ok',
      text: `✓ review complete — ${findings.length} finding(s) (${blockers} blockers, ${warnings} warnings)`,
    });

    if (priorFindingStatuses.length > 0) {
      const lines = priorFindingStatuses
        .map((s) => `  ${s.id}: ${s.status}${s.reason ? ` — ${s.reason.slice(0, 120)}` : ''}`)
        .join('\n');
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'review',
        severity: 'muted',
        text: `◦ prior findings:\n${lines}`,
      });
    }

    // ── Round/gate logic ────────────────────────────────────────────────────
    if (blockers === 0) {
      // No blockers at any round → REVIEW_PASS (or REVIEW_PASS_LIGHT for light features)
      const passEvent = isLight ? ('REVIEW_PASS_LIGHT' as const) : ('REVIEW_PASS' as const);
      let nextState: import('@prisma/client').FeatureStatus | null = null;
      await getPrisma().$transaction(async (tx) => {
        const next = await applyTransition(tx, featureId, 'CODE_REVIEW', passEvent);
        if (next) {
          nextState = next;
          await appendEvent(tx, featureId, {
            type: 'phase.changed',
            from: 'CODE_REVIEW',
            to: next,
          });
        }
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.status',
        agent: 'review',
        status: 'done',
      });
      if (nextState) {
        await dispatchForState(featureId, nextState, {
          simulated_run: simulatedRun,
        });
      }
    } else if (priorReviewRounds >= 1) {
      // Round cap: second entry with blockers → open human gate
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'review',
        severity: 'action',
        text: '· round cap reached — escalating to human gate',
      });
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, {
          type: 'gate.opened',
          gate: 'code_review',
          summary: `${blockers} unresolved blocker(s) after revision round — human review required`,
          revision: specRev,
          counts: { blockers, warnings, suggestions: 0 },
        }),
      );
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.status',
        agent: 'review',
        status: 'waiting',
      });
    } else {
      // Round 0 with blockers → REVIEW_FAIL + bounce-back
      const failEvent = isLight ? ('REVIEW_FAIL_LIGHT' as const) : ('REVIEW_FAIL' as const);
      const bounceState = isLight ? ('LIGHT_IMPLEMENTING' as const) : ('IMPLEMENTING' as const);
      await getPrisma().$transaction(async (tx) => {
        const next = await applyTransition(tx, featureId, 'CODE_REVIEW', failEvent);
        if (next) {
          await appendEvent(tx, featureId, {
            type: 'phase.changed',
            from: 'CODE_REVIEW',
            to: next,
          });
        }
      });
      if (isLight) {
        // Light bounce-back: no synthetic tasks — dispatch light-dev jobs directly
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'info',
          text: `↻ light bounce-back: ${blockers} blocker(s) — re-dispatching light dev jobs`,
        });
      } else {
        // Full bounce-back: create synthetic fix tasks so dispatchUnblockedTasks has rows
        const created = await createSyntheticFixTasks(featureId, findings, repos);
        await appendEvent(getPrisma(), featureId, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'info',
          text: `↻ bounce-back: ${blockers} blocker(s) — dispatching synthetic fix task(s) (${created.map((c) => c.repo).join(', ')})`,
        });
      }
      await dispatchForState(featureId, bounceState, { simulated_run: feature.simulatedRun });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.status',
        agent: 'review',
        status: 'done',
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'review_job_error', featureId, error: msg }));

    const isBedrock403 = msg.includes('403') || msg.includes('security token');

    if (isBedrock403) {
      // Credential failure: park in CODE_REVIEW so retry-review remains valid
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.status',
        agent: 'review',
        status: 'failed',
      });
      await appendEvent(getPrisma(), featureId, {
        type: 'agent.log',
        agent: 'review',
        severity: 'muted',
        text: `· Bedrock 403 — STS token expired. Run: aws sso login --profile ai-devtools-dev. Then POST /features/${featureId}/retry-review`,
      });
      return;
    }

    // Non-credential error: fail-open — never brick the feature on a broken review agent
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'review',
      status: 'failed',
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'review',
      severity: 'muted',
      text: '· review unavailable — gate skipped',
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'review.skipped',
      agent: 'review',
      reason: msg.slice(0, 200),
    });

    await getPrisma().feature.update({
      where: { id: featureId },
      data: { reviewSkipped: true },
    });

    await getPrisma().$transaction(async (tx) => {
      const fallbackEvent = isLight ? ('REVIEW_PASS_LIGHT' as const) : ('REVIEW_PASS' as const);
      const next = await applyTransition(tx, featureId, 'CODE_REVIEW', fallbackEvent);
      if (next) {
        await appendEvent(tx, featureId, { type: 'phase.changed', from: 'CODE_REVIEW', to: next });
      }
    });
  }
}
