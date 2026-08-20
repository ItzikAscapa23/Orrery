import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

vi.mock('../lib/queue.js', () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
  getQueue: () => ({ getWorkers: vi.fn().mockResolvedValue([]) }),
  closeQueue: vi.fn(),
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import { createFeature } from '../lib/features.js';
import { appendEvent } from '../lib/events.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let featureId: string;

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  app = await createApp();
  vi.clearAllMocks();

  const feature = await createFeature({ name: 'Task Table Test', requirement: 'req' });
  featureId = feature.id;
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

async function createTask(
  title: string,
  dependsOn: string[] = [],
  status = 'pending',
): Promise<string> {
  const task = await getPrisma().task.create({
    data: {
      featureId,
      repo: 'server',
      side: 'server',
      title,
      description: title,
      specRefs: [],
      dependsOn,
      status,
    },
  });
  return task.id;
}

async function insertUsageEvent(taskId: string, jobId: string): Promise<void> {
  await appendEvent(getPrisma(), featureId, {
    type: 'usage.recorded',
    agent: 'server',
    model: 'test',
    input_tokens: 100,
    output_tokens: 50,
    provider: 'test',
    job_id: jobId,
    task_id: taskId,
  });
}

describe('GET /features/:id/tasks', () => {
  it('returns 404 for unknown feature', async () => {
    const res = await app.inject({ method: 'GET', url: '/features/nonexistent/tasks' });
    expect(res.statusCode).toBe(404);
  });

  it('returns empty array when feature has no tasks', async () => {
    const res = await app.inject({ method: 'GET', url: `/features/${featureId}/tasks` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('returns tasks with null turns when no usage events exist', async () => {
    await createTask('First Task');
    const res = await app.inject({ method: 'GET', url: `/features/${featureId}/tasks` });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { title: string; turns: null; jobCount: null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('First Task');
    expect(rows[0]!.turns).toBeNull();
    expect(rows[0]!.jobCount).toBeNull();
  });

  it('aggregates turns and job count across multiple jobs for the same task', async () => {
    const taskId = await createTask('Dev Task');

    // 3 events across 2 different jobs
    await insertUsageEvent(taskId, 'job-1');
    await insertUsageEvent(taskId, 'job-1');
    await insertUsageEvent(taskId, 'job-2');

    const res = await app.inject({ method: 'GET', url: `/features/${featureId}/tasks` });
    const rows = res.json() as { title: string; turns: number; jobCount: number }[];
    expect(rows[0]!.turns).toBe(3);
    expect(rows[0]!.jobCount).toBe(2);
  });

  it('keeps usage events for different tasks isolated', async () => {
    const taskA = await createTask('Task A');
    const taskB = await createTask('Task B');

    await insertUsageEvent(taskA, 'job-1');
    await insertUsageEvent(taskA, 'job-1');
    await insertUsageEvent(taskB, 'job-2');

    const res = await app.inject({ method: 'GET', url: `/features/${featureId}/tasks` });
    const rows = res.json() as { title: string; turns: number }[];
    const a = rows.find((r) => r.title === 'Task A')!;
    const b = rows.find((r) => r.title === 'Task B')!;
    expect(a.turns).toBe(2);
    expect(b.turns).toBe(1);
  });

  it('computes blockedBy as titles of unmet dependencies for pending task', async () => {
    const depId = await createTask('Blocking Task', [], 'pending');
    await createTask('Dependent Task', [depId], 'pending');

    const res = await app.inject({ method: 'GET', url: `/features/${featureId}/tasks` });
    const rows = res.json() as { title: string; blockedBy: string[] }[];
    const dep = rows.find((r) => r.title === 'Dependent Task')!;
    expect(dep.blockedBy).toEqual(['Blocking Task']);
  });

  it('returns empty blockedBy when dependency is completed', async () => {
    const depId = await createTask('Done Task', [], 'completed');
    await createTask('Ready Task', [depId], 'pending');

    const res = await app.inject({ method: 'GET', url: `/features/${featureId}/tasks` });
    const rows = res.json() as { title: string; blockedBy: string[] }[];
    const ready = rows.find((r) => r.title === 'Ready Task')!;
    expect(ready.blockedBy).toEqual([]);
  });

  it('returns empty blockedBy for completed tasks regardless of deps', async () => {
    const depId = await createTask('Blocker', [], 'pending');
    await createTask('Completed Anyway', [depId], 'completed');

    const res = await app.inject({ method: 'GET', url: `/features/${featureId}/tasks` });
    const rows = res.json() as { title: string; blockedBy: string[] }[];
    const done = rows.find((r) => r.title === 'Completed Anyway')!;
    expect(done.blockedBy).toEqual([]);
  });

  it('orders rows topologically — independent tasks before dependent ones', async () => {
    const aId = await createTask('Task A');
    const bId = await createTask('Task B', [aId]);
    await createTask('Task C', [bId]);
    await createTask('Task D'); // independent

    const res = await app.inject({ method: 'GET', url: `/features/${featureId}/tasks` });
    const rows = res.json() as { title: string }[];
    const titles = rows.map((r) => r.title);

    // A and D (depth 0) must come before B (depth 1), which must come before C (depth 2)
    expect(titles.indexOf('Task A')).toBeLessThan(titles.indexOf('Task B'));
    expect(titles.indexOf('Task B')).toBeLessThan(titles.indexOf('Task C'));
    expect(titles.indexOf('Task D')).toBeLessThan(titles.indexOf('Task C'));
  });
});
