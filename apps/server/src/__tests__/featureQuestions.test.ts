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
// No charter → skip AWS review, go directly to submitSpecSkip.
vi.mock('../lib/charterResolver.js', () => ({
  resolveCharterPath: vi.fn().mockReturnValue(null),
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import { createFeature } from '../lib/features.js';
import { appendEvent } from '../lib/events.js';
import type { FastifyInstance } from 'fastify';
import type Anthropic from '@anthropic-ai/sdk';

let app: FastifyInstance;
let featureId: string;

const SPEC = '# Feature spec\n\n## Overview\nA test feature.';
const assistantContent: Anthropic.ContentBlock[] = [{ type: 'text', text: 'Updated.' }];

async function seedGateOpen(fId: string): Promise<void> {
  await appendEvent(getPrisma(), fId, {
    type: 'gate.opened',
    gate: 'spec_approval',
    summary: SPEC.slice(0, 200),
    revision: 0,
    counts: { blockers: 0, warnings: 0, suggestions: 0 },
    spec_commit: 'abc0000',
  });
}

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  app = await createApp();
  const feature = await createFeature({ name: 'Questions Test', requirement: 'something' });
  featureId = feature.id;

  await getPrisma().feature.update({
    where: { id: featureId },
    data: { status: 'AWAITING_APPROVAL', proposedSpec: SPEC },
  });

  vi.clearAllMocks();
  mockCommitSpecDraft.mockReturnValue({
    path: 'features/questions-test/spec.md',
    commit: 'def5678',
    message: 'spec: questions-test draft r1',
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

// ── Error paths ───────────────────────────────────────────────────────────────

describe('POST /features/:id/questions/:qId/answer — error paths', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features/nonexistent/questions/q1/answer',
      payload: { answer: 'yes' },
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
      url: `/features/${featureId}/questions/q1/answer`,
      payload: { answer: 'yes' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 400 when answer is missing', async () => {
    await seedGateOpen(featureId);
    await getPrisma().specQuestion.create({
      data: { id: 'q1', featureId, specRev: 0, text: 'What is the scope?' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/questions/q1/answer`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when question id does not exist', async () => {
    await seedGateOpen(featureId);
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/questions/nonexistent/answer`,
      payload: { answer: 'yes' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when question belongs to a stale specRev', async () => {
    // Two gate.opened events → gateOpenedCount=2, currentCycleRev=1
    // Question has specRev=0 → stale
    await seedGateOpen(featureId);
    await seedGateOpen(featureId);
    await getPrisma().specQuestion.create({
      data: { id: 'q1', featureId, specRev: 0, text: 'Old cycle question?' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/questions/q1/answer`,
      payload: { answer: 'yes' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>()['error']).toMatch(/revision/);
  });

  it('returns 409 when question has already been answered', async () => {
    await seedGateOpen(featureId);
    await getPrisma().specQuestion.create({
      data: {
        id: 'q1',
        featureId,
        specRev: 0,
        text: 'Already answered?',
        resolution: 'answered',
        answer: 'yes',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/questions/q1/answer`,
      payload: { answer: 'no' },
    });
    expect(res.statusCode).toBe(409);
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('POST /features/:id/questions/:qId/answer — happy path', () => {
  it('returns SSE stream with done event, marks question answered, transitions away from AWAITING_APPROVAL', async () => {
    await seedGateOpen(featureId);
    await getPrisma().specQuestion.create({
      data: { id: 'q1', featureId, specRev: 0, text: 'What is the target platform?' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/features/${featureId}/questions/q1/answer`,
      payload: { answer: 'iOS and Android' },
    });

    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('"type":"done"');

    const question = await getPrisma().specQuestion.findUnique({
      where: { featureId_specRev_id: { featureId, specRev: 0, id: 'q1' } },
    });
    expect(question?.resolution).toBe('answered');
    expect(question?.answer).toBe('iOS and Android');

    const updated = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(updated?.status).not.toBe('AWAITING_APPROVAL');
  });

  it('emits spec.question_answered event with correct payload', async () => {
    await seedGateOpen(featureId);
    await getPrisma().specQuestion.create({
      data: { id: 'q1', featureId, specRev: 0, text: 'What is the scope?' },
    });

    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/questions/q1/answer`,
      payload: { answer: 'auth module only' },
    });

    const events = await getEvents();
    const answered = events.find((e) => e.type === 'spec.question_answered');
    expect(answered).toBeDefined();
    expect((answered?.payload as { question_id: string }).question_id).toBe('q1');
    expect((answered?.payload as { answer: string }).answer).toBe('auth module only');
  });

  it('emits gate.resolved(changes_requested) before spec agent reruns', async () => {
    await seedGateOpen(featureId);
    await getPrisma().specQuestion.create({
      data: { id: 'q1', featureId, specRev: 0, text: 'Scope?' },
    });

    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/questions/q1/answer`,
      payload: { answer: 'minimal' },
    });

    const events = await getEvents();
    const gateResolved = events.find(
      (e) =>
        e.type === 'gate.resolved' &&
        (e.payload as { resolution: string }).resolution === 'changes_requested',
    );
    expect(gateResolved).toBeDefined();
  });

  it('104-answer-round-trips: spec agent is invoked and gate reopens on answer', async () => {
    await seedGateOpen(featureId);
    await getPrisma().specQuestion.create({
      data: { id: 'q1', featureId, specRev: 0, text: 'Platform?' },
    });

    // Mock spec agent to call onSpecProposed — simulates the agent rewriting the spec
    mockRunSpecAgentTurn.mockImplementation(
      async (
        _fid: string,
        _name: string,
        _req: string,
        _slug: string,
        _history: unknown,
        _onToken: unknown,
        onSpecProposed: (
          spec: string,
          questions: Array<{ id: string; text: string }>,
        ) => Promise<void>,
        _onUsage: unknown,
        _path: unknown,
      ) => {
        await onSpecProposed('# Updated spec\n\nPlatform: iOS and Android.', []);
        return { role: 'assistant' as const, content: assistantContent };
      },
    );

    await app.inject({
      method: 'POST',
      url: `/features/${featureId}/questions/q1/answer`,
      payload: { answer: 'iOS and Android' },
    });

    const events = await getEvents();

    // Gate should have reopened (new gate.opened event from submitSpecSkip)
    const gateOpenedEvents = events.filter((e) => e.type === 'gate.opened');
    expect(gateOpenedEvents.length).toBeGreaterThanOrEqual(2);

    // Artifact committed for the new spec
    const artifactCommitted = events.filter((e) => e.type === 'artifact.committed');
    expect(artifactCommitted.length).toBeGreaterThanOrEqual(1);

    // Feature proposedSpec updated with the new spec
    const updated = await getPrisma().feature.findUnique({ where: { id: featureId } });
    expect(updated?.proposedSpec).toContain('Platform: iOS and Android');
  });

  it('104-id-recurrence: question id reuse across specRevs does not conflict', async () => {
    // Model assigns 'q1' in both rev 0 and rev 1 — composite PK prevents collision
    await getPrisma().specQuestion.createMany({
      data: [
        {
          id: 'q1',
          featureId,
          specRev: 0,
          text: 'Rev 0 scope?',
          resolution: 'answered',
          answer: 'limited',
        },
        { id: 'q1', featureId, specRev: 1, text: 'Rev 1 same id unanswered' },
      ],
    });

    const rev0 = await getPrisma().specQuestion.findUnique({
      where: { featureId_specRev_id: { featureId, specRev: 0, id: 'q1' } },
    });
    const rev1 = await getPrisma().specQuestion.findUnique({
      where: { featureId_specRev_id: { featureId, specRev: 1, id: 'q1' } },
    });

    expect(rev0?.resolution).toBe('answered');
    expect(rev1?.resolution).toBeNull();
  });
});
