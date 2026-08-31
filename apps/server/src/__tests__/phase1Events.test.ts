import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockRunSpecAgentTurn, mockEnqueueJob, mockCommitSpecDraft } = vi.hoisted(() => ({
  mockRunSpecAgentTurn: vi.fn(),
  mockEnqueueJob: vi.fn().mockResolvedValue(undefined),
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

// Prevent real Redis connections in tests — the job is enqueued but not executed.
vi.mock('../lib/queue.js', () => ({
  enqueueJob: mockEnqueueJob,
  getQueue: vi.fn(),
  closeQueue: vi.fn(),
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createFeature } from '../lib/features.js';
import { createApp } from '../app.js';
import type { FastifyInstance } from 'fastify';
import type Anthropic from '@anthropic-ai/sdk';

let app: FastifyInstance;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  app = await createApp();
  vi.clearAllMocks();
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

async function getEvents(featureId: string) {
  return getPrisma().event.findMany({
    where: { featureId },
    orderBy: { seq: 'asc' },
  });
}

describe('createFeature event emission', () => {
  it('emits phase.changed{from:null,to:DRAFTING_SPEC} with seq=1 on creation', async () => {
    const feature = await createFeature({ name: 'My Feature', requirement: 'do something' });
    const events = await getEvents(feature.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(1);
    expect(events[0]?.type).toBe('phase.changed');
    const payload = events[0]?.payload as { from: unknown; to: string };
    expect(payload.from).toBeNull();
    expect(payload.to).toBe('DRAFTING_SPEC');
  });

  it('feature status is DRAFTING_SPEC after creation', async () => {
    const feature = await createFeature({ name: 'Status Check', requirement: 'req' });
    const row = await getPrisma().feature.findUnique({ where: { id: feature.id } });
    expect(row?.status).toBe('DRAFTING_SPEC');
  });
});

describe('POST /features/:id/messages event emission', () => {
  const assistantContent: Anthropic.ContentBlock[] = [{ type: 'text', text: 'Got it.' }];

  it('emits chat.message{who:dev} for user message', async () => {
    mockRunSpecAgentTurn.mockResolvedValue({ role: 'assistant', content: assistantContent });
    const feature = await createFeature({ name: 'Chat Test', requirement: 'req' });

    await app.inject({
      method: 'POST',
      url: `/features/${feature.id}/messages`,
      payload: { text: 'Hello from dev' },
    });

    const events = await getEvents(feature.id);
    const chatDev = events.find(
      (e) => e.type === 'chat.message' && (e.payload as { who: string }).who === 'dev',
    );
    expect(chatDev).toBeDefined();
    expect((chatDev?.payload as { text: string }).text).toBe('Hello from dev');
  });

  it('emits chat.message{who:spec} for assistant reply', async () => {
    mockRunSpecAgentTurn.mockResolvedValue({ role: 'assistant', content: assistantContent });
    const feature = await createFeature({ name: 'Assistant Chat', requirement: 'req' });

    await app.inject({
      method: 'POST',
      url: `/features/${feature.id}/messages`,
      payload: { text: 'Hello' },
    });

    const events = await getEvents(feature.id);
    const chatSpec = events.find(
      (e) => e.type === 'chat.message' && (e.payload as { who: string }).who === 'spec',
    );
    expect(chatSpec).toBeDefined();
    expect((chatSpec?.payload as { text: string }).text).toBe('Got it.');
  });

  it('transitions to AWAITING_APPROVAL and skips aws-review when no charter is configured', async () => {
    const specMarkdown = '## Overview\n' + 'x'.repeat(150);
    mockRunSpecAgentTurn.mockImplementation(
      async (
        _id: string,
        _name: string,
        _req: string,
        _slug: string,
        _msgs: unknown,
        _onToken: unknown,
        onSpecProposed: (s: string) => Promise<void>,
      ) => {
        await onSpecProposed(specMarkdown);
        return { role: 'assistant', content: assistantContent };
      },
    );
    const feature = await createFeature({ name: 'Spec Proposal', requirement: 'req' });

    await app.inject({
      method: 'POST',
      url: `/features/${feature.id}/messages`,
      payload: { text: 'Ready to spec' },
    });

    const events = await getEvents(feature.id);
    const types = events.map((e) => e.type);

    // No charter configured — spec approval gate is opened directly by the route
    expect(types).toContain('gate.opened');
    expect(types).toContain('phase.changed');
    expect(types).toContain('agent.log');

    // Machine advances to AWAITING_APPROVAL directly (no AWS_REVIEW)
    const updated = await getPrisma().feature.findUnique({ where: { id: feature.id } });
    expect(updated?.status).toBe('AWAITING_APPROVAL');

    // aws-review job must NOT be enqueued
    expect(mockEnqueueJob).not.toHaveBeenCalledWith(feature.id, 'aws-review', expect.anything());
  });

  it('re-propose skips aws-review when no charter is configured', async () => {
    const specMarkdown = '## Overview\n' + 'x'.repeat(150);
    mockRunSpecAgentTurn.mockImplementation(
      async (
        _id: string,
        _name: string,
        _req: string,
        _slug: string,
        _msgs: unknown,
        _onToken: unknown,
        onSpecProposed: (s: string) => Promise<void>,
      ) => {
        await onSpecProposed(specMarkdown);
        return { role: 'assistant', content: assistantContent };
      },
    );
    const feature = await createFeature({ name: 'Revision Test', requirement: 'req' });

    await app.inject({
      method: 'POST',
      url: `/features/${feature.id}/messages`,
      payload: { text: 'first' },
    });

    // Manually roll back to DRAFTING_SPEC so a second proposal is valid
    await getPrisma().feature.update({
      where: { id: feature.id },
      data: { status: 'DRAFTING_SPEC' },
    });

    mockEnqueueJob.mockClear();

    await app.inject({
      method: 'POST',
      url: `/features/${feature.id}/messages`,
      payload: { text: 'revised' },
    });

    // Still no charter — aws-review not enqueued
    expect(mockEnqueueJob).not.toHaveBeenCalledWith(feature.id, 'aws-review', expect.anything());
    // Feature ends at AWAITING_APPROVAL again
    const updated = await getPrisma().feature.findUnique({ where: { id: feature.id } });
    expect(updated?.status).toBe('AWAITING_APPROVAL');
  });
});
