interface Pricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheWritePer1M: number;
  cacheReadPer1M: number;
}

const PRICING_TABLE: Array<{ match: string; pricing: Pricing }> = [
  {
    match: 'claude-opus-4',
    pricing: { inputPer1M: 15.0, outputPer1M: 75.0, cacheWritePer1M: 18.75, cacheReadPer1M: 1.5 },
  },
  {
    match: 'claude-opus-3',
    pricing: { inputPer1M: 15.0, outputPer1M: 75.0, cacheWritePer1M: 18.75, cacheReadPer1M: 1.5 },
  },
  {
    match: 'claude-sonnet-4-5',
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, cacheWritePer1M: 3.75, cacheReadPer1M: 0.3 },
  },
  {
    match: 'claude-sonnet-4',
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, cacheWritePer1M: 3.75, cacheReadPer1M: 0.3 },
  },
  {
    match: 'sonnet-4',
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, cacheWritePer1M: 3.75, cacheReadPer1M: 0.3 },
  },
  {
    match: 'claude-sonnet-3-7',
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, cacheWritePer1M: 3.75, cacheReadPer1M: 0.3 },
  },
  {
    match: 'claude-sonnet-3',
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, cacheWritePer1M: 3.75, cacheReadPer1M: 0.3 },
  },
  {
    match: 'claude-haiku-3-5',
    pricing: { inputPer1M: 0.8, outputPer1M: 4.0, cacheWritePer1M: 1.0, cacheReadPer1M: 0.08 },
  },
  {
    match: 'claude-haiku-3',
    pricing: { inputPer1M: 0.8, outputPer1M: 4.0, cacheWritePer1M: 1.0, cacheReadPer1M: 0.08 },
  },
  {
    match: 'claude-haiku',
    pricing: { inputPer1M: 0.25, outputPer1M: 1.25, cacheWritePer1M: 0.3, cacheReadPer1M: 0.03 },
  },
];

const FALLBACK_PRICING: Pricing = {
  inputPer1M: 3.0,
  outputPer1M: 15.0,
  cacheWritePer1M: 3.75,
  cacheReadPer1M: 0.3,
};

function lookupPricing(model: string): Pricing {
  const lower = model.toLowerCase();
  for (const entry of PRICING_TABLE) {
    if (lower.includes(entry.match)) return entry.pricing;
  }
  return FALLBACK_PRICING;
}

export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreateTokens = 0,
  cacheReadTokens = 0,
): number {
  const p = lookupPricing(model);
  return (
    (inputTokens * p.inputPer1M +
      outputTokens * p.outputPer1M +
      cacheCreateTokens * p.cacheWritePer1M +
      cacheReadTokens * p.cacheReadPer1M) /
    1_000_000
  );
}
