import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Published rates (USD per million tokens) as of 2026-08-02.
// Sources: platform.claude.com/docs/en/pricing (direct API, Anthropic provider)
//          aws.amazon.com/bedrock/pricing/ (Bedrock on-demand, eu-west-1)
// Bedrock and direct-API are keyed separately because they can diverge; add a
// new row with a later effectiveFrom when either side changes — never edit existing rows.
const EFFECTIVE_FROM = new Date('2025-10-01T00:00:00Z');

type RateSeed = {
  provider: string;
  model: string;
  effectiveFrom: Date;
  inputPerMToken: number;
  outputPerMToken: number;
  cacheWritePerMToken: number;
  cacheReadPerMToken: number;
};

const rates: RateSeed[] = [
  // ── claude-3-5-sonnet-20241022 (Claude Sonnet 3.5) ──────────────────────
  // Source: platform.claude.com/docs/en/pricing, aws.amazon.com/bedrock/pricing/ — 2026-08-02
  {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    effectiveFrom: EFFECTIVE_FROM,
    inputPerMToken: 3.0,
    outputPerMToken: 15.0,
    cacheWritePerMToken: 3.75,
    cacheReadPerMToken: 0.3,
  },
  {
    provider: 'bedrock',
    model: 'claude-3-5-sonnet-20241022',
    effectiveFrom: EFFECTIVE_FROM,
    inputPerMToken: 3.0,
    outputPerMToken: 15.0,
    cacheWritePerMToken: 3.75,
    cacheReadPerMToken: 0.3,
  },

  // ── claude-sonnet-4-6 (Claude Sonnet 4.6) ────────────────────────────────
  // This is the model string Bedrock echoes back when resolving the application
  // inference profile ARN (BEDROCK_MODEL_ID). Every real production usage event
  // carries this string — it must have a row.
  // Source: platform.claude.com/docs/en/pricing, aws.amazon.com/bedrock/pricing/ — 2026-08-02
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    effectiveFrom: EFFECTIVE_FROM,
    inputPerMToken: 3.0,
    outputPerMToken: 15.0,
    cacheWritePerMToken: 3.75,
    cacheReadPerMToken: 0.3,
  },
  {
    provider: 'bedrock',
    model: 'claude-sonnet-4-6',
    effectiveFrom: EFFECTIVE_FROM,
    inputPerMToken: 3.0,
    outputPerMToken: 15.0,
    cacheWritePerMToken: 3.75,
    cacheReadPerMToken: 0.3,
  },

  // ── claude-sonnet-5-20251008 (Claude Sonnet 5, dated alias) ──────────────
  // anthropic introductory price active through 2026-08-31: $2/$10 base;
  // cache derived 1.25×/0.1× base. Source: anthropic.com/pricing, checked 2026-08-02.
  // No bedrock row: AWS has not published a Bedrock price for this model;
  // a missing row causes 6b to report "rate unknown" (honest) rather than a guessed value.
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5-20251008',
    effectiveFrom: EFFECTIVE_FROM,
    inputPerMToken: 2.0,
    outputPerMToken: 10.0,
    cacheWritePerMToken: 2.5,
    cacheReadPerMToken: 0.2,
  },
  // anthropic standard price from 2026-09-01 (introductory period ends): $3/$15 base;
  // cache derived 1.25×/0.1× base. Source: anthropic.com/pricing, checked 2026-08-02.
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5-20251008',
    effectiveFrom: new Date('2026-09-01T00:00:00Z'),
    inputPerMToken: 3.0,
    outputPerMToken: 15.0,
    cacheWritePerMToken: 3.75,
    cacheReadPerMToken: 0.3,
  },

  // ── claude-sonnet-5 (Claude Sonnet 5, bare alias) ────────────────────────
  // anthropic introductory price active through 2026-08-31: $2/$10 base;
  // cache derived 1.25×/0.1× base. Source: anthropic.com/pricing, checked 2026-08-02.
  // No bedrock row: AWS has not published a Bedrock price for this model;
  // a missing row causes 6b to report "rate unknown" (honest) rather than a guessed value.
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    effectiveFrom: EFFECTIVE_FROM,
    inputPerMToken: 2.0,
    outputPerMToken: 10.0,
    cacheWritePerMToken: 2.5,
    cacheReadPerMToken: 0.2,
  },
  // anthropic standard price from 2026-09-01 (introductory period ends): $3/$15 base;
  // cache derived 1.25×/0.1× base. Source: anthropic.com/pricing, checked 2026-08-02.
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    effectiveFrom: new Date('2026-09-01T00:00:00Z'),
    inputPerMToken: 3.0,
    outputPerMToken: 15.0,
    cacheWritePerMToken: 3.75,
    cacheReadPerMToken: 0.3,
  },
];

async function main(): Promise<void> {
  for (const rate of rates) {
    await prisma.modelRate.upsert({
      where: {
        provider_model_effectiveFrom: {
          provider: rate.provider,
          model: rate.model,
          effectiveFrom: rate.effectiveFrom,
        },
      },
      create: rate,
      update: rate,
    });
  }
  console.log(`Seeded ${rates.length} model rate rows.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
