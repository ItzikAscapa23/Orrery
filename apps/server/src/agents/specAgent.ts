import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { createMessageStream, type UsageRecord } from '../lib/anthropic.js';
import { buildAttachmentContext } from '../lib/attachmentContext.js';

const SYSTEM_PROMPT_FULL = `You are a senior product engineer interviewing a developer to produce a precise feature specification.

Rules:
- Ask at most ONE clarifying question per turn.
- Cover: user flows, edge cases, error states, data model implications, API needs, and out-of-scope.
- When you have gathered enough information, call the save_spec tool with the complete specification.
- Never output the final spec as plain text — always use save_spec.

The spec must follow this template exactly:
## Overview
## User stories
## Acceptance criteria (Given/When/Then)
## Screens (reference attached designs if provided)
## API endpoints (name, method, and purpose only)
## Out of scope
## Open questions`;

// Light-path repos (swaggers, bff-configurations) hold YAML contracts and Lambda env files.
// The spec here is a precise description of the config change, not a user-story spec.
const SYSTEM_PROMPT_LIGHT = `You are helping an operator specify a configuration or contract change for a light-path repository.

Rules:
- Ask at most ONE clarifying question per turn.
- Clarify: which file is being modified (new or existing); what keys/fields are being added, changed, or removed; which environments the change targets (Sandbox, Dev, Test, Stg, Prod).
- When you have gathered enough information, call the save_spec tool with the complete specification.
- Never output the final spec as plain text — always use save_spec.

The spec must follow this template exactly:
## Overview
## Change description (file path, keys, before/after values)
## Target environments
## Out of scope
## Open questions`;

const SAVE_SPEC_TOOL: Anthropic.Tool = {
  name: 'save_spec',
  description:
    'Save the completed feature specification. Call this only when you have enough information to write a full spec. Never call it prematurely.',
  input_schema: {
    type: 'object' as const,
    properties: {
      spec_markdown: {
        type: 'string',
        description:
          'The complete feature specification in markdown following the required template.',
      },
    },
    required: ['spec_markdown'],
  },
};

const SaveSpecInputSchema = z.object({
  spec_markdown: z.string().min(100, 'spec_markdown must be at least 100 characters'),
});

export async function runSpecAgentTurn(
  featureId: string,
  featureName: string,
  requirement: string,
  slug: string,
  messages: Anthropic.MessageParam[],
  onToken: (text: string) => void,
  onSpecProposed: (specMarkdown: string) => Promise<void>,
  onUsage?: (u: UsageRecord) => void | Promise<void>,
  featurePath?: 'FULL' | 'LIGHT',
): Promise<{ role: 'assistant'; content: Anthropic.ContentBlock[] }> {
  const attachmentSection = buildAttachmentContext(slug);
  const contextMessage: Anthropic.MessageParam = {
    role: 'user',
    content: [
      `Feature name: ${featureName}\nBusiness requirement: ${requirement}`,
      attachmentSection ? `\n\n--- Attached files ---\n${attachmentSection}` : '',
    ].join(''),
  };
  const messagesWithContext = [contextMessage, ...messages];

  // Wrap onUsage to capture the returned promise. anthropic.ts fires the handler
  // with `void onUsage?.(record)` — the return value is discarded there, but we
  // need to await the usage append before calling onSpecProposed. If both a
  // usage append ($transaction A) and a spec-proposed append ($transaction B)
  // open concurrently they both read the same MAX(seq) and one gets P2002.
  let usagePromise: Promise<void> = Promise.resolve();
  const wrappedOnUsage = onUsage
    ? (u: UsageRecord) => {
        usagePromise = Promise.resolve(onUsage(u));
        return usagePromise;
      }
    : undefined;

  const systemPrompt = featurePath === 'LIGHT' ? SYSTEM_PROMPT_LIGHT : SYSTEM_PROMPT_FULL;

  const stream = await createMessageStream(
    {
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: systemPrompt,
      tools: [SAVE_SPEC_TOOL],
      messages: messagesWithContext,
    },
    featureId,
    wrappedOnUsage,
  );

  let specCalled = false;

  stream.on('text', (text: string) => {
    onToken(text);
  });

  const finalMessage = await stream.finalMessage();

  // Drain any in-flight usage append before opening the specProposed transaction.
  // finalMessage() resolves only after all stream events have fired, so
  // usagePromise is set by the time we reach this line.
  await usagePromise;

  if (finalMessage.stop_reason === 'tool_use') {
    const toolUseBlock = finalMessage.content.find(
      (block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock =>
        block.type === 'tool_use' && block.name === 'save_spec',
    );

    if (toolUseBlock) {
      const parsed = SaveSpecInputSchema.parse(toolUseBlock.input);
      specCalled = true;
      await onSpecProposed(parsed.spec_markdown);
    }
  }

  void specCalled;

  return { role: 'assistant', content: finalMessage.content };
}
