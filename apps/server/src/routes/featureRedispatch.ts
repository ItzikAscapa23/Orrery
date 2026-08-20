import type { FastifyInstance } from 'fastify';
import { findFeatureById } from '../lib/features.js';
import { getPrisma } from '../lib/prisma.js';
import { dispatchForState } from '../lib/dispatch.js';
import { appendEvent } from '../lib/events.js';
import { reconcileOrphanedTasks } from '../lib/taskReconciler.js';
import type { PlanProposedTask } from '@orrery/shared';

/**
 * POST /features/:id/redispatch
 *
 * Re-dispatch for a feature parked in IMPLEMENTING with no pending Task rows.
 * Implements the spec's "resumable via re-dispatch on demand" failure policy:
 *
 * 1. Seeds any missing Task rows from the latest plan.proposed event
 *    (idempotent — skipDuplicates ensures existing rows are not re-created).
 * 2. Calls dispatchForState(IMPLEMENTING) which enqueues one server-dev job
 *    per pending server-side task.
 *
 * Also used as the primary mechanism to unpark features after task failures,
 * replacing the need for direct DB manipulation.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function featureRedispatchRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>('/features/:id/redispatch', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }
    if (feature.status !== 'IMPLEMENTING' && feature.status !== 'LIGHT_IMPLEMENTING') {
      return reply.status(409).send({
        error: `Re-dispatch is only valid in IMPLEMENTING or LIGHT_IMPLEMENTING state (current: ${feature.status})`,
      });
    }

    if (feature.status === 'LIGHT_IMPLEMENTING') {
      await dispatchForState(feature.id, 'LIGHT_IMPLEMENTING', feature);
      return reply.status(200).send({
        path: 'light',
        jobsEnqueued: feature.repos.length,
      });
    }

    // Seed any missing Task rows from the latest plan.proposed event.
    const planEvent = await getPrisma().event.findFirst({
      where: { featureId: feature.id, type: 'plan.proposed' },
      orderBy: { seq: 'desc' },
    });

    let tasksSeeded = 0;
    if (planEvent) {
      const payload = planEvent.payload as { tasks?: PlanProposedTask[] };
      const planTasks = payload.tasks ?? [];
      if (planTasks.length > 0) {
        // Check which titles are already present to avoid duplicates — the Task
        // model has no composite unique constraint so skipDuplicates is a no-op.
        const existing = await getPrisma().task.findMany({
          where: { featureId: feature.id },
          select: { id: true, title: true, repo: true },
        });
        const existingKeys = new Set(existing.map((t) => `${t.repo}::${t.title}`));
        const newTasks = planTasks.filter((t) => !existingKeys.has(`${t.repo}::${t.title}`));
        if (newTasks.length > 0) {
          // depends_on stored as task IDs: resolve titles against existing rows
          // plus new rows being created here. Create new rows first, then update deps.
          const titleToId = new Map(existing.map((r) => [r.title, r.id]));
          for (const t of newTasks) {
            const row = await getPrisma().task.create({
              data: {
                featureId: feature.id,
                repo: t.repo,
                side: t.side,
                title: t.title,
                description: t.description,
                specRefs: t.spec_refs,
                dependsOn: [],
                status: 'pending',
              },
              select: { id: true, title: true },
            });
            titleToId.set(row.title, row.id);
            tasksSeeded++;
          }
          // Second pass: resolve and write dependsOn IDs for newly-created rows.
          const newRows = await getPrisma().task.findMany({
            where: {
              featureId: feature.id,
              title: { in: newTasks.map((t) => t.title) },
            },
            select: { id: true, title: true },
          });
          const newTitleToId = new Map(newRows.map((r) => [r.title, r.id]));
          for (const t of newTasks) {
            if (t.depends_on.length === 0) continue;
            const depIds = t.depends_on
              .map((title) => titleToId.get(title) ?? newTitleToId.get(title))
              .filter((id): id is string => id !== undefined);
            if (depIds.length > 0) {
              await getPrisma().task.update({
                where: { id: newTitleToId.get(t.title)! },
                data: { dependsOn: depIds },
              });
            }
          }
        }
      }
    }

    // Pre-park any zombie tasks stuck in 'running' with no live BullMQ job.
    // This handles the case where a task was running but the server was killed
    // before the periodic reconciler fired. After parking, they'll be resurrected
    // below along with already-parked tasks.
    await reconcileOrphanedTasks();

    // Resurrect parked tasks: human redispatch is a new grant, not attempt N+1.
    // The attempt cap exists to stop model loops — not to punish environmental
    // failures (expired SSO, registry down). Reset attempt_count to 0 so the
    // full retry budget is available again.
    const parkedTasks = await getPrisma().task.findMany({
      where: { featureId: feature.id, status: 'parked' },
      select: { id: true },
    });
    if (parkedTasks.length > 0) {
      await getPrisma().task.updateMany({
        where: { featureId: feature.id, status: 'parked' },
        data: { status: 'pending', attemptCount: 0, parkReason: null },
      });
      for (const t of parkedTasks) {
        await appendEvent(getPrisma(), feature.id, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'muted',
          text: `↻ task ${t.id} reset by redispatch, attempts cleared`,
        });
      }
    }

    // Snapshot pending count before dispatch: dispatchForState consumes the
    // rows, so a post-dispatch count would always be 0.
    const pendingBeforeDispatch = await getPrisma().task.count({
      where: { featureId: feature.id, side: 'server', status: 'pending' },
    });

    await dispatchForState(feature.id, 'IMPLEMENTING', feature);

    return reply.status(200).send({
      path: 'full',
      tasksSeeded,
      tasksResurrected: parkedTasks.length,
      jobsEnqueued: pendingBeforeDispatch,
    });
  });
}
