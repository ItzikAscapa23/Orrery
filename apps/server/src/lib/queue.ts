import { Queue } from 'bullmq';
import { env } from './env.js';

export interface AgentJobPayload {
  featureId: string;
  task:
    | 'simulate'
    | 'simulate-resume'
    | 'aws-review'
    | 'plan'
    | 'test-plan'
    | 'server-dev'
    | 'client-dev'
    | 'server-test-task'
    | 'client-test-task'
    | 'light-dev'
    | 'create-ado-pr'
    | 'review'
    | 'test'
    | 'testing-stub';
  // task-specific fields
  taskId?: string; // required for 'server-dev' and 'client-dev'
  repoId?: string; // required for 'light-dev'
}

// Pass the URL string directly — BullMQ creates its own ioredis instance,
// avoiding the type mismatch between the two bundled ioredis versions.
function connectionOpts() {
  return {
    connection: {
      host: new URL(env.REDIS_URL).hostname,
      port: Number(new URL(env.REDIS_URL).port || 6379),
    },
  };
}

let _queue: Queue<AgentJobPayload> | null = null;

export function getQueue(): Queue<AgentJobPayload> {
  if (!_queue) {
    _queue = new Queue<AgentJobPayload>('agent-jobs', connectionOpts());
  }
  return _queue;
}

export async function enqueueJob(
  featureId: string,
  task: AgentJobPayload['task'],
  extra?: { taskId?: string; repoId?: string },
): Promise<string> {
  const opts =
    task === 'aws-review' || task === 'server-dev' || task === 'client-dev' || task === 'light-dev'
      ? { attempts: 3, backoff: { type: 'exponential' as const, delay: 3000 } }
      : {};
  const payload: AgentJobPayload = { featureId, task, ...extra };
  const job = await getQueue().add(task, payload, opts);
  return job.id ?? '';
}

export async function closeQueue(): Promise<void> {
  await _queue?.close();
  _queue = null;
}
