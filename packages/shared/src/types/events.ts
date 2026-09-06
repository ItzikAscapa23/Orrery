import { z } from 'zod';

// ── Artifact kind registry ──────────────────────────────────────────────────

export const ARTIFACT_KINDS = ['spec', 'plan', 'contract', 'test-plan'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

// basename → kind (single source of truth; server derives KIND_TO_FILE from this)
export const FILE_TO_KIND: Record<string, ArtifactKind> = {
  'spec.md': 'spec',
  'plan.md': 'plan',
  'contract.yaml': 'contract',
  'test-plan.md': 'test-plan',
};

// ── Finding schema (Phase 3) ────────────────────────────────────────────────

export const FindingSchema = z.object({
  id: z.string(),
  severity: z.enum(['blocker', 'warning', 'suggestion']),
  section: z.string(),
  issue: z.string(),
  suggested_text: z.string().optional(),
  // Review Agent populates; AWS agent omits. Optional for backwards compatibility.
  repo: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

// ── Individual payload schemas ──────────────────────────────────────────────

export const PhaseChangedPayloadSchema = z.object({
  type: z.literal('phase.changed'),
  from: z.string().nullable(),
  to: z.string(),
});

export const AgentStatusPayloadSchema = z.object({
  type: z.literal('agent.status'),
  agent: z.string(),
  status: z.enum(['queued', 'working', 'waiting', 'done', 'failed']),
  // Spec 04 §Core model: ALL Phase 4 events add repo (nullable for non-repo events).
  // Optional so pre-4b persisted events still validate.
  repo: z.string().optional(),
});

export const AgentLogPayloadSchema = z.object({
  type: z.literal('agent.log'),
  agent: z.string(),
  severity: z.enum(['ok', 'action', 'info', 'muted']),
  text: z.string(),
  // Spec 04 §Core model: ALL Phase 4 events add repo (nullable for non-repo events).
  repo: z.string().optional(),
});

export const ChatMessagePayloadSchema = z.object({
  type: z.literal('chat.message'),
  who: z.string(), // 'dev' | AgentId — string to tolerate future ids
  text: z.string(),
});

export const GateOpenedPayloadSchema = z.object({
  type: z.literal('gate.opened'),
  gate: z.string(),
  summary: z.string().max(200),
  revision: z.number().int().nonnegative(),
  // Optional: present when the AWS review ran; absent for Phase 2 persisted events.
  counts: z
    .object({
      blockers: z.number().int().nonnegative(),
      warnings: z.number().int().nonnegative(),
      suggestions: z.number().int().nonnegative(),
    })
    .optional(),
  // SHA of spec.md committed at specProposed time; absent for pre-ruling persisted events.
  spec_commit: z.string().optional(),
  // SHAs of plan.md and contract.yaml committed before the plan gate opens.
  plan_commit: z.string().optional(),
  contract_commit: z.string().optional(),
  // task_acceptance_gate fields — present only when gate === 'task_acceptance_gate'.
  taskId: z.string().optional(),
  taskTitle: z.string().optional(),
  findings: z.array(z.object({ id: z.string(), issue: z.string() })).optional(),
  // spend_guard fields — present only when gate === 'spend_guard'.
  turns: z.number().int().nonnegative().optional(),
  jobCount: z.number().int().nonnegative().optional(),
  threshold: z.number().int().nonnegative().optional(),
  // spec_approval fields — unanswered questions at gate-open time.
  question_count: z.number().int().nonnegative().optional(),
});

export const GateResolvedPayloadSchema = z.object({
  type: z.literal('gate.resolved'),
  gate: z.string(),
  resolution: z.enum(['approved', 'changes_requested', 'override', 'retry']),
  comment: z.string().optional(),
  // task_acceptance_gate resolution fields
  taskId: z.string().optional(),
});

export const UsageRecordedPayloadSchema = z.object({
  type: z.literal('usage.recorded'),
  agent: z.string(),
  model: z.string(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  provider: z.string().optional(),
  job_id: z.string().optional(),
  task_id: z.string().optional(),
  simulated: z.boolean().optional(),
});

export const ArtifactCommittedPayloadSchema = z.object({
  type: z.literal('artifact.committed'),
  path: z.string(),
  commit: z.string(),
  message: z.string(),
});

// ── Phase 3 payload schemas ─────────────────────────────────────────────────

export const ReviewFindingsPayloadSchema = z.object({
  type: z.literal('review.findings'),
  agent: z.enum(['aws', 'review']), // widened from z.literal('aws') in Phase 5
  spec_rev: z.number().int().nonnegative(),
  findings: z.array(FindingSchema),
});

export const FindingResolvedPayloadSchema = z.object({
  type: z.literal('finding.resolved'),
  finding_id: z.string(),
  resolution: z.enum(['accepted', 'dismissed']),
  reason: z.string().optional(),
});

export const SpecRevisedPayloadSchema = z.object({
  type: z.literal('spec.revised'),
  rev: z.number().int().positive(),
  cause: z.enum(['finding_accepted', 'changes_requested']),
});

// ── Phase 4 payload schemas ─────────────────────────────────────────────────

// Inline task schema matches PlanTaskSchema in plannerAgent.ts — kept here
// so shared types do not depend on server-only agent code.
export const PlanProposedTaskSchema = z.object({
  repo: z.string(),
  side: z.enum(['server', 'client']),
  title: z.string(),
  description: z.string(),
  spec_refs: z.array(z.string()),
  depends_on: z.array(z.string()),
});

export const PlanProposedPayloadSchema = z.object({
  type: z.literal('plan.proposed'),
  agent: z.literal('planner'),
  spec_rev: z.number().int().nonnegative(),
  plan_summary: z.string().max(300),
  task_count: z.number().int().nonnegative(),
  // Full structured task list — source of truth for Task row seeding at approval.
  tasks: z.array(PlanProposedTaskSchema),
});

// ── Phase 4b payload schemas ────────────────────────────────────────────────

export const TaskStartedPayloadSchema = z.object({
  type: z.literal('task.started'),
  repo: z.string(),
  task_id: z.string(),
  attempt: z.number().int().positive(),
});

export const TaskCompletedPayloadSchema = z.object({
  type: z.literal('task.completed'),
  repo: z.string(),
  task_id: z.string(),
  commit: z.string().optional(),
});

export const TaskFailedPayloadSchema = z.object({
  type: z.literal('task.failed'),
  repo: z.string(),
  task_id: z.string(),
  reason: z.string(),
  attempt: z.number().int().positive(),
  final: z.boolean(),
  orphaned: z.boolean().optional(),
});

// ── Phase 4c payload schemas ────────────────────────────────────────────────

// contract.amendment.proposed — emitted when a dev-agent calls propose_amendment.
// Stores the full replacement contract YAML (not a patch diff) so approve-amendment
// can write it with commitArtifact without needing a general diff applier.
export const ContractAmendmentProposedPayloadSchema = z.object({
  type: z.literal('contract.amendment.proposed'),
  repo: z.string(), // repo id of the proposing agent instance
  task_id: z.string(), // task that triggered the amendment
  proposed_contract_yaml: z.string(), // full replacement OpenAPI YAML
  rationale: z.string(), // operator-facing explanation
});

// contract.revised — emitted when the operator approves an amendment.
export const ContractRevisedPayloadSchema = z.object({
  type: z.literal('contract.revised'),
  repo: z.string(),
  contract_commit: z.string(), // git SHA from commitArtifact
});

// amendment.rejected — emitted on rejection so every subsequent dev-agent
// prompt for this feature can include the ruling and avoid re-proposing.
export const AmendmentRejectedPayloadSchema = z.object({
  type: z.literal('amendment.rejected'),
  task_id: z.string(),
  rationale_summary: z.string(), // first 160 chars of the proposed rationale
  operator_reason: z.string(), // rejection comment; empty string if none given
});

// pr.created — emitted when the orchestrator opens a pull request in Azure DevOps.
export const PrCreatedPayloadSchema = z.object({
  type: z.literal('pr.created'),
  repo: z.string(), // manifest id, e.g. 'demo-server'
  pr_id: z.number().int().positive(),
  pr_url: z.string(),
  title: z.string(),
});

// ── Phase 5 payload schemas ─────────────────────────────────────────────────

// review.started — emitted when the review job begins diff acquisition
export const ReviewStartedPayloadSchema = z.object({
  type: z.literal('review.started'),
  agent: z.literal('review'),
  repos: z.array(z.string()),
});

// review.skipped — emitted when fail-open fires (two consecutive parse failures).
// A skipped gate must leave a record so the operator can see the gate was bypassed.
export const ReviewSkippedPayloadSchema = z.object({
  type: z.literal('review.skipped'),
  agent: z.literal('review'),
  reason: z.string(),
});

// test.started — emitted when the test agent begins
export const TestStartedPayloadSchema = z.object({
  type: z.literal('test.started'),
  agent: z.literal('test'),
  repos: z.array(z.string()),
});

// TestFindingSchema extends FindingSchema with test-runner-specific fields (OQ3).
export const TestFindingSchema = FindingSchema.extend({
  test_name: z.string(), // exact test identifier as reported by the runner
  duration_ms: z.number().int().nonnegative().optional(),
});

// TestRowSchema — one row per test, both passing and failing.
// Distinct from TestFindingSchema: findings are failure-only and feed the
// bounce-back path; rows are the full roster for observability.
export const TestRowSchema = z.object({
  test_name: z.string(),
  status: z.enum(['passed', 'failed']),
  duration_ms: z.number().int().nonnegative().optional(),
  message: z.string().optional(), // failure message summary; absent for passing tests
  authored: z.boolean().optional(), // true when the row's file was staged by the agent
});

// test.report — emitted by both simulator and real Test Agent after a run.
// passed/failed are nullable when the JSON reporter output could not be parsed
// (parse_error is set). skipped/skip_reason are set when no repos were observed.
export const TestReportPayloadSchema = z.object({
  type: z.literal('test.report'),
  agent: z.literal('test'),
  spec_rev: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative().nullable(),
  failed: z.number().int().nonnegative().nullable(),
  findings: z.array(TestFindingSchema), // failure-only; for bounce-back routing
  tests: z.array(TestRowSchema).optional(), // per-test rows for both branches
  authored_passed: z.number().int().nonnegative().optional(), // tests in agent-staged files
  authored_failed: z.number().int().nonnegative().optional(),
  skipped: z.boolean().optional(), // true when no repos were observed
  skip_reason: z.string().optional(),
  parse_error: z.string().optional(), // present when counts could not be parsed
  wall_time_ms: z.number().int().nonnegative().optional(), // container exec elapsed ms (install and agent turns excluded)
});

// ── Phase 7 payload schemas ─────────────────────────────────────────────────

// test_plan.proposed — emitted by the test planner after deciding coverage.
export const TestPlanCoverageEntrySchema = z.object({
  taskId: z.string(),
  covered: z.boolean(),
  behaviour: z.string().optional(),
  skipReason: z.string().optional(),
});

export const TestPlanProposedPayloadSchema = z.object({
  type: z.literal('test_plan.proposed'),
  agent: z.literal('test-planner'),
  spec_rev: z.number().int().nonnegative(),
  plan_summary: z.string().max(300),
  task_count: z.number().int().nonnegative(),
  coverage: z.array(TestPlanCoverageEntrySchema),
});

// task.tests_written — emitted by taskTestJob after acceptance tests are committed.
export const TaskTestsWrittenPayloadSchema = z.object({
  type: z.literal('task.tests_written'),
  task_id: z.string(),
  files: z.array(z.string()),
});

// light_dev.completed — emitted by lightDevJob when a light-path repo commit lands.
// maybeAdvanceLightToReview folds these to check all repos are done.
export const LightDevCompletedPayloadSchema = z.object({
  type: z.literal('light_dev.completed'),
  repo_id: z.string(),
  commit_sha: z.string().optional(),
});

// ── Phase 29 payload schemas ────────────────────────────────────────────────

// spec.questions — emitted when the spec agent calls save_spec with structured questions.
export const SpecQuestionsPayloadSchema = z.object({
  type: z.literal('spec.questions'),
  spec_rev: z.number().int().nonnegative(),
  questions: z.array(z.object({ id: z.string(), text: z.string() })),
});

// spec.question_answered — emitted when the operator answers an open question.
export const SpecQuestionAnsweredPayloadSchema = z.object({
  type: z.literal('spec.question_answered'),
  spec_rev: z.number().int().nonnegative(),
  question_id: z.string(),
  answer: z.string(),
});

// ── Union ───────────────────────────────────────────────────────────────────

export const EventPayloadSchema = z.discriminatedUnion('type', [
  PhaseChangedPayloadSchema,
  AgentStatusPayloadSchema,
  AgentLogPayloadSchema,
  ChatMessagePayloadSchema,
  GateOpenedPayloadSchema,
  GateResolvedPayloadSchema,
  UsageRecordedPayloadSchema,
  ArtifactCommittedPayloadSchema,
  ReviewFindingsPayloadSchema,
  FindingResolvedPayloadSchema,
  SpecRevisedPayloadSchema,
  PlanProposedPayloadSchema,
  TaskStartedPayloadSchema,
  TaskCompletedPayloadSchema,
  TaskFailedPayloadSchema,
  ContractAmendmentProposedPayloadSchema,
  ContractRevisedPayloadSchema,
  AmendmentRejectedPayloadSchema,
  PrCreatedPayloadSchema,
  ReviewStartedPayloadSchema,
  ReviewSkippedPayloadSchema,
  TestStartedPayloadSchema,
  TestReportPayloadSchema,
  TestPlanProposedPayloadSchema,
  TaskTestsWrittenPayloadSchema,
  LightDevCompletedPayloadSchema,
  SpecQuestionsPayloadSchema,
  SpecQuestionAnsweredPayloadSchema,
]);

export type EventPayload = z.infer<typeof EventPayloadSchema>;
export type PhaseChangedPayload = z.infer<typeof PhaseChangedPayloadSchema>;
export type AgentStatusPayload = z.infer<typeof AgentStatusPayloadSchema>;
export type AgentLogPayload = z.infer<typeof AgentLogPayloadSchema>;
export type ChatMessagePayload = z.infer<typeof ChatMessagePayloadSchema>;
export type GateOpenedPayload = z.infer<typeof GateOpenedPayloadSchema>;
export type GateResolvedPayload = z.infer<typeof GateResolvedPayloadSchema>;
export type UsageRecordedPayload = z.infer<typeof UsageRecordedPayloadSchema>;
export type ArtifactCommittedPayload = z.infer<typeof ArtifactCommittedPayloadSchema>;
export type ReviewFindingsPayload = z.infer<typeof ReviewFindingsPayloadSchema>;
export type FindingResolvedPayload = z.infer<typeof FindingResolvedPayloadSchema>;
export type SpecRevisedPayload = z.infer<typeof SpecRevisedPayloadSchema>;
export type PlanProposedTask = z.infer<typeof PlanProposedTaskSchema>;
export type PlanProposedPayload = z.infer<typeof PlanProposedPayloadSchema>;
export type TaskStartedPayload = z.infer<typeof TaskStartedPayloadSchema>;
export type TaskCompletedPayload = z.infer<typeof TaskCompletedPayloadSchema>;
export type TaskFailedPayload = z.infer<typeof TaskFailedPayloadSchema>;
export type ContractAmendmentProposedPayload = z.infer<
  typeof ContractAmendmentProposedPayloadSchema
>;
export type ContractRevisedPayload = z.infer<typeof ContractRevisedPayloadSchema>;
export type AmendmentRejectedPayload = z.infer<typeof AmendmentRejectedPayloadSchema>;
export type PrCreatedPayload = z.infer<typeof PrCreatedPayloadSchema>;
export type ReviewStartedPayload = z.infer<typeof ReviewStartedPayloadSchema>;
export type ReviewSkippedPayload = z.infer<typeof ReviewSkippedPayloadSchema>;
export type TestStartedPayload = z.infer<typeof TestStartedPayloadSchema>;
export type TestFinding = z.infer<typeof TestFindingSchema>;
export type TestRow = z.infer<typeof TestRowSchema>;
export type TestReportPayload = z.infer<typeof TestReportPayloadSchema>;
export type TestPlanCoverageEntry = z.infer<typeof TestPlanCoverageEntrySchema>;
export type TestPlanProposedPayload = z.infer<typeof TestPlanProposedPayloadSchema>;
export type TaskTestsWrittenPayload = z.infer<typeof TaskTestsWrittenPayloadSchema>;
export type LightDevCompletedPayload = z.infer<typeof LightDevCompletedPayloadSchema>;
export type SpecQuestionsPayload = z.infer<typeof SpecQuestionsPayloadSchema>;
export type SpecQuestionAnsweredPayload = z.infer<typeof SpecQuestionAnsweredPayloadSchema>;

// ── Full event row (as returned from the DB / SSE stream) ───────────────────

export const EventRowSchema = z.object({
  id: z.number(),
  featureId: z.string().uuid(),
  seq: z.number().int().positive(),
  agent: z.string().nullable(),
  payload: EventPayloadSchema,
  createdAt: z.string().datetime(),
});

export type EventRow = z.infer<typeof EventRowSchema>;
