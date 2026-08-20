import type { FastifyRequest } from 'fastify';
import type Anthropic from '@anthropic-ai/sdk';

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg']);

type AllowedMime = 'image/png' | 'image/jpeg';

export async function parseImageAttachments(
  request: FastifyRequest,
): Promise<Anthropic.ImageBlockParam[]> {
  const blocks: Anthropic.ImageBlockParam[] = [];

  // @fastify/multipart adds .parts() when registered
  const parts = (request as FastifyRequest & { parts?: () => AsyncIterable<unknown> }).parts;
  if (typeof parts !== 'function') return blocks;

  for await (const part of parts.call(request)) {
    const p = part as {
      type: string;
      mimetype?: string;
      toBuffer?: () => Promise<Buffer>;
    };
    if (p.type !== 'file' || !p.mimetype || !ALLOWED_MIME_TYPES.has(p.mimetype)) continue;
    if (!p.toBuffer) continue;
    const buffer = await p.toBuffer();
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: p.mimetype as AllowedMime,
        data: buffer.toString('base64'),
      },
    });
  }

  return blocks;
}
