import type { Prisma } from '@prisma/client';
import { getPrisma } from './prisma.js';
import { appendEvent } from './events.js';

/**
 * One definition for parking a task-level job (devJob, taskTestJob) on Bedrock
 * connectivity failure. Updates the Task row to parked, clears bullJobId, rolls
 * back the attempt counter, then emits task.failed (final:false) + agent.status
 * + agent.log events.
 *
 * Cited from: devJob.ts, taskTestJob.ts
 */
export async function parkTaskOnBedrockFailure(opts: {
  featureId: string;
  agentName: string;
  retryPath: string;
  taskId: string;
  repo: string;
  attemptRollback: Prisma.TaskUpdateInput;
  attempt: number;
}): Promise<void> {
  await getPrisma().task.update({
    where: { id: opts.taskId },
    data: {
      status: 'parked',
      parkReason: 'bedrock_unreachable',
      bullJobId: null,
      ...opts.attemptRollback,
    },
  });
  // task.failed terminates the activityFold span; final:false marks it recoverable.
  await appendEvent(getPrisma(), opts.featureId, {
    type: 'task.failed',
    repo: opts.repo,
    task_id: opts.taskId,
    reason: 'Bedrock unreachable — check VPN / aws sso login',
    attempt: opts.attempt,
    final: false,
  });
  await appendEvent(getPrisma(), opts.featureId, {
    type: 'agent.status',
    agent: opts.agentName,
    repo: opts.repo,
    status: 'failed',
  });
  await appendEvent(getPrisma(), opts.featureId, {
    type: 'agent.log',
    agent: opts.agentName,
    repo: opts.repo,
    severity: 'muted',
    text: `· ${opts.agentName} parked — Bedrock unreachable; check VPN / aws sso login. Use ${opts.retryPath} to resume.`,
  });
}

/**
 * One definition for parking a feature-level job (reviewJob, testJob) on Bedrock
 * connectivity failure. These jobs have no Task row to update; only events are
 * emitted so the operator sees the park and the retry path in the activity feed.
 *
 * Cited from: reviewJob.ts, testJob.ts
 */
export async function parkFeatureAgentOnBedrockFailure(opts: {
  featureId: string;
  agentName: string;
  retryPath: string;
}): Promise<void> {
  await appendEvent(getPrisma(), opts.featureId, {
    type: 'agent.status',
    agent: opts.agentName,
    status: 'failed',
  });
  await appendEvent(getPrisma(), opts.featureId, {
    type: 'agent.log',
    agent: opts.agentName,
    severity: 'muted',
    text: `· ${opts.agentName} parked — Bedrock unreachable; check VPN / aws sso login. Use ${opts.retryPath} to resume.`,
  });
}
