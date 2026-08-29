import type { ArtifactKind, EventRow } from '@orrery/shared';
import { FILE_TO_KIND } from '@orrery/shared';
import type {
  RunState,
  PhaseId,
  AgentDisplayStatus,
  ChatEntry,
  GateState,
  PlanGateState,
  TestPlanGateState,
  TaskAcceptanceGateState,
  AmendmentGateState,
  SpendGateState,
  TaskFailureEntry,
  PrLink,
  FindingEntry,
  TestReportState,
} from '../types/ui.js';

const EMPTY_STATE: RunState = {
  currentPhase: null,
  agentStatuses: {},
  chatEntries: [],
  gateOpen: null,
  planGateOpen: null,
  testPlanGateOpen: null,
  taskAcceptanceGateOpen: null,
  amendmentGateOpen: null,
  spendGates: [],
  eventLogsByAgent: {},
  usageTotal: { input_tokens: 0, output_tokens: 0 },
  taskFailures: [],
  prLinks: [],
  findings: [],
  testReport: null,
  committedKinds: [],
};

/**
 * Pure reducer: fold an ordered array of EventRows into the complete RunState.
 * Called on every new event — safe to re-run from scratch on reconnect/refresh.
 */
interface TaskSummary {
  side: string;
  status: string;
  coveredByTestPlan: boolean;
  testsWritten: boolean;
}

function deriveAgentStatusesFromTasks(
  tasks: TaskSummary[],
): Partial<Record<string, AgentDisplayStatus>> {
  const derived: Record<string, AgentDisplayStatus> = {};
  for (const agentKey of ['server', 'client'] as const) {
    const relevant = tasks.filter((t) => t.side === agentKey);
    if (relevant.length === 0) continue;
    if (relevant.some((t) => t.status === 'running')) {
      derived[agentKey] = 'working';
    } else if (relevant.some((t) => t.status === 'parked' || t.status === 'amendment_paused')) {
      derived[agentKey] = 'waiting';
    } else if (relevant.every((t) => t.status === 'completed')) {
      derived[agentKey] = 'done';
    } else {
      derived[agentKey] = 'queued';
    }
  }
  const testTasks = tasks.filter((t) => t.coveredByTestPlan);
  if (testTasks.length > 0) {
    if (testTasks.some((t) => t.status === 'running')) {
      derived['test'] = 'working';
    } else if (testTasks.some((t) => t.status === 'parked' || t.status === 'amendment_paused')) {
      derived['test'] = 'waiting';
    } else if (testTasks.every((t) => t.testsWritten || t.status === 'completed')) {
      derived['test'] = 'done';
    } else {
      derived['test'] = 'queued';
    }
  }
  return derived;
}

