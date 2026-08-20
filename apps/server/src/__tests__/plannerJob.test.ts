import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_PROVIDER'] = 'anthropic';
process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

// Use vi.hoisted so MockArtifactCommitError is available inside the vi.mock factory
// (vi.mock factories are hoisted before module declarations).
const { mockRunPlannerAgent, mockCommitArtifact, mockReadArtifact, MockArtifactCommitError } =
  vi.hoisted(() => {
    class MockArtifactCommitError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'ArtifactCommitError';
      }
    }
    return {
      mockRunPlannerAgent: vi.fn(),
      mockCommitArtifact: vi
        .fn()
        .mockReturnValue({ path: 'features/t/plan.md', commit: 'abc', message: 'plan: t plan.md' }),
      mockReadArtifact: vi.fn().mockReturnValue(null),
      MockArtifactCommitError,
    };
  });

vi.mock('../agents/plannerAgent.js', () => ({
  runPlannerAgent: mockRunPlannerAgent,
  buildSystemPrompt: vi.fn().mockReturnValue('system prompt'),
}));

// ArtifactCommitError must be re-exported from the mock so instanceof checks in
// plannerJob.ts work correctly against the same class reference.
vi.mock('../lib/artifacts.js', () => ({
  commitArtifact: mockCommitArtifact,
  commitSpecDraft: vi.fn(),
  readArtifact: mockReadArtifact,
  ArtifactCommitError: MockArtifactCommitError,
}));

vi.mock('../lib/queue.js', () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
  getQueue: vi.fn(),
  closeQueue: vi.fn(),
  dispatchJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/dispatch.js', () => ({
  dispatchForState: vi.fn().mockResolvedValue(undefined),
  dispatchJob: vi.fn().mockResolvedValue(undefined),
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { appendEvent } from '../lib/events.js';
import { runPlannerJob } from '../jobs/plannerJob.js';

const MOCK_PLAN_OUTPUT = {
  contract_yaml: 'openapi: "3.0.0"\ninfo:\n  title: T\n  version: "1"\npaths: {}',
  tasks: [
    {
      repo: 'demo-server',
      side: 'server' as const,
      title: 'Task 1',
      description: 'Do it.',
      spec_refs: [],
      depends_on: [],
    },
  ],
};

let featureId: string;
let featureSlug: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  vi.clearAllMocks();
  mockRunPlannerAgent.mockResolvedValue(MOCK_PLAN_OUTPUT);
  mockCommitArtifact.mockReturnValue({
    path: 'features/t/plan.md',
    commit: 'abc',
    message: 'plan: t plan.md',
  });
  mockReadArtifact.mockReturnValue(null);

  const feature = await createFeature({ name: 'Revision Test', requirement: 'req' });
  featureId = feature.id;
  featureSlug = feature.slug;

  await getPrisma().feature.update({
    where: { id: featureId },
    data: { status: 'PLANNING', proposedSpec: '## Overview\nSpec here.' },
  });
});

afterEach(async () => {
  await disconnectPrisma();
});

// ── Revision detection ────────────────────────────────────────────────────────

