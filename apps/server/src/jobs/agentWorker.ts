import { Worker } from 'bullmq';
import { env } from '../lib/env.js';
import type { AgentJobPayload } from '../lib/queue.js';
import { sweepOrphanContainers } from '../lib/container.js';
import { resumeOrphanStalledFeatures } from '../lib/startupResume.js';
import { runAwsReviewJob } from './awsReviewJob.js';
import { runSimulate, runSimulateResume } from './simulatorJob.js';
import { runPlannerJob } from './plannerJob.js';
import { runServerDevJob } from './serverDevJob.js';
import { runClientDevJob } from './clientDevJob.js';
import { runCreateAdoPrJob } from './createAdoPrJob.js';
import { runReviewJob } from './reviewJob.js';
import { runTestJob } from './testJob.js';
import { runTestingStubJob } from './testingStubJob.js';
import { runTestPlannerJob } from './testPlannerJob.js';
import { runTaskTestJob } from './taskTestJob.js';
import { runLightDevJob } from './lightDevJob.js';
import { validateProbeCommands } from '../lib/validateManifest.js';

/**
 * The single worker for the "agent-jobs" queue, dispatching by task type.
 *
 * There must be EXACTLY ONE Worker on this queue. BullMQ hands each job to
 * whichever worker acquires it first — with multiple task-filtered workers,
 * a job grabbed by the "wrong" worker completed as a silent no-op (~5ms) and
 * the feature stayed stuck in its current state forever (the "wrong task
 * type" gotcha). Add new task types to this switch, never as a new Worker.
 */
// Stamp the commit SHA at worker registration time so log output can confirm
// the running worker is executing code from the expected commit (guards against
// tsx watch serving a stale module cache after a hot reload).
const WORKER_CODE_COMMIT = process.env['WORKER_CODE_COMMIT'] ?? 'unknown';

export function startAgentWorker(): Worker<AgentJobPayload> {
  const url = new URL(env.REDIS_URL);
  const connection = { host: url.hostname, port: Number(url.port || 6379) };

  void sweepOrphanContainers(); // remove leftover containers from a prior crash
  void resumeOrphanStalledFeatures(); // resume IMPLEMENTING features stalled by orphan-parks
  try {
    validateProbeCommands();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Config error: ${message}`);
    process.exit(1);
  }

  console.error(
    JSON.stringify({
      event: 'worker_registered',
      commit: WORKER_CODE_COMMIT,
      queue: 'agent-jobs',
    }),
  );

  const worker = new Worker<AgentJobPayload>(
    'agent-jobs',
    async (job) => {
      console.error(
        JSON.stringify({
          event: 'job_start',
          task: job.data.task,
          featureId: job.data.featureId,
          jobId: job.id,
          attempt: job.attemptsMade + 1,
        }),
      );
      switch (job.data.task) {
        case 'simulate':
          await runSimulate(job.data.featureId);
          break;
        case 'simulate-resume':
          await runSimulateResume(job.data.featureId);
          break;
        case 'aws-review':
          await runAwsReviewJob(
            job.data.featureId,
            { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 },
            job.id ?? undefined,
            job.data.charterPath,
          );
          break;
        case 'plan':
          await runPlannerJob(job.data.featureId, job.id ?? undefined);
          break;
        case 'test-plan':
          await runTestPlannerJob(job.data.featureId, job.id ?? undefined);
          break;
        case 'server-test-task': {
          const serverTestTaskId = job.data.taskId;
          if (!serverTestTaskId) {
            console.error(
              JSON.stringify({ event: 'server_test_task_missing_taskId', jobId: job.id }),
            );
            break;
          }
          await runTaskTestJob(job.data.featureId, serverTestTaskId, job.id ?? '', 'server');
          break;
        }
        case 'client-test-task': {
          const clientTestTaskId = job.data.taskId;
          if (!clientTestTaskId) {
            console.error(
              JSON.stringify({ event: 'client_test_task_missing_taskId', jobId: job.id }),
            );
            break;
          }
          await runTaskTestJob(job.data.featureId, clientTestTaskId, job.id ?? '', 'client');
          break;
        }
        case 'server-dev': {
          const taskId = job.data.taskId;
          if (!taskId) {
            console.error(JSON.stringify({ event: 'server_dev_missing_taskId', jobId: job.id }));
            break;
          }
          const serverDevResult = await runServerDevJob(job.data.featureId, taskId, job.id ?? '');
          if (serverDevResult === 'parked') {
            console.error(
              JSON.stringify({
                event: 'job_failed',
                task: job.data.task,
                featureId: job.data.featureId,
                jobId: job.id,
                reason: 'task parked (final failure)',
              }),
            );
            return; // skip the generic job_complete below
          }
          break;
        }
        case 'client-dev': {
          const clientTaskId = job.data.taskId;
          if (!clientTaskId) {
            console.error(JSON.stringify({ event: 'client_dev_missing_taskId', jobId: job.id }));
            break;
          }
          const clientDevResult = await runClientDevJob(
            job.data.featureId,
            clientTaskId,
            job.id ?? '',
          );
          if (clientDevResult === 'parked') {
            console.error(
              JSON.stringify({
                event: 'job_failed',
                task: job.data.task,
                featureId: job.data.featureId,
                jobId: job.id,
                reason: 'task parked (final failure)',
              }),
            );
            return;
          }
          break;
        }
        case 'light-dev': {
          const lightRepoId = job.data.repoId;
          if (!lightRepoId) {
            console.error(JSON.stringify({ event: 'light_dev_missing_repoId', jobId: job.id }));
            break;
          }
          await runLightDevJob(job.data.featureId, lightRepoId, job.id ?? '');
          break;
        }
        case 'review':
          await runReviewJob(job.data.featureId, job.id ?? undefined);
          break;
        case 'test':
          await runTestJob(job.data.featureId, job.id ?? undefined);
          break;
        case 'testing-stub':
          await runTestingStubJob(job.data.featureId);
          break;
        case 'create-ado-pr': {
          const adoResult = await runCreateAdoPrJob(job.data.featureId, job.id ?? '');
          if (adoResult === 'parked') {
            console.error(
              JSON.stringify({
                event: 'job_failed',
                task: job.data.task,
                featureId: job.data.featureId,
                jobId: job.id,
                reason: 'ADO PR creation failed (parked)',
              }),
            );
            return;
          }
          // PRs created — now run the real Review Agent.
          await runReviewJob(job.data.featureId, job.id ?? undefined);
          break;
        }
        default:
          // Tolerate future task ids (spec 02: unknown ids must not crash),
          // but never swallow them silently.
          console.error(
            JSON.stringify({ event: 'job_unknown_task', task: job.data.task, jobId: job.id }),
          );
      }
      console.error(
        JSON.stringify({
          event: 'job_complete',
          task: job.data.task,
          featureId: job.data.featureId,
          jobId: job.id,
        }),
      );
    },
    {
      connection,
      concurrency: 2,
      lockDuration: 30 * 60 * 1000, // 30 min — comfortably exceeds longest realistic job
      maxStalledCount: 1, // one auto-recovery from stall, then fail
    },
  );

  worker.on('failed', (job, err) => {
    console.error(
      JSON.stringify({
        event: 'agent_job_failed',
        task: job?.data.task,
        jobId: job?.id,
        featureId: job?.data.featureId,
        attemptsMade: job?.attemptsMade,
        error: err.message,
      }),
    );
  });

  return worker;
}
