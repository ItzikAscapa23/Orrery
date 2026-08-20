import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockCommitSpecDraft, mockRunSpecAgentTurn } = vi.hoisted(() => ({
  mockCommitSpecDraft: vi.fn(),
  mockRunSpecAgentTurn: vi.fn(),
}));

vi.mock('../lib/artifacts.js', () => ({
  commitSpecDraft: mockCommitSpecDraft,
  ArtifactCommitError: class ArtifactCommitError extends Error {},
}));
vi.mock('../agents/specAgent.js', () => ({ runSpecAgentTurn: mockRunSpecAgentTurn }));
vi.mock('../lib/queue.js', () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
  getQueue: vi.fn(),
  closeQueue: vi.fn(),
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import { createFeature } from '../lib/features.js';
import { appendEvent } from '../lib/events.js';
import type { FastifyInstance } from 'fastify';
import type Anthropic from '@anthropic-ai/sdk';

let app: FastifyInstance;
let featureId: string;

const SPEC = '# Full spec\n\nThis is a complete specification document with enough content.';
const assistantContent: Anthropic.ContentBlock[] = [{ type: 'text', text: 'Understood.' }];

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  app = await createApp();
  const feature = await createFeature({ name: 'Approve Test', requirement: 'something' });
  featureId = feature.id;

  // Put the feature in AWAITING_APPROVAL with a proposed spec
  await getPrisma().feature.update({
    where: { id: featureId },
    data: { status: 'AWAITING_APPROVAL', proposedSpec: SPEC },
  });

  vi.clearAllMocks();
  mockCommitSpecDraft.mockReturnValue({
    path: 'features/approve-test/spec.md',
    commit: 'abc1234',
    message: 'spec: approve-test draft r0',
  });
  mockRunSpecAgentTurn.mockResolvedValue({ role: 'assistant', content: assistantContent });
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

async function getEvents() {
  return getPrisma().event.findMany({ where: { featureId }, orderBy: { seq: 'asc' } });
}

// ── POST /approve ─────────────────────────────────────────────────────────────

describe('POST /features/:id/approve', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/features/nonexistent/approve' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when feature is not in AWAITING_APPROVAL', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'DRAFTING_SPEC' },
    });
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/approve` });
    expect(res.statusCode).toBe(409);
  });

  it('returns 409 when called a second time (feature already in PLANNING)', async () => {
    await app.inject({ method: 'POST', url: `/features/${featureId}/approve` });
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/approve` });
    expect(res.statusCode).toBe(409);
  });

  it('does NOT call commitSpecDraft on approve — spec committed at draft time', async () => {
    await app.inject({ method: 'POST', url: `/features/${featureId}/approve` });
    expect(mockCommitSpecDraft).not.toHaveBeenCalled();
  });

  it('returns 200 with updated feature', async () => {
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/approve` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>()['status']).toBe('PLANNING');
  });

  it('emits gate.resolved(approved) and phase.changed; no second artifact.committed', async () => {
    // Seed a pre-existing artifact.committed (simulates what specProposed committed)
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'artifact.committed',
        path: 'features/approve-test/spec.md',
        commit: 'abc1234',
        message: 'spec: approve-test draft r0',
      }),
    );

    await app.inject({ method: 'POST', url: `/features/${featureId}/approve` });
    const events = await getEvents();
    const types = events.map((e) => e.type);
    expect(types).toContain('gate.resolved');
    expect(types).toContain('phase.changed');

    const gateEvent = events.find((e) => e.type === 'gate.resolved');
    expect((gateEvent?.payload as { resolution: string }).resolution).toBe('approved');

    const phaseEvent = events.filter((e) => e.type === 'phase.changed').at(-1);
    expect((phaseEvent?.payload as { to: string }).to).toBe('PLANNING');

    // Exactly one artifact.committed (the draft one seeded above — approve does not add another)
    const artifactEvents = events.filter((e) => e.type === 'artifact.committed');
    expect(artifactEvents).toHaveLength(1);
    expect((artifactEvents[0]?.payload as { commit: string }).commit).toBe('abc1234');
  });

  it('enqueues plan job on approve (dispatchForState, non-simulated)', async () => {
    // approve → PLANNING → dispatchForState → 'plan' for both real and simulated
    const { enqueueJob: mockEnqueue } = await import('../lib/queue.js');
    vi.mocked(mockEnqueue).mockClear();
    await app.inject({ method: 'POST', url: `/features/${featureId}/approve` });
    expect(vi.mocked(mockEnqueue)).toHaveBeenCalledWith(featureId, 'plan', undefined);
  });

  it('enqueues plan job on approve when simulatedRun=true (plannerJob handles simulation internally)', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { simulatedRun: true },
    });
    const { enqueueJob: mockEnqueue } = await import('../lib/queue.js');
    vi.mocked(mockEnqueue).mockClear();
    await app.inject({ method: 'POST', url: `/features/${featureId}/approve` });
    expect(vi.mocked(mockEnqueue)).toHaveBeenCalledWith(featureId, 'plan', undefined);
  });
});

// ── POST /request-changes ─────────────────────────────────────────────────────

describe('POST /features/:id/request-changes', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features/nonexistent/request-changes',
      payload: { comment: 'please fix' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when feature is not in AWAITING_APPROVAL', async () => {
    await getPrisma().feature.update({
      where: { id: featureId },
      data: { status: 'DRAFTING_SPEC' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-changes`,
      payload: { comment: 'fix this' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 400 when comment is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-changes`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns SSE stream with done event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-changes`,
      payload: { comment: 'Add error handling section' },
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('"type":"done"');
  });

  it('emits gate.resolved(changes_requested), chat.message(dev), phase.changed to DRAFTING_SPEC', async () => {
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-changes`,
      payload: { comment: 'Add error states' },
    });

    const events = await getEvents();
    const gateEvent = events.find((e) => e.type === 'gate.resolved');
    expect((gateEvent?.payload as { resolution: string }).resolution).toBe('changes_requested');
    expect((gateEvent?.payload as { comment: string }).comment).toBe('Add error states');

    const chatDev = events.find(
      (e) => e.type === 'chat.message' && (e.payload as { who: string }).who === 'dev',
    );
    expect((chatDev?.payload as { text: string }).text).toBe('Add error states');

    const phaseEvent = events.find(
      (e) => e.type === 'phase.changed' && (e.payload as { to: string }).to === 'DRAFTING_SPEC',
    );
    expect(phaseEvent).toBeDefined();

    const updated = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(updated?.status).toBe('DRAFTING_SPEC');
    expect(updated?.proposedSpec).toBeNull();
  });

  it('delivers comment to spec agent as next user message', async () => {
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-changes`,
      payload: { comment: 'Please add user story 3' },
    });

    expect(mockRunSpecAgentTurn).toHaveBeenCalled();
    const callArgs = mockRunSpecAgentTurn.mock.calls[0] as unknown[];
    const messages = callArgs[4] as Anthropic.MessageParam[];
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg?.role).toBe('user');
    const content = lastMsg?.content as { type: string; text: string }[];
    expect(content[0]?.text).toBe('Please add user story 3');
  });

  it('second approve after request-changes returns 409 (machine in DRAFTING_SPEC)', async () => {
    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/request-changes`,
      payload: { comment: 'fix it' },
    });
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/approve` });
    expect(res.statusCode).toBe(409);

    // Verify no extra events were appended by the rejected approve
    const events = await getEvents();
    const approveEvents = events.filter(
      (e) =>
        e.type === 'gate.resolved' &&
        (e.payload as { resolution: string }).resolution === 'approved',
    );
    expect(approveEvents).toHaveLength(0);
  });
});

// ── Legacy /approve-spec removed ──────────────────────────────────────────────

describe('POST /features/:id/approve-spec (removed)', () => {
  it('returns 404 — route no longer exists', async () => {
    const res = await app.inject({ method: 'POST', url: `/features/${featureId}/approve-spec` });
    expect(res.statusCode).toBe(404);
  });
});

// ── SSE event emission via appendEvent (verify seq integrity) ─────────────────

describe('approve event seq integrity', () => {
  it('seq is monotonically increasing across approve events', async () => {
    // seed an initial event manually
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'agent.log',
        agent: 'spec',
        severity: 'info',
        text: 'pre-existing',
      }),
    );
    await app.inject({ method: 'POST', url: `/features/${featureId}/approve` });
    const events = await getEvents();
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });
});