describe('plannerJob — revision detection', () => {
  it('first plan after spec revisions stays in initial mode (no plan.proposed event)', async () => {
    // Simulate a spec that was revised: a spec gate.opened event exists (specRev=1)
    // but no plan.proposed event — this is a first-time plan generation.
    await appendEvent(getPrisma(), featureId, {
      type: 'gate.opened',
      gate: 'spec_approval',
      summary: 'Spec rev 1',
      revision: 0,
    });

    await runPlannerJob(featureId);

    // runPlannerAgent must be called with revisionContext === undefined
    expect(mockRunPlannerAgent).toHaveBeenCalledTimes(1);
    const [, , , , revisionContext] = mockRunPlannerAgent.mock.calls[0] as unknown[];
    expect(revisionContext).toBeUndefined();
  });

  it('plan revision uses plan-gate comment when plan.proposed exists', async () => {
    // Spec gate request-changes — should be ignored by plan revision
    await appendEvent(getPrisma(), featureId, {
      type: 'gate.resolved',
      gate: 'spec_approval',
      resolution: 'changes_requested',
      comment: 'SPEC_COMMENT',
    });
    // Plan was generated
    await appendEvent(getPrisma(), featureId, {
      type: 'plan.proposed',
      agent: 'planner',
      spec_rev: 0,
      plan_summary: '1 task(s)',
      task_count: 1,
      tasks: [],
    });
    // Plan gate request-changes with the real plan comment
    await appendEvent(getPrisma(), featureId, {
      type: 'gate.resolved',
      gate: 'plan_approval',
      resolution: 'changes_requested',
      comment: 'PLAN_COMMENT',
    });

    // plan.md exists on disk
    mockReadArtifact.mockReturnValue('Prior plan content');

    await runPlannerJob(featureId);

    expect(mockRunPlannerAgent).toHaveBeenCalledTimes(1);
    const [, , , , revisionContext] = mockRunPlannerAgent.mock.calls[0] as unknown[];
    expect((revisionContext as { comment: string } | undefined)?.comment).toBe('PLAN_COMMENT');
    expect((revisionContext as { priorPlan: string } | undefined)?.priorPlan).toBe(
      'Prior plan content',
    );
  });

  it('falls back to initial mode when plan.md is missing even if plan.proposed exists', async () => {
    await appendEvent(getPrisma(), featureId, {
      type: 'plan.proposed',
      agent: 'planner',
      spec_rev: 0,
      plan_summary: '1 task(s)',
      task_count: 1,
      tasks: [],
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'gate.resolved',
      gate: 'plan_approval',
      resolution: 'changes_requested',
      comment: 'Split the tasks',
    });

    // readArtifact returns null (plan.md not on disk)
    mockReadArtifact.mockReturnValue(null);

    await runPlannerJob(featureId);

    expect(mockRunPlannerAgent).toHaveBeenCalledTimes(1);
    const [, , , , revisionContext] = mockRunPlannerAgent.mock.calls[0] as unknown[];
    expect(revisionContext).toBeUndefined();
  });

  it('spec-gate comment is never injected into plan revision', async () => {
    // Only a spec-gate changes_requested exists (no plan-gate one yet)
    await appendEvent(getPrisma(), featureId, {
      type: 'gate.resolved',
      gate: 'spec_approval',
      resolution: 'changes_requested',
      comment: 'SPEC_ONLY_COMMENT',
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'plan.proposed',
      agent: 'planner',
      spec_rev: 0,
      plan_summary: '1 task(s)',
      task_count: 1,
      tasks: [],
    });
    // No plan-gate request-changes event
    mockReadArtifact.mockReturnValue('Prior plan content');

    await runPlannerJob(featureId);

    expect(mockRunPlannerAgent).toHaveBeenCalledTimes(1);
    const [, , , , revisionContext] = mockRunPlannerAgent.mock.calls[0] as unknown[];
    // No plan-gate comment → falls back to initial mode
    expect(revisionContext).toBeUndefined();

    void featureSlug; // used for clarity
  });
});

// ── ArtifactCommitError handling ─────────────────────────────────────────────

describe('plannerJob — artifact commit error handling', () => {
  it('re-throws ArtifactCommitError so the gate is NOT opened', async () => {
    mockCommitArtifact.mockImplementation(() => {
      throw new MockArtifactCommitError('git commit failed for test/plan.md: Command failed');
    });

    await expect(runPlannerJob(featureId)).rejects.toThrow(MockArtifactCommitError);

    // gate.opened must NOT have been emitted
    const gateEvent = await getPrisma().event.findFirst({
      where: { featureId, type: 'gate.opened' },
    });
    expect(gateEvent).toBeNull();

    // Feature must still be in PLANNING
    const feature = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(feature?.status).toBe('PLANNING');
  });

  it('uses the error fallback (opens gate) for non-artifact errors like model failure', async () => {
    mockRunPlannerAgent.mockRejectedValue(new Error('Bedrock timeout'));

    // Should NOT throw — fallback advances to AWAITING_PLAN_APPROVAL
    await expect(runPlannerJob(featureId)).resolves.toBeUndefined();

    const gateEvent = await getPrisma().event.findFirst({
      where: { featureId, type: 'gate.opened' },
    });
    expect(gateEvent).not.toBeNull();
  });

  it('no-op path: commitArtifact returns HEAD SHA without error when called with identical content', async () => {
    // commitArtifact returning normally (mocked success) is the no-op behaviour;
    // the unit-level no-op test is in artifacts.test.ts.
    // Here we just verify plannerJob completes and opens the gate normally.
    await expect(runPlannerJob(featureId)).resolves.toBeUndefined();

    const gateEvent = await getPrisma().event.findFirst({
      where: { featureId, type: 'gate.opened' },
    });
    expect(gateEvent).not.toBeNull();
  });
});
