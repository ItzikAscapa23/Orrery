import type { PrismaClient, FeatureStatus } from '@prisma/client';

// ── Transition table ──────────────────────────────────────────────────────────
// Key: `${fromState}:${event}` → nextState.
// Any pair absent from this map is an invalid transition (returns null).

type TransitionEvent =
  | 'START' // feature created → DRAFTING_SPEC
  | 'SUBMIT_SPEC' // save_spec called → AWS_REVIEW
  | 'SUBMIT_SPEC_LIGHT' // light: save_spec called → AWAITING_APPROVAL (skips AWS_REVIEW)
  | 'AWS_SKIP' // Phase 2 compat: AWS agent absent → AWAITING_APPROVAL (deprecated)
  | 'AWS_DONE' // AWS review complete (success or fallback) → AWAITING_APPROVAL
  | 'AWS_REJECT' // AWS review failed → DRAFTING_SPEC
  | 'APPROVE' // human approves spec → PLANNING
  | 'APPROVE_LIGHT' // light: human approves spec → LIGHT_IMPLEMENTING (skips PLANNING)
  | 'REQUEST_CHANGES' // human requests spec changes → DRAFTING_SPEC
  | 'SUBMIT_PLAN' // planner produced plan → AWAITING_PLAN_APPROVAL
  | 'APPROVE_PLAN' // human approves plan → PLANNING_TESTS
  | 'REQUEST_PLAN_CHANGES' // human requests plan changes → PLANNING
  | 'SUBMIT_TEST_PLAN' // test planner done → AWAITING_TEST_PLAN_APPROVAL
  | 'APPROVE_TEST_PLAN' // human approves test plan → IMPLEMENTING
  | 'REQUEST_TEST_PLAN_CHANGES' // human requests test plan changes → PLANNING_TESTS
  | 'START_PLANNING' // planning begins → PLANNING (internal, unused)
  | 'START_IMPL' // implementation begins → IMPLEMENTING
  | 'SUBMIT_REVIEW' // code review requested → CODE_REVIEW (from IMPLEMENTING or LIGHT_IMPLEMENTING)
  | 'REVIEW_PASS' // review passed → TESTING
  | 'REVIEW_PASS_LIGHT' // light: review passed → DONE (skips TESTING)
  | 'REVIEW_FAIL' // review failed → IMPLEMENTING
  | 'REVIEW_FAIL_LIGHT' // light: review failed → LIGHT_IMPLEMENTING
  | 'TEST_PASS' // tests passed → DONE
  | 'TEST_FAIL' // tests failed → IMPLEMENTING
  | 'FAIL'; // terminal failure from any state

export type { TransitionEvent };

const TRANSITIONS: Record<string, FeatureStatus> = {
  'DRAFTING_SPEC:SUBMIT_SPEC': 'AWS_REVIEW',
  'DRAFTING_SPEC:SUBMIT_SPEC_LIGHT': 'AWAITING_APPROVAL', // light: skip AWS_REVIEW
  'AWS_REVIEW:AWS_SKIP': 'AWAITING_APPROVAL', // Phase 2 compat — kept so old simulator paths compile
  'AWS_REVIEW:AWS_DONE': 'AWAITING_APPROVAL',
  'AWS_REVIEW:AWS_REJECT': 'DRAFTING_SPEC',
  'AWAITING_APPROVAL:APPROVE': 'PLANNING',
  'AWAITING_APPROVAL:APPROVE_LIGHT': 'LIGHT_IMPLEMENTING', // light: skip PLANNING
  'AWAITING_APPROVAL:REQUEST_CHANGES': 'DRAFTING_SPEC',
  'PLANNING:SUBMIT_PLAN': 'AWAITING_PLAN_APPROVAL',
  'AWAITING_PLAN_APPROVAL:APPROVE_PLAN': 'PLANNING_TESTS',
  'AWAITING_PLAN_APPROVAL:REQUEST_PLAN_CHANGES': 'PLANNING',
  'PLANNING_TESTS:SUBMIT_TEST_PLAN': 'AWAITING_TEST_PLAN_APPROVAL',
  'AWAITING_TEST_PLAN_APPROVAL:APPROVE_TEST_PLAN': 'IMPLEMENTING',
  'AWAITING_TEST_PLAN_APPROVAL:REQUEST_TEST_PLAN_CHANGES': 'PLANNING_TESTS',
  'PLANNING:START_IMPL': 'IMPLEMENTING', // kept for compatibility; superseded by SUBMIT_PLAN flow
  'IMPLEMENTING:SUBMIT_REVIEW': 'CODE_REVIEW',
  'LIGHT_IMPLEMENTING:SUBMIT_REVIEW': 'CODE_REVIEW', // light: same event, different source state
  'CODE_REVIEW:REVIEW_PASS': 'TESTING',
  'CODE_REVIEW:REVIEW_PASS_LIGHT': 'DONE', // light: skip TESTING
  'CODE_REVIEW:REVIEW_FAIL': 'IMPLEMENTING',
  'CODE_REVIEW:REVIEW_FAIL_LIGHT': 'LIGHT_IMPLEMENTING', // light: bounce back to light phase
  'TESTING:TEST_PASS': 'DONE',
  'TESTING:TEST_FAIL': 'IMPLEMENTING',
};

// FAIL is reachable from any non-DONE state
const TERMINAL: FeatureStatus[] = ['DONE', 'FAILED'];

export function isValidTransition(from: FeatureStatus, event: TransitionEvent): boolean {
  if (event === 'FAIL') return !TERMINAL.includes(from);
  return `${from}:${event}` in TRANSITIONS;
}

export function nextState(from: FeatureStatus, event: TransitionEvent): FeatureStatus | null {
  if (!isValidTransition(from, event)) return null;
  if (event === 'FAIL') return 'FAILED';
  return TRANSITIONS[`${from}:${event}`] ?? null;
}

// ── DB helper ─────────────────────────────────────────────────────────────────

type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Validates the transition, updates the feature's status cache, and returns the
 * next state. Returns null (and writes nothing) if the transition is invalid.
 *
 * Callers are responsible for running this inside a $transaction and for
 * appending the phase.changed event in the same transaction.
 */
export async function applyTransition(
  tx: TxClient,
  featureId: string,
  currentStatus: FeatureStatus,
  event: TransitionEvent,
): Promise<FeatureStatus | null> {
  const next = nextState(currentStatus, event);
  if (!next) return null;

  await tx.feature.update({
    where: { id: featureId },
    data: { status: next },
  });

  return next;
}
