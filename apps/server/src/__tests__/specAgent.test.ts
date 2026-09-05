import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

// vi.hoisted ensures the mock fn is defined before vi.mock's factory runs
const { mockCreateMessageStream } = vi.hoisted(() => ({
  mockCreateMessageStream: vi.fn(),
}));

vi.mock('../lib/anthropic.js', () => ({
  createMessageStream: mockCreateMessageStream,
  createMessage: vi.fn(),
}));

vi.mock('../lib/attachmentContext.js', () => ({
  buildAttachmentContext: vi.fn().mockReturnValue(''),
}));

import { runSpecAgentTurn } from '../agents/specAgent.js';
import type Anthropic from '@anthropic-ai/sdk';

function makeStreamStub(finalMessage: Anthropic.Message) {
  const handlers: Record<string, (arg: unknown) => void> = {};
  return {
    on: vi.fn((event: string, cb: (arg: unknown) => void) => {
      handlers[event] = cb;
      return streamStub;
    }),
    finalMessage: vi.fn().mockResolvedValue(finalMessage),
    _emit: (event: string, arg: unknown) => handlers[event]?.(arg),
  };
}

let streamStub: ReturnType<typeof makeStreamStub>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runSpecAgentTurn', () => {
  it('calls onToken for text replies and does not call onSpecProposed', async () => {
    const textMessage: Anthropic.Message = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'What is the target platform?' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 8 },
    };

    streamStub = makeStreamStub(textMessage);
    mockCreateMessageStream.mockReturnValue(streamStub);

    const tokens: string[] = [];
    const onToken = vi.fn((t: string) => tokens.push(t));
    const onSpecProposed = vi.fn().mockResolvedValue(undefined);

    // simulate text event before finalMessage resolves
    mockCreateMessageStream.mockImplementation(() => {
      const s = makeStreamStub(textMessage);
      // emit text event synchronously during finalMessage call
      const orig = s.finalMessage.bind(s);
      s.finalMessage = vi.fn().mockImplementation(() => {
        s._emit('text', 'What is the target platform?');
        return orig() as Promise<Anthropic.Message>;
      });
      return s;
    });

    const result = await runSpecAgentTurn(
      'feat-1',
      'My Feature',
      'Some requirement',
      'test-slug',
      [],
      onToken,
      onSpecProposed,
    );

    expect(onToken).toHaveBeenCalledWith('What is the target platform?');
    expect(onSpecProposed).not.toHaveBeenCalled();
    expect(result.role).toBe('assistant');
  });

  it('calls onSpecProposed when agent calls save_spec', async () => {
    const specMarkdown = `## Overview\nThis feature allows users to log in.\n## User stories\n- As a user I can log in\n## Acceptance criteria\nGiven valid credentials, when I submit, then I am logged in.\n## Screens\nN/A\n## API endpoints\nPOST /auth/login\n## Out of scope\nSSO\n## Open questions\nNone`;

    const toolUseMessage: Anthropic.Message = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'save_spec',
          input: { spec_markdown: specMarkdown },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 50 },
    };

    mockCreateMessageStream.mockReturnValue(makeStreamStub(toolUseMessage));

    const onToken = vi.fn();
    const onSpecProposed = vi.fn().mockResolvedValue(undefined);

    await runSpecAgentTurn(
      'feat-2',
      'My Feature',
      'Some requirement',
      'test-slug',
      [],
      onToken,
      onSpecProposed,
    );

    expect(onSpecProposed).toHaveBeenCalledWith(specMarkdown, []);
  });

  it('passes feature name and requirement as the first message to the model', async () => {
    const textMessage: Anthropic.Message = {
      id: 'msg_ctx',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'Got it, let me ask a clarifying question.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 10 },
    };

    mockCreateMessageStream.mockReturnValue(makeStreamStub(textMessage));

    await runSpecAgentTurn(
      'feat-ctx',
      'Login Flow',
      'Users need to log in with email and password',
      'test-slug',
      [],
      vi.fn(),
      vi.fn().mockResolvedValue(undefined),
    );

    const callArgs = mockCreateMessageStream.mock.calls[0]?.[0] as {
      messages: { role: string; content: string }[];
    };
    const firstMessage = callArgs.messages[0];
    expect(firstMessage?.role).toBe('user');
    expect(firstMessage?.content).toContain('Login Flow');
    expect(firstMessage?.content).toContain('Users need to log in with email and password');
  });

  it('throws when save_spec input is too short (Zod validation)', async () => {
    const toolUseMessage: Anthropic.Message = {
      id: 'msg_3',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [
        {
          type: 'tool_use',
          id: 'tool_2',
          name: 'save_spec',
          input: { spec_markdown: 'too short' },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    mockCreateMessageStream.mockReturnValue(makeStreamStub(toolUseMessage));

    await expect(
      runSpecAgentTurn(
        'feat-3',
        'My Feature',
        'Some requirement',
        'test-slug',
        [],
        vi.fn(),
        vi.fn().mockResolvedValue(undefined),
      ),
    ).rejects.toThrow('spec_markdown must be at least 100 characters');
  });
});
