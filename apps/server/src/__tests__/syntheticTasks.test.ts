import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createSyntheticFixTasks } from '../lib/syntheticTasks.js';
import type { Finding } from '@orrery/shared';

afterEach(async () => {
  await disconnectPrisma();
});

async function seedFeature(id: string) {
  return getPrisma().feature.create({
    data: {
      id,
      slug: `feat-${id}`,
      name: `Feature ${id}`,
      requirement: 'req',
      status: 'IMPLEMENTING',
    },
  });
}

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
});

describe('createSyntheticFixTasks', () => {
  it('creates one task row when two blockers share the same repo', async () => {
    const featureId = 'aaa00000-0000-0000-0000-000000000001';
    await seedFeature(featureId);

    const findings: Finding[] = [
      { id: 'f1', severity: 'blocker', repo: 'repo-a', section: 'S1', issue: 'issue one' },
      { id: 'f2', severity: 'blocker', repo: 'repo-a', section: 'S2', issue: 'issue two' },
    ];

    const result = await createSyntheticFixTasks(featureId, findings, []);

    expect(result).toHaveLength(1);
    expect(result[0]!.repo).toBe('repo-a');

    const tasks = await getPrisma().task.findMany({ where: { featureId } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('Fix review blockers — repo-a');
    expect(tasks[0]!.status).toBe('pending');
    expect(tasks[0]!.side).toBe('server'); // fallback: no prior task
    expect(tasks[0]!.description).toContain('issue one');
    expect(tasks[0]!.description).toContain('issue two');
  });

  it('creates one task per repo when blockers span two repos', async () => {
    const featureId = 'aaa00000-0000-0000-0000-000000000002';
    await seedFeature(featureId);

    const findings: Finding[] = [
      { id: 'f1', severity: 'blocker', repo: 'repo-server', section: 'S1', issue: 'server bug' },
      { id: 'f2', severity: 'blocker', repo: 'repo-client', section: 'S2', issue: 'client bug' },
    ];

    const result = await createSyntheticFixTasks(featureId, findings, []);

    expect(result).toHaveLength(2);
    const repos = result.map((r) => r.repo).sort();
    expect(repos).toEqual(['repo-client', 'repo-server']);

    const tasks = await getPrisma().task.findMany({ where: { featureId }, orderBy: { createdAt: 'asc' } });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.status === 'pending')).toBe(true);
  });

  it('inherits side from prior completed task for the repo', async () => {
    const featureId = 'aaa00000-0000-0000-0000-000000000003';
    await seedFeature(featureId);

    // Seed a completed client-side task for repo-x
    await getPrisma().task.create({
      data: {
        featureId,
        repo: 'repo-x',
        side: 'client',
        title: 'Original client task',
        description: 'original',
        status: 'completed',
        dependsOn: [],
        specRefs: [],
      },
    });

    const findings: Finding[] = [
      { id: 'f1', severity: 'blocker', repo: 'repo-x', section: 'S1', issue: 'client bug' },
    ];

    const result = await createSyntheticFixTasks(featureId, findings, []);
    expect(result).toHaveLength(1);

    const task = await getPrisma().task.findUnique({ where: { id: result[0]!.taskId } });
    expect(task!.side).toBe('client');
  });

  it('uses fallbackRepos when findings have no repo field', async () => {
    const featureId = 'aaa00000-0000-0000-0000-000000000004';
    await seedFeature(featureId);

    const findings: Finding[] = [
      { id: 'f1', severity: 'blocker', section: 'S1', issue: 'generic blocker' },
    ];

    const result = await createSyntheticFixTasks(featureId, findings, ['fallback-repo']);

    expect(result).toHaveLength(1);
    expect(result[0]!.repo).toBe('fallback-repo');
  });

  it('returns empty array and creates nothing when there are no blockers', async () => {
    const featureId = 'aaa00000-0000-0000-0000-000000000005';
    await seedFeature(featureId);

    const findings: Finding[] = [
      { id: 'f1', severity: 'warning', repo: 'repo-a', section: 'S1', issue: 'warning only' },
    ];

    const result = await createSyntheticFixTasks(featureId, findings, []);
    expect(result).toHaveLength(0);

    const tasks = await getPrisma().task.findMany({ where: { featureId } });
    expect(tasks).toHaveLength(0);
  });
});
