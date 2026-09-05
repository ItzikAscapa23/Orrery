import { getPrisma } from './prisma.js';
import { appendEvent } from './events.js';
import { applyTransition } from './orchestrator.js';

/**
 * Atomically commits the spec artifact, updates proposedSpec, transitions the
 * feature to AWAITING_APPROVAL via SUBMIT_SPEC_LIGHT, and opens the spec_approval
 * gate — without dispatching an AWS review job.
 *
 * Used when no review_charter is configured for any repo in scope. Does NOT emit
 * agent.log — callers own the log message so each can tailor it.
 */
export async function submitSpecSkip(
  featureId: string,
  specMarkdown: string,
  specCommitResult: { path: string; commit: string; message: string },
  rev: number,
  questionCount = 0,
): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    await appendEvent(tx, featureId, {
      type: 'artifact.committed',
      path: specCommitResult.path,
      commit: specCommitResult.commit,
      message: specCommitResult.message,
    });
    await tx.feature.update({
      where: { id: featureId },
      data: { proposedSpec: specMarkdown },
    });
    const current = await tx.feature.findUniqueOrThrow({ where: { id: featureId } });
    const next = await applyTransition(tx, featureId, current.status, 'SUBMIT_SPEC_LIGHT');
    if (next) {
      await appendEvent(tx, featureId, {
        type: 'phase.changed',
        from: current.status,
        to: next,
      });
    }
    await appendEvent(tx, featureId, {
      type: 'gate.opened',
      gate: 'spec_approval',
      summary: specMarkdown.slice(0, 200),
      revision: rev,
      counts: { blockers: 0, warnings: 0, suggestions: 0 },
      spec_commit: specCommitResult.commit,
      ...(questionCount > 0 ? { question_count: questionCount } : {}),
    });
  });
}
