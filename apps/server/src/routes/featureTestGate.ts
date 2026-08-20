import type { FastifyInstance } from 'fastify';
import type { FeatureStatus } from '@prisma/client';
import { findFeatureById } from '../lib/features.js';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { dispatchJob, dispatchForState } from '../lib/dispatch.js';
import { gateOpenedCount } from '../lib/reviewCycle.js';

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureTestGateRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /approve-test ────────────────────────────────────────────────────
  // Valid in TESTING when the test_report gate is open. All blocker findings
  // (test failures) for the current cycle must already be dismissed. Fires TEST_PASS.
  app.post<{ Params: { id: string } }>('/features/:id/approve-test', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }
    if (feature.status !== 'TESTING') {
      return reply.status(409).send({ error: 'Feature is not in TESTING' });
    }

    const cycleRev = (await gateOpenedCount(feature.id)) - 1;
    const unresolvedBlockers = await getPrisma().finding.count({
      where: { featureId: feature.id, specRev: cycleRev, severity: 'blocker', resolution: null },
    });
    if (unresolvedBlockers > 0) {
      return reply.status(409).send({
        error: `${unresolvedBlockers} test failure(s) must be dismissed before approval`,
      });
    }

    await getPrisma().$transaction(async (tx) => {
      await appendEvent(tx, feature.id, {
        type: 'gate.resolved',
        gate: 'test_report',
        resolution: 'approved',
      });
      const next = await applyTransition(tx, feature.id, 'TESTING', 'TEST_PASS');
      if (next) {
        await appendEvent(tx, feature.id, {
          type: 'phase.changed',
          from: 'TESTING',
          to: next,
        });
      }
    });

    const updated = await findFeatureById(feature.id);
    if (updated?.status && updated.status !== 'TESTING') {
      await dispatchForState(feature.id, updated.status as FeatureStatus, feature);
    }

    return reply.status(200).send(updated);
  });

  // ── POST /retry-test ──────────────────────────────────────────────────────
  // Re-enqueue the test job after a Bedrock error or infra failure. Feature
  // must be in TESTING. Same pattern as POST /retry-review.
  app.post<{ Params: { id: string } }>('/features/:id/retry-test', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }
    if (feature.status !== 'TESTING') {
      return reply.status(409).send({
        error: `retry-test is only valid in TESTING state (current: ${feature.status})`,
      });
    }

    await appendEvent(getPrisma(), feature.id, {
      type: 'agent.log',
      agent: 'orchestrator',
      severity: 'muted',
      text: '↻ test agent retried by operator',
    });

    await dispatchJob(feature.id, 'test');

    return reply.status(200).send({ dispatched: 'test' });
  });
}
