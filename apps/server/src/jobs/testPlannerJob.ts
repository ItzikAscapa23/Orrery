import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { commitArtifact, readArtifact, ArtifactCommitError } from '../lib/artifacts.js';
import { gateOpenedCount } from '../lib/reviewCycle.js';
import {
  runTestPlannerAgent,
  type CoverageEntry,
  type TaskSummary,
} from '../agents/testPlannerAgent.js';
import { usageEventPayload, simulatedUsagePayload } from '../lib/usageEvent.js';

// ── Mock coverage for simulated runs ─────────────────────────────────────────

function buildMockCoverage(tasks: TaskSummary[]): CoverageEntry[] {
  return tasks.map((t) => ({
    taskId: t.id,
    covered: true,
    behaviour: `Simulated: verify observable behaviour for task "${t.title}"`,
  }));
}

// ── Markdown builder ──────────────────────────────────────────────────────────

function buildTestPlanMarkdown(
  featureName: string,
  tasks: TaskSummary[],
  coverage: CoverageEntry[],
): string {
  const coverageById = new Map(coverage.map((c) => [c.taskId, c]));
  const lines = [`# Test Coverage Plan: ${featureName}`, ''];
  for (const task of tasks) {
    const c = coverageById.get(task.id);
    if (!c) continue;
    lines.push(`## ${task.title}`);
    lines.push(`**Task ID:** ${task.id}`);
    lines.push(`**Spec refs:** ${task.specRefs.join(', ') || '—'}`);
    if (c.covered) {
      lines.push(`**Coverage:** ✓ Covered`);
      lines.push(`**Behaviour to test:** ${c.behaviour ?? '—'}`);
    } else {
      lines.push(`**Coverage:** ✗ Skipped`);
      lines.push(`**Skip reason:** ${c.skipReason ?? '—'}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ── Job handler ───────────────────────────────────────────────────────────────

export async function runTestPlannerJob(featureId: string, jobId?: string): Promise<void> {
  const feature = await getPrisma().feature.findUniqueOrThrow({ where: { id: featureId } });

  if (feature.status !== 'PLANNING_TESTS') {
    return;
  }

  const specRev = await gateOpenedCount(featureId);

  const tasks = await getPrisma().task.findMany({
    where: { featureId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true, specRefs: true },
  });

  const taskSummaries: TaskSummary[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    specRefs: t.specRefs as string[],
  }));

  const specMarkdown = readArtifact(feature.slug, 'spec.md') ?? '';
  const contractYaml = readArtifact(feature.slug, 'contract.yaml') ?? '';

  try {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'test-planner',
      status: 'working',
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'test-planner',
      severity: 'action',
      text: `▸ planning test coverage — ${taskSummaries.length} task(s)`,
    });

    let coverage: CoverageEntry[];

    if (feature.simulatedRun) {
      coverage = buildMockCoverage(taskSummaries);
      await appendEvent(
        getPrisma(),
        featureId,
        simulatedUsagePayload('test-planner', 'claude-sonnet-5', 300, 200),
      );
    } else {
      const result = await runTestPlannerAgent(
        featureId,
        specMarkdown,
        contractYaml,
        taskSummaries,
        async (usage) => {
          await appendEvent(
            getPrisma(),
            featureId,
            usageEventPayload(usage, 'test-planner', { jobId }),
          );
        },
      );
      coverage = result.coverage;
    }

    const coveredCount = coverage.filter((c) => c.covered).length;
    const skippedCount = coverage.length - coveredCount;

    const testPlanMd = buildTestPlanMarkdown(feature.name, taskSummaries, coverage);
    const planCommit = commitArtifact(feature.slug, 'test-plan.md', testPlanMd, 'test-plan');
    await appendEvent(getPrisma(), featureId, {
      type: 'artifact.committed',
      path: planCommit.path,
      commit: planCommit.commit,
      message: planCommit.message,
    });

    const planSummary = `${coveredCount} covered, ${skippedCount} skipped`;

    await appendEvent(getPrisma(), featureId, {
      type: 'test_plan.proposed' as const,
      agent: 'test-planner' as const,
      spec_rev: specRev,
      plan_summary: planSummary,
      task_count: taskSummaries.length,
      coverage,
    });

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'test-planner',
      severity: 'ok',
      text: `✓ test coverage plan ready — ${planSummary}`,
    });

    const summary = `${feature.name}: ${planSummary}`;
    await getPrisma().$transaction(async (tx) => {
      await appendEvent(tx, featureId, {
        type: 'gate.opened',
        gate: 'test_plan_approval',
        summary: summary.slice(0, 200),
        revision: specRev,
        plan_commit: planCommit.commit,
      });
      const next = await applyTransition(tx, featureId, 'PLANNING_TESTS', 'SUBMIT_TEST_PLAN');
      if (next) {
        await appendEvent(tx, featureId, {
          type: 'phase.changed',
          from: 'PLANNING_TESTS',
          to: next,
        });
      }
    });

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'test-planner',
      status: 'done',
    });
  } catch (err: unknown) {
    if (err instanceof ArtifactCommitError) {
      throw err;
    }

    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'test_planner_job_error', featureId, error: msg }));

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'test-planner',
      status: 'failed',
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'test-planner',
      severity: 'muted',
      text: '· Test planner unavailable — proceeding to test plan approval gate without plan',
    });

    const summary = `${feature.name}: test planning failed`;
    await getPrisma().$transaction(async (tx) => {
      await appendEvent(tx, featureId, {
        type: 'gate.opened',
        gate: 'test_plan_approval',
        summary: summary.slice(0, 200),
        revision: specRev,
      });
      const next = await applyTransition(tx, featureId, 'PLANNING_TESTS', 'SUBMIT_TEST_PLAN');
      if (next) {
        await appendEvent(tx, featureId, {
          type: 'phase.changed',
          from: 'PLANNING_TESTS',
          to: next,
        });
      }
    });
  }
}
