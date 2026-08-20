import https from 'node:https';
import fs from 'node:fs';
import { env } from './env.js';

interface CacheEntry {
  reachable: boolean;
  checkedAt: number;
}

let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 30_000;

/**
 * TLS handshake to bedrock-runtime.<region>.amazonaws.com.
 *
 * Any HTTP response (including 404) means TLS succeeded and the endpoint is
 * reachable — AWS rejects the unsigned HEAD request but the connection worked.
 * SSL error / ECONNREFUSED / timeout means the corporate proxy or VPN is down.
 *
 * Only runs when ANTHROPIC_PROVIDER=bedrock; always returns true otherwise
 * (direct Anthropic API does not depend on VPN).
 *
 * Result is cached for 30 s to avoid per-request overhead.
 */
export async function checkBedrockConnectivity(): Promise<boolean> {
  if (env.ANTHROPIC_PROVIDER !== 'bedrock') return true;

  const now = Date.now();
  if (cache && now - cache.checkedAt < CACHE_TTL_MS) return cache.reachable;

  const region = env.AWS_REGION ?? 'eu-west-1';
  const hostname = `bedrock-runtime.${region}.amazonaws.com`;

  const reachable = await new Promise<boolean>((resolve) => {
    const caPath = process.env['NODE_EXTRA_CA_CERTS'];
    const caOptions = caPath && fs.existsSync(caPath) ? { ca: fs.readFileSync(caPath) } : {};

    const req = https.request(
      {
        hostname,
        port: 443,
        method: 'HEAD',
        path: '/',
        timeout: 5_000,
        ...caOptions,
      },
      () => resolve(true), // any HTTP response = TLS handshake succeeded
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });

  cache = { reachable, checkedAt: now };
  return reachable;
}

/** Read the cached result without making a network call. */
export function getConnectivityCache(): CacheEntry | null {
  return cache;
}

/** Force-expire the cache (useful in tests). */
export function resetConnectivityCache(): void {
  cache = null;
}
