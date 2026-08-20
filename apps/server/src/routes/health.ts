import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@orrery/shared';
import { checkBedrockConnectivity } from '../lib/connectivity.js';
import { env } from '../lib/env.js';

// eslint-disable-next-line @typescript-eslint/require-await
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/require-await
  app.get<{ Reply: HealthResponse }>('/health', async () => {
    return { status: 'ok' };
  });

  app.get('/health/connectivity', async () => {
    const reachable = await checkBedrockConnectivity();
    return {
      reachable,
      provider: env.ANTHROPIC_PROVIDER,
      checkedAt: new Date().toISOString(),
    };
  });
}
