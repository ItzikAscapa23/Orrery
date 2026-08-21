import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { dispatchJob } from '../lib/dispatch.js';
import { commitSpecDraft } from '../lib/artifacts.js';
import { gateOpenedCount } from '../lib/reviewCycle.js';
import { persistFindings } from '../lib/persistFindings.js';
import type { FeatureStatus } from '@prisma/client';
import { simulatedUsagePayload } from '../lib/usageEvent.js';

// Mutable so tests can set _delayMs.min = _delayMs.max = 0 to skip waits.
export const _delayMs: { min: number; max: number } = { min: 1000, max: 3000 };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(): number {
  return _delayMs.min + Math.floor(Math.random() * (_delayMs.max - _delayMs.min));
}

// ── Per-phase simulation steps ────────────────────────────────────────────────

type SimPhase = Exclude<
  FeatureStatus,
  | 'DRAFTING_SPEC'
  | 'AWAITING_APPROVAL'
  | 'AWAITING_PLAN_APPROVAL'
  | 'PLANNING_TESTS'
  | 'AWAITING_TEST_PLAN_APPROVAL'
  | 'LIGHT_IMPLEMENTING' // simulator does not walk the light path
  | 'FAILED'
>;

const PHASE_AGENTS: Record<SimPhase, string> = {
  AWS_REVIEW: 'aws',
  PLANNING: 'orchestrator',
  IMPLEMENTING: 'server',
  CODE_REVIEW: 'review',
  TESTING: 'test',
  DONE: 'orchestrator',
};

const PHASE_LOGS: Record<SimPhase, string[]> = {
  AWS_REVIEW: [
    'Reviewing AWS architecture requirements',
    'Checking IAM policy implications',
    'Architecture review complete',
  ],
  PLANNING: [
    'Decomposing feature into sub-tasks',
    'Estimating complexity',
    'Plan ready for implementation',
  ],
  IMPLEMENTING: [
    'Setting up module scaffold',
    'Implementing core logic',
    'Writing unit tests',
    'Implementation complete',
  ],
  CODE_REVIEW: [
    'Checking code style and coverage',
    'Reviewing error handling',
    'Code review passed',
  ],
  TESTING: ['Running unit test suite', 'Running integration tests', 'All tests green'],
  DONE: ['Feature delivered successfully'],
};

async function emitPhaseActivity(featureId: string, phase: SimPhase): Promise<void> {
  const agent = PHASE_AGENTS[phase];
  const logs = PHASE_LOGS[phase];

  await getPrisma().$transaction((tx) =>
    appendEvent(tx, featureId, { type: 'agent.status', agent, status: 'working' }),
  );

  for (const text of logs.slice(0, -1)) {
    await delay(jitter());
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, { type: 'agent.log', agent, severity: 'action', text }),
    );
  }

  await delay(jitter());
  const lastLog = logs[logs.length - 1]!;
  await getPrisma().$transaction((tx) =>
    appendEvent(tx, featureId, { type: 'agent.log', agent, severity: 'ok', text: lastLog }),
  );

  if (phase !== 'DONE') {
    await getPrisma().$transaction((tx) =>
      appendEvent(
        tx,
        featureId,
        simulatedUsagePayload(
          agent,
          'claude-sonnet-5',
          800 + Math.floor(Math.random() * 400),
          200 + Math.floor(Math.random() * 200),
        ),
      ),
    );
  }

  await getPrisma().$transaction((tx) =>
    appendEvent(tx, featureId, { type: 'agent.status', agent, status: 'done' }),
  );
}

async function advanceState(
  featureId: string,
  currentStatus: FeatureStatus,
  event: Parameters<typeof applyTransition>[3],
): Promise<FeatureStatus | null> {
  return getPrisma().$transaction(async (tx) => {
    const next = await applyTransition(tx, featureId, currentStatus, event);
    if (next) {
      await appendEvent(tx, featureId, { type: 'phase.changed', from: currentStatus, to: next });
    }
    return next;
  });
}

// ── Job handlers ──────────────────────────────────────────────────────────────

