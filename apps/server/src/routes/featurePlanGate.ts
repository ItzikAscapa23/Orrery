import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { findFeatureById } from '../lib/features.js';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { dispatchForState } from '../lib/dispatch.js';
import type { FeatureStatus } from '@prisma/client';
import type { PlanProposedTask } from '@orrery/shared';

const RequestPlanChangesBodySchema = z.object({
  comment: z.string().min(1),
});

/**
 * Seed Task rows from a plan task list, resolving depends_on titles to task IDs.
 *
 * The Planner emits depends_on as human-readable titles (display format).
 * At seed time we create all rows first to obtain their IDs, then update
 * dependsOn to store IDs — so dispatchUnblockedTasks can join on IDs without
 * fragile title matching that breaks on minor title edits.
 */
async function seedTasksWithIdDeps(
  featureId: string,
  planTasks: PlanProposedTask[],
): Promise<void> {
  // Phase 1: create all rows with empty dependsOn to obtain IDs.
  const created: Array<{ id: string; title: string }> = [];
  for (const t of planTasks) {
    const row = await getPrisma().task.create({
      data: {
        featureId,
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
    created.push(row);
  }

  // Phase 2: resolve title→id and update dependsOn in place.
  const titleToId = new Map(created.map((r) => [r.title, r.id]));
  for (let i = 0; i < planTasks.length; i++) {
    const deps = planTasks[i]!.depends_on;
    if (deps.length === 0) continue;
    const depIds = deps
      .map((title) => {
        const id = titleToId.get(title);
        if (!id) {
          console.error(
            JSON.stringify({
              event: 'depends_on_title_unresolved',
              featureId,
              title,
              warning: 'depends_on title not found in plan task list — dependency dropped',
            }),
          );
          return null;
        }
        return id;
      })
      .filter((id): id is string => id !== null);
    if (depIds.length > 0) {
      await getPrisma().task.update({
        where: { id: created[i]!.id },
        data: { dependsOn: depIds },
      });
    }
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function featurePlanGateRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /approve-plan ─────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/features/:id/approve-plan', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }
    if (feature.status !== 'AWAITING_PLAN_APPROVAL') {
      return reply.status(409).send({ error: 'Feature is not awaiting plan approval' });
    }

    await getPrisma().$transaction(async (tx) => {
      await appendEvent(tx, feature.id, {
        type: 'gate.resolved',
        gate: 'plan_approval',
        resolution: 'approved',
      });
      const next = await applyTransition(
        tx,
        feature.id,
        feature.status as FeatureStatus,
        'APPROVE_PLAN',
      );
      if (next) {
        await appendEvent(tx, feature.id, {
          type: 'phase.changed',
          from: feature.status,
          to: next,
        });
      }
    });

    // Seed Task rows from the most recent plan.proposed event.
    // Seeding at approval (not proposal) avoids orphan rows when the plan is revised.
    // depends_on is stored as task IDs (not titles) — resolve at seed time so
    // dispatchUnblockedTasks can join on IDs without fragile title matching.
    const planEvent = await getPrisma().event.findFirst({
      where: { featureId: feature.id, type: 'plan.proposed' },
      orderBy: { seq: 'desc' },
    });
    if (planEvent) {
      const payload = planEvent.payload as { tasks?: PlanProposedTask[] };
      const planTasks = payload.tasks ?? [];
      if (planTasks.length > 0) {
        await seedTasksWithIdDeps(feature.id, planTasks);
      }
    }

    await dispatchForState(feature.id, 'PLANNING_TESTS', feature);

    const updated = await findFeatureById(feature.id);
    return reply.status(200).send(updated);
  });

  // ── POST /request-plan-changes ─────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/features/:id/request-plan-changes',
    async (request, reply) => {
      const feature = await findFeatureById(request.params.id);
      if (!feature) {
        return reply.status(404).send({ error: 'Feature not found' });
      }
      if (feature.status !== 'AWAITING_PLAN_APPROVAL') {
        return reply.status(409).send({ error: 'Feature is not awaiting plan approval' });
      }

      let comment: string;
      try {
        ({ comment } = RequestPlanChangesBodySchema.parse(request.body));
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: err.issues.map((i) => i.message).join(', ') });
        }
        throw err;
      }

      // Atomic: gate.resolved + chat.message(dev) + transition back to PLANNING
      await getPrisma().$transaction(async (tx) => {
        await appendEvent(tx, feature.id, {
          type: 'gate.resolved',
          gate: 'plan_approval',
          resolution: 'changes_requested',
          comment,
        });
        await appendEvent(tx, feature.id, {
          type: 'chat.message',
          who: 'dev',
          text: comment,
        });
        const next = await applyTransition(
          tx,
          feature.id,
          feature.status as FeatureStatus,
          'REQUEST_PLAN_CHANGES',
        );
        if (next) {
          await appendEvent(tx, feature.id, {
            type: 'phase.changed',
            from: feature.status,
            to: next,
          });
        }
      });

      // Re-enqueue the planner job; it will produce a new plan addressing the comment.
      // Fire-and-forget: the UI watches the event stream for the next plan.proposed.
      await dispatchForState(feature.id, 'PLANNING', feature);
      await appendEvent(getPrisma(), feature.id, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'info',
        text: '◦ re-planning with requested changes',
      });

      const updated = await findFeatureById(feature.id);
      return reply.status(200).send(updated);
    },
  );
}
