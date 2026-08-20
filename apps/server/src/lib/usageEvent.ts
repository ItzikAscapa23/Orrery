import type { UsageRecord } from './anthropic.js';

export interface UsageEventPayload {
  type: 'usage.recorded';
  agent: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  provider: string;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  job_id?: string;
  task_id?: string;
  simulated?: true;
}

export function usageEventPayload(
  usage: UsageRecord,
  agent: string,
  opts?: { jobId?: string | undefined; taskId?: string | undefined },
): UsageEventPayload {
  return {
    type: 'usage.recorded',
    agent,
    model: usage.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    provider: usage.provider,
    ...(usage.cache_creation_input_tokens !== undefined
      ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
      : {}),
    ...(usage.cache_read_input_tokens !== undefined
      ? { cache_read_input_tokens: usage.cache_read_input_tokens }
      : {}),
    ...(opts?.jobId ? { job_id: opts.jobId } : {}),
    ...(opts?.taskId ? { task_id: opts.taskId } : {}),
  };
}

export function simulatedUsagePayload(
  agent: string,
  model: string,
  input_tokens: number,
  output_tokens: number,
): UsageEventPayload {
  return {
    type: 'usage.recorded',
    agent,
    model,
    input_tokens,
    output_tokens,
    provider: 'simulated',
    simulated: true,
  };
}
