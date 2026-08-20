import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_PROVIDER'] = 'anthropic';
process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockRunTestPlannerAgent, mockCommitArtifact, mockReadArtifact, MockArtifactCommitError } =
  vi.hoisted(() => {
    class MockArtifactCommitError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'ArtifactCommitError';
      }
    }
    return {
      mockRunTestPlannerAgent: vi.fn(),
      mockCommitArtifact: vi
        .fn()
        .mockReturnValue({ path: 'features/t/test-plan.md', commit: 'def', message: 'test-plan: t test-plan.md' }),
      mockReadArtifact: vi.fn().mockReturnValue('# Spec'),
      MockArtifactCommitError,
    };
  });

vi.mock('../agents/testPlannerAgent.js', () => ({
  runTestPlannerAgent: mockRunTestPlannerAgent,
}));

vi.mock('../lib/artifacts.js', () => ({
  commitArtifact: mockCommitArtifact,
  commitSpecDraft: vi.fn(),
  readArtifact: mockReadArtifact,
  ArtifactCommitError: MockArtifactCommitError,
}));

vi.mock('../lib/dispatch.js', () => ({
  dispatchForState: vi.fn().mockResolvedValue(undefined),
  dispatchJob: vi.fn().mockResolvedValue(undefined),
  dispatchUnblockedTasks: vi.fn().mockResolvedValue(undefined),
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { runTestPlannerJob } from '../jobs/testPlannerJob.js';

afterEach(async () => {
  await disconnectPrisma();
});

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  mockRunTestPlannerAgent.mockClear();
  mockCommitArtifact.mockClear();
  mockRunTestPlannerAgent.mockResolvedValue({
    coverage: [
      { taskId: 'task-1', covered: true, behaviour: 'POST /items returns 201 with item' },
      { taskId: 'task-2', covered: false, skipReason: 'Database migration only — no public surface' },
    ],
  });
});

async function makeFeatureInPlanningTests(): Promise<string> {
  const f = await createFeature({ name: 'TDD feature', requirement: 'test tdd' });
  // Must set status to PLANNING_TESTS for the job to run
  await getPrisma().feature.update({
    where: { id: f.id },
    data: { status: 'PLANNING_TESTS', proposedSpec: 'spec content' },
  });
  // Seed two tasks
  await getPrisma().task.createMany({
    data: [
      {
        id: 'task-1',
        featureId: f.id,
        repo: 'demo-server',
        side: 'server',
        title: 'Add items endpoint',
        description: 'POST /items',
        specRefs: ['API endpoints'],
        dependsOn: [],
        status: 'pending',
      },
      {
        id: 'task-2',
        featureId: f.id,
        repo: 'demo-server',
        side: 'server',
        title: 'Run DB migration',
        description: 'Migration only',
        specRefs: ['Database schema'],
        dependsOn: [],
        status: 'pending',
      },
    ],
  });
  return f.id;
}

describe('runTestPlannerJob', () => {
  it('is a no-op when feature is not in PLANNING_TESTS', async () => {
    const f = await createFeature({ name: 'Not planning', requirement: 'req' });
    await runTestPlannerJob(f.id);
    expect(mockRunTestPlannerAgent).not.toHaveBeenCalled();
    expect(mockCommitArtifact).not.toHaveBeenCalled();
  });

  it('commits test-plan.md artifact', async () => {
    const featureId = await makeFeatureInPlanningTests();
    await runTestPlannerJob(featureId);
    expect(mockCommitArtifact).toHaveBeenCalledWith(
      expect.any(String),
      'test-plan.md',
      expect.stringContaining('Test Coverage Plan'),
      'test-plan',
    );
  });

  it('skipped tasks carry a skipReason in the markdown', async () => {
    const featureId = await makeFeatureInPlanningTests();
    await runTestPlannerJob(featureId);
    const commitCall = mockCommitArtifact.mock.calls.find(
      (c: unknown[]) => c[1] === 'test-plan.md',
    );
    const markdown = commitCall?.[2] as string;
    expect(markdown).toContain('Database migration only');
    expect(markdown).toContain('✗ Skipped');
  });

  it('emits test_plan.proposed event', async () => {
    const featureId = await makeFeatureInPlanningTests();
    await runTestPlannerJob(featureId);
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const proposed = events.find((e) => e.type === 'test_plan.proposed');
    expect(proposed).not.toBeUndefined();
    expect((proposed!.payload as { coverage: unknown[] }).coverage).toHaveLength(2);
  });

  it('opens test_plan_approval gate and transitions to AWAITING_TEST_PLAN_APPROVAL', async () => {
    const featureId = await makeFeatureInPlanningTests();
    await runTestPlannerJob(featureId);
    const events = await getPrisma().event.findMany({ where: { featureId } });
    const gateEvent = events.find((e) => e.type === 'gate.opened');
    expect(gateEvent).not.toBeUndefined();
    expect((gateEvent!.payload as { gate: string }).gate).toBe('test_plan_approval');
    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('AWAITING_TEST_PLAN_APPROVAL');
  });

  it('passes task titles and specRefs to agent but NOT descriptions', async () => {
    const featureId = await makeFeatureInPlanningTests();
    await runTestPlannerJob(featureId);
    expect(mockRunTestPlannerAgent).toHaveBeenCalledWith(
      featureId,
      expect.any(String), // spec
      expect.any(String), // contract
      expect.arrayContaining([
        expect.objectContaining({ id: 'task-1', title: 'Add items endpoint', specRefs: ['API endpoints'] }),
      ]),
      expect.any(Function), // usage callback
    );
    // Agent must not receive task descriptions — verify call args
    const callArgs = mockRunTestPlannerAgent.mock.calls[0];
    const tasks = callArgs?.[3] as Array<{ description?: string }>;
    expect(tasks.every((t) => !('description' in t))).toBe(true);
  });

  it('uses mock coverage for simulated run without calling agent', async () => {
    const featureId = await makeFeatureInPlanningTests();
    await getPrisma().feature.update({ where: { id: featureId }, data: { simulatedRun: true } });
    await runTestPlannerJob(featureId);
    expect(mockRunTestPlannerAgent).not.toHaveBeenCalled();
    const events = await getPrisma().event.findMany({ where: { featureId } });
    expect(events.find((e) => e.type === 'test_plan.proposed')).not.toBeUndefined();
  });
});
