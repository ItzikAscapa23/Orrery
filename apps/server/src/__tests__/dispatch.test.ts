import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockEnqueueJob } = vi.hoisted(() => ({
  mockEnqueueJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/queue.js', () => ({
  enqueueJob: mockEnqueueJob,
  getQueue: vi.fn(),
  closeQueue: vi.fn(),
}));

const { mockAppendEvent } = vi.hoisted(() => ({
  mockAppendEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/events.js', () => ({
  appendEvent: mockAppendEvent,
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import * as dispatchModule from '../lib/dispatch.js';
const { dispatchForState, dispatchJob } = dispatchModule;
import { getQueue } from '../lib/queue.js';
import type { Feature } from '../lib/features.js';

afterEach(async () => {
  await disconnectPrisma();
});

const baseFeature: Feature = {
  id: 'f1',
  slug: 'test',
  name: 'Test',
  requirement: 'req',
  status: 'DRAFTING_SPEC',
  proposed_spec: null,
  simulated_run: false,
  repos: [],
  feature_path: 'FULL',
  created_at: new Date().toISOString(),
  current_branches: {},
  review_skipped: false,
};

beforeEach(async () => {
  mockEnqueueJob.mockClear();
  mockAppendEvent.mockClear();
  dispatchModule._headCommit.value = null; // reset between tests; each drift test sets its own value
  // Ensure no stale tasks from previous tests
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
});

describe('dispatchForState', () => {
  it('enqueues aws-review on entering AWS_REVIEW', async () => {
    await dispatchForState('feat-1', 'AWS_REVIEW', baseFeature);
    expect(mockEnqueueJob).toHaveBeenCalledWith('feat-1', 'aws-review', undefined);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
  });

  it('enqueues plan on entering PLANNING (real run)', async () => {
    await dispatchForState('feat-2', 'PLANNING', { ...baseFeature, simulated_run: false });
    expect(mockEnqueueJob).toHaveBeenCalledWith('feat-2', 'plan', undefined);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
  });

  it('enqueues plan on entering PLANNING (simulated run)', async () => {
    await dispatchForState('feat-3', 'PLANNING', { ...baseFeature, simulated_run: true });
    expect(mockEnqueueJob).toHaveBeenCalledWith('feat-3', 'plan', undefined);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
  });

  it('enqueues nothing on entering AWAITING_APPROVAL', async () => {
    await dispatchForState('feat-4', 'AWAITING_APPROVAL', baseFeature);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('enqueues nothing on entering DRAFTING_SPEC', async () => {
    await dispatchForState('feat-5', 'DRAFTING_SPEC', baseFeature);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('enqueues nothing on entering DONE', async () => {
    await dispatchForState('feat-6', 'DONE', baseFeature);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('enqueues simulate-resume on entering IMPLEMENTING for simulated run', async () => {
    await dispatchForState('feat-7', 'IMPLEMENTING', { ...baseFeature, simulated_run: true });
    expect(mockEnqueueJob).toHaveBeenCalledWith('feat-7', 'simulate-resume', undefined);
  });

  it('enqueues one server-dev job per repo per wave on IMPLEMENTING (real run)', async () => {
    // Seed a feature with two server tasks on different repos — one per repo
    // dispatched per wave (one-task-per-repo-per-wave invariant).
    const feature = await getPrisma().feature.create({
      data: { id: 'feat-8', slug: 'feat-8', name: 'T', requirement: 'req' },
    });
    await getPrisma().task.createMany({
      data: [
        {
          id: 't1',
          featureId: feature.id,
          repo: 'demo-server',
          side: 'server',
          title: 'Task 1',
          description: 'Do it.',
          status: 'pending',
        },
        {
          id: 't2',
          featureId: feature.id,
          repo: 'demo-api', // different repo — dispatches independently
          side: 'server',
          title: 'Task 2',
          description: 'Do it too.',
          status: 'pending',
        },
      ],
    });

    await dispatchForState(feature.id, 'IMPLEMENTING', { ...baseFeature, simulated_run: false });

    // One job per repo: t1 (demo-server) and t2 (demo-api) both dispatch.
    expect(mockEnqueueJob).toHaveBeenCalledWith(feature.id, 'server-dev', { taskId: 't1' });
    expect(mockEnqueueJob).toHaveBeenCalledWith(feature.id, 'server-dev', { taskId: 't2' });
  });

  it('enqueues only first task per repo per wave when two tasks share a repo', async () => {
    const feature = await getPrisma().feature.create({
      data: { id: 'feat-9', slug: 'feat-9', name: 'T2', requirement: 'req' },
    });
    await getPrisma().task.createMany({
      data: [
        {
          id: 't3',
          featureId: feature.id,
          repo: 'demo-server',
          side: 'server',
          title: 'Task A',
          description: 'First.',
          status: 'pending',
        },
        {
          id: 't4',
          featureId: feature.id,
          repo: 'demo-server',
          side: 'server',
          title: 'Task B',
          description: 'Second.',
          status: 'pending',
        },
      ],
    });

    await dispatchForState(feature.id, 'IMPLEMENTING', { ...baseFeature, simulated_run: false });

    // Only t3 (first by createdAt) dispatched — t4 blocked by one-per-repo-per-wave
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(feature.id, 'server-dev', { taskId: 't3' });
  });

  // ── Light path (14b) ──────────────────────────────────────────────────────

  it('enqueues light-dev jobs for each repo on LIGHT_IMPLEMENTING', async () => {
    const lightFeature = await getPrisma().feature.create({
      data: {
        id: 'feat-light-1',
        slug: 'feat-light-1',
        name: 'Light Feature',
        requirement: 'req',
        repos: ['swaggers', 'bff-configurations'],
        featurePath: 'LIGHT',
      },
    });

    await dispatchForState(lightFeature.id, 'LIGHT_IMPLEMENTING', {
      ...baseFeature,
      simulated_run: false,
    });

    expect(mockEnqueueJob).toHaveBeenCalledTimes(2);
    expect(mockEnqueueJob).toHaveBeenCalledWith(lightFeature.id, 'light-dev', {
      repoId: 'swaggers',
    });
    expect(mockEnqueueJob).toHaveBeenCalledWith(lightFeature.id, 'light-dev', {
      repoId: 'bff-configurations',
    });
  });

  it('creates no Task rows for a light feature dispatched at LIGHT_IMPLEMENTING', async () => {
    const lightFeature = await getPrisma().feature.create({
      data: {
        id: 'feat-light-2',
        slug: 'feat-light-2',
        name: 'Light Feature 2',
        requirement: 'req',
        repos: ['swaggers'],
        featurePath: 'LIGHT',
      },
    });

    await dispatchForState(lightFeature.id, 'LIGHT_IMPLEMENTING', {
      ...baseFeature,
      simulated_run: false,
    });

    const tasks = await getPrisma().task.findMany({ where: { featureId: lightFeature.id } });
    expect(tasks).toHaveLength(0);
  });
});

describe('dispatchJob drift detection', () => {
  beforeEach(() => {
    vi.mocked(getQueue).mockReturnValue({
      getWorkers: vi.fn().mockResolvedValue([{ id: 'w1' }]),
    } as unknown as ReturnType<typeof getQueue>);
  });

  it('emits no drift event when stamp equals HEAD', async () => {
    process.env['WORKER_CODE_COMMIT'] = 'abc1234';
    dispatchModule._headCommit.value = 'abc1234';
    await dispatchJob('feat-drift-1', 'aws-review');
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it('emits console.error and agent.log event when stamp differs from HEAD', async () => {
    process.env['WORKER_CODE_COMMIT'] = 'oldhash';
    dispatchModule._headCommit.value = 'newhash';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await dispatchJob('feat-drift-2', 'aws-review');
    const driftCall = consoleSpy.mock.calls.find((args) => {
      try {
        return (JSON.parse(String(args[0])) as { event: string }).event === 'dispatch_commit_drift';
      } catch {
        return false;
      }
    });
    expect(driftCall).toBeDefined();
    const parsed = JSON.parse(String(driftCall![0])) as {
      worker_commit: string;
      head_commit: string;
    };
    expect(parsed.worker_commit).toBe('oldhash');
    expect(parsed.head_commit).toBe('newhash');
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.anything(),
      'feat-drift-2',
      expect.objectContaining({
        type: 'agent.log',
        severity: 'muted',
        agent: 'orchestrator',
      }),
    );
    consoleSpy.mockRestore();
  });

  it('emits nothing when WORKER_CODE_COMMIT is "unknown"', async () => {
    process.env['WORKER_CODE_COMMIT'] = 'unknown';
    dispatchModule._headCommit.value = 'newhash';
    await dispatchJob('feat-drift-3', 'aws-review');
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it('emits nothing when WORKER_CODE_COMMIT is absent', async () => {
    delete process.env['WORKER_CODE_COMMIT'];
    dispatchModule._headCommit.value = 'newhash';
    await dispatchJob('feat-drift-4', 'aws-review');
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it('dispatch still proceeds and emits nothing when headCommit is null', async () => {
    process.env['WORKER_CODE_COMMIT'] = 'oldhash';
    dispatchModule._headCommit.value = null; // simulates git call having failed at startup
    await expect(dispatchJob('feat-drift-5', 'aws-review')).resolves.toBeUndefined();
    expect(mockAppendEvent).not.toHaveBeenCalled();
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
  });
});

// ── dispatchForState: PLANNING_TESTS ─────────────────────────────────────────

describe('dispatchForState — PLANNING_TESTS', () => {
  it('enqueues test-plan for real run', async () => {
    await dispatchForState('feat-pt-1', 'PLANNING_TESTS', baseFeature);
    expect(mockEnqueueJob).toHaveBeenCalledWith('feat-pt-1', 'test-plan', undefined);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
  });

  it('enqueues simulate-resume for simulated run', async () => {
    await dispatchForState('feat-pt-2', 'PLANNING_TESTS', { ...baseFeature, simulated_run: true });
    expect(mockEnqueueJob).toHaveBeenCalledWith('feat-pt-2', 'simulate-resume', undefined);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
  });
});

// ── dispatchUnblockedTasks: coverage routing ──────────────────────────────────

describe('dispatchUnblockedTasks — coverage routing', () => {
  const { dispatchUnblockedTasks } = dispatchModule;

  async function makeFeatureWithTask(
    featureId: string,
    coveredByTestPlan: boolean,
    testsWritten: boolean,
  ): Promise<string> {
    await getPrisma().feature.create({
      data: { id: featureId, slug: featureId, name: 'T', requirement: 'req' },
    });
    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo: 'demo-server',
        side: 'server',
        title: 'Task',
        description: 'Do it',
        status: 'pending',
        coveredByTestPlan,
        testsWritten,
      },
    });
    return task.id;
  }

  it('dispatches server-test-task for covered task with testsWritten=false', async () => {
    await makeFeatureWithTask('cov-feat-1', true, false);
    await dispatchUnblockedTasks('cov-feat-1', 'server');
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      'cov-feat-1',
      'server-test-task',
      expect.any(Object),
    );
  });

  it('dispatches server-dev for covered task with testsWritten=true', async () => {
    await makeFeatureWithTask('cov-feat-2', true, true);
    await dispatchUnblockedTasks('cov-feat-2', 'server');
    expect(mockEnqueueJob).toHaveBeenCalledWith('cov-feat-2', 'server-dev', expect.any(Object));
  });

  it('dispatches server-dev for uncovered task (coveredByTestPlan=false)', async () => {
    await makeFeatureWithTask('cov-feat-3', false, false);
    await dispatchUnblockedTasks('cov-feat-3', 'server');
    expect(mockEnqueueJob).toHaveBeenCalledWith('cov-feat-3', 'server-dev', expect.any(Object));
  });

  it('dispatches server-dev for covered task with testsWritten=false but testTaskAttempts>0', async () => {
    // A task that already had a test-task attempt (failed) must bypass the test
    // job and go straight to the dev job — prevents infinite re-routing.
    const taskId = await makeFeatureWithTask('cov-feat-4', true, false);
    await getPrisma().task.update({ where: { id: taskId }, data: { testTaskAttempts: 1 } });
    await dispatchUnblockedTasks('cov-feat-4', 'server');
    expect(mockEnqueueJob).toHaveBeenCalledWith('cov-feat-4', 'server-dev', expect.any(Object));
  });

  it('does not log dispatch_no_tasks when all tasks are awaiting_tests (R-25)', async () => {
    // A covered task in awaiting_tests has committed code but is waiting for the
    // test agent. dispatchUnblockedTasks fires (nothing to dispatch) but must not
    // log the seeding-bug warning — awaiting_tests is a legitimate quiet state.
    const taskId = await makeFeatureWithTask('cov-feat-5', true, false);
    await getPrisma().task.update({ where: { id: taskId }, data: { status: 'awaiting_tests' } });
    const errSpy = vi.spyOn(console, 'error');
    await dispatchUnblockedTasks('cov-feat-5', 'server');
    const noTasksWarning = errSpy.mock.calls.some((args) =>
      String(args[0]).includes('dispatch_no_tasks'),
    );
    expect(noTasksWarning).toBe(false);
    errSpy.mockRestore();
  });
});
