import { z } from 'zod';
import fs from 'node:fs';
import { createMessageStream } from '../lib/anthropic.js';
import type { UsageRecord } from '../lib/anthropic.js';
import { FindingSchema } from '@orrery/shared';

const FindingArraySchema = z.object({ findings: z.array(FindingSchema) });

function buildSystemPrompt(charterPath: string): string {
  const charter = fs.readFileSync(charterPath, 'utf-8');
  return (
    'You are an AWS solutions architect reviewing a feature specification.\n\n' +
    charter +
    '\n\nReturn ONLY valid JSON — no prose, no markdown fences — matching:\n' +
    '{ "findings": [ { "id": "...", "severity": "blocker"|"warning"|"suggestion", ' +
    '"section": "...", "issue": "...", "suggested_text": "..." } ] }'
  );
}

function parseResponse(text: string): z.infer<typeof FindingArraySchema> | null {
  let json: unknown;
  try {
    // Strip any accidental markdown fences the model may prepend/append
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '');
    json = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const result = FindingArraySchema.safeParse(json);
  return result.success ? result.data : null;
}

export async function runAwsReview(
  featureId: string,
  featureName: string,
  specMarkdown: string,
  charterPath: string,
  repoContext?: string,
  onUsage?: (u: UsageRecord) => void | Promise<void>,
): Promise<z.infer<typeof FindingSchema>[]> {
  const systemPrompt = buildSystemPrompt(charterPath);
  const repoLine = repoContext ? `\nRepositories in scope: ${repoContext}\n` : '';
  const userContent = `Feature: ${featureName}${repoLine}\n\nSpec:\n\n${specMarkdown}`;
  // createMessage accepts a void-returning callback; wrap to suppress the
  // no-misused-promises lint error when onUsage returns a Promise.
  const usageCb = onUsage ? (u: UsageRecord) => void onUsage(u) : undefined;

  const first = await (
    await createMessageStream(
      {
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      },
      featureId,
      usageCb,
    )
  ).finalMessage();

  if (first.stop_reason === 'max_tokens') {
    console.error(
      JSON.stringify({
        event: 'aws_agent_truncated',
        featureId,
        attempt: 1,
        stop_reason: first.stop_reason,
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

  // Retry once, feeding the validation failure back to the model
  const retryContent =
    `${userContent}\n\nYour previous response could not be parsed as valid JSON matching the schema. ` +
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
        event: 'aws_agent_truncated',
        featureId,
        attempt: 2,
        stop_reason: second.stop_reason,
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
    `AWS agent parse failure after retry. Last response: ${secondText.slice(0, 200)}`,
  );
}
