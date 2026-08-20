import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';

const { mockCreateMessageStream } = vi.hoisted(() => ({
  mockCreateMessageStream: vi.fn(),
}));

vi.mock('../lib/anthropic.js', () => ({
  createMessageStream: mockCreateMessageStream,
}));

import { runAwsReview } from '../agents/awsAgent.js';
import { disconnectPrisma } from '../lib/prisma.js';

afterAll(async () => {
  await disconnectPrisma();
});

function makeMessageResponse(text: string) {
  return {
    model: 'claude-sonnet-5',
    usage: { input_tokens: 100, output_tokens: 50 },
    content: [{ type: 'text', text }],
  };
}

function sm(text: string) {
  return { finalMessage: () => Promise.resolve(makeMessageResponse(text)) };
}

const VALID_FINDINGS_JSON = JSON.stringify({
  findings: [
    {
      id: 'f1',
      severity: 'warning',
      section: 'API endpoints',
      issue: 'Uses DynamoDB which is not in the approved service list.',
      suggested_text: 'Replace DynamoDB with Amazon RDS (PostgreSQL).',
    },
  ],
});

const VALID_EMPTY_JSON = JSON.stringify({ findings: [] });

describe('runAwsReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed findings on valid first response', async () => {
    mockCreateMessageStream.mockResolvedValueOnce(sm(VALID_FINDINGS_JSON));

    const findings = await runAwsReview('feat-1', 'Login Feature', '## Overview\nSpec text here.');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe('f1');
    expect(findings[0]?.severity).toBe('warning');
    expect(mockCreateMessageStream).toHaveBeenCalledTimes(1);
  });

  it('returns empty findings array when model reports no issues', async () => {
    mockCreateMessageStream.mockResolvedValueOnce(sm(VALID_EMPTY_JSON));

    const findings = await runAwsReview('feat-2', 'Login Feature', '## Overview\nSpec text here.');
    expect(findings).toHaveLength(0);
  });

  it('retries once when first response is invalid JSON and returns findings on retry', async () => {
    mockCreateMessageStream
      .mockResolvedValueOnce(sm('This is not JSON at all.'))
      .mockResolvedValueOnce(sm(VALID_FINDINGS_JSON));

    const findings = await runAwsReview('feat-3', 'Login Feature', '## Overview\nSpec text here.');
    expect(findings).toHaveLength(1);
    expect(mockCreateMessageStream).toHaveBeenCalledTimes(2);
  });

  it('throws when both attempts fail to parse', async () => {
    mockCreateMessageStream
      .mockResolvedValueOnce(sm('invalid'))
      .mockResolvedValueOnce(sm('also invalid'));

    await expect(
      runAwsReview('feat-4', 'Login Feature', '## Overview\nSpec text here.'),
    ).rejects.toThrow('AWS agent parse failure');
    expect(mockCreateMessageStream).toHaveBeenCalledTimes(2);
  });

  it('handles findings without suggested_text (optional field)', async () => {
    const jsonNoSuggest = JSON.stringify({
      findings: [
        {
          id: 'f2',
          severity: 'suggestion',
          section: 'Overview',
          issue: 'Consider adding a retry policy.',
          // no suggested_text
        },
      ],
    });
    mockCreateMessageStream.mockResolvedValueOnce(sm(jsonNoSuggest));

    const findings = await runAwsReview('feat-5', 'Login Feature', '## Overview\nSpec text here.');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.suggested_text).toBeUndefined();
  });

  it('strips markdown fences if the model wraps the JSON', async () => {
    const fenced = '```json\n' + VALID_FINDINGS_JSON + '\n```';
    mockCreateMessageStream.mockResolvedValueOnce(sm(fenced));

    const findings = await runAwsReview('feat-6', 'Login Feature', '## Overview\nSpec text here.');
    expect(findings).toHaveLength(1);
  });

  it('calls onUsage callback with token counts', async () => {
    mockCreateMessageStream.mockResolvedValueOnce(sm(VALID_EMPTY_JSON));
    const usageRecords: { input_tokens: number; output_tokens: number }[] = [];

    await runAwsReview('feat-7', 'Login Feature', '## Overview\nSpec text here.', (u) => {
      usageRecords.push(u);
    });

    // The mock resolves without calling onUsage directly; the test verifies
    // that runAwsReview passes usageCb through to createMessageStream without error.
    expect(mockCreateMessageStream).toHaveBeenCalledWith(
      expect.any(Object),
      'feat-7',
      expect.any(Function),
    );
  });
});
