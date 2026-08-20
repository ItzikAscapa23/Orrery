import { getPrisma } from './prisma.js';

/**
 * Number of spec-cycle gates (spec_approval, plan_approval) for a feature.
 * code_review and amendment gates are escalation events within a cycle and
 * must not advance the clock — they are emitted AFTER findings are written,
 * so counting them inflates currentCycleRev at dismiss/accept time.
 * The current review-cycle revision is gateOpenedCount - 1 (0-based).
 *
 * Uses $queryRaw because Prisma 4.x JsonFilter has no string_in operator.
 */
export async function gateOpenedCount(featureId: string): Promise<number> {
  const result = await getPrisma().$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::int AS count
    FROM events
    WHERE feature_id = ${featureId}
      AND type = 'gate.opened'
      AND payload->>'gate' IN ('spec_approval', 'plan_approval')
  `;
  return Number(result[0]?.count ?? 0);
}

/**
 * Number of review.findings events emitted by the Review Agent (agent='review')
 * for this feature. Used by reviewJob to determine which round of CODE_REVIEW
 * we are on:
 *   0 → first entry: run review, emit findings; blockers → REVIEW_FAIL
 *   ≥1 → second entry after bounce-back: run re-review; blockers → human gate
 *
 * Filters to agent='review' to exclude the AWS spec-review event (agent='aws')
 * which shares the same event type but is emitted during a different phase.
 */
export async function getReviewRound(featureId: string): Promise<number> {
  return getPrisma().event.count({
    where: {
      featureId,
      type: 'review.findings',
      payload: { path: ['agent'], equals: 'review' },
    },
  });
}

/**
 * Number of test.report events emitted by the Test Agent (agent='test') for
 * this feature. Used by testJob to determine which round of TESTING we are on:
 *   0 → first entry: run tests, emit report; failures → TEST_FAIL bounce-back
 *   ≥1 → second entry after bounce-back: re-run; failures → human gate
 */
export async function getTestRound(featureId: string): Promise<number> {
  return getPrisma().event.count({
    where: {
      featureId,
      type: 'test.report',
      payload: { path: ['agent'], equals: 'test' },
    },
  });
}
