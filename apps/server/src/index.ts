import { createApp } from './app.js';
import { startAgentWorker } from './jobs/agentWorker.js';
import { startReconcilerInterval } from './lib/taskReconciler.js';
import { checkBedrockConnectivity } from './lib/connectivity.js';
import { onUnhandledRejection, onUncaughtException } from './lib/processHandlers.js';

// Registered before any async work so transient DB rejections (e.g. P2028 from
// fire-and-forget appendEvent calls) log and survive rather than killing the server.
process.on('unhandledRejection', onUnhandledRejection);
process.on('uncaughtException', onUncaughtException);

const PORT = Number(process.env['PORT'] ?? 3001);

const app = await createApp();
const worker = startAgentWorker();
startReconcilerInterval();
await app.listen({ port: PORT, host: '0.0.0.0' });

// Non-blocking boot check — log VPN/connectivity state for operator awareness.
checkBedrockConnectivity()
  .then((ok) => {
    console.error(
      JSON.stringify({
        event: ok ? 'bedrock_reachable' : 'bedrock_unreachable',
        ...(ok ? {} : { warning: 'VPN or aws sso login may be needed before dispatching jobs' }),
      }),
    );
  })
  .catch(() => {}); // never block startup

// Graceful shutdown: give in-flight BullMQ jobs a chance to finish their
// current async turn before the process exits. Without this, Ctrl+C or a
// tsx watch restart kills the process mid-job, leaving the task row in
// 'running' state with no task.failed event written.
async function shutdown(signal: string): Promise<void> {
  console.error(JSON.stringify({ event: 'shutdown_signal', signal }));
  await app.close();
  // force=false: wait for active jobs to complete, don't forcibly terminate them
  await worker.close(false);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
