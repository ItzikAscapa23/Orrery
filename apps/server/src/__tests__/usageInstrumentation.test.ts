import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env['ANTHROPIC_API_KEY'] = 'test-key';
  process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';
  process.env['ANTHROPIC_PROVIDER'] = 'anthropic';
});

// ── Schema backward-compat ────────────────────────────────────────────────────
import { UsageRecordedPayloadSchema } from '@orrery/shared';
import type { UsageRecord } from '../lib/anthropic.js';
import { usageEventPayload, simulatedUsagePayload } from '../lib/usageEvent.js';

describe('UsageRecordedPayloadSchema backward compat', () => {
  it('historical 3-field event parses without cache/provider/job_id', () => {
    const historical = {
      type: 'usage.recorded',
      agent: 'review',
      model: 'claude-3-5-sonnet-20241022',
      input_tokens: 100,
      output_tokens: 20,
    };
    expect(() => UsageRecordedPayloadSchema.parse(historical)).not.toThrow();
  });

  it('full event with all optional fields parses', () => {
    const full = {
      type: 'usage.recorded',
      agent: 'review',
      model: 'claude-3-5-sonnet-20241022',
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 10,
      provider: 'anthropic',
      job_id: 'bullmq-123',
    };
    const result = UsageRecordedPayloadSchema.parse(full);
    expect(result.cache_creation_input_tokens).toBe(50);
    expect(result.cache_read_input_tokens).toBe(10);
    expect(result.provider).toBe('anthropic');
    expect(result.job_id).toBe('bullmq-123');
  });
});

// ── job_id threading through runReviewJob ─────────────────────────────────────

const { mockAppendEvent } = vi.hoisted(() => ({
  mockAppendEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/events.js', () => ({
  appendEvent: mockAppendEvent,
}));

const { mockRunReviewAgent } = vi.hoisted(() => ({
  mockRunReviewAgent: vi.fn(),
}));

vi.mock('../agents/reviewAgent.js', () => ({
  runReviewAgent: mockRunReviewAgent,
}));

vi.mock('../lib/prisma.js', () => {
  const tx = { $transaction: vi.fn((fn: (t: unknown) => unknown) => fn(tx)) };
  const prisma = {
    feature: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: 'feat-1',
        slug: 'test',
        name: 'Test',
        status: 'CODE_REVIEW',
        simulatedRun: false,
        currentBranches: {},
      }),
    },
    event: {
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    $transaction: vi.fn((fn: (t: unknown) => unknown) => fn(prisma)),
  };
  return { getPrisma: () => prisma, disconnectPrisma: vi.fn() };
});

vi.mock('../lib/orchestrator.js', () => ({
  applyTransition: vi.fn().mockResolvedValue(null),
}));

vi.mock('../lib/reviewCycle.js', () => ({
  gateOpenedCount: vi.fn().mockResolvedValue(1),
  getReviewRound: vi.fn().mockResolvedValue(0),
}));

vi.mock('../lib/artifacts.js', () => ({
  readArtifact: vi.fn().mockReturnValue('content'),
}));

vi.mock('../lib/persistFindings.js', () => ({
  persistFindings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/dispatch.js', () => ({
  dispatchForState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/syntheticTasks.js', () => ({
  createSyntheticFixTasks: vi.fn().mockResolvedValue([]),
}));

vi.mock('./devJob.js', () => ({
  getRepoEntry: vi.fn(),
}));

import { runReviewJob } from '../jobs/reviewJob.js';

beforeEach(() => {
  mockAppendEvent.mockClear();
  mockRunReviewAgent.mockClear();
});

