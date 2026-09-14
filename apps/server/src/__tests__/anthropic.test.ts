import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

// These must be set before any module that reads env vars is imported.
// vi.hoisted ensures they run before all imports are resolved.
const { mockCreate, mockStream } = vi.hoisted(() => {
  process.env['ANTHROPIC_PROVIDER'] = 'anthropic';
  process.env['ANTHROPIC_API_KEY'] = 'test-key';
  process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';
  return { mockCreate: vi.fn(), mockStream: vi.fn() };
});

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate, stream: mockStream },
  }));
  return { default: MockAnthropic };
});

import {
  createMessage,
  createMessageStream,
  resetClientForTesting,
  withLastMessageCached,
  REQUEST_TIMEOUT_MS,
} from '../lib/anthropic.js';
import type { UsageRecord } from '../lib/anthropic.js';

const makeMessage = () => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-3-5-sonnet-20241022',
  content: [{ type: 'text', text: 'Hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
});

const mockStreamObj = { on: vi.fn().mockReturnThis() };

beforeEach(() => {
  vi.clearAllMocks();
  resetClientForTesting(); // clear cached Promise<client> between tests
  mockCreate.mockResolvedValue(makeMessage());
  mockStream.mockReturnValue(mockStreamObj);
});

describe('createMessage', () => {
  it('calls messages.create with the given params', async () => {
    const params = {
      model: 'claude-3-5-sonnet-20241022' as const,
      max_tokens: 100,
      messages: [{ role: 'user' as const, content: 'Hello' }],
    };
    await createMessage(params);
    expect(mockCreate).toHaveBeenCalledWith(params);
  });

  it('logs usage to stderr', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await createMessage({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(spy).toHaveBeenCalledOnce();
    const logged = JSON.parse((spy.mock.calls[0] as string[])[0] as string) as Record<
      string,
      unknown
    >;
    expect(logged['event']).toBe('anthropic_usage');
    expect(logged['input_tokens']).toBe(10);
    spy.mockRestore();
  });

  it('includes feature_id in usage log when provided', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await createMessage(
      {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
      },
      'feature-abc',
    );
    const logged = JSON.parse((spy.mock.calls[0] as string[])[0] as string) as Record<
      string,
      unknown
    >;
    expect(logged['feature_id']).toBe('feature-abc');
    spy.mockRestore();
  });

  it('propagates errors from the SDK', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API error'));
    await expect(
      createMessage({ model: 'claude-3-5-sonnet-20241022', max_tokens: 100, messages: [] }),
    ).rejects.toThrow('API error');
  });
});

describe('createMessage — cache token instrumentation', () => {
  const params = {
    model: 'claude-3-5-sonnet-20241022' as const,
    max_tokens: 100,
    messages: [{ role: 'user' as const, content: 'Hi' }],
  };

  it('carries cache tokens when SDK reports them', async () => {
    mockCreate.mockResolvedValueOnce({
      ...makeMessage(),
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 50,
      },
    });
    let captured: UsageRecord | undefined;
    await createMessage(params, undefined, (u) => {
      captured = u;
    });
    expect(captured?.cache_creation_input_tokens).toBe(200);
    expect(captured?.cache_read_input_tokens).toBe(50);
  });

  it('omits cache fields when SDK does not report them', async () => {
    // makeMessage() already has no cache fields
    let captured: UsageRecord | undefined;
    await createMessage(params, undefined, (u) => {
      captured = u;
    });
    expect(captured?.cache_creation_input_tokens).toBeUndefined();
    expect(captured?.cache_read_input_tokens).toBeUndefined();
  });

  it('carries provider on UsageRecord', async () => {
    let captured: UsageRecord | undefined;
    await createMessage(params, undefined, (u) => {
      captured = u;
    });
    expect(captured?.provider).toBe('anthropic');
  });
});

