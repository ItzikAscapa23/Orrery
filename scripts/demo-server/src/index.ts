import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/health', async (_request, reply) => {
  return reply.send({ status: 'ok' });
});

const PORT = Number(process.env['PORT'] ?? 3002);
await app.listen({ port: PORT, host: '0.0.0.0' });
