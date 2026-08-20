import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

async function createApp() {
  const app = Fastify();
  app.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok' });
  });
  return app;
}

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });
});