export async function runSimulate(featureId: string): Promise<void> {
  const feature = await getPrisma().feature.findUniqueOrThrow({ where: { id: featureId } });
  let status = feature.status;

  if (status === 'DRAFTING_SPEC') {
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'info',
        text: 'Simulator starting — walking to spec approval gate',
      }),
    );

    // Simulate SUBMIT_SPEC → AWS_REVIEW transition
    const specSummary =
      'Simulated spec: feature fully defined with user stories and acceptance criteria';
    await getPrisma().$transaction(async (tx) => {
      await tx.feature.update({ where: { id: featureId }, data: { proposedSpec: specSummary } });
      const afterSubmit = await applyTransition(tx, featureId, status, 'SUBMIT_SPEC');
      if (afterSubmit) {
        await appendEvent(tx, featureId, { type: 'phase.changed', from: status, to: afterSubmit });
        status = afterSubmit;
      }
    });

    // Simulate AWS review with a mock warning finding
    const specRev = await gateOpenedCount(featureId);
    const mockFinding = {
      id: 'sim-f1',
      severity: 'warning' as const,
      section: 'API endpoints',
      issue: 'Simulated: verify endpoint authentication follows bank IAM policy.',
      suggested_text: 'All API endpoints must use Cognito JWT authorisation via API Gateway.',
    };

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'aws',
      status: 'working',
    });
    await delay(jitter());
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'aws',
      severity: 'action',
      text: '▸ reviewing spec against charter',
    });
    await delay(jitter());
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'aws',
      severity: 'ok',
      text: '✓ review complete — 1 finding(s) (0 blockers, 1 warnings)',
    });

    // Persist mock finding row (ignore duplicate on re-run)
    await getPrisma().finding.upsert({
      where: {
        featureId_specRev_id: {
          featureId,
          specRev,
          id: mockFinding.id,
        },
      },
      create: {
        id: mockFinding.id,
        featureId,
        specRev,
        severity: mockFinding.severity,
        section: mockFinding.section,
        issue: mockFinding.issue,
        suggestedText: mockFinding.suggested_text,
      },
      update: {},
    });

    await appendEvent(
      getPrisma(),
      featureId,
      simulatedUsagePayload(
        'aws',
        'claude-sonnet-5',
        600 + Math.floor(Math.random() * 300),
        150 + Math.floor(Math.random() * 100),
      ),
    );
    await appendEvent(getPrisma(), featureId, {
      type: 'review.findings',
      agent: 'aws',
      spec_rev: specRev,
      findings: [mockFinding],
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'aws',
      status: 'done',
    });

    // Commit a placeholder spec.md so the artifact viewer works for simulated
    // features. Guard: if ARTIFACTS_REPO_PATH is not set, skip silently.
    let simSpecCommit: string | undefined;
    if (process.env['ARTIFACTS_REPO_PATH']) {
      try {
        const specContent =
          `# ${feature.name}\n\n` +
          `**Requirement**: ${feature.requirement}\n\n` +
          `*Simulated spec — not generated by the Spec Agent.*\n`;
        const simCommitResult = commitSpecDraft(feature.slug, specContent, specRev);
        await appendEvent(getPrisma(), featureId, {
          type: 'artifact.committed',
          path: simCommitResult.path,
          commit: simCommitResult.commit,
          message: simCommitResult.message,
        });
        simSpecCommit = simCommitResult.commit;
      } catch (err) {
        console.error(
          JSON.stringify({
            event: 'sim_spec_commit_failed',
            featureId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    const next = await getPrisma().$transaction(async (tx) => {
      await appendEvent(tx, featureId, {
        type: 'gate.opened',
        gate: 'spec_approval',
        summary: specSummary.slice(0, 200),
        revision: specRev,
        counts: { blockers: 0, warnings: 1, suggestions: 0 },
        spec_commit: simSpecCommit,
      });
      const afterDone = await applyTransition(tx, featureId, 'AWS_REVIEW', 'AWS_DONE');
      if (afterDone) {
        await appendEvent(tx, featureId, {
          type: 'phase.changed',
          from: 'AWS_REVIEW',
          to: afterDone,
        });
        return afterDone;
      }
      return null;
    });

    if (next) status = next;
  }

  if (status === 'AWAITING_APPROVAL') {
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'info',
        text: 'Simulator paused at spec approval gate — call POST /approve to continue',
      }),
    );
  }
}

