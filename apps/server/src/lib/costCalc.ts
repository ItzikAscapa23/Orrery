import type { PrismaClient, Prisma } from '@prisma/client';
import type { UsageRecordedPayload } from '@orrery/shared';

export type CostResult = {
  total_usd: number;
  priced_events: number;
  partial_events: number;
  unpriceable_events: number;
  rate_unknown_events: number;
  tagged_simulated_events: number;
  by_agent: { agent: string; in_tokens: number; cache_read_tokens: number; cache_write_tokens: number; out_tokens: number; cost_usd: number; elapsed_ms: number }[];
  by_model: { model: string; provider: string; total_usd: number; events: number }[];
  by_job: { job_id: string; total_usd: number; events: number }[];
};

type EventRow = { payload: Prisma.JsonValue; createdAt: Date };

export async function computeCost(prisma: PrismaClient, events: EventRow[]): Promise<CostResult> {
  let total_usd = 0;
  let priced_events = 0;
  let partial_events = 0;
  let unpriceable_events = 0;
  let rate_unknown_events = 0;
  let tagged_simulated_events = 0;

  const byAgent = new Map<string, { in_tokens: number; cache_read_tokens: number; cache_write_tokens: number; out_tokens: number; cost_usd: number }>();
  // Per-(agent, job_id) span tracker. Events with no job_id contribute no span (elapsed = 0).
  const agentJobSpans = new Map<string, Map<string, { firstAt: Date; lastAt: Date }>>();
  const byModel = new Map<string, { model: string; provider: string; total_usd: number; events: number }>();
  const byJob = new Map<string, { total_usd: number; events: number }>();

  for (const row of events) {
    const p = row.payload as UsageRecordedPayload;

    if (p.simulated === true) {
      tagged_simulated_events++;
      continue;
    }

    if (!p.provider) {
      unpriceable_events++;
      continue;
    }

    const rate = await prisma.modelRate.findFirst({
      where: {
        provider: p.provider,
        model: p.model,
        effectiveFrom: { lte: row.createdAt },
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    if (!rate) {
      rate_unknown_events++;
      continue;
    }

    const cacheWrite = p.cache_creation_input_tokens ?? 0;
    const cacheRead = p.cache_read_input_tokens ?? 0;

    const cost =
      (p.input_tokens * rate.inputPerMToken +
        p.output_tokens * rate.outputPerMToken +
        cacheWrite * (rate.cacheWritePerMToken ?? 0) +
        cacheRead * (rate.cacheReadPerMToken ?? 0)) /
      1_000_000;

    // Partial: cache tokens absent from payload (undefined, not explicitly 0).
    const isPartial =
      p.cache_creation_input_tokens === undefined || p.cache_read_input_tokens === undefined;

    total_usd += cost;
    if (isPartial) {
      partial_events++;
    } else {
      priced_events++;
    }

    const agentKey = p.agent;
    const existing = byAgent.get(agentKey);
    if (existing) {
      byAgent.set(agentKey, {
        in_tokens: existing.in_tokens + p.input_tokens,
        cache_read_tokens: existing.cache_read_tokens + cacheRead,
        cache_write_tokens: existing.cache_write_tokens + cacheWrite,
        out_tokens: existing.out_tokens + p.output_tokens,
        cost_usd: existing.cost_usd + cost,
      });
    } else {
      byAgent.set(agentKey, {
        in_tokens: p.input_tokens,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        out_tokens: p.output_tokens,
        cost_usd: cost,
      });
    }

    if (p.job_id) {
      let jobMap = agentJobSpans.get(agentKey);
      if (!jobMap) { jobMap = new Map(); agentJobSpans.set(agentKey, jobMap); }
      const span = jobMap.get(p.job_id);
      if (span) {
        jobMap.set(p.job_id, { firstAt: span.firstAt, lastAt: row.createdAt });
      } else {
        jobMap.set(p.job_id, { firstAt: row.createdAt, lastAt: row.createdAt });
      }
    }

    const modelKey = `${p.provider}:${p.model}`;
    const existingModel = byModel.get(modelKey) ?? { model: p.model, provider: p.provider, total_usd: 0, events: 0 };
    byModel.set(modelKey, { ...existingModel, total_usd: existingModel.total_usd + cost, events: existingModel.events + 1 });

    if (p.job_id) {
      const existingJob = byJob.get(p.job_id) ?? { total_usd: 0, events: 0 };
      byJob.set(p.job_id, { total_usd: existingJob.total_usd + cost, events: existingJob.events + 1 });
    }
  }

  return {
    total_usd,
    priced_events,
    partial_events,
    unpriceable_events,
    rate_unknown_events,
    tagged_simulated_events,
    by_agent: Array.from(byAgent.entries())
      .map(([agent, v]) => {
        const spans = agentJobSpans.get(agent);
        let elapsed_ms = 0;
        if (spans) {
          for (const s of spans.values()) {
            elapsed_ms += s.lastAt.getTime() - s.firstAt.getTime();
          }
        }
        return { agent, in_tokens: v.in_tokens, cache_read_tokens: v.cache_read_tokens, cache_write_tokens: v.cache_write_tokens, out_tokens: v.out_tokens, cost_usd: v.cost_usd, elapsed_ms };
      })
      .sort((a, b) => b.cost_usd - a.cost_usd),
    by_model: Array.from(byModel.values()),
    by_job: Array.from(byJob.entries()).map(([job_id, v]) => ({ job_id, ...v })),
  };
}
