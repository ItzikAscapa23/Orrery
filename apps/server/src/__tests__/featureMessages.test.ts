import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';
process.env['FIGMA_TOKEN'] = 'test-figma-token';

const { mockRunSpecAgentTurn, mockFetchFigmaImage, mockCommitSpecDraft } = vi.hoisted(() => ({
  mockRunSpecAgentTurn: vi.fn(),
  mockFetchFigmaImage: vi.fn(),
  mockCommitSpecDraft: vi
    .fn()
    .mockReturnValue({ path: 'features/t/spec.md', commit: 'abc', message: 'spec: t draft r0' }),
}));

vi.mock('../agents/specAgent.js', () => ({
  runSpecAgentTurn: mockRunSpecAgentTurn,
}));

vi.mock('../lib/artifacts.js', () => ({
  commitSpecDraft: mockCommitSpecDraft,
  ArtifactCommitError: class ArtifactCommitError extends Error {},
}));

vi.mock('../lib/figma.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/figma.js')>();
  return { ...original, fetchFigmaImage: mockFetchFigmaImage };
});

vi.mock('../lib/queue.js', () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
  getQueue: vi.fn(),
  closeQueue: vi.fn(),
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import { createFeature } from '../lib/features.js';
import { getMessagesByFeatureId } from '../lib/messages.js';
import type { FastifyInstance } from 'fastify';
import type Anthropic from '@anthropic-ai/sdk';
import type { runSpecAgentTurn as RunSpecAgentTurnType } from '../agents/specAgent.js';

let app: FastifyInstance;
let featureId: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  app = await createApp();
  const feature = await createFeature({ name: 'Test Feature', requirement: 'Do something' });
  featureId = feature.id;
  vi.clearAllMocks();
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

const assistantContent: Anthropic.ContentBlock[] = [{ type: 'text', text: 'Got it.' }];

describe('POST /features/:id/messages', () => {
  it('returns 404 when feature does not exist', async () => {
    mockRunSpecAgentTurn.mockResolvedValue({ role: 'assistant', content: assistantContent });
    const res = await app.inject({
      method: 'POST',
      url: '/features/nonexistent/messages',
      payload: { text: 'Hello' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when feature is not in DRAFTING_SPEC', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'AWS_REVIEW' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/messages`,
      payload: { text: 'Hello' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('AWS_REVIEW');
    expect(mockRunSpecAgentTurn).not.toHaveBeenCalled();
  });

  it('sets SSE response headers', async () => {
    mockRunSpecAgentTurn.mockResolvedValue({ role: 'assistant', content: assistantContent });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/messages`,
      payload: { text: 'Hello' },
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
  });

  it('streams a done event on success', async () => {
    mockRunSpecAgentTurn.mockResolvedValue({ role: 'assistant', content: assistantContent });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/messages`,
      payload: { text: 'Hello' },
    });
    expect(res.body).toContain('"type":"done"');
  });

  it('calls runSpecAgentTurn with user message appended to history', async () => {
    mockRunSpecAgentTurn.mockResolvedValue({ role: 'assistant', content: assistantContent });
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/messages`,
      payload: { text: 'My requirement' },
    });
    const [calledFeatureId, , , , calledMessages] = mockRunSpecAgentTurn.mock.calls[0] as [
      string,
      string,
      string,
      string,
      Anthropic.MessageParam[],
      unknown,
      unknown,
    ];
    expect(calledFeatureId).toBe(featureId);
    const lastMsg = calledMessages[calledMessages.length - 1];
    expect(lastMsg?.role).toBe('user');
  });

  it('saves assistant message to DB after completion', async () => {
    mockRunSpecAgentTurn.mockResolvedValue({ role: 'assistant', content: assistantContent });
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/messages`,
      payload: { text: 'Hello' },
    });
    const messages = await getMessagesByFeatureId(featureId);
    expect(messages).toHaveLength(2); // user + assistant
    expect(messages[1]?.role).toBe('assistant');
  });

  it('does not persist tool_use blocks — history after save_spec is replay-safe', async () => {
    // Simulate the model returning both a text block and a tool_use block (save_spec).
    // Only the text block must be persisted; the tool_use would cause a 400 on replay.
    const contentWithToolUse: Anthropic.ContentBlock[] = [
      { type: 'text', text: 'Saving the spec now.' },
      {
        type: 'tool_use',
        id: 'tu_01',
        name: 'save_spec',
        input: { spec_markdown: '## Overview\n' + 'x'.repeat(100) },
      },
    ];
    mockRunSpecAgentTurn.mockResolvedValue({
      role: 'assistant',
      content: contentWithToolUse,
    });
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/messages`,
      payload: { text: 'Please write the spec' },
    });
    const messages = await getMessagesByFeatureId(featureId);
    const assistantMsg = messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    const blocks = assistantMsg?.content as { type: string }[];
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(false);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
  });

  it('calls onSpecProposed when agent proposes a spec and writes spec_proposed event', async () => {
    const specMarkdown =
      '## Overview\nTest spec content that is long enough to be valid for our purposes here.';
    mockRunSpecAgentTurn.mockImplementation(
      async (
        _id: string,
        _name: string,
        _req: string,
        _slug: string,
        _msgs: Anthropic.MessageParam[],
        _onToken: (t: string) => void,
        onSpecProposed: (s: string) => Promise<void>,
      ) => {
        await onSpecProposed(specMarkdown);
        return { role: 'assistant', content: assistantContent };
      },
    );
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/messages`,
      payload: { text: 'Done defining the feature' },
    });
    expect(res.body).toContain('"type":"spec_proposed"');
  });

  it('streams error event when runSpecAgentTurn throws', async () => {
    mockRunSpecAgentTurn.mockRejectedValue(new Error('Agent crashed'));
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/messages`,
      payload: { text: 'Hello' },
    });
    expect(res.body).toContain('"type":"error"');
    expect(res.body).toContain('Agent crashed');
  });

  it('includes an image block in the user message when a PNG is attached', async () => {
    mockRunSpecAgentTurn.mockResolvedValue({ role: 'assistant', content: assistantContent });

    const pngBuffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic bytes
    const form = new FormData();
    form.append('text', 'Describe the UI');
    form.append('attachment', new File([pngBuffer], 'screen.png', { type: 'image/png' }));

    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/messages`,
      payload: form,
    });

    expect(mockRunSpecAgentTurn).toHaveBeenCalled();
    const [, , , , calledMessages] = mockRunSpecAgentTurn.mock.calls[0] as [
      string,
      string,
      string,
      string,
      Anthropic.MessageParam[],
      unknown,
      unknown,
    ];
    const lastMsg = calledMessages[calledMessages.length - 1];
    const content = lastMsg?.content as (Anthropic.ContentBlock | Anthropic.ImageBlockParam)[];
    const imageBlock = content?.find((b) => (b as { type: string }).type === 'image') as
      Anthropic.ImageBlockParam | undefined;
    expect(imageBlock).toBeDefined();
    expect(imageBlock?.source.media_type).toBe('image/png');
    expect(imageBlock?.source.data).toBe(pngBuffer.toString('base64'));
  });

  it('fetches a Figma image and includes it in the user message when a Figma URL is in the text', async () => {
    mockRunSpecAgentTurn.mockResolvedValue({ role: 'assistant', content: assistantContent });

    const figmaSource: Anthropic.ImageBlockParam['source'] = {
      type: 'base64',
      media_type: 'image/png',
      data: Buffer.from([137, 80, 78, 71]).toString('base64'),
    };
    mockFetchFigmaImage.mockResolvedValue(figmaSource);

    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/messages`,
      payload: {
        text: 'Check this design https://www.figma.com/file/ABC123/App?node-id=10:20',
      },
    });

    expect(mockFetchFigmaImage).toHaveBeenCalledWith('ABC123', '10:20');

    const [, , , , calledMessages] = mockRunSpecAgentTurn.mock.calls[0] as [
      string,
      string,
      string,
      string,
      Anthropic.MessageParam[],
      unknown,
      unknown,
    ];
    const lastMsg = calledMessages[calledMessages.length - 1];
    const content = lastMsg?.content as (Anthropic.ContentBlock | Anthropic.ImageBlockParam)[];
    const imageBlock = content?.find((b) => (b as { type: string }).type === 'image') as
      Anthropic.ImageBlockParam | undefined;
    expect(imageBlock).toBeDefined();
    expect(imageBlock?.source.media_type).toBe('image/png');
    expect(imageBlock?.source.data).toBe(figmaSource.data);
  });
});

// ── Agent activity contract — integration ─────────────────────────────────────

describe('agent activity contract — real conversation turn', () => {
  it('emits agent.status(working → waiting) and at least one agent.log with correct attribution for a mid-conversation reply', async () => {
    // runSpecAgentTurn calls the token callback only — no onSpecProposed call,
    // modelling a mid-conversation reply where the agent responds but does not
    // yet call save_spec.
    (mockRunSpecAgentTurn as MockedFunction<typeof RunSpecAgentTurnType>).mockImplementation(
      (
        _id: string,
        _name: string,
        _req: string,
        _slug: string,
        _msgs: Anthropic.MessageParam[],
        onToken: (t: string) => void,
      ) => {
        onToken('Hello');
        return Promise.resolve({ role: 'assistant', content: assistantContent });
      },
    );

    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/messages`,
      payload: { text: 'Tell me more' },
    });

    const events = await getPrisma().event.findMany({
      where: { featureId },
      orderBy: { seq: 'asc' },
    });

    const statusEvents = events.filter((e) => e.type === 'agent.status');
    const logEvents = events.filter((e) => e.type === 'agent.log');

    // Must have at least working + waiting
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);

    const workingEvent = statusEvents.find(
      (e) => (e.payload as { status?: string }).status === 'working',
    );
    const waitingEvent = statusEvents.find(
      (e) => (e.payload as { status?: string }).status === 'waiting',
    );
    expect(workingEvent).toBeDefined();
    expect(waitingEvent).toBeDefined();

    // All status events attributed to 'spec'
    for (const e of statusEvents) {
      expect(e.agent).toBe('spec');
    }

    // At least one agent.log line from the spec agent
    const specLogs = logEvents.filter((e) => e.agent === 'spec');
    expect(specLogs.length).toBeGreaterThanOrEqual(1);

    // No spec-agent event with agent=null
    const nullAgentSpecEvents = events.filter(
      (e) =>
        e.agent === null &&
        (e.type === 'agent.status' || e.type === 'agent.log') &&
        (e.payload as { agent?: string }).agent === 'spec',
    );
    expect(nullAgentSpecEvents).toHaveLength(0);
  });

  it('emits agent.status(failed) when runSpecAgentTurn throws', async () => {
    mockRunSpecAgentTurn.mockRejectedValue(new Error('API timeout'));

    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/messages`,
      payload: { text: 'Hello' },
    });

    const failedEvent = await getPrisma().event.findFirst({
      where: {
        featureId,
        type: 'agent.status',
        payload: { path: ['status'], equals: 'failed' },
      },
    });
    expect(failedEvent).not.toBeNull();
    expect(failedEvent?.agent).toBe('spec');
  });
});
