import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { findFeatureById } from '../lib/features.js';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { dispatchForState, dispatchUnblockedTasks } from '../lib/dispatch.js';
import { maybeAdvanceToReview } from '../lib/maybeAdvance.js';
import type { FeatureStatus } from '@prisma/client';
import type { CoverageEntry } from '../agents/testPlannerAgent.js';

const RequestChangesBodySchema = z.object({
  comment: z.string().min(1),
});

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureTestPlanGateRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /approve-test-plan ────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/features/:id/approve-test-plan',
    async (request, reply) => {
      const feature = await findFeatureById(request.params.id);
      if (!feature) {
        return reply.status(404).send({ error: 'Feature not found' });
      }
      if (feature.status !== 'AWAITING_TEST_PLAN_APPROVAL') {
        return reply.status(409).send({ error: 'Feature is not awaiting test plan approval' });
      }

      // Read coverage decisions from the most recent test_plan.proposed event.
      const testPlanEvent = await getPrisma().event.findFirst({
        where: { featureId: feature.id, type: 'test_plan.proposed' },
        orderBy: { seq: 'desc' },
      });
      const coverage: CoverageEntry[] = testPlanEvent
        ? ((testPlanEvent.payload as { coverage?: CoverageEntry[] }).coverage ?? [])
        : [];
      const coveredTaskIds = coverage.filter((c) => c.covered).map((c) => c.taskId);

      await getPrisma().$transaction(async (tx) => {
        await appendEvent(tx, feature.id, {
          type: 'gate.resolved',
          gate: 'test_plan_approval',
          resolution: 'approved',
        });
        const next = await applyTransition(
          tx,
          feature.id,
          feature.status as FeatureStatus,
          'APPROVE_TEST_PLAN',
        );
        if (next) {
          await appendEvent(tx, feature.id, {
            type: 'phase.changed',
            from: feature.status,
            to: next,
          });
        }
      });

      // Mark covered tasks so dispatchUnblockedTasks routes them to test-task jobs first.
      if (coveredTaskIds.length > 0) {
        await getPrisma().task.updateMany({
          where: { featureId: feature.id, id: { in: coveredTaskIds } },
          data: { coveredByTestPlan: true },
        });
      }

      await dispatchForState(feature.id, 'IMPLEMENTING', feature);

      const updated = await findFeatureById(feature.id);
      return reply.status(200).send(updated);
    },
  );

  // ── POST /request-test-plan-changes ───────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/features/:id/request-test-plan-changes',
    async (request, reply) => {
      const feature = await findFeatureById(request.params.id);
      if (!feature) {
        return reply.status(404).send({ error: 'Feature not found' });
      }
      if (feature.status !== 'AWAITING_TEST_PLAN_APPROVAL') {
        return reply.status(409).send({ error: 'Feature is not awaiting test plan approval' });
      }

      let comment: string;
      try {
        ({ comment } = RequestChangesBodySchema.parse(request.body));
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: err.issues.map((i) => i.message).join(', ') });
        }
        throw err;
      }

      await getPrisma().$transaction(async (tx) => {
        await appendEvent(tx, feature.id, {
          type: 'gate.resolved',
          gate: 'test_plan_approval',
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
          'REQUEST_TEST_PLAN_CHANGES',
        );
        if (next) {
          await appendEvent(tx, feature.id, {
            type: 'phase.changed',
            from: feature.status,
            to: next,
          });
        }
      });

      await dispatchForState(feature.id, 'PLANNING_TESTS', feature);
      await appendEvent(getPrisma(), feature.id, {
        type: 'agent.log',
        agent: 'orchestrator',
        severity: 'info',
        text: '◦ re-planning test coverage with requested changes',
      });

      const updated = await findFeatureById(feature.id);
      return reply.status(200).send(updated);
    },
  );

  // ── POST /tasks/:taskId/override-acceptance ────────────────────────────────
  app.post<{ Params: { id: string; taskId: string } }>(
    '/features/:id/tasks/:taskId/override-acceptance',
    async (request, reply) => {
      const feature = await findFeatureById(request.params.id);
      if (!feature) {
        return reply.status(404).send({ error: 'Feature not found' });
      }
      if (feature.status !== 'IMPLEMENTING') {
        return reply.status(409).send({ error: 'Feature is not in IMPLEMENTING state' });
      }

      const task = await getPrisma().task.findFirst({
        where: { id: request.params.taskId, featureId: feature.id },
      });
      if (!task) {
        return reply.status(404).send({ error: 'Task not found' });
      }
      if (task.status !== 'parked') {
        return reply.status(409).send({ error: 'Task is not parked' });
      }

      await appendEvent(getPrisma(), feature.id, {
        type: 'gate.resolved',
        gate: 'task_acceptance_gate',
        taskId: task.id,
        resolution: 'override',
      });

      await getPrisma().task.update({
        where: { id: task.id },
        data: { status: 'completed' },
      });

      const newState = await maybeAdvanceToReview(feature.id);
      if (newState === 'CODE_REVIEW') {
        const updatedFeature = await findFeatureById(feature.id);
        if (updatedFeature) {
          await dispatchForState(feature.id, 'CODE_REVIEW', updatedFeature);
        }
      } else if (newState === null) {
        await dispatchUnblockedTasks(feature.id, task.side as 'server' | 'client');
      }

      const updated = await findFeatureById(feature.id);
      return reply.status(200).send(updated);
    },
  );

  // ── POST /tasks/:taskId/retry-acceptance ───────────────────────────────────
  app.post<{ Params: { id: string; taskId: string } }>(
    '/features/:id/tasks/:taskId/retry-acceptance',
    async (request, reply) => {
      const feature = await findFeatureById(request.params.id);
      if (!feature) {
        return reply.status(404).send({ error: 'Feature not found' });
      }
      if (feature.status !== 'IMPLEMENTING') {
        return reply.status(409).send({ error: 'Feature is not in IMPLEMENTING state' });
      }

      const task = await getPrisma().task.findFirst({
        where: { id: request.params.taskId, featureId: feature.id },
      });
      if (!task) {
        return reply.status(404).send({ error: 'Task not found' });
      }
      if (task.status !== 'parked') {
        return reply.status(409).send({ error: 'Task is not parked' });
      }

      await appendEvent(getPrisma(), feature.id, {
        type: 'gate.resolved',
        gate: 'task_acceptance_gate',
        taskId: task.id,
        resolution: 'retry',
      });

      await getPrisma().task.update({
        where: { id: task.id },
        data: { status: 'pending', attemptCount: 0, parkReason: null },
      });

      await dispatchUnblockedTasks(feature.id, task.side as 'server' | 'client');

      const updated = await findFeatureById(feature.id);
      return reply.status(200).send(updated);
    },
  );
}
