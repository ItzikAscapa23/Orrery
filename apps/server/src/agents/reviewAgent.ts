import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMessageStream } from '../lib/anthropic.js';
import type { UsageRecord } from '../lib/anthropic.js';
import { FindingSchema } from '@orrery/shared';

const ReviewFindingArraySchema = z.object({ findings: z.array(FindingSchema) });

// Resolve the charter path relative to this file so the server can be started
// from any working directory.
const CHARTER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/agents/review-charter.md',
);

function buildSystemPrompt(): string {
  const charter = fs.readFileSync(CHARTER_PATH, 'utf-8');
  return (
    'You are a code reviewer verifying that a feature implementation conforms ' +
    'to its approved spec and contract.\n\n' +
    charter +
    '\n\nReturn ONLY valid JSON — no prose, no markdown fences — matching:\n' +
    '{ "findings": [ { "id": "...", "severity": "blocker"|"warning", ' +
    '"section": "...", "issue": "...", "repo": "..." } ] }'
  );
}

function parseResponse(text: string): z.infer<typeof ReviewFindingArraySchema> | null {
  let json: unknown;
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '');
    json = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const result = ReviewFindingArraySchema.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * Single Messages API call to the Review Agent. Takes a pre-assembled prompt
 * (spec + contract + diffs — built in reviewJob.ts) and returns parsed findings.
 * Retries once on JSON parse failure; throws on the second failure so the caller
 * can handle fail-open.
 */
export async function runReviewAgent(
  featureId: string,
  userPrompt: string,
  onUsage?: (u: UsageRecord) => void | Promise<void>,
): Promise<z.infer<typeof FindingSchema>[]> {
  const systemPrompt = buildSystemPrompt();
  const usageCb = onUsage ? (u: UsageRecord) => void onUsage(u) : undefined;

  const first = await (
    await createMessageStream(
      {
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      },
      featureId,
      usageCb,
    )
  ).finalMessage();

  if (first.stop_reason === 'max_tokens') {
    console.error(
      JSON.stringify({
        event: 'review_agent_truncated',
        featureId,
        attempt: 1,
        output_tokens: first.usage?.output_tokens,
      }),
    );
  }

  const firstText = first.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const firstParsed = parseResponse(firstText);
  if (firstParsed) return firstParsed.findings;

  // Retry once with the validation failure fed back to the model
  const retryContent =
    `${userPrompt}\n\nYour previous response could not be parsed as valid JSON matching the schema. ` +
    `Previous response:\n${firstText}\n\nFix it and return valid JSON only.`;

  const second = await (
    await createMessageStream(
      {
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: retryContent }],
      },
      featureId,
      usageCb,
    )
  ).finalMessage();

  if (second.stop_reason === 'max_tokens') {
    console.error(
      JSON.stringify({
        event: 'review_agent_truncated',
        featureId,
        attempt: 2,
        output_tokens: second.usage?.output_tokens,
      }),
    );
  }

  const secondText = second.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const secondParsed = parseResponse(secondText);
  if (secondParsed) return secondParsed.findings;

  throw new Error(
    `Review agent parse failure after retry. Last response: ${secondText.slice(0, 200)}`,
  );
}
