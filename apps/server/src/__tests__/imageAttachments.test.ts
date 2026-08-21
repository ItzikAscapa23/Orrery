import { describe, expect, it, vi } from 'vitest';
import { parseImageAttachments } from '../lib/imageAttachments.js';
import type { FastifyRequest } from 'fastify';

function makeRequest(parts: unknown[]): FastifyRequest {
  return {
    headers: { 'content-type': 'multipart/form-data' },
    parts: async function* () {
      for (const p of parts) yield p;
    },
  } as unknown as FastifyRequest;
}

describe('parseImageAttachments', () => {
  it('converts a PNG file part to an image block', async () => {
    const pngBuffer = Buffer.from([137, 80, 78, 71]); // PNG magic bytes
    const req = makeRequest([
      {
        type: 'file',
        fieldname: 'attachment',
        mimetype: 'image/png',
        toBuffer: vi.fn().mockResolvedValue(pngBuffer),
      },
    ]);
    const blocks = await parseImageAttachments(req);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('image');
    expect(blocks[0]?.source.type).toBe('base64');
    expect(blocks[0]?.source.media_type).toBe('image/png');
    expect(blocks[0]?.source.data).toBe(pngBuffer.toString('base64'));
  });

  it('converts a JPEG file part to an image block', async () => {
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff]); // JPEG magic bytes
    const req = makeRequest([
      {
        type: 'file',
        fieldname: 'photo',
        mimetype: 'image/jpeg',
        toBuffer: vi.fn().mockResolvedValue(jpegBuffer),
      },
    ]);
    const blocks = await parseImageAttachments(req);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.source.media_type).toBe('image/jpeg');
  });

  it('skips non-image file parts', async () => {
    const req = makeRequest([
      {
        type: 'file',
        fieldname: 'doc',
        mimetype: 'application/pdf',
        toBuffer: vi.fn().mockResolvedValue(Buffer.from('PDF')),
      },
    ]);
    const blocks = await parseImageAttachments(req);
    expect(blocks).toHaveLength(0);
  });

  it('skips field parts (non-file)', async () => {
    const req = makeRequest([{ type: 'field', fieldname: 'text', value: 'hello' }]);
    const blocks = await parseImageAttachments(req);
    expect(blocks).toHaveLength(0);
  });

  it('returns empty array when request has no parts() method', async () => {
    const req = { headers: {} } as FastifyRequest;
    const blocks = await parseImageAttachments(req);
    expect(blocks).toHaveLength(0);
  });
});
