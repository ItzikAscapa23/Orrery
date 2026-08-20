import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

vi.mock('../lib/queue.js', () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
  getQueue: () => ({
    getWorkers: vi.fn().mockResolvedValue([]),
    getActive: vi.fn().mockResolvedValue([]),
    getWaiting: vi.fn().mockResolvedValue([]),
    getDelayed: vi.fn().mockResolvedValue([]),
  }),
  closeQueue: vi.fn(),
}));

vi.mock('../lib/dispatch.js', () => ({
  dispatchUnblockedTasks: vi.fn().mockResolvedValue(undefined),
  dispatchJob: vi.fn().mockResolvedValue(undefined),
  dispatchForState: vi.fn().mockResolvedValue(undefined),
  _headCommit: { value: null },
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { resumeOrphanStalledFeatures } from '../lib/startupResume.js';
import { dispatchUnblockedTasks } from '../lib/dispatch.js';

let featureId: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  vi.clearAllMocks();

  const feature = await createFeature({ name: 'Startup Resume Test', requirement: 'req' });
  featureId = feature.id;
  await getPrisma().feature.update({
    where: { id: featureId },
    data: { status: 'IMPLEMENTING' },
  });
});

afterEach(async () => {
  await disconnectPrisma();
});

async function makeTask(
  overrides: Partial<{
    status: string;
    parkReason: string | null;
    orphanCount: number;
    attemptCount: number;
    title: string;
  }> = {},
) {
  return getPrisma().task.create({
    data: {
      featureId,
      repo: 'demo-server',
      side: 'server',
      title: overrides.title ?? 'task',
      description: 'desc',
      specRefs: [],
      dependsOn: [],
      status: overrides.status ?? 'pending',
      attemptCount: overrides.attemptCount ?? 0,
      orphanCount: overrides.orphanCount ?? 0,
      parkReason: overrides.parkReason ?? null,
    },
  });
}

describe('resumeOrphanStalledFeatures', () => {
  it('resumes feature with all-orphan-parked tasks', async () => {
    await makeTask({ status: 'parked', parkReason: 'orphan' });
    await makeTask({ status: 'completed', title: 'completed task' });

    await resumeOrphanStalledFeatures();

    const tasks = await getPrisma().task.findMany({ where: { featureId } });
    const parkedTask = tasks.find((t) => t.title === 'task');
    expect(parkedTask?.status).toBe('pending'); // flipped back
    expect(parkedTask?.parkReason).toBeNull();

    expect(dispatchUnblockedTasks).toHaveBeenCalledWith(featureId, 'server');
    expect(dispatchUnblockedTasks).toHaveBeenCalledWith(featureId, 'client');
  });

  it('skips feature with any failure-parked task', async () => {
    await makeTask({ status: 'parked', parkReason: 'orphan', title: 'orphaned' });
    await makeTask({ status: 'parked', parkReason: 'failure', title: 'failed' });

    await resumeOrphanStalledFeatures();

    expect(dispatchUnblockedTasks).not.toHaveBeenCalled();

    const tasks = await getPrisma().task.findMany({ where: { featureId } });
    expect(tasks.every((t) => t.status === 'parked')).toBe(true); // nothing changed
  });

  it('skips feature with orphan_cap task', async () => {
    await makeTask({ status: 'parked', parkReason: 'orphan_cap' });

    await resumeOrphanStalledFeatures();

    expect(dispatchUnblockedTasks).not.toHaveBeenCalled();
  });

  it('skips feature with a running task', async () => {
    await makeTask({ status: 'running', title: 'running task' });
    await makeTask({ status: 'parked', parkReason: 'orphan', title: 'orphaned task' });

    await resumeOrphanStalledFeatures();

    expect(dispatchUnblockedTasks).not.toHaveBeenCalled();
  });

  it('skips feature with no orphan-parked tasks (all pending)', async () => {
    await makeTask({ status: 'pending' });

    await resumeOrphanStalledFeatures();

    expect(dispatchUnblockedTasks).not.toHaveBeenCalled();
  });
});
