import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Must run before ANY server module evaluates env.ts (parses process.env at module-load time).
vi.hoisted(() => {
  process.env['ANTHROPIC_API_KEY'] = 'test-key';
  process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';
});

import { createApp } from '../app.js';
import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { appendEvent } from '../lib/events.js';
import type { CostResult } from '../lib/costCalc.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let featureId: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  await getPrisma().$executeRaw`TRUNCATE model_rates`;

  const feature = await createFeature({ name: 'Cost Test Feature', requirement: 'req' });
  featureId = feature.id;
  app = await createApp();
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

async function inject(path: string) {
  return app.inject({ method: 'GET', url: path });
}

async function seedRate(
  provider: string,
  model: string,
  effectiveFrom: Date,
  input: number,
  output: number,
  cacheWrite: number | null,
  cacheRead: number | null,
) {
  await getPrisma().modelRate.upsert({
    where: { provider_model_effectiveFrom: { provider, model, effectiveFrom } },
    create: {
      provider,
      model,
      effectiveFrom,
      inputPerMToken: input,
      outputPerMToken: output,
      cacheWritePerMToken: cacheWrite,
      cacheReadPerMToken: cacheRead,
    },
    update: {},
  });
}

describe('GET /features/:id/cost', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await inject('/features/00000000-0000-0000-0000-000000000000/cost');
    expect(res.statusCode).toBe(404);
  });

  it('returns zero totals when there are no usage events', async () => {
    const res = await inject(`/features/${featureId}/cost`);
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResult>();
    expect(body.total_usd).toBe(0);
    expect(body.priced_events).toBe(0);
    expect(body.partial_events).toBe(0);
    expect(body.unpriceable_events).toBe(0);
    expect(body.rate_unknown_events).toBe(0);
    expect(body.tagged_simulated_events).toBe(0);
  });

  it('computes correct cost to the cent for a fully-shaped event', async () => {
    await seedRate('anthropic', 'claude-sonnet-4-6', new Date('2025-10-01T00:00:00Z'), 3, 15, 3.75, 0.3);
    await appendEvent(getPrisma(), featureId, {
      type: 'usage.recorded',
      agent: 'spec',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 100,
    });

    const res = await inject(`/features/${featureId}/cost`);
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResult>();

    // (3×1000 + 15×500 + 3.75×200 + 0.30×100) / 1_000_000
    // = (3000 + 7500 + 750 + 30) / 1_000_000 = 11280 / 1_000_000 = 0.01128
    expect(body.total_usd).toBeCloseTo(0.01128, 8);
    expect(body.priced_events).toBe(1);
    expect(body.partial_events).toBe(0);
    expect(body.unpriceable_events).toBe(0);
    expect(body.rate_unknown_events).toBe(0);
    expect(body.tagged_simulated_events).toBe(0);
  });

  it('counts event as partial when cache tokens are absent, still contributes to total', async () => {
    await seedRate('anthropic', 'claude-sonnet-4-6', new Date('2025-10-01T00:00:00Z'), 3, 15, 3.75, 0.3);
    await appendEvent(getPrisma(), featureId, {
      type: 'usage.recorded',
      agent: 'spec',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      input_tokens: 1000,
      output_tokens: 500,
      // no cache fields
    });

    const res = await inject(`/features/${featureId}/cost`);
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResult>();

    // Only input+output priced: (3×1000 + 15×500) / 1_000_000 = 10500 / 1_000_000 = 0.0105
    expect(body.total_usd).toBeCloseTo(0.0105, 8);
    expect(body.priced_events).toBe(0);
    expect(body.partial_events).toBe(1);
    expect(body.rate_unknown_events).toBe(0);
  });

  it('classifies event as unpriceable when provider is absent', async () => {
    await appendEvent(getPrisma(), featureId, {
      type: 'usage.recorded',
      agent: 'spec',
      model: 'claude-sonnet-4-6',
      input_tokens: 1000,
      output_tokens: 500,
      // no provider
    });

    const res = await inject(`/features/${featureId}/cost`);
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResult>();
    expect(body.total_usd).toBe(0);
    expect(body.unpriceable_events).toBe(1);
    expect(body.priced_events).toBe(0);
  });

  it('excludes simulated events from total', async () => {
    await appendEvent(getPrisma(), featureId, {
      type: 'usage.recorded',
      agent: 'spec',
      model: 'claude-sonnet-4-6',
      provider: 'simulated',
      input_tokens: 1000,
      output_tokens: 500,
      simulated: true,
    });

    const res = await inject(`/features/${featureId}/cost`);
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResult>();
    expect(body.total_usd).toBe(0);
    expect(body.tagged_simulated_events).toBe(1);
    expect(body.priced_events).toBe(0);
    expect(body.unpriceable_events).toBe(0);
  });

  it('returns rate_unknown for bedrock sonnet-5 (no rate row exists)', async () => {
    // No bedrock sonnet-5 row is seeded — deliberately absent per 6a-rates-2.
    await appendEvent(getPrisma(), featureId, {
      type: 'usage.recorded',
      agent: 'spec',
      model: 'claude-sonnet-5',
      provider: 'bedrock',
      input_tokens: 1000,
      output_tokens: 500,
    });

    const res = await inject(`/features/${featureId}/cost`);
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResult>();
    expect(body.total_usd).toBe(0);
    expect(body.rate_unknown_events).toBe(1);
    expect(body.priced_events).toBe(0);
  });

  it('picks the 2026-09-01 rate ($3/$15) for an event on 2026-09-15', async () => {
    await seedRate('anthropic', 'claude-sonnet-5', new Date('2025-10-01T00:00:00Z'), 2, 10, 2.5, 0.2);
    await seedRate('anthropic', 'claude-sonnet-5', new Date('2026-09-01T00:00:00Z'), 3, 15, 3.75, 0.3);

    // appendEvent doesn't expose createdAt; insert directly.
    await getPrisma().$executeRaw`
      INSERT INTO events (feature_id, seq, type, agent, payload, created_at)
      VALUES (
        ${featureId},
        (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE feature_id = ${featureId}),
        'usage.recorded',
        'spec',
        ${JSON.stringify({
          type: 'usage.recorded',
          agent: 'spec',
          model: 'claude-sonnet-5',
          provider: 'anthropic',
          input_tokens: 1000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        })}::jsonb,
        '2026-09-15T00:00:00Z'::timestamptz
      )
    `;

    const res = await inject(`/features/${featureId}/cost`);
    const body = res.json<CostResult>();
    // At $3/M input: 1000 tokens × $3/1_000_000 = $0.003
    expect(body.total_usd).toBeCloseTo(0.003, 8);
    expect(body.priced_events).toBe(1);
  });

  it('picks the 2025-10-01 rate ($2/$10) for an event on 2026-08-15', async () => {
    await seedRate('anthropic', 'claude-sonnet-5', new Date('2025-10-01T00:00:00Z'), 2, 10, 2.5, 0.2);
    await seedRate('anthropic', 'claude-sonnet-5', new Date('2026-09-01T00:00:00Z'), 3, 15, 3.75, 0.3);

    await getPrisma().$executeRaw`
      INSERT INTO events (feature_id, seq, type, agent, payload, created_at)
      VALUES (
        ${featureId},
        (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE feature_id = ${featureId}),
        'usage.recorded',
        'spec',
        ${JSON.stringify({
          type: 'usage.recorded',
          agent: 'spec',
          model: 'claude-sonnet-5',
          provider: 'anthropic',
          input_tokens: 1000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        })}::jsonb,
        '2026-08-15T00:00:00Z'::timestamptz
      )
    `;

    const res = await inject(`/features/${featureId}/cost`);
    const body = res.json<CostResult>();
    // At $2/M input: 1000 tokens × $2/1_000_000 = $0.002
    expect(body.total_usd).toBeCloseTo(0.002, 8);
    expect(body.priced_events).toBe(1);
  });

  it('returns rate_unknown for an event before the earliest rate row', async () => {
    await seedRate('anthropic', 'claude-sonnet-4-6', new Date('2025-10-01T00:00:00Z'), 3, 15, 3.75, 0.3);

    await getPrisma().$executeRaw`
      INSERT INTO events (feature_id, seq, type, agent, payload, created_at)
      VALUES (
        ${featureId},
        (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE feature_id = ${featureId}),
        'usage.recorded',
        'spec',
        ${JSON.stringify({
          type: 'usage.recorded',
          agent: 'spec',
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
          input_tokens: 1000,
          output_tokens: 500,
        })}::jsonb,
        '2024-01-01T00:00:00Z'::timestamptz
      )
    `;

    const res = await inject(`/features/${featureId}/cost`);
    const body = res.json<CostResult>();
    expect(body.total_usd).toBe(0);
    expect(body.rate_unknown_events).toBe(1);
    expect(body.priced_events).toBe(0);
  });

  it('by_agent rows have in_tokens/out_tokens/cost_usd/elapsed_ms and sum to total_usd', async () => {
    await seedRate('anthropic', 'claude-sonnet-4-6', new Date('2025-10-01T00:00:00Z'), 3, 15, 3.75, 0.3);
    await appendEvent(getPrisma(), featureId, {
      type: 'usage.recorded',
      agent: 'spec',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    await appendEvent(getPrisma(), featureId, {
      type: 'usage.recorded',
      agent: 'aws',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      input_tokens: 2000,
      output_tokens: 300,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

    const res = await inject(`/features/${featureId}/cost`);
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResult>();

    expect(body.by_agent).toHaveLength(2);
    const agentSum = body.by_agent.reduce((acc, row) => acc + row.cost_usd, 0);
    expect(agentSum).toBeCloseTo(body.total_usd, 8);

    for (const row of body.by_agent) {
      expect(typeof row.in_tokens).toBe('number');
      expect(typeof row.out_tokens).toBe('number');
      expect(typeof row.cost_usd).toBe('number');
      expect(typeof row.elapsed_ms).toBe('number');
    }
  });

  it('single-event agent has elapsed_ms === 0, not null', async () => {
    await seedRate('anthropic', 'claude-sonnet-4-6', new Date('2025-10-01T00:00:00Z'), 3, 15, 3.75, 0.3);
    await appendEvent(getPrisma(), featureId, {
      type: 'usage.recorded',
      agent: 'spec',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

    const res = await inject(`/features/${featureId}/cost`);
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResult>();

    expect(body.by_agent).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(body.by_agent[0]!.elapsed_ms).toBe(0);
  });

  it('agents with no priced events are absent from by_agent', async () => {
    await appendEvent(getPrisma(), featureId, {
      type: 'usage.recorded',
      agent: 'spec',
      model: 'claude-sonnet-4-6',
      input_tokens: 1000,
      output_tokens: 500,
      // no provider — unpriceable
    });

    const res = await inject(`/features/${featureId}/cost`);
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResult>();

    expect(body.unpriceable_events).toBe(1);
    expect(body.by_agent).toHaveLength(0);
  });

  it('gap statement fields are preserved in response after by_agent expansion', async () => {
    await appendEvent(getPrisma(), featureId, {
      type: 'usage.recorded',
      agent: 'spec',
      model: 'claude-sonnet-4-6',
      input_tokens: 1000,
      output_tokens: 500,
      // no provider — unpriceable
    });

    const res = await inject(`/features/${featureId}/cost`);
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResult>();

    expect(body).toHaveProperty('unpriceable_events');
    expect(body).toHaveProperty('partial_events');
    expect(body).toHaveProperty('tagged_simulated_events');
    expect(body).toHaveProperty('rate_unknown_events');
  });

  it('elapsed_ms sums per-job spans, not feature wall-clock', async () => {
    // Scenario: feature ran job A (5 min), was parked overnight (8h), then ran job B (3 min).
    // Current (broken) code: elapsed = 08:00 to next-day 16:03 = 480+ min.
    // Correct (new) code: elapsed = 5 min + 3 min = 8 min = 480000 ms.
    await seedRate('anthropic', 'claude-sonnet-4-6', new Date('2025-10-01T00:00:00Z'), 3, 15, 3.75, 0.3);

    const jobA = 'job-span-A';
    const jobB = 'job-span-B';

    const insertEvent = (ts: string, jobId: string) =>
      getPrisma().$executeRaw`
        INSERT INTO events (feature_id, seq, type, agent, payload, created_at)
        VALUES (
          ${featureId},
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE feature_id = ${featureId}),
          'usage.recorded',
          'server',
          ${JSON.stringify({
            type: 'usage.recorded',
            agent: 'server',
            model: 'claude-sonnet-4-6',
            provider: 'anthropic',
            input_tokens: 500,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            job_id: jobId,
          })}::jsonb,
          ${ts}::timestamptz
        )
      `;

    // Job A: 08:00 → 08:05 (5 min span)
    await insertEvent('2026-01-01T08:00:00Z', jobA);
    await insertEvent('2026-01-01T08:05:00Z', jobA);

    // Job B (next day after overnight park): 16:00 → 16:03 (3 min span)
    await insertEvent('2026-01-02T16:00:00Z', jobB);
    await insertEvent('2026-01-02T16:03:00Z', jobB);

    const res = await inject(`/features/${featureId}/cost`);
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResult>();

    expect(body.by_agent).toHaveLength(1);
    // Sum of spans: 5 min + 3 min = 8 min = 480000 ms
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(body.by_agent[0]!.elapsed_ms).toBe(480_000);
  });
});
