import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { dispatchForState } from '../lib/dispatch.js';

/**
 * Phase 5a stub: auto-advances TESTING → DONE until the real Test Agent lands
 * in 5b. Replaced by testJob.ts when 5b wires the real agent.
 */
export async function runTestingStubJob(featureId: string): Promise<void> {
  const feature = await getPrisma().feature.findUniqueOrThrow({
    where: { id: featureId },
    select: { status: true, simulatedRun: true },
  });

  if (feature.status !== 'TESTING') return;

  await appendEvent(getPrisma(), featureId, {
    type: 'agent.log',
    agent: 'orchestrator',
    severity: 'muted',
    text: '◦ TESTING auto-advance: real test agent not yet implemented (Phase 5b)',
  });

  let nextState: string | null = null;
  await getPrisma().$transaction(async (tx) => {
    const next = await applyTransition(tx, featureId, 'TESTING', 'TEST_PASS');
    if (next) {
      nextState = next;
      await appendEvent(tx, featureId, { type: 'phase.changed', from: 'TESTING', to: next });
    }
  });

  if (nextState) {
    await dispatchForState(featureId, nextState as import('@prisma/client').FeatureStatus, {
      simulated_run: feature.simulatedRun,
    });
  }
}
