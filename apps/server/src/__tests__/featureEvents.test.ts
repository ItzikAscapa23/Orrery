import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { createApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let port: number;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  app = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

async function seedFeature() {
  return getPrisma().feature.create({
    data: { slug: `feat-${Math.random().toString(36).slice(2)}`, name: 'T', requirement: 'r' },
  });
}

async function seedEvents(featureId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, featureId, {
        type: 'agent.log',
        agent: 'spec',
        severity: 'info',
        text: `log line ${i + 1}`,
      }),
    );
  }
}

/** Collect SSE body until the safety timeout fires, then destroy the connection. */
function collectSSE(
  url: string,
  opts: { waitMs?: number; headers?: Record<string, string> } = {},
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    let statusCode = 0;
    let responseHeaders: Record<string, string> = {};
    let body = '';
    let resolved = false;

    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve({ statusCode, headers: responseHeaders, body });
      }
    };

    const req = http.get(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: opts.headers ?? {},
      },
      (res) => {
        statusCode = res.statusCode ?? 0;
        responseHeaders = res.headers as Record<string, string>;
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', done);
        res.on('error', done);
      },
    );

    req.on('error', done);

    // Wait for replay to flush, then destroy to unblock
    setTimeout(() => {
      req.destroy();
      done();
    }, opts.waitMs ?? 500);
  });
}

// ── SSE endpoint ──────────────────────────────────────────────────────────────

describe('GET /features/:id/events', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/features/no-such-id/events' });
    expect(res.statusCode).toBe(404);
  });

  it('responds with SSE content-type header', async () => {
    const feature = await seedFeature();
    await seedEvents(feature.id, 1);
    const result = await collectSSE(`http://127.0.0.1:${port}/features/${feature.id}/events`);
    expect(result.headers['content-type']).toContain('text/event-stream');
  });

  it('replays events with seq > since', async () => {
    const feature = await seedFeature();
    await seedEvents(feature.id, 3);

    const result = await collectSSE(
      `http://127.0.0.1:${port}/features/${feature.id}/events?since=1`,
    );
    expect(result.body).toContain('"seq":2');
    expect(result.body).toContain('"seq":3');
    expect(result.body).not.toContain('"seq":1');
  });

  it('replays all events when since=0', async () => {
    const feature = await seedFeature();
    await seedEvents(feature.id, 2);

    const result = await collectSSE(
      `http://127.0.0.1:${port}/features/${feature.id}/events?since=0`,
    );
    expect(result.body).toContain('"seq":1');
    expect(result.body).toContain('"seq":2');
  });

  it('honours Last-Event-ID header over ?since param', async () => {
    const feature = await seedFeature();
    await seedEvents(feature.id, 3);

    const result = await collectSSE(
      `http://127.0.0.1:${port}/features/${feature.id}/events?since=0`,
      { headers: { 'last-event-id': '2' } },
    );
    expect(result.body).toContain('"seq":3');
    expect(result.body).not.toContain('"seq":1');
    expect(result.body).not.toContain('"seq":2');
  });

  it('each SSE frame carries id: <seq>', async () => {
    const feature = await seedFeature();
    await seedEvents(feature.id, 1);

    const result = await collectSSE(`http://127.0.0.1:${port}/features/${feature.id}/events`);
    expect(result.body).toContain('id: 1');
  });
});

// ── History endpoint ──────────────────────────────────────────────────────────

describe('GET /features/:id/events/history', () => {
  it('returns 404 when feature does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/features/no-such-id/events/history' });
    expect(res.statusCode).toBe(404);
  });

  it('returns all events in seq order', async () => {
    const feature = await seedFeature();
    await seedEvents(feature.id, 3);

    const res = await app.inject({ method: 'GET', url: `/features/${feature.id}/events/history` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ seq: number }[]>();
    expect(body.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('returns empty array when no events exist', async () => {
    const feature = await seedFeature();
    const res = await app.inject({ method: 'GET', url: `/features/${feature.id}/events/history` });
    expect(res.json()).toEqual([]);
  });

  it('paginates with ?limit', async () => {
    const feature = await seedFeature();
    await seedEvents(feature.id, 5);

    const res = await app.inject({
      method: 'GET',
      url: `/features/${feature.id}/events/history?limit=2`,
    });
    expect(res.json<unknown[]>()).toHaveLength(2);
  });

  it('paginates with ?before for cursor-based navigation', async () => {
    const feature = await seedFeature();
    await seedEvents(feature.id, 5);

    const res = await app.inject({
      method: 'GET',
      url: `/features/${feature.id}/events/history?before=4`,
    });
    const seqs = res.json<{ seq: number }[]>().map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('caps limit at 500', async () => {
    const feature = await seedFeature();
    const res = await app.inject({
      method: 'GET',
      url: `/features/${feature.id}/events/history?limit=9999`,
    });
    expect(res.statusCode).toBe(200);
  });
});
