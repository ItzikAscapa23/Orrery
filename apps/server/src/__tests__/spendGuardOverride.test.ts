/**
 * Integration tests for the spend-guard override behaviour (task 164).
 *
 * These tests use a real DB to verify that the SQL correlated subquery correctly
 * scopes the turn count to events after the last gate.resolved anchor.
 * The unit tests in spendGuard.test.ts cover the threshold arithmetic with mocks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { checkSpendGuard } from '../lib/spendGuard.js';

// Use a small threshold so tests don't need 150 events.
const TEST_THRESHOLD = 3;

async function insertUsageEvents(featureId: string, taskId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await appendEvent(getPrisma(), featureId, {
      type: 'usage.recorded',
      agent: 'dev',
      model: 'test-model',
      input_tokens: 10,
      output_tokens: 5,
      task_id: taskId,
      job_id: `job-${i}`,
    });
  }
}

let featureId: string;
let taskId: string;

beforeEach(async () => {
  process.env['SPEND_GUARD_MAX_TURNS'] = String(TEST_THRESHOLD);
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;

  const feature = await getPrisma().feature.create({
    data: { slug: 'sg-test', name: 'Spend Guard Test', requirement: 'req' },
  });
  featureId = feature.id;

  const task = await getPrisma().task.create({
    data: {
      featureId,
      repo: 'demo-server',
      side: 'server',
      title: 'Test task',
      description: 'desc',
      specRefs: [],
      dependsOn: [],
      status: 'pending',
    },
  });
  taskId = task.id;
});

afterEach(async () => {
  delete process.env['SPEND_GUARD_MAX_TURNS'];
  await disconnectPrisma();
});

describe('checkSpendGuard — override anchor (task 164)', () => {
  it('parks when turns reach threshold with no prior override', async () => {
    await insertUsageEvents(featureId, taskId, TEST_THRESHOLD);
    const result = await checkSpendGuard(featureId, taskId, 'Test task');
    expect(result).toMatchObject({ parked: true });
  });

  it('does NOT re-park after gate.resolved — count resets to 0 after override (fails before fix)', async () => {
    // Reach the threshold → park
    await insertUsageEvents(featureId, taskId, TEST_THRESHOLD);
    await checkSpendGuard(featureId, taskId, 'Test task');

    // Simulate RESUME: reset task status and append gate.resolved
    await getPrisma().task.update({
      where: { id: taskId },
      data: { status: 'pending', parkReason: null, bullJobId: null },
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'gate.resolved',
      gate: 'spend_guard',
      resolution: 'override',
      taskId,
    });

    // No new usage events since the override — guard must grant a fresh window
    const result = await checkSpendGuard(featureId, taskId, 'Test task');
    expect(result).toMatchObject({ parked: false, remainingBudget: TEST_THRESHOLD });
  });

  it('parks again after a second override window is exhausted', async () => {
    // First window: reach threshold
    await insertUsageEvents(featureId, taskId, TEST_THRESHOLD);
    await checkSpendGuard(featureId, taskId, 'Test task');

    // Override 1
    await getPrisma().task.update({
      where: { id: taskId },
      data: { status: 'pending', parkReason: null, bullJobId: null },
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'gate.resolved',
      gate: 'spend_guard',
      resolution: 'override',
      taskId,
    });

    // Second window: add threshold more events
    await insertUsageEvents(featureId, taskId, TEST_THRESHOLD);

    // Must park again — second window exhausted
    const result = await checkSpendGuard(featureId, taskId, 'Test task');
    expect(result).toMatchObject({ parked: true });
  });
});
