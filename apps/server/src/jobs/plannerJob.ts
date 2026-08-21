import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { commitArtifact, readArtifact, ArtifactCommitError } from '../lib/artifacts.js';
import { gateOpenedCount } from '../lib/reviewCycle.js';
import { runPlannerAgent, type PlanTask } from '../agents/plannerAgent.js';
import { usageEventPayload, simulatedUsagePayload } from '../lib/usageEvent.js';

// ── Mock plan for simulated runs ──────────────────────────────────────────────

function buildMockPlan(
  featureName: string,
  selectedRepos: string[],
): { contract_yaml: string; tasks: PlanTask[] } {
  // Build minimal OpenAPI YAML inline — avoids a js-yaml dependency for a mock.
  const contractYaml = [
    'openapi: "3.0.0"',
    `info:`,
    `  title: "${featureName.replace(/"/g, '\\"')}"`,
    `  version: "1.0.0"`,
    `paths:`,
    `  /simulated-endpoint:`,
    `    get:`,
    `      summary: Simulated endpoint`,
    `      responses:`,
    `        "200":`,
    `          description: OK`,
  ].join('\n');
  const allTasks: PlanTask[] = [
    {
      repo: 'demo-server',
      side: 'server' as const,
      title: 'Implement simulated server endpoint',
      description: 'Add the simulated endpoint to the server.',
      spec_refs: ['API endpoints'],
      depends_on: [],
    },
    {
      repo: 'demo-server-2',
      side: 'server' as const,
      title: 'Implement simulated server-2 endpoint',
      description: 'Add the simulated endpoint to the secondary server repo.',
      spec_refs: ['API endpoints'],
      depends_on: [],
    },
    {
      repo: 'demo-client',
      side: 'client' as const,
      title: 'Implement simulated client screen',
      description: 'Add the simulated screen to the client.',
      spec_refs: ['Screens'],
      depends_on: [],
    },
  ];
  const tasks =
    selectedRepos.length > 0 ? allTasks.filter((t) => selectedRepos.includes(t.repo)) : allTasks;
  return { contract_yaml: contractYaml, tasks };
}

// ── Job handler ───────────────────────────────────────────────────────────────