describe('createMessageStream — cache token instrumentation', () => {
  it('carries cache tokens from stream message event', async () => {
    const handlers: Record<string, (arg: unknown) => void> = {};
    const captureStream = {
      on: vi.fn((event: string, cb: (arg: unknown) => void) => {
        handlers[event] = cb;
        return captureStream;
      }),
    };
    mockStream.mockReturnValueOnce(captureStream);

    let captured: UsageRecord | undefined;
    await createMessageStream(
      { model: 'claude-3-5-sonnet-20241022', max_tokens: 100, messages: [] },
      undefined,
      (u) => {
        captured = u;
      },
    );

    handlers['message']?.({
      model: 'claude-3-5-sonnet-20241022',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 75,
      },
    });

    expect(captured?.cache_creation_input_tokens).toBe(300);
    expect(captured?.cache_read_input_tokens).toBe(75);
  });

  it('omits cache fields from stream when SDK does not report them', async () => {
    const handlers: Record<string, (arg: unknown) => void> = {};
    const captureStream = {
      on: vi.fn((event: string, cb: (arg: unknown) => void) => {
        handlers[event] = cb;
        return captureStream;
      }),
    };
    mockStream.mockReturnValueOnce(captureStream);

    let captured: UsageRecord | undefined;
    await createMessageStream(
      { model: 'claude-3-5-sonnet-20241022', max_tokens: 100, messages: [] },
      undefined,
      (u) => {
        captured = u;
      },
    );

    handlers['message']?.({
      model: 'claude-3-5-sonnet-20241022',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    expect(captured?.cache_creation_input_tokens).toBeUndefined();
    expect(captured?.cache_read_input_tokens).toBeUndefined();
  });
});

describe('withLastMessageCached', () => {
  it('returns the same reference for an empty array', () => {
    const input: Anthropic.MessageParam[] = [];
    expect(withLastMessageCached(input)).toBe(input);
  });

  it('promotes string content to a text block array with cache_control', () => {
    const input: Anthropic.MessageParam[] = [{ role: 'user', content: 'hello' }];
    const result = withLastMessageCached(input);
    expect(result).toHaveLength(1);
    const content = result[0]!.content as unknown as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({
      type: 'text',
      text: 'hello',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('adds cache_control only to the last block when content is an array', () => {
    const input: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    ];
    const result = withLastMessageCached(input);
    const content = result[0]!.content as unknown as Array<Record<string, unknown>>;
    expect((content[0] as Record<string, unknown>)['cache_control']).toBeUndefined();
    expect((content[1] as Record<string, unknown>)['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('adds cache_control to a ToolResultBlockParam as last block', () => {
    const input: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
      },
    ];
    const result = withLastMessageCached(input);
    const block = (result[0]!.content as unknown as Array<Record<string, unknown>>)[0]!;
    expect(block['cache_control']).toEqual({ type: 'ephemeral' });
    expect(block['tool_use_id']).toBe('tu_1');
  });

  it('does not mutate the original messages array', () => {
    const input: Anthropic.MessageParam[] = [{ role: 'user', content: 'hello' }];
    withLastMessageCached(input);
    expect(input[0]!.content).toBe('hello');
  });

  it('does not mutate the content array inside the last message', () => {
    const originalContent = [{ type: 'text' as const, text: 'x' }];
    const input: Anthropic.MessageParam[] = [{ role: 'user', content: originalContent }];
    withLastMessageCached(input);
    expect(input[0]!.content).toBe(originalContent);
    expect(originalContent).toHaveLength(1);
  });

  it('only touches the last message; earlier messages are the same references', () => {
    const first: Anthropic.MessageParam = { role: 'user', content: 'first' };
    const last: Anthropic.MessageParam = {
      role: 'assistant',
      content: [{ type: 'text', text: 'last' }],
    };
    const input = [first, last];
    const result = withLastMessageCached(input);
    expect(result[0]).toBe(first);
    expect(result[1]).not.toBe(last);
  });

  it('returns the same array reference when last message has empty content array', () => {
    const input: Anthropic.MessageParam[] = [{ role: 'user', content: [] }];
    expect(withLastMessageCached(input)).toBe(input);
  });
});

describe('createMessageStream', () => {
  it('calls messages.stream with given params and the request timeout', async () => {
    const params = {
      model: 'claude-3-5-sonnet-20241022' as const,
      max_tokens: 100,
      messages: [{ role: 'user' as const, content: 'Hello' }],
    };
    const stream = await createMessageStream(params);
    expect(mockStream).toHaveBeenCalledWith(params, { timeout: REQUEST_TIMEOUT_MS });
    expect(stream).toBe(mockStreamObj);
  });

  it('REQUEST_TIMEOUT_MS is 15 minutes', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });

  it('logs usage when the message event fires on the stream', async () => {
    const handlers: Record<string, (arg: unknown) => void> = {};
    const captureStream = {
      on: vi.fn((event: string, cb: (arg: unknown) => void) => {
        handlers[event] = cb;
        return captureStream;
      }),
    };
    mockStream.mockReturnValueOnce(captureStream);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await createMessageStream(
      { model: 'claude-3-5-sonnet-20241022', max_tokens: 100, messages: [] },
      'feat-stream-1',
    );

    // Simulate the SDK firing the 'message' event with a completed message
    handlers['message']?.({
      model: 'claude-3-5-sonnet-20241022',
      usage: { input_tokens: 42, output_tokens: 7 },
    });

    expect(spy).toHaveBeenCalledOnce();
    const logged = JSON.parse((spy.mock.calls[0] as string[])[0] as string) as Record<
      string,
      unknown
    >;
    expect(logged['event']).toBe('anthropic_usage');
    expect(logged['feature_id']).toBe('feat-stream-1');
    expect(logged['input_tokens']).toBe(42);
    expect(logged['output_tokens']).toBe(7);
    spy.mockRestore();
  });
});
