import type { AgentId, AgentLogPayload, ArtifactKind, Finding, TestRow } from '@orrery/shared';

/** Machine states from the backend FeatureStatus enum */
export type PhaseId =
  | 'DRAFTING_SPEC'
  | 'AWS_REVIEW'
  | 'AWAITING_APPROVAL'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'PLANNING_TESTS'
  | 'AWAITING_TEST_PLAN_APPROVAL'
  | 'IMPLEMENTING'
  | 'LIGHT_IMPLEMENTING'
  | 'CODE_REVIEW'
  | 'TESTING'
  | 'DONE'
  | 'FAILED'
  | null; // null = no feature selected / initial

/** Per-agent display status derived from agent.status events */
export type AgentDisplayStatus = 'queued' | 'working' | 'waiting' | 'done' | 'failed';

/** A single entry in the mission-control chat */
export interface ChatEntry {
  id: string; // seq-based unique id
  who: 'dev' | 'spec' | 'system' | AgentId;
  text: string;
}

/** A gate that is currently open */
export interface GateState {
  gate: string;
  summary: string;
  revision: number;
}

/** Plan gate state derived from plan.proposed event */
export interface PlanGateState {
  summary: string;
  task_count: number;
  spec_rev: number;
}

/** A task.failed event or dispatch-run separator surfaced for display */
export type TaskFailureEntry =
  | {
      isSeparator: false;
      taskId: string;
      reason: string;
      attempt: number;
      final: boolean;
      orphaned: boolean; // true → vanished job (env restart), not an agent failure
      ts: string; // ISO datetime from EventRow.createdAt
    }
  | {
      isSeparator: true;
      ts: string; // time of the redispatch event
    };

/** Test plan gate state derived from test_plan.proposed event */
export interface TestPlanGateState {
  summary: string;
  task_count: number;
  spec_rev: number;
  coverage: Array<{
    taskId: string;
    covered: boolean;
    behaviour?: string;
    skipReason?: string;
  }>;
}

/** Task acceptance gate state — opened when a covered task's tests still fail after 2 dev attempts */
export interface TaskAcceptanceGateState {
  taskId: string;
  taskTitle: string;
  summary: string;
  findings: Array<{ id: string; issue: string }>;
}

/** Spend guard gate — opened when a task's cumulative turns exceed the threshold */
export interface SpendGateState {
  taskId: string;
  taskTitle: string;
  turns: number;
  jobCount: number;
  threshold: number;
  summary: string;
}

/** Amendment gate state derived from contract.amendment.proposed event */
export interface AmendmentGateState {
  repo: string;
  rationale: string;
  proposedContractYaml: string;
}

/** A pull request opened by the orchestrator in Azure DevOps */
export interface PrLink {
  repo: string;
  prId: number;
  prUrl: string;
  title: string;
}

/** A finding with its current resolution state. Optional test-agent fields
 *  are present when the finding originates from a test.report event. */
export interface FindingEntry extends Finding {
  resolution: 'accepted' | 'dismissed' | null;
  test_name?: string | undefined;
  duration_ms?: number | undefined;
}

/** An open question from the spec agent, with its current resolution state. */
export interface QuestionEntry {
  id: string;
  text: string;
  resolution: 'answered' | null;
  answer: string | null;
}

/** Derived state from the most-recent test.report event in the stream. */
export interface TestReportState {
  passed: number | null;
  failed: number | null;
  tests: TestRow[];
  authoredPassed: number | undefined;
  authoredFailed: number | undefined;
  skipped: boolean;
  skipReason: string | null;
  parseError: string | null;
  findings: FindingEntry[];
}

/** The full derived run state — produced by foldEvents() */
export interface RunState {
  currentPhase: PhaseId;
  agentStatuses: Record<string, AgentDisplayStatus>;
  chatEntries: ChatEntry[];
  gateOpen: GateState | null;
  planGateOpen: PlanGateState | null;
  testPlanGateOpen: TestPlanGateState | null;
  taskAcceptanceGateOpen: TaskAcceptanceGateState | null;
  amendmentGateOpen: AmendmentGateState | null;
  spendGates: SpendGateState[];
  eventLogsByAgent: Record<string, AgentLogPayload[]>;
  usageTotal: { input_tokens: number; output_tokens: number };
  taskFailures: TaskFailureEntry[];
  prLinks: PrLink[];
  /** Active findings from the most-recent review.findings event in the current gate cycle */
  findings: FindingEntry[];
  /** Open questions from the spec agent in the current gate cycle */
  questions: QuestionEntry[];
  /** Derived state from the most-recent test.report event; null until first test run */
  testReport: TestReportState | null;
  /** Artifact kinds that have been committed at least once (derived from artifact.committed events) */
  committedKinds: ArtifactKind[];
}

/** Which entity is selected in the inspector */
export type SelectedEntity = AgentId | 'orchestrator' | null;
