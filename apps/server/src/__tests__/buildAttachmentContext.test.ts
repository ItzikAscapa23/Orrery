import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockListArtifacts, mockReadArtifact } = vi.hoisted(() => ({
  mockListArtifacts: vi.fn(),
  mockReadArtifact: vi.fn(),
}));

vi.mock('../lib/artifacts.js', () => ({
  listArtifacts: mockListArtifacts,
  readArtifact: mockReadArtifact,
  commitArtifact: vi.fn(),
  commitSpecDraft: vi.fn(),
  ArtifactCommitError: class ArtifactCommitError extends Error {},
}));

import { buildAttachmentContext } from '../lib/attachmentContext.js';

const SLUG = 'test-feature';

function makeFrontMatter(kind: string, sha: string, body: string): string {
  return `---\nkind: ${kind}\nsha: ${sha}\n---\n${body}`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildAttachmentContext', () => {
  it('inlines an input file ≤ 15 KB with "Absorb" instruction', () => {
    const body = 'User must be able to log in.\n';
    mockListArtifacts.mockReturnValue(['attachment-req.md']);
    mockReadArtifact.mockReturnValue(makeFrontMatter('input', 'abc1234', body));

    const ctx = buildAttachmentContext(SLUG);

    expect(ctx).toContain('Absorb this into the spec');
    expect(ctx).toContain('User must be able to log in.');
    expect(ctx).not.toContain('truncated');
  });

  it('inlines a reference file with direction statement', () => {
    const body = 'API must return JSON.\n';
    mockListArtifacts.mockReturnValue(['attachment-api-guide.md']);
    mockReadArtifact.mockReturnValue(makeFrontMatter('reference', 'def5678', body));

    const ctx = buildAttachmentContext(SLUG);

    expect(ctx).toContain('EXTERNAL service');
    expect(ctx).toContain('does NOT describe our own API');
    expect(ctx).toContain('API must return JSON.');
    expect(ctx).not.toContain('truncated');
  });

  it('input instruction does not contain direction statement', () => {
    const body = 'User must be able to log in.\n';
    mockListArtifacts.mockReturnValue(['attachment-req.md']);
    mockReadArtifact.mockReturnValue(makeFrontMatter('input', 'abc1234', body));

    const ctx = buildAttachmentContext(SLUG);

    expect(ctx).not.toContain('EXTERNAL service');
    expect(ctx).toContain('Absorb this into the spec');
  });

  it('truncates a file over 15 KB and includes a marker with true size', () => {
    const body = 'x'.repeat(20_000);
    mockListArtifacts.mockReturnValue(['attachment-large.md']);
    mockReadArtifact.mockReturnValue(makeFrontMatter('input', 'aaa0000', body));

    const ctx = buildAttachmentContext(SLUG);

    // Content must be cut at exactly 15_000 chars
    expect(ctx).toContain('x'.repeat(15_000));
    expect(ctx).not.toContain('x'.repeat(15_001));
    // Truncation marker must name the true size
    expect(ctx).toContain('20000');
    expect(ctx).toContain('treat content past this marker as not read');
  });

  it('falls back to filenames-only once 45 KB total budget is exhausted', () => {
    // Four files, each truncated to 15 KB → first three exhaust the 45 KB budget exactly,
    // fourth must appear as filename-only.
    const body16k = 'y'.repeat(16_000);
    mockListArtifacts.mockReturnValue([
      'attachment-a.md',
      'attachment-b.md',
      'attachment-c.md',
      'attachment-d.md',
    ]);
    mockReadArtifact.mockReturnValue(makeFrontMatter('input', 'aaa0001', body16k));

    const ctx = buildAttachmentContext(SLUG);

    // The overflow section must appear
    expect(ctx).toContain('Files not inlined');
    // Fourth file must appear in the overflow list
    expect(ctx).toContain('attachment-d.md');
    // Exactly 3 files worth of content inlined (3 × 150 chunks of 'y'×100 = 450)
    // meaning the 4th file was NOT inlined
    const yChunks = ctx.split('y'.repeat(100)).length - 1;
    expect(yChunks).toBe(450);
  });
});
