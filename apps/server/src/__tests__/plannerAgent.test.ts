import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/repo-manifest.yaml',
);

process.env['ANTHROPIC_PROVIDER'] = 'anthropic';
process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockCreateMessageStream } = vi.hoisted(() => ({
  mockCreateMessageStream: vi.fn(),
}));

vi.mock('../lib/anthropic.js', () => ({
  createMessageStream: mockCreateMessageStream,
  resetClientForTesting: vi.fn(),
}));

import { runPlannerAgent, buildSystemPrompt } from '../agents/plannerAgent.js';
import { disconnectPrisma } from '../lib/prisma.js';

afterAll(async () => {
  await disconnectPrisma();
});

function makeMessage(text: string) {
  return {
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 200, output_tokens: 150 },
    content: [{ type: 'text', text }],
  };
}

function sm(text: string) {
  return { finalMessage: () => Promise.resolve(makeMessage(text)) };
}

const VALID_PLAN_JSON = JSON.stringify({
  contract_yaml: 'openapi: "3.0.0"\ninfo:\n  title: Test\n  version: "1.0.0"\npaths: {}',
  tasks: [
    {
      repo: 'demo-server',
      side: 'server',
      title: 'Add endpoint',
      description: 'Implement the endpoint.',
      spec_refs: ['API endpoints'],
      depends_on: [],
    },
  ],
});

describe('runPlannerAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed plan on valid first response', async () => {
    mockCreateMessageStream.mockResolvedValueOnce(sm(VALID_PLAN_JSON));

    const result = await runPlannerAgent('feat-1', 'Test Feature', '## Overview\nSpec here.');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.repo).toBe('demo-server');
    expect(result.contract_yaml).toContain('openapi');
    expect(mockCreateMessageStream).toHaveBeenCalledTimes(1);
  });

  it('retries once on invalid first response and returns plan on retry', async () => {
    mockCreateMessageStream
      .mockResolvedValueOnce(sm('not valid json at all'))
      .mockResolvedValueOnce(sm(VALID_PLAN_JSON));

    const result = await runPlannerAgent('feat-2', 'Test Feature', '## Overview\nSpec here.');
    expect(result.tasks).toHaveLength(1);
    expect(mockCreateMessageStream).toHaveBeenCalledTimes(2);
  });

  it('retry prompt does not echo the prior response (prevents token budget collapse)', async () => {
    const bigFirstResponse = 'x'.repeat(10000); // simulate truncated/large first response
    mockCreateMessageStream
      .mockResolvedValueOnce(sm(bigFirstResponse))
      .mockResolvedValueOnce(sm(VALID_PLAN_JSON));

    await runPlannerAgent('feat-2b', 'Test Feature', '## Overview\nSpec here.');

    const retryCall = mockCreateMessageStream.mock.calls[1];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const retryMessages = retryCall?.[0]?.messages as Array<{
      role: string;
      content: string;
    }>;
    const retryContent = retryMessages?.[0]?.content ?? '';

    // The retry prompt must NOT include the full prior response text
    expect(retryContent).not.toContain(bigFirstResponse);
    // But it must contain a clear instruction to produce valid JSON
    expect(retryContent).toContain('valid JSON');
  });

  it('throws when both attempts fail to parse', async () => {
    mockCreateMessageStream
      .mockResolvedValueOnce(sm('invalid'))
      .mockResolvedValueOnce(sm('also invalid'));

    await expect(
      runPlannerAgent('feat-3', 'Test Feature', '## Overview\nSpec here.'),
    ).rejects.toThrow('Planner agent parse failure');
    expect(mockCreateMessageStream).toHaveBeenCalledTimes(2);
  });

  it('handles tasks with empty depends_on and spec_refs', async () => {
    const minimalJson = JSON.stringify({
      contract_yaml: 'openapi: "3.0.0"\ninfo:\n  title: T\n  version: "1"\npaths: {}',
      tasks: [
        {
          repo: 'demo-client',
          side: 'client',
          title: 'Add screen',
          description: 'Add a screen.',
          spec_refs: [],
          depends_on: [],
        },
      ],
    });
    mockCreateMessageStream.mockResolvedValueOnce(sm(minimalJson));

    const result = await runPlannerAgent('feat-4', 'Test Feature', '## Overview\nSpec here.');
    expect(result.tasks[0]?.side).toBe('client');
    expect(result.tasks[0]?.depends_on).toHaveLength(0);
  });

  it('strips markdown fences if model wraps JSON', async () => {
    const fenced = '```json\n' + VALID_PLAN_JSON + '\n```';
    mockCreateMessageStream.mockResolvedValueOnce(sm(fenced));

    const result = await runPlannerAgent('feat-5', 'Test Feature', '## Overview\nSpec here.');
    expect(result.tasks).toHaveLength(1);
  });
});

