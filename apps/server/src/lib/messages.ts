import type Anthropic from '@anthropic-ai/sdk';
import { getPrisma } from './prisma.js';
import { updateFeatureProposedSpec } from './features.js';

// The SDK has no combined ContentBlockParam type; this union covers all block kinds.
export type AnyContentBlock =
  | Anthropic.TextBlockParam
  | Anthropic.ImageBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam
  | Anthropic.ContentBlock;

export async function saveMessage(
  featureId: string,
  role: 'user' | 'assistant',
  contentBlocks: AnyContentBlock[],
): Promise<void> {
  await getPrisma().message.create({
    data: {
      featureId,
      role,
      contentJson: JSON.stringify(contentBlocks),
    },
  });
}

export async function getMessagesByFeatureId(featureId: string): Promise<Anthropic.MessageParam[]> {
  const rows = await getPrisma().message.findMany({
    where: { featureId },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map((row) => ({
    role: row.role as 'user' | 'assistant',
    content: JSON.parse(row.contentJson) as AnyContentBlock[],
  }));
}

// Block types that must not be replayed as conversation history:
// - 'thinking': requires the interleaved-thinking beta header (CLAUDE.md gotcha)
// - 'tool_use': a terminal tool call (e.g. save_spec) has no following tool_result
//   when replayed in a later turn, causing an Anthropic API 400.
const NON_REPLAYABLE_TYPES = new Set(['thinking', 'tool_use']);

export function sanitizeAssistantContent(content: AnyContentBlock[]): AnyContentBlock[] {
  return content.filter((b) => !NON_REPLAYABLE_TYPES.has((b as { type: string }).type));
}

export { updateFeatureProposedSpec };