export function foldEvents(events: EventRow[], tasks?: TaskSummary[]): RunState {
  let currentPhase: PhaseId = null;
  const agentStatuses: Record<string, AgentDisplayStatus> = {};
  const chatEntries: ChatEntry[] = [];
  let gateOpen: GateState | null = null;
  let planGateOpen: PlanGateState | null = null;
  let testPlanGateOpen: TestPlanGateState | null = null;
  let taskAcceptanceGateOpen: TaskAcceptanceGateState | null = null;
  let amendmentGateOpen: AmendmentGateState | null = null;
  let spendGates: SpendGateState[] = [];
  const eventLogsByAgent: Record<
    string,
    {
      type: 'agent.log';
      agent: string;
      severity: 'ok' | 'action' | 'info' | 'muted';
      text: string;
    }[]
  > = {};
  const taskFailures: TaskFailureEntry[] = [];
  const prLinks: PrLink[] = [];
  let findings: FindingEntry[] = [];
  let testReport: TestReportState | null = null;
  const committedKindSet = new Set<ArtifactKind>();
  let inputTokens = 0;
  let outputTokens = 0;

  for (const event of events) {
    const p = event.payload;

    switch (p.type) {
      case 'phase.changed': {
        currentPhase = p.to as PhaseId;
        const orchKey = event.agent ?? 'orchestrator';
        const orchLog = (eventLogsByAgent[orchKey] ??= []);
        orchLog.push({
          type: 'agent.log',
          agent: orchKey,
          severity: 'info',
          text: `◦ phase: ${p.from ?? '—'} → ${p.to}`,
        });
        break;
      }

      case 'agent.status':
        agentStatuses[p.agent] = p.status;
        (eventLogsByAgent[p.agent] ??= []).push({
          type: 'agent.log',
          agent: p.agent,
          severity: 'muted',
          text: `· status → ${p.status}`,
        });
        break;

      case 'agent.log':
        (eventLogsByAgent[p.agent] ??= []).push(p);
        // Insert a dispatch-run separator whenever the orchestrator resets tasks.
        if (
          p.agent === 'orchestrator' &&
          p.text.startsWith('↻ task ') &&
          p.text.includes('reset by redispatch')
        ) {
          taskFailures.push({ isSeparator: true, ts: event.createdAt });
        }
        break;

      case 'chat.message':
        chatEntries.push({
          id: String(event.seq),
          who: p.who as ChatEntry['who'],
          text: p.text,
        });
        break;

      case 'gate.opened':
        if (p.gate === 'plan_approval') {
          planGateOpen = { summary: p.summary, task_count: 0, spec_rev: p.revision };
        } else if (p.gate === 'test_plan_approval') {
          testPlanGateOpen = {
            summary: p.summary,
            task_count: 0,
            spec_rev: p.revision,
            coverage: [],
          };
        } else if (p.gate === 'task_acceptance_gate') {
          const g = p as Record<string, unknown>;
          taskAcceptanceGateOpen = {
            taskId: typeof g['taskId'] === 'string' ? g['taskId'] : '',
            taskTitle: typeof g['taskTitle'] === 'string' ? g['taskTitle'] : '',
            summary: typeof g['summary'] === 'string' ? g['summary'] : '',
            findings: Array.isArray(g['findings'])
              ? (g['findings'] as Array<{ id: string; issue: string }>)
              : [],
          };
        } else if (p.gate === 'spend_guard') {
          const g = p as Record<string, unknown>;
          spendGates = [
            ...spendGates,
            {
              taskId: typeof g['taskId'] === 'string' ? g['taskId'] : '',
              taskTitle: typeof g['taskTitle'] === 'string' ? g['taskTitle'] : '',
              turns: typeof g['turns'] === 'number' ? g['turns'] : 0,
              jobCount: typeof g['jobCount'] === 'number' ? g['jobCount'] : 0,
              threshold: typeof g['threshold'] === 'number' ? g['threshold'] : 150,
              summary: typeof g['summary'] === 'string' ? g['summary'] : '',
            },
          ];
        } else {
          gateOpen = { gate: p.gate, summary: p.summary, revision: p.revision };
        }
        break;

      case 'gate.resolved': {
        const resolvedGate = (p as { gate: string }).gate;
        if (resolvedGate === 'plan_approval') {
          planGateOpen = null;
        } else if (resolvedGate === 'test_plan_approval') {
          testPlanGateOpen = null;
        } else if (resolvedGate === 'task_acceptance_gate') {
          taskAcceptanceGateOpen = null;
        } else if (resolvedGate === 'amendment') {
          amendmentGateOpen = null;
        } else if (resolvedGate === 'spend_guard') {
          const g = p as Record<string, unknown>;
          const resolvedTaskId = typeof g['taskId'] === 'string' ? g['taskId'] : '';
          spendGates = spendGates.filter((sg) => sg.taskId !== resolvedTaskId);
        } else {
          gateOpen = null;
          // Clear findings on cycle exit (not entry) so AWS findings remain visible
          // while the spec-approval gate is open. Next cycle starts from a clean slate.
          if (resolvedGate === 'spec_approval') findings = [];
        }
        break;
      }

      case 'plan.proposed':
        // Enrich planGateOpen with task_count once the planner has completed
        planGateOpen = {
          summary: p.plan_summary,
          task_count: p.task_count,
          spec_rev: p.spec_rev,
        };
        break;

      case 'test_plan.proposed': {
        const tp = p as Record<string, unknown>;
        testPlanGateOpen = {
          summary: typeof tp['plan_summary'] === 'string' ? tp['plan_summary'] : '',
          task_count: typeof tp['task_count'] === 'number' ? tp['task_count'] : 0,
          spec_rev: typeof tp['spec_rev'] === 'number' ? tp['spec_rev'] : 0,
          coverage: Array.isArray(tp['coverage'])
            ? (tp['coverage'] as TestPlanGateState['coverage'])
            : [],
        };
        break;
      }

      case 'task.failed': {
        // Guard defensively — any payload shape must not crash the fold.
        // Missing fields degrade to safe defaults so a malformed event
        // produces a console warning in the error boundary, not a blank UI.
        const tf = p as Record<string, unknown>;
        taskFailures.push({
          isSeparator: false,
          taskId: typeof tf['task_id'] === 'string' ? tf['task_id'] : '(unknown)',
          reason: typeof tf['reason'] === 'string' ? tf['reason'] : '(no reason)',
          attempt: typeof tf['attempt'] === 'number' ? tf['attempt'] : 0,
          final: typeof tf['final'] === 'boolean' ? tf['final'] : false,
          orphaned: typeof tf['orphaned'] === 'boolean' ? tf['orphaned'] : false,
          ts: event.createdAt,
        });
        break;
      }

      case 'usage.recorded':
        inputTokens += p.input_tokens;
        outputTokens += p.output_tokens;
        break;

      case 'contract.amendment.proposed':
        amendmentGateOpen = {
          repo: p.repo,
          rationale: p.rationale,
          proposedContractYaml: p.proposed_contract_yaml,
        };
        break;

      case 'contract.revised':
        // gate.resolved{amendment} already cleared amendmentGateOpen — no extra state needed
        break;

      case 'pr.created':
        prLinks.push({ repo: p.repo, prId: p.pr_id, prUrl: p.pr_url, title: p.title });
        (eventLogsByAgent['orchestrator'] ??= []).push({
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'ok',
          text: `✓ PR #${p.pr_id} opened for ${p.repo}: ${p.pr_url}`,
        });
        break;

      case 'review.started':
        (eventLogsByAgent[p.agent] ??= []).push({
          type: 'agent.log',
          agent: p.agent,
          severity: 'muted',
          text: `· reviewing ${p.repos.join(', ')}`,
        });
        break;

      case 'review.skipped':
        (eventLogsByAgent[p.agent] ??= []).push({
          type: 'agent.log',
          agent: p.agent,
          severity: 'muted',
          text: `· review skipped — ${p.reason}`,
        });
        agentStatuses[p.agent] = 'failed';
        break;

      case 'test.started':
        (eventLogsByAgent[p.agent] ??= []).push({
          type: 'agent.log',
          agent: p.agent,
          severity: 'muted',
          text: `· testing ${p.repos.join(', ')}`,
        });
        break;

      case 'review.findings':
        // Replace findings with the latest review output for this gate cycle.
        // finding.resolved events below mutate resolution state in-place.
        findings = p.findings.map((f) => ({ ...f, resolution: null }));
        break;

      case 'test.report': {
        const testFindings = p.findings.map((f) => ({ ...f, resolution: null }));
        findings = testFindings;
        testReport = {
          passed: p.passed,
          failed: p.failed,
          tests: p.tests ?? [],
          authoredPassed: p.authored_passed,
          authoredFailed: p.authored_failed,
          skipped: p.skipped ?? false,
          skipReason: p.skip_reason ?? null,
          parseError: p.parse_error ?? null,
          findings: testFindings,
        };
        break;
      }

      case 'finding.resolved': {
        const idx = findings.findIndex((f) => f.id === p.finding_id);
        if (idx !== -1) {
          findings = findings.map((f, i) => (i === idx ? { ...f, resolution: p.resolution } : f));
        }
        if (testReport !== null) {
          const prev: TestReportState = testReport;
          const tidx = prev.findings.findIndex((f) => f.id === p.finding_id);
          if (tidx !== -1) {
            testReport = {
              passed: prev.passed,
              failed: prev.failed,
              tests: prev.tests,
              authoredPassed: prev.authoredPassed,
              authoredFailed: prev.authoredFailed,
              skipped: prev.skipped,
              skipReason: prev.skipReason,
              parseError: prev.parseError,
              findings: prev.findings.map((f, i) =>
                i === tidx ? { ...f, resolution: p.resolution } : f,
              ),
            };
          }
        }
        break;
      }

      case 'artifact.committed': {
        const basename = p.path.split('/').at(-1) ?? '';
        const kind = FILE_TO_KIND[basename];
        if (kind !== undefined) committedKindSet.add(kind);
        break;
      }

      // task.started, task.completed — no derived state needed
    }
  }

  // Suppress gate fields whose owning phase is no longer current.
  // Prevents stale gate.opened events (unmatched by gate.resolved) from
  // rendering cards after the state machine has moved on.
  // Gate cards are valid in AWAITING_APPROVAL (spec gate), CODE_REVIEW (review
  // gate), and TESTING (test gate). Suppress in all other phases.
  if (
    currentPhase !== 'AWAITING_APPROVAL' &&
    currentPhase !== 'CODE_REVIEW' &&
    currentPhase !== 'TESTING'
  )
    gateOpen = null;
  if (currentPhase !== 'AWAITING_PLAN_APPROVAL') planGateOpen = null;
  if (currentPhase !== 'AWAITING_TEST_PLAN_APPROVAL') testPlanGateOpen = null;
  if (currentPhase !== 'IMPLEMENTING') taskAcceptanceGateOpen = null;
  if (currentPhase !== 'IMPLEMENTING') amendmentGateOpen = null;
  if (currentPhase !== 'IMPLEMENTING') spendGates = [];

  // Derive authoritative agent statuses from phase + gate state.
  // Prevents stale 'waiting'/'working' from surviving a phase advance or gate close.
  // Runs after gate suppression so anyGateOpen reflects already-corrected gate state.
  const anyGateOpen =
    gateOpen !== null ||
    planGateOpen !== null ||
    testPlanGateOpen !== null ||
    taskAcceptanceGateOpen !== null ||
    amendmentGateOpen !== null ||
    spendGates.length > 0;
  const isTerminal = currentPhase === 'DONE' || currentPhase === 'FAILED';
  const terminalStatus: AgentDisplayStatus = currentPhase === 'FAILED' ? 'failed' : 'done';
  for (const agent of Object.keys(agentStatuses)) {
    const s = agentStatuses[agent];
    if (s === 'working' || s === 'waiting') {
      if (isTerminal) {
        agentStatuses[agent] = terminalStatus;
      } else if (s === 'waiting' && !anyGateOpen) {
        agentStatuses[agent] = 'done';
      }
    }
  }

  // Override dev/test agent statuses from task rows — more reliable than the
  // last agent.status event, which can be left stale on the gate-resolved path (O-14).
  // Exception: don't override an event-sourced 'working' with a task-derived 'done'.
  // The feature-level test job emits agent.status(working) directly and runs after all
  // covered tasks complete — task rows can't see it, so event wins.
  if (tasks && tasks.length > 0) {
    const derived = deriveAgentStatusesFromTasks(tasks);
    for (const [agent, derivedStatus] of Object.entries(derived)) {
      if (agentStatuses[agent] === 'working' && derivedStatus === 'done') continue;
      agentStatuses[agent] = derivedStatus;
    }
    // Re-apply terminal override to any newly merged task-derived statuses.
    if (isTerminal) {
      for (const agent of Object.keys(agentStatuses)) {
        const s = agentStatuses[agent];
        if (s === 'working' || s === 'waiting') agentStatuses[agent] = terminalStatus;
      }
    }
  }

  return {
    currentPhase,
    agentStatuses,
    chatEntries,
    gateOpen,
    planGateOpen,
    testPlanGateOpen,
    taskAcceptanceGateOpen,
    amendmentGateOpen,
    spendGates,
    eventLogsByAgent,
    usageTotal: { input_tokens: inputTokens, output_tokens: outputTokens },
    taskFailures,
    prLinks,
    findings,
    testReport,
    committedKinds: [...committedKindSet],
  };
}

export { EMPTY_STATE };
