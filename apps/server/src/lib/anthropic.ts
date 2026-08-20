import Anthropic from '@anthropic-ai/sdk';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { env } from './env.js';

const _require = createRequire(import.meta.url);

export interface UsageRecord {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Minimal interface shared by both Anthropic and AnthropicBedrock clients.
// Both expose the same .messages.create / .messages.stream surface.
interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
    stream(params: Anthropic.MessageStreamParams): MessageStream;
  };
}

// When BEDROCK_MODEL_ID is set (e.g. an application inference profile ARN),
// all Bedrock calls use that ID regardless of what the call site passes.
// This is required when org IAM policy restricts access to a specific profile
// and explicitly denies foundation-model ARNs. When not set, the plain model
// name is prefixed with 'anthropic.' for the standard Bedrock path.
function normaliseModelId(_model: string): string {
  if (env.ANTHROPIC_PROVIDER !== 'bedrock') return _model;
  if (env.BEDROCK_MODEL_ID) return env.BEDROCK_MODEL_ID;
  return _model.includes('.') ? _model : `anthropic.${_model}`;
}

// The SDK ^0.26 Usage type omits cache fields — they only appear on the beta
// prompt-caching variant. Cast to access them without introducing a beta dep.
type UsageWithCache = Anthropic.Usage & {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

let clientPromise: Promise<MessagesClient> | null = null;

/** Reset the cached client — for testing only. */
export function resetClientForTesting(): void {
  clientPromise = null;
}

function getClient(): Promise<MessagesClient> {
  if (clientPromise) return clientPromise;

  let resolved: MessagesClient;
  if (env.ANTHROPIC_PROVIDER === 'bedrock') {
    // Use createRequire so Vite/Vitest does not attempt to resolve or bundle
    // this optional dep at transform time. Only executed when
    // ANTHROPIC_PROVIDER=bedrock; package must be installed separately.
    // Install: npm install @anthropic-ai/bedrock-sdk  (in apps/server)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { AnthropicBedrock } = _require('@anthropic-ai/bedrock-sdk');
    // Load corporate CA bundle into the bedrock client's fetch options so the
    // TLS-inspecting proxy is trusted. NODE_EXTRA_CA_CERTS only works with the
    // legacy `https` module; the bedrock SDK uses `fetch` (undici) which needs
    // the CA passed directly via fetchOptions.
    const extraCa = process.env['NODE_EXTRA_CA_CERTS']
      ? readFileSync(process.env['NODE_EXTRA_CA_CERTS'], 'utf-8')
      : undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    resolved = new AnthropicBedrock({
      awsRegion: env.AWS_REGION,
      awsAccessKey: env.AWS_ACCESS_KEY_ID,
      awsSecretKey: env.AWS_SECRET_ACCESS_KEY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fetchOptions not typed in older SDK
      ...(extraCa ? ({ fetchOptions: { ca: extraCa } } as any) : {}),
    }) as MessagesClient;
  } else {
    resolved = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  clientPromise = Promise.resolve(resolved);

  return clientPromise;
}

// Detect expired AWS STS credentials (Bedrock SSO tokens have a TTL) and
// rethrow with a human-actionable message that includes the refresh command.
// Called from every API path so no individual agent needs to handle this.
function rethrowIfExpiredToken(err: unknown): never {
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    const msg = err.message.toLowerCase();
    const isExpired =
      (msg.includes('security token') && msg.includes('expired')) ||
      (status === 403 && msg.includes('expired'));
    if (isExpired) {
      throw new Error(
        'Bedrock credentials expired. Refresh with:\n' +
          '  aws sso login --profile ai-devtools-dev\n' +
          'Then restart the server (env vars are read at startup).',
      );
    }
  }
  throw err;
}

function logUsage(featureId: string | undefined, usage: UsageRecord): void {
  console.error(
    JSON.stringify({
      event: 'anthropic_usage',
      feature_id: featureId ?? null,
      provider: usage.provider,
      model: usage.model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      ...(usage.cache_creation_input_tokens !== undefined
        ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
        : {}),
      ...(usage.cache_read_input_tokens !== undefined
        ? { cache_read_input_tokens: usage.cache_read_input_tokens }
        : {}),
    }),
  );
}

export async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
  featureId?: string,
  onUsage?: (u: UsageRecord) => void,
): Promise<Anthropic.Message> {
  try {
    const c = await getClient();
    const message = await c.messages.create({
      ...params,
      model: normaliseModelId(params.model),
    });
    const usage = message.usage as UsageWithCache;
    const record: UsageRecord = {
      model: message.model,
      provider: env.ANTHROPIC_PROVIDER,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      ...(usage.cache_creation_input_tokens !== undefined
        ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
        : {}),
      ...(usage.cache_read_input_tokens !== undefined
        ? { cache_read_input_tokens: usage.cache_read_input_tokens }
        : {}),
    };
    logUsage(featureId, record);
    onUsage?.(record);
    return message;
  } catch (err) {
    rethrowIfExpiredToken(err);
  }
}

export async function createMessageStream(
  params: Anthropic.MessageStreamParams,
  featureId?: string,
  onUsage?: (u: UsageRecord) => void | Promise<void>,
): Promise<MessageStream> {
  try {
    const c = await getClient();
    const stream = c.messages.stream({
      ...params,
      model: normaliseModelId(params.model),
    });
    stream.on('message', (msg: Anthropic.Message) => {
      const streamUsage = msg.usage as UsageWithCache;
      const record: UsageRecord = {
        model: msg.model,
        provider: env.ANTHROPIC_PROVIDER,
        input_tokens: streamUsage.input_tokens,
        output_tokens: streamUsage.output_tokens,
        ...(streamUsage.cache_creation_input_tokens !== undefined
          ? { cache_creation_input_tokens: streamUsage.cache_creation_input_tokens }
          : {}),
        ...(streamUsage.cache_read_input_tokens !== undefined
          ? { cache_read_input_tokens: streamUsage.cache_read_input_tokens }
          : {}),
      };
      logUsage(featureId, record);
      void onUsage?.(record);
    });
    return stream;
  } catch (err) {
    rethrowIfExpiredToken(err);
  }
}

/**
 * Returns a new messages array where the last message has
 * `cache_control: { type: 'ephemeral' }` on its last content block.
 *
 * This implements the "moving breakpoint" pattern: each API call caches the
 * full conversation prefix up to the current tail. The next turn reads that
 * prefix from cache and only pays full input-token cost for the new messages.
 *
 * The original array and its message objects are not mutated.
 *
 * cache_control is absent from ContentBlockParam in SDK ^0.26 (beta field not
 * yet typed). Same cast pattern as the system-prompt block in devAgent /
 * testAgent.
 */
export function withLastMessageCached(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;

  const last = messages[messages.length - 1]!;
  let newContent: Anthropic.MessageParam['content'];

  if (typeof last.content === 'string') {
    newContent = [
      {
        type: 'text' as const,
        text: last.content,
        cache_control: { type: 'ephemeral' },
      } as Anthropic.TextBlockParam,
    ];
  } else {
    const blocks = last.content;
    if (blocks.length === 0) return messages;
    const lastBlock = blocks[blocks.length - 1]!;
    const cachedLastBlock = {
      ...lastBlock,
      cache_control: { type: 'ephemeral' as const },
    } as unknown as typeof lastBlock;
    newContent = [...blocks.slice(0, -1), cachedLastBlock];
  }

  return [...messages.slice(0, -1), { ...last, content: newContent }];
}
