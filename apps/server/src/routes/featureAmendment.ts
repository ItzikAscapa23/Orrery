import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { findFeatureById } from '../lib/features.js';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { commitArtifact } from '../lib/artifacts.js';
import { dispatchUnblockedTasks } from '../lib/dispatch.js';

const RejectAmendmentBodySchema = z.object({
  comment: z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns all operator rejections for this feature, oldest first.
 * Used to inject the ruling into every subsequent dev-agent prompt and to
 * detect duplicate amendment proposals before they pause the feature again.
 */
export async function getRejectedAmendments(
  featureId: string,
): Promise<Array<{ taskId: string; rationaleSummary: string; operatorReason: string }>> {
  const events = await getPrisma().event.findMany({
    where: { featureId, type: 'amendment.rejected' },
    orderBy: { seq: 'asc' },
  });
  return events.map((e) => {
    const p = e.payload as {
      task_id: string;
      rationale_summary: string;
      operator_reason: string;
    };
    return {
      taskId: p['task_id'] ?? '',
      rationaleSummary: p['rationale_summary'] ?? '',
      operatorReason: p['operator_reason'] ?? '',
    };
  });
}

/**
 * Returns the open amendment proposal payload if an unanswered
 * contract.amendment.proposed event exists for this feature.
 * Returns null if no amendment gate is open.
 */
async function getOpenAmendmentProposal(featureId: string): Promise<{
  proposed_contract_yaml: string;
  rationale: string;
  repo: string;
  task_id: string;
} | null> {
  const [proposedEvent, resolvedEvent] = await Promise.all([
    getPrisma().event.findFirst({
      where: { featureId, type: 'contract.amendment.proposed' },
      orderBy: { seq: 'desc' },
    }),
    getPrisma().event.findFirst({
      where: {
        featureId,
        type: 'gate.resolved',
        payload: { path: ['gate'], equals: 'amendment' },
      },
      orderBy: { seq: 'desc' },
    }),
  ]);

  if (!proposedEvent) return null;
  // Gate is closed if a resolution came after the proposal.
  if (resolvedEvent && resolvedEvent.seq > proposedEvent.seq) return null;

  // Prisma stores payload as JsonValue. Use a plain object cast — same pattern
  // used elsewhere in the codebase (featureRedispatch.ts line 44).
  const p = proposedEvent.payload as { [key: string]: string };
  return {
    proposed_contract_yaml: p['proposed_contract_yaml'] ?? '',
    rationale: p['rationale'] ?? '',
    repo: p['repo'] ?? '',
    task_id: p['task_id'] ?? '',
  };
}

// ── Route helpers ─────────────────────────────────────────────────────────────

/** Reset all amendment_paused tasks to pending with a fresh grant (attemptCount 0). */
async function resumeAmendmentPausedTasks(featureId: string): Promise<void> {
  const pausedTasks = await getPrisma().task.findMany({
    where: { featureId, status: 'amendment_paused' },
    select: { id: true },
  });
  if (pausedTasks.length === 0) return;

  await getPrisma().task.updateMany({
    where: { featureId, status: 'amendment_paused' },
    data: { status: 'pending', attemptCount: 0, parkReason: null },
  });

  for (const t of pausedTasks) {
    await appendEvent(getPrisma(), featureId, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: `↻ task ${t.id} resumed after amendment resolved, attempts cleared`,
    });
  }
}

// ── Route plugin ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureAmendmentRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /approve-amendment ────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/features/:id/approve-amendment',
    async (request, reply) => {
      const feature = await findFeatureById(request.params.id);
      if (!feature) return reply.status(404).send({ error: 'Feature not found' });

      const proposal = await getOpenAmendmentProposal(feature.id);
      if (!proposal) {
        return reply.status(409).send({ error: 'No open amendment gate for this feature' });
      }

      // Write the proposed contract.yaml to the artifacts repo.
      const contractCommit = commitArtifact(
        feature.slug,
        'contract.yaml',
        proposal.proposed_contract_yaml,
      );

      await appendEvent(getPrisma(), feature.id, {
        type: 'contract.revised',
        repo: proposal.repo,
        contract_commit: contractCommit.commit,
      });

      await appendEvent(getPrisma(), feature.id, {
        type: 'artifact.committed',
        path: contractCommit.path,
        commit: contractCommit.commit,
        message: contractCommit.message,
      });

      await appendEvent(getPrisma(), feature.id, {
        type: 'gate.resolved',
        gate: 'amendment',
        resolution: 'approved',
      });

      await appendEvent(getPrisma(), feature.id, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'ok',
        text: `✓ contract amendment approved — contract.yaml updated (${contractCommit.commit})`,
      });

      await resumeAmendmentPausedTasks(feature.id);

      await Promise.all([
        dispatchUnblockedTasks(feature.id, 'server'),
        dispatchUnblockedTasks(feature.id, 'client'),
      ]);

      return reply.status(200).send({ contractCommit: contractCommit.commit });
    },
  );

  // ── POST /reject-amendment ─────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/features/:id/reject-amendment', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) return reply.status(404).send({ error: 'Feature not found' });

    const proposal = await getOpenAmendmentProposal(feature.id);
    if (!proposal) {
      return reply.status(409).send({ error: 'No open amendment gate for this feature' });
    }

    let comment: string | undefined;
    try {
      ({ comment } = RejectAmendmentBodySchema.parse(request.body));
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: err.issues.map((i) => i.message).join(', ') });
      }
      throw err;
    }

    await appendEvent(getPrisma(), feature.id, {
      type: 'gate.resolved',
      gate: 'amendment',
      resolution: 'changes_requested',
      ...(comment ? { comment } : {}),
    });

    // Persist the ruling as a feature-level record so every subsequent dev-agent
    // prompt for this feature can include it, preventing sibling tasks from
    // re-proposing the same amendment independently.
    await appendEvent(getPrisma(), feature.id, {
      type: 'amendment.rejected',
      task_id: proposal.task_id,
      rationale_summary: proposal.rationale.slice(0, 160),
      operator_reason: comment ?? '',
    });

    // Append rejection context to the proposing task's description so the agent
    // sees it on retry and implements within the existing contract.
    if (comment) {
      const proposingTask = await getPrisma().task.findUnique({
        where: { id: proposal.task_id },
        select: { description: true },
      });
      if (proposingTask) {
        await getPrisma().task.update({
          where: { id: proposal.task_id },
          data: {
            description:
              proposingTask.description +
              `\n\nAmendment rejected: ${comment}. Implement within the existing contract or fail the task.`,
          },
        });
      }
    }

    await appendEvent(getPrisma(), feature.id, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: `◦ amendment rejected — tasks resumed, proposing task will retry within existing contract`,
    });

    await resumeAmendmentPausedTasks(feature.id);

    await Promise.all([
      dispatchUnblockedTasks(feature.id, 'server'),
      dispatchUnblockedTasks(feature.id, 'client'),
    ]);

    return reply.status(200).send({});
  });
}