export async function runPlannerJob(featureId: string, jobId?: string): Promise<void> {
  const feature = await getPrisma().feature.findUniqueOrThrow({ where: { id: featureId } });

  if (feature.status !== 'PLANNING' || !feature.proposedSpec) {
    // Already advanced or spec missing — nothing to do
    return;
  }

  // specRev for gate.opened: count of prior gate.opened events (spec gate and
  // plan gate share this counter — it is NOT the signal for "plan exists").
  const specRev = await gateOpenedCount(featureId);

  // True re-plan signal: a plan.proposed event exists, meaning a plan was
  // already produced and the developer requested changes via the plan gate.
  // specRev > 0 is insufficient because spec-gate revisions also increment it,
  // so a first-time plan after spec changes would falsely enter revision mode.
  const priorPlanEvent = await getPrisma().event.findFirst({
    where: { featureId, type: 'plan.proposed' },
    orderBy: { seq: 'desc' },
  });

  let revisionContext: { priorPlan: string; comment: string } | undefined;
  if (priorPlanEvent && !feature.simulatedRun) {
    const lastPlanRequest = await getPrisma().event.findFirst({
      where: {
        featureId,
        type: 'gate.resolved',
        payload: { path: ['resolution'], equals: 'changes_requested' },
      },
      orderBy: { seq: 'desc' },
    });
    // Guard: only use the event if it came from the plan gate, not the spec gate.
    // Prisma 4.x JSON path filters can only test one field per condition, so
    // the gate check is done in JS after the query.
    const isPlanGateComment =
      lastPlanRequest && (lastPlanRequest.payload as { gate?: string }).gate === 'plan_approval';
    const comment = isPlanGateComment
      ? (lastPlanRequest.payload as { comment?: string }).comment
      : undefined;
    const priorPlan = readArtifact(feature.slug, 'plan.md');
    if (comment && priorPlan) {
      revisionContext = { priorPlan, comment };
    }
  }

  try {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'planner',
      status: 'working',
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'planner',
      severity: 'action',
      text: revisionContext
        ? `▸ revising plan — "${revisionContext.comment.slice(0, 60)}${revisionContext.comment.length > 60 ? '…' : ''}"`
        : '▸ planning feature implementation',
    });

    let contractYaml: string;
    let tasks: PlanTask[];

    if (feature.simulatedRun) {
      // Simulated run: use mock plan, skip model call
      const mock = buildMockPlan(feature.name, feature.repos);
      contractYaml = mock.contract_yaml;
      tasks = mock.tasks;
      // Emit a sample usage record so the event vocabulary is complete
      await appendEvent(
        getPrisma(),
        featureId,
        simulatedUsagePayload('planner', 'claude-sonnet-5', 500, 300),
      );
    } else {
      const result = await runPlannerAgent(
        featureId,
        feature.name,
        feature.proposedSpec,
        async (usage) => {
          await appendEvent(getPrisma(), featureId, usageEventPayload(usage, 'planner', { jobId }));
        },
        revisionContext,
        feature.repos,
      );
      contractYaml = result.contract_yaml;
      tasks = result.tasks;
    }

    // Commit artifacts to the artifacts repo
    const contractCommit = commitArtifact(feature.slug, 'contract.yaml', contractYaml);
    await appendEvent(getPrisma(), featureId, {
      type: 'artifact.committed',
      path: contractCommit.path,
      commit: contractCommit.commit,
      message: contractCommit.message,
    });

    const planMd = buildPlanMarkdown(feature.name, tasks);
    const planCommit = commitArtifact(feature.slug, 'plan.md', planMd);
    await appendEvent(getPrisma(), featureId, {
      type: 'artifact.committed',
      path: planCommit.path,
      commit: planCommit.commit,
      message: planCommit.message,
    });

    const planSummary = `${tasks.length} task(s) across ${new Set(tasks.map((t) => t.repo)).size} repo(s)`;

    await appendEvent(getPrisma(), featureId, {
      type: 'plan.proposed',
      agent: 'planner',
      spec_rev: specRev,
      plan_summary: planSummary,
      task_count: tasks.length,
      tasks: tasks.map((t) => ({
        repo: t.repo,
        side: t.side,
        title: t.title,
        description: t.description,
        spec_refs: t.spec_refs,
        depends_on: t.depends_on,
      })),
    });

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'planner',
      severity: 'ok',
      text: `✓ plan ready — ${planSummary}`,
    });

    // Atomic: gate.opened + SUBMIT_PLAN transition + phase.changed
    const summary = `${feature.name}: ${planSummary}`;
    await getPrisma().$transaction(async (tx) => {
      await appendEvent(tx, featureId, {
        type: 'gate.opened',
        gate: 'plan_approval',
        summary: summary.slice(0, 200),
        revision: specRev,
        plan_commit: planCommit.commit,
        contract_commit: contractCommit.commit,
      });
      const next = await applyTransition(tx, featureId, 'PLANNING', 'SUBMIT_PLAN');
      if (next) {
        await appendEvent(tx, featureId, {
          type: 'phase.changed',
          from: 'PLANNING',
          to: next,
        });
      }
    });

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'planner',
      status: 'done',
    });
  } catch (err: unknown) {
    // ArtifactCommitError: the plan was generated but could not be persisted to the
    // artifacts repo (git failure). Opening the plan gate with uncommitted artifacts
    // violates its premise — the operator must approve what is stored.
    // Re-throw so BullMQ parks this job; the operator can fix the repo and redispatch.
    if (err instanceof ArtifactCommitError) {
      throw err;
    }

    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'planner_job_error', featureId, error: msg }));

    await appendEvent(getPrisma(), featureId, {
      type: 'agent.status',
      agent: 'planner',
      status: 'failed',
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'planner',
      severity: 'muted',
      text: '· Planner unavailable — proceeding to plan approval gate without plan',
    });

    // Never brick the feature — advance to AWAITING_PLAN_APPROVAL without artifacts
    // (model/API failures: Bedrock timeout, parse error, rate limit, etc.)
    const summary = `${feature.name}: planning failed`;
    await getPrisma().$transaction(async (tx) => {
      await appendEvent(tx, featureId, {
        type: 'gate.opened',
        gate: 'plan_approval',
        summary: summary.slice(0, 200),
        revision: specRev,
      });
      const next = await applyTransition(tx, featureId, 'PLANNING', 'SUBMIT_PLAN');
      if (next) {
        await appendEvent(tx, featureId, {
          type: 'phase.changed',
          from: 'PLANNING',
          to: next,
        });
      }
    });
  }
}

function buildPlanMarkdown(featureName: string, tasks: PlanTask[]): string {
  const lines = [`# Implementation Plan: ${featureName}`, ''];
  for (const task of tasks) {
    lines.push(`## [${task.repo}] ${task.title}`);
    lines.push(`**Side:** ${task.side}`);
    lines.push(`**Description:** ${task.description}`);
    if (task.spec_refs.length > 0) lines.push(`**Spec refs:** ${task.spec_refs.join(', ')}`);
    if (task.depends_on.length > 0) lines.push(`**Depends on:** ${task.depends_on.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}
