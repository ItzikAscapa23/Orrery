import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { maybeAdvanceToReview } from '../lib/maybeAdvance.js';

let featureId: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  const feature = await createFeature({ name: 'Advance Test', requirement: 'req' });
  featureId = feature.id;
  await getPrisma().feature.update({
    where: { id: featureId },
    data: { status: 'IMPLEMENTING' },
  });
});

afterEach(async () => {
  await disconnectPrisma();
});

async function seedTask(status: string) {
  return getPrisma().task.create({
    data: {
      featureId,
      repo: 'demo-server',
      side: 'server',
      title: 'Task',
      description: 'desc',
      specRefs: [],
      dependsOn: [],
      status,
    },
  });
}

describe('maybeAdvanceToReview', () => {
  it('does not advance when tasks are still incomplete', async () => {
    await seedTask('pending');
    await maybeAdvanceToReview(featureId);

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('IMPLEMENTING');
  });

  it('simulated run: stops at CODE_REVIEW so simulate-resume can walk the review path', async () => {
    // Phase 5: simulated runs no longer auto-advance past CODE_REVIEW.
    // dispatchForState('CODE_REVIEW', { simulated_run: true }) enqueues
    // simulate-resume which walks the configured review sub-path.
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { simulatedRun: true },
    });
    await seedTask('completed');
    const newState = await maybeAdvanceToReview(featureId);

    expect(newState).toBe('CODE_REVIEW');
    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('CODE_REVIEW');

    const events = await getPrisma().event.findMany({
      where: { featureId, type: 'phase.changed' },
      orderBy: { seq: 'asc' },
    });
    const phases = events.map((e) => (e.payload as { to: string }).to);
    expect(phases).toContain('CODE_REVIEW');
    expect(phases).not.toContain('TESTING');
    expect(phases).not.toContain('DONE');
  });

  it('real run: stops at CODE_REVIEW and returns CODE_REVIEW', async () => {
    // simulatedRun defaults to false — no update needed.
    await seedTask('completed');
    const newState = await maybeAdvanceToReview(featureId);

    expect(newState).toBe('CODE_REVIEW');
    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('CODE_REVIEW');

    const events = await getPrisma().event.findMany({
      where: { featureId, type: 'phase.changed' },
      orderBy: { seq: 'asc' },
    });
    const phases = events.map((e) => (e.payload as { to: string }).to);
    expect(phases).toContain('CODE_REVIEW');
    expect(phases).not.toContain('TESTING');
    expect(phases).not.toContain('DONE');
  });

  it('is a no-op when called twice (idempotent — double-fire safe)', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { simulatedRun: true },
    });
    await seedTask('completed');
    await maybeAdvanceToReview(featureId);
    const secondResult = await maybeAdvanceToReview(featureId); // second call must not throw

    expect(secondResult).toBeNull();
    // Phase 5: simulated runs stop at CODE_REVIEW (no longer auto-advance to DONE)
    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('CODE_REVIEW');
  });

  it('does not advance when feature is not in IMPLEMENTING', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'AWAITING_PLAN_APPROVAL' },
    });
    await seedTask('completed');
    await maybeAdvanceToReview(featureId);

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('AWAITING_PLAN_APPROVAL');
  });

  it('does not advance when one task is completed but another is pending', async () => {
    await seedTask('completed');
    await seedTask('pending');
    await maybeAdvanceToReview(featureId);

    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('IMPLEMENTING');
  });
});