describe('runReviewJob — job_id threading', () => {
  it('includes job_id on usage.recorded when jobId param is provided', async () => {
    mockRunReviewAgent.mockImplementation(
      async (
        _featureId: string,
        _prompt: string,
        onUsage: (u: {
          model: string;
          provider: string;
          input_tokens: number;
          output_tokens: number;
        }) => Promise<void>,
      ) => {
        await onUsage({
          model: 'claude-3-5-sonnet-20241022',
          provider: 'anthropic',
          input_tokens: 50,
          output_tokens: 10,
        });
        return { findings: [], priorFindingStatuses: [] };
      },
    );

    await runReviewJob('feat-1', 'bullmq-job-42');

    const usageCall = mockAppendEvent.mock.calls.find(
      (args) => (args[2] as { type: string }).type === 'usage.recorded',
    );
    expect(usageCall).toBeDefined();
    expect((usageCall![2] as { job_id: string }).job_id).toBe('bullmq-job-42');
  });

  it('omits job_id on usage.recorded when jobId is not provided', async () => {
    mockRunReviewAgent.mockImplementation(
      async (
        _featureId: string,
        _prompt: string,
        onUsage: (u: {
          model: string;
          provider: string;
          input_tokens: number;
          output_tokens: number;
        }) => Promise<void>,
      ) => {
        await onUsage({
          model: 'claude-3-5-sonnet-20241022',
          provider: 'anthropic',
          input_tokens: 50,
          output_tokens: 10,
        });
        return { findings: [], priorFindingStatuses: [] };
      },
    );

    await runReviewJob('feat-1');

    const usageCall = mockAppendEvent.mock.calls.find(
      (args) => (args[2] as { type: string }).type === 'usage.recorded',
    );
    expect(usageCall).toBeDefined();
    expect((usageCall![2] as Record<string, unknown>)['job_id']).toBeUndefined();
  });
});

// ── usageEventPayload helper ──────────────────────────────────────────────────

describe('usageEventPayload helper', () => {
  it('includes provider, cache fields, and job_id for a real-job site', () => {
    const usage: UsageRecord = {
      model: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 50,
    };
    const payload = usageEventPayload(usage, 'review', { jobId: 'j-1' });
    expect(payload.type).toBe('usage.recorded');
    expect(payload.agent).toBe('review');
    expect(payload.provider).toBe('anthropic');
    expect(payload.cache_creation_input_tokens).toBe(200);
    expect(payload.cache_read_input_tokens).toBe(50);
    expect(payload.job_id).toBe('j-1');
    expect(payload.simulated).toBeUndefined();
  });

  it('omits cache fields when not present on UsageRecord', () => {
    const usage: UsageRecord = {
      model: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
      input_tokens: 10,
      output_tokens: 5,
    };
    const payload = usageEventPayload(usage, 'spec');
    expect(payload.cache_creation_input_tokens).toBeUndefined();
    expect(payload.cache_read_input_tokens).toBeUndefined();
    expect(payload.job_id).toBeUndefined();
    expect(payload.simulated).toBeUndefined();
  });
});

// ── simulatedUsagePayload helper ──────────────────────────────────────────────

describe('simulatedUsagePayload helper', () => {
  it('marks event as simulated with provider "simulated"', () => {
    const p = simulatedUsagePayload('aws', 'claude-sonnet-5', 600, 150);
    expect(p.type).toBe('usage.recorded');
    expect(p.simulated).toBe(true);
    expect(p.provider).toBe('simulated');
    expect(p.agent).toBe('aws');
    expect(p.input_tokens).toBe(600);
  });
});

// ── Schema: simulated field ───────────────────────────────────────────────────

describe('UsageRecordedPayloadSchema — simulated field', () => {
  it('parses event with simulated: true', () => {
    const withSimulated = {
      type: 'usage.recorded',
      agent: 'aws',
      model: 'claude-sonnet-5',
      input_tokens: 10,
      output_tokens: 5,
      simulated: true,
    };
    const r = UsageRecordedPayloadSchema.parse(withSimulated);
    expect(r.simulated).toBe(true);
  });

  it('simulated is absent (undefined) when not provided', () => {
    const without = {
      type: 'usage.recorded',
      agent: 'aws',
      model: 'claude-sonnet-5',
      input_tokens: 10,
      output_tokens: 5,
    };
    expect(UsageRecordedPayloadSchema.parse(without).simulated).toBeUndefined();
  });
});
