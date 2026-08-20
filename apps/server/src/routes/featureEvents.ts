import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../lib/prisma.js';
import { subscribeToFeature, unsubscribeFromFeature } from '../lib/events.js';
import type { EventRow } from '../lib/events.js';

const HEARTBEAT_MS = 25_000;

function sseEvent(raw: import('node:http').ServerResponse, row: EventRow): void {
  raw.write(`id: ${row.seq}\ndata: ${JSON.stringify(row)}\n\n`);
}

function rowFromPrisma(r: {
  id: bigint;
  featureId: string;
  seq: number;
  type: string;
  agent: string | null;
  payload: unknown;
  createdAt: Date;
}): EventRow {
  return {
    id: Number(r.id),
    featureId: r.featureId,
    seq: r.seq,
    type: r.type,
    agent: r.agent,
    // payload stored as jsonb; cast straight through — Zod validates at write time
    payload: r.payload as EventRow['payload'],
    createdAt: r.createdAt.toISOString(),
  };
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureEventsRoutes(app: FastifyInstance): Promise<void> {
  // ── SSE stream ─────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/features/:id/events',
    async (request, reply) => {
      const feature = await getPrisma().feature.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!feature) {
        return reply.status(404).send({ error: 'Feature not found' });
      }

      // Last-Event-ID header takes priority over ?since query param
      const lastEventId = request.headers['last-event-id'];
      const sinceRaw = typeof lastEventId === 'string' ? lastEventId : (request.query.since ?? '0');
      const since = parseInt(sinceRaw, 10) || 0;

      const raw = reply.raw;
      raw.setHeader('Content-Type', 'text/event-stream');
      raw.setHeader('Cache-Control', 'no-cache');
      raw.setHeader('Connection', 'keep-alive');
      raw.setHeader('X-Accel-Buffering', 'no');
      raw.flushHeaders();

      // Replay missed events
      const missed = await getPrisma().event.findMany({
        where: { featureId: feature.id, seq: { gt: since } },
        orderBy: { seq: 'asc' },
      });
      for (const row of missed) {
        sseEvent(raw, rowFromPrisma(row));
      }

      // Subscribe to live events
      const listener = (row: EventRow) => sseEvent(raw, row);
      subscribeToFeature(feature.id, listener);

      // Heartbeat to keep the connection alive through proxies
      const heartbeat = setInterval(() => {
        raw.write(': heartbeat\n\n');
      }, HEARTBEAT_MS);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribeFromFeature(feature.id, listener);
      };

      raw.on('close', cleanup);
      raw.on('error', cleanup);

      return reply;
    },
  );

  // ── History (paginated JSON) ───────────────────────────────────────────────
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; before?: string };
  }>('/features/:id/events/history', async (request, reply) => {
    const feature = await getPrisma().feature.findUnique({
      where: { id: request.params.id },
      select: { id: true },
    });
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }

    const limit = Math.min(parseInt(request.query.limit ?? '100', 10) || 100, 500);
    const before = parseInt(request.query.before ?? '0', 10) || 0;

    const rows = await getPrisma().event.findMany({
      where: {
        featureId: feature.id,
        ...(before > 0 ? { seq: { lt: before } } : {}),
      },
      orderBy: { seq: 'asc' },
      take: limit,
    });

    return reply.send(rows.map(rowFromPrisma));
  });
}