export async function runSimulateResume(featureId: string): Promise<void> {
  const feature = await getPrisma().feature.findUniqueOrThrow({ where: { id: featureId } });
  let status = feature.status;

  await getPrisma().$transaction((tx) =>
    appendEvent(tx, featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'info',
      text: 'Simulator resuming after approval — walking to DONE',
    }),
  );

  // PLANNING: the plannerJob runs inline (simulatedRun=true → mock plan, no model call)
  // and transitions to AWAITING_PLAN_APPROVAL automatically.
  if (status === 'PLANNING') {
    const { runPlannerJob } = await import('./plannerJob.js');
    await runPlannerJob(featureId);
    const updated = await getPrisma().feature.findUniqueOrThrow({ where: { id: featureId } });
    status = updated.status;
  }

  if (status === 'AWAITING_PLAN_APPROVAL') {
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'info',
        text: 'Simulator paused at plan gate — call POST /approve-plan to continue',
      }),
    );
    return; // pause; resume triggered by POST /approve-plan → simulate-resume re-enqueued
  }

  // PLANNING_TESTS: the testPlannerJob runs inline (simulatedRun=true → mock coverage, no model call)
  // and transitions to AWAITING_TEST_PLAN_APPROVAL automatically.
  if (status === 'PLANNING_TESTS') {
    const { runTestPlannerJob } = await import('./testPlannerJob.js');
    await runTestPlannerJob(featureId);
    const updated = await getPrisma().feature.findUniqueOrThrow({ where: { id: featureId } });
    status = updated.status;
  }

  if (status === 'AWAITING_TEST_PLAN_APPROVAL') {
    // Auto-approve: mark all tasks covered so the feature advances automatically.
    const tasks = await getPrisma().task.findMany({
      where: { featureId },
      select: { id: true },
    });
    if (tasks.length > 0) {
      await getPrisma().task.updateMany({
        where: { featureId, id: { in: tasks.map((t) => t.id) } },
        data: { coveredByTestPlan: true },
      });
    }
    const next = await advanceState(featureId, status, 'APPROVE_TEST_PLAN');
    if (next) {
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, {
          type: 'gate.resolved',
          gate: 'test_plan_approval',
          resolution: 'approved',
        }),
      );
      status = next;
    }
  }

  if (status === 'IMPLEMENTING') {
    // already past the test plan gate (third resume after approve-test-plan)
  }

  if (false as boolean) {
    // dead branch: replaced by plannerJob-based flow above
    await emitPhaseActivity(featureId, 'PLANNING');
  }

  if (status === 'IMPLEMENTING') {
    // Server-dev activity (existing)
    await emitPhaseActivity(featureId, 'IMPLEMENTING');
    // Client-dev activity — T-4a-1: emit client agent vocabulary so the
    // simulator covers both sides, matching the mock plan's two tasks.
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, { type: 'agent.status', agent: 'client', status: 'working' }),
    );
    await delay(jitter());
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'agent.log',
        agent: 'client',
        severity: 'action',
        text: '▸ implementing simulated client screen',
      }),
    );
    await delay(jitter());
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'agent.log',
        agent: 'client',
        severity: 'ok',
        text: '✓ client task complete',
      }),
    );
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, { type: 'agent.status', agent: 'client', status: 'done' }),
    );
    const next = await advanceState(featureId, status, 'SUBMIT_REVIEW');
    if (next) status = next;
  }

  if (status === 'CODE_REVIEW') {
    // Re-read feature for simulatorReviewPath and round count.
    const feat = await getPrisma().feature.findUniqueOrThrow({
      where: { id: featureId },
      select: { simulatorReviewPath: true },
    });
    const reviewPath = feat.simulatorReviewPath ?? 'forced-fix';

    // Count prior review.findings events to determine round (0 = first entry,
    // 1 = second entry after bounce-back). Must filter to agent='review' only —
    // runSimulate emits a review.findings event with agent='aws' for the spec
    // review, which would otherwise be counted here and skip round 0 entirely.
    const priorReviewRounds = await getPrisma().event.count({
      where: {
        featureId,
        type: 'review.findings',
        payload: { path: ['agent'], equals: 'review' },
      },
    });

    const simFinding = {
      id: 'sim-rf1',
      severity: 'blocker' as const,
      repo: 'sim-server',
      section: 'POST /api/features (contract)',
      issue: 'Simulated: endpoint response shape missing required `id` field.',
    };

    // ── Emit review.started ────────────────────────────────────────────────
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'review.started',
        agent: 'review',
        repos: ['sim-server', 'sim-client'],
      }),
    );
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, { type: 'agent.status', agent: 'review', status: 'working' }),
    );
    await delay(jitter());
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'agent.log',
        agent: 'review',
        severity: 'action',
        text: '▸ reviewing diff against spec and contract',
      }),
    );
    await delay(jitter());

    if (priorReviewRounds === 0) {
      // ── Round 0: seeded blocker finding ────────────────────────────────
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, {
          type: 'review.findings',
          agent: 'review',
          spec_rev: 0,
          findings: [simFinding],
        }),
      );
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, {
          type: 'agent.log',
          agent: 'review',
          severity: 'action',
          text: '· 1 blocker found — triggering bounce-back revision round',
        }),
      );
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, { type: 'agent.status', agent: 'review', status: 'done' }),
      );
      await getPrisma().$transaction((tx) =>
        appendEvent(
          tx,
          featureId,
          simulatedUsagePayload(
            'review',
            'claude-sonnet-5',
            900 + Math.floor(Math.random() * 300),
            250 + Math.floor(Math.random() * 150),
          ),
        ),
      );

      // REVIEW_FAIL → IMPLEMENTING
      const next = await advanceState(featureId, status, 'REVIEW_FAIL');
      if (next) status = next;

      // Bounce-back: orchestrator log with scope-fenced ## Required fixes block
      const fixBlock =
        '## Required fixes (Review Agent findings)\n' +
        '- sim-rf1 [blocker] POST /api/features (contract): ' +
        'endpoint response shape missing required `id` field.\n\n' +
        'Address only the findings listed above. Do not refactor unrelated code, ' +
        'rename identifiers, or expand scope beyond the listed items. ' +
        'The standard commit guardrail applies: the orchestrator will only commit ' +
        'if tests pass in the worktree; no changes → task parked.';

      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'info',
          text: '↻ bounce-back: 1 synthetic fix task dispatched to sim-server',
        }),
      );
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'action',
          text: fixBlock,
        }),
      );

      // Simulate dev agent fixing it
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, { type: 'agent.status', agent: 'server', status: 'working' }),
      );
      await delay(jitter());
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, {
          type: 'agent.log',
          agent: 'server',
          severity: 'action',
          text:
            reviewPath === 'forced-fix'
              ? '▸ adding `id` field to response schema'
              : '▸ attempting fix for `id` field',
        }),
      );
      await delay(jitter());
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, {
          type: 'agent.log',
          agent: 'server',
          severity: 'ok',
          text: reviewPath === 'forced-fix' ? '✓ fix applied — tests pass' : '✓ task complete',
        }),
      );
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, { type: 'agent.status', agent: 'server', status: 'done' }),
      );

      // IMPLEMENTING → CODE_REVIEW (re-entry via SUBMIT_REVIEW)
      if (status === 'IMPLEMENTING') {
        const nextAfterFix = await advanceState(featureId, status, 'SUBMIT_REVIEW');
        if (nextAfterFix) status = nextAfterFix;
      }

      // Explicitly dispatch a new simulate-resume for the second CODE_REVIEW
      // entry. We cannot fall through in the same invocation because the round
      // count is only reliably determined at the start of each invocation.
      if (status === 'CODE_REVIEW') {
        await dispatchJob(featureId, 'simulate-resume');
      }
      return;
    }

    if (priorReviewRounds >= 1) {
      // ── Round 1 handling ────────────────────────────────────────────────
      if (reviewPath === 'forced-fix') {
        // Pass: no blockers
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, {
            type: 'agent.log',
            agent: 'review',
            severity: 'ok',
            text: '✓ re-review: 0 blockers — diff conforms to spec and contract',
          }),
        );
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, {
            type: 'review.findings',
            agent: 'review',
            spec_rev: 0,
            findings: [],
          }),
        );
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, { type: 'agent.status', agent: 'review', status: 'done' }),
        );
        await getPrisma().$transaction((tx) =>
          appendEvent(
            tx,
            featureId,
            simulatedUsagePayload(
              'review',
              'claude-sonnet-5',
              700 + Math.floor(Math.random() * 200),
              150 + Math.floor(Math.random() * 100),
            ),
          ),
        );
        const next = await advanceState(featureId, status, 'REVIEW_PASS');
        if (next) status = next;
      } else {
        // Gate path: blocker still present after bounce-back → human gate
        const staleFinding = {
          ...simFinding,
          issue: 'Simulated: `id` field still absent from response — fix incomplete.',
        };
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, {
            type: 'agent.log',
            agent: 'review',
            severity: 'action',
            text: '▸ re-reviewing diff after bounce-back round',
          }),
        );
        await delay(jitter());
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, {
            type: 'review.findings',
            agent: 'review',
            spec_rev: 0,
            findings: [staleFinding],
          }),
        );
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, {
            type: 'agent.log',
            agent: 'review',
            severity: 'action',
            text: '· round cap reached — escalating to human gate',
          }),
        );
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, { type: 'agent.status', agent: 'review', status: 'waiting' }),
        );
        await getPrisma().$transaction((tx) =>
          appendEvent(
            tx,
            featureId,
            simulatedUsagePayload(
              'review',
              'claude-sonnet-5',
              700 + Math.floor(Math.random() * 200),
              150 + Math.floor(Math.random() * 100),
            ),
          ),
        );

        // Persist the sim finding so the dismiss route can resolve it.
        // specRev must be dynamic — by this point plannerJob has already
        // emitted gate.opened(plan_approval), so the clock is ≥ 1.
        const codeReviewSpecRev = (await gateOpenedCount(featureId)) - 1;
        await persistFindings(featureId, codeReviewSpecRev, [staleFinding], 'simulator');

        // Open the human gate — simulator pauses here
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, {
            type: 'gate.opened',
            gate: 'code_review',
            summary: '1 unresolved blocker after revision round — human review required',
            revision: codeReviewSpecRev,
            counts: { blockers: 1, warnings: 0, suggestions: 0 },
          }),
        );
        // Gate path ends here. T4 (approve-review route) handles the resolution.
        return;
      }
    }
  }

  if (status === 'TESTING') {
    // Re-read feature for simulatorReviewPath (same column reused for test path).
    const testFeat = await getPrisma().feature.findUniqueOrThrow({
      where: { id: featureId },
      select: { simulatorReviewPath: true },
    });
    const testPath = testFeat.simulatorReviewPath ?? 'forced-fix';

    // Count prior test.report events to determine round (0 = first TESTING entry,
    // 1 = second entry after TEST_FAIL bounce-back).
    const priorTestRounds = await getPrisma().event.count({
      where: {
        featureId,
        type: 'test.report',
        payload: { path: ['agent'], equals: 'test' },
      },
    });

    const simTestFinding = {
      id: 'sim-tf1',
      severity: 'blocker' as const,
      test_name: 'sim-test-1',
      section: 'POST /api/features',
      issue: 'Simulated: status code was 500, expected 201.',
    };

    // ── Emit test.started ──────────────────────────────────────────────────
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'test.started',
        agent: 'test',
        repos: ['sim-server'],
      }),
    );
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, { type: 'agent.status', agent: 'test', status: 'working' }),
    );
    await delay(jitter());
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'agent.log',
        agent: 'test',
        severity: 'action',
        text:
          priorTestRounds === 0
            ? '▸ running acceptance tests against feature branch'
            : testPath === 'forced-fix'
              ? '▸ re-running tests after fix'
              : '▸ re-running tests — checking if failure persists',
      }),
    );
    await delay(jitter());

    if (priorTestRounds === 0) {
      // ── Round 0: seeded failure ────────────────────────────────────────
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, {
          type: 'test.report',
          agent: 'test',
          spec_rev: 0,
          passed: 0,
          failed: 1,
          findings: [simTestFinding],
        }),
      );
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, {
          type: 'agent.log',
          agent: 'test',
          severity: 'action',
          text: '· 1 failure — triggering bounce-back revision round',
        }),
      );
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, { type: 'agent.status', agent: 'test', status: 'done' }),
      );
      await getPrisma().$transaction((tx) =>
        appendEvent(
          tx,
          featureId,
          simulatedUsagePayload(
            'test',
            'claude-sonnet-5',
            600 + Math.floor(Math.random() * 200),
            180 + Math.floor(Math.random() * 100),
          ),
        ),
      );

      // TEST_FAIL → IMPLEMENTING
      const next = await advanceState(featureId, status, 'TEST_FAIL');
      if (next) status = next;

      // Bounce-back: orchestrator log
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'info',
          text: '↻ bounce-back: 1 synthetic fix task dispatched to sim-server',
        }),
      );
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'action',
          text:
            '## Required fixes (Test Agent findings)\n' +
            '- sim-tf1 [blocker] POST /api/features: status code was 500, expected 201.\n\n' +
            'Address only the findings listed above.',
        }),
      );

      // Simulate dev agent fixing the test failure
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, { type: 'agent.status', agent: 'server', status: 'working' }),
      );
      await delay(jitter());
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, {
          type: 'agent.log',
          agent: 'server',
          severity: 'ok',
          text:
            testPath === 'forced-fix'
              ? '✓ fix applied — handler now returns 201'
              : '✓ task complete',
        }),
      );
      await getPrisma().$transaction((tx) =>
        appendEvent(tx, featureId, { type: 'agent.status', agent: 'server', status: 'done' }),
      );

      // IMPLEMENTING → CODE_REVIEW (re-entry); CODE_REVIEW auto-passes on round ≥ 1.
      if (status === 'IMPLEMENTING') {
        const nextAfterFix = await advanceState(featureId, status, 'SUBMIT_REVIEW');
        if (nextAfterFix) status = nextAfterFix;
      }

      // Dispatch a fresh simulate-resume to handle CODE_REVIEW → TESTING (round 1).
      if (status === 'CODE_REVIEW') {
        await dispatchJob(featureId, 'simulate-resume');
      }
      return;
    }

    if (priorTestRounds >= 1) {
      // ── Round 1 handling ──────────────────────────────────────────────
      if (testPath === 'forced-fix') {
        // Pass: 0 failures
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, {
            type: 'agent.log',
            agent: 'test',
            severity: 'ok',
            text: '✓ re-run: 0 failures — all acceptance tests pass',
          }),
        );
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, {
            type: 'test.report',
            agent: 'test',
            spec_rev: 0,
            passed: 1,
            failed: 0,
            findings: [],
          }),
        );
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, { type: 'agent.status', agent: 'test', status: 'done' }),
        );
        await getPrisma().$transaction((tx) =>
          appendEvent(
            tx,
            featureId,
            simulatedUsagePayload(
              'test',
              'claude-sonnet-5',
              500 + Math.floor(Math.random() * 150),
              120 + Math.floor(Math.random() * 80),
            ),
          ),
        );
        const next = await advanceState(featureId, status, 'TEST_PASS');
        if (next) status = next;
      } else {
        // Gate path: failure persists → human gate
        const staleFinding = {
          ...simTestFinding,
          issue: 'Simulated: status code still 500 — fix incomplete.',
        };
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, {
            type: 'agent.log',
            agent: 'test',
            severity: 'action',
            text: '· failure persists after fix — escalating to human gate',
          }),
        );
        await delay(jitter());
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, {
            type: 'test.report',
            agent: 'test',
            spec_rev: 0,
            passed: 0,
            failed: 1,
            findings: [staleFinding],
          }),
        );
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, { type: 'agent.status', agent: 'test', status: 'waiting' }),
        );
        await getPrisma().$transaction((tx) =>
          appendEvent(
            tx,
            featureId,
            simulatedUsagePayload(
              'test',
              'claude-sonnet-5',
              500 + Math.floor(Math.random() * 150),
              120 + Math.floor(Math.random() * 80),
            ),
          ),
        );

        // Persist the sim finding so the dismiss route can resolve it.
        const testSpecRev = (await gateOpenedCount(featureId)) - 1;
        await persistFindings(featureId, testSpecRev, [staleFinding], 'simulator');

        // Open the human gate — simulator pauses here.
        await getPrisma().$transaction((tx) =>
          appendEvent(tx, featureId, {
            type: 'gate.opened',
            gate: 'test_report',
            summary: '1 test failure after revision round — human review required',
            revision: testSpecRev,
            counts: { blockers: 1, warnings: 0, suggestions: 0 },
          }),
        );
        // Gate path ends here. retry-test / approve-review route handles resolution.
        return;
      }
    }
  }

  if (status === 'DONE') {
    await emitPhaseActivity(featureId, 'DONE');
  }
}
