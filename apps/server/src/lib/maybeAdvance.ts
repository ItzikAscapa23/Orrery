import type { FeatureStatus } from '@prisma/client';
import { getPrisma } from './prisma.js';
import { appendEvent } from './events.js';
import { applyTransition } from './orchestrator.js';

/**
 * Idempotent check: if all tasks for a feature are completed (across all sides),
 * fire IMPLEMENTING → CODE_REVIEW. Safe to call from every task completion
 * because applyTransition returns null when the feature is no longer in
 * IMPLEMENTING (handles the double-fire race when server and client tasks
 * complete within the same event loop tick).
 *
 * For simulated runs: auto-advances CODE_REVIEW → TESTING → DONE immediately
 * inside the same transaction (Phase-2 skip-log pattern).
 *
 * For real runs: stops at CODE_REVIEW and returns 'CODE_REVIEW' so the caller
 * can dispatchForState, which enqueues the create-ado-pr job.
 *
 * Returns the new FeatureStatus if a transition fired, null otherwise.
 */
export async function maybeAdvanceToReview(featureId: string): Promise<FeatureStatus | null> {
  return getPrisma().$transaction(async (tx) => {
    // Re-read inside the transaction so the count, status, and simulatedRun are consistent.
    const feature = await tx.feature.findUnique({
      where: { id: featureId },
      select: { status: true, simulatedRun: true },
    });
    if (!feature || feature.status !== 'IMPLEMENTING') {
      // Already advanced (double-fire) or not in IMPLEMENTING — nothing to do.
      return null;
    }

    const incomplete = await tx.task.count({
      where: { featureId, status: { not: 'completed' } },
    });
    if (incomplete > 0) return null;

    const next = await applyTransition(tx, featureId, 'IMPLEMENTING', 'SUBMIT_REVIEW');
    if (!next) return null; // transition not valid — shouldn't happen, but guard anyway

    await appendEvent(tx, featureId, {
      type: 'phase.changed',
      from: 'IMPLEMENTING',
      to: next,
    });

    // Both real and simulated runs stop at CODE_REVIEW and return `next` so the
    // caller can call dispatchForState('CODE_REVIEW'). For real runs this
    // enqueues create-ado-pr; for simulated runs this enqueues simulate-resume
    // which walks the configured CODE_REVIEW sub-path (Phase 5).
    return next;
  });
}

/**
 * Idempotent check for the light path: if every repo in feature.repos has a
 * light_dev.completed event, fire LIGHT_IMPLEMENTING → CODE_REVIEW.
 *
 * Race-safe: applyTransition returns null when the feature is no longer in
 * LIGHT_IMPLEMENTING (handles double-fire when two repos complete concurrently).
 */
export async function maybeAdvanceLightToReview(featureId: string): Promise<FeatureStatus | null> {
  return getPrisma().$transaction(async (tx) => {
    const feature = await tx.feature.findUnique({
      where: { id: featureId },
      select: { status: true, repos: true, simulatedRun: true },
    });
    if (!feature || feature.status !== 'LIGHT_IMPLEMENTING') return null;

    // Collect unique repo_ids from light_dev.completed events
    const completionEvents = await tx.event.findMany({
      where: { featureId, type: 'light_dev.completed' },
      select: { payload: true },
    });
    const completedRepos = new Set(
      completionEvents
        .map((e) => (e.payload as Record<string, unknown>)['repo_id'] as string)
        .filter(Boolean),
    );

    const allDone = feature.repos.every((repoId) => completedRepos.has(repoId));
    if (!allDone) return null;

    const next = await applyTransition(tx, featureId, 'LIGHT_IMPLEMENTING', 'SUBMIT_REVIEW');
    if (!next) return null;

    await appendEvent(tx, featureId, {
      type: 'phase.changed',
      from: 'LIGHT_IMPLEMENTING',
      to: next,
    });

    return next;
  });
}