// ── Manifest filtering ────────────────────────────────────────────────────────

describe('buildSystemPrompt — active repo filtering', () => {
  it('includes both active demo repos in the prompt', () => {
    const prompt = buildSystemPrompt([], FIXTURE_PATH);
    expect(prompt).toContain('demo-server');
    expect(prompt).toContain('demo-client');
  });

  it('excludes inactive real-bank repos from the prompt', () => {
    const prompt = buildSystemPrompt([], FIXTURE_PATH);
    const inactiveIds = [
      'bff',
      'bff-configurations',
      'swaggers',
      'mobile-app',
      'demo-components',
      'demo-theme',
    ];
    for (const id of inactiveIds) {
      expect(prompt).not.toContain(id);
    }
  });
});

// ── Selected repo filtering ───────────────────────────────────────────────────

describe('buildSystemPrompt — selected repo filtering', () => {
  it('restricts the manifest section to the selected repos', () => {
    const prompt = buildSystemPrompt(['demo-server'], FIXTURE_PATH);
    expect(prompt).toContain('demo-server');
    expect(prompt).not.toContain('demo-client');
  });

  it('includes all active repos when selectedRepos is empty (legacy fallback)', () => {
    const prompt = buildSystemPrompt([], FIXTURE_PATH);
    expect(prompt).toContain('demo-server');
    expect(prompt).toContain('demo-client');
  });
});

// ── Revision mode ─────────────────────────────────────────────────────────────

describe('runPlannerAgent — revision mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateMessageStream.mockResolvedValue(sm(VALID_PLAN_JSON));
  });

  it('revision prompt contains the prior plan verbatim', async () => {
    await runPlannerAgent('feat-rev-1', 'Login Feature', '## Overview\nSpec here.', undefined, {
      priorPlan: 'PRIOR_PLAN_SENTINEL',
      comment: 'Split the server work into smaller tasks',
    });
    const callArg = mockCreateMessageStream.mock.calls[0]?.[0] as {
      messages: { content: string }[];
    };
    const userContent = callArg.messages[0]?.content ?? '';
    expect(userContent).toContain('PRIOR_PLAN_SENTINEL');
  });

  it('revision prompt contains the developer comment as a prioritized instruction', async () => {
    const comment = 'Split the server work into smaller tasks';
    await runPlannerAgent('feat-rev-2', 'Login Feature', '## Overview\nSpec here.', undefined, {
      priorPlan: 'Some previous plan content',
      comment,
    });
    const callArg = mockCreateMessageStream.mock.calls[0]?.[0] as {
      messages: { content: string }[];
    };
    const userContent = callArg.messages[0]?.content ?? '';
    expect(userContent).toContain(
      `The developer reviewed the previous plan and requires: ${comment}`,
    );
  });

  it('initial plan (no revisionContext) is unaffected — does not mention revision', async () => {
    await runPlannerAgent('feat-rev-3', 'Login Feature', '## Overview\nSpec here.');
    const callArg = mockCreateMessageStream.mock.calls[0]?.[0] as {
      messages: { content: string }[];
    };
    const userContent = callArg.messages[0]?.content ?? '';
    expect(userContent).not.toContain('Previous plan');
    expect(userContent).not.toContain('developer reviewed');
  });
});
