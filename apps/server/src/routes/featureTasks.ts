import type { FastifyInstance } from 'fastify';
import { findFeatureById } from '../lib/features.js';
import { getPrisma } from '../lib/prisma.js';

interface TaskRow {
  id: string;
  title: string;
  repo: string;
  side: string;
  status: string;
  turns: number | null;
  jobCount: number | null;
  blockedBy: string[];
  coveredByTestPlan: boolean;
  testsWritten: boolean;
  testTaskAttempts: number;
  spendGuardThreshold: number;
}

interface UsageAggRow {
  task_id: string;
  turns: bigint;
  job_count: bigint;
}

function topoSort(tasks: { id: string; dependsOn: string[] }[]): string[] {
  const depMap = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const depths = new Map<string, number>();

  function depth(id: string, visited = new Set<string>()): number {
    if (depths.has(id)) return depths.get(id)!;
    if (visited.has(id)) return 0; // cycle guard
    visited.add(id);
    const deps = depMap.get(id) ?? [];
    const d = deps.length === 0 ? 0 : Math.max(...deps.map((d) => depth(d, visited) + 1));
    depths.set(id, d);
    return d;
  }

  tasks.forEach((t) => depth(t.id));
  return tasks
    .slice()
    .sort((a, b) => (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0))
    .map((t) => t.id);
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureTasksRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/features/:id/tasks', async (request, reply) => {
    const { id } = request.params;

    const feature = await findFeatureById(id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }

    const tasks = await getPrisma().task.findMany({
      where: { featureId: id },
      orderBy: { createdAt: 'asc' },
    });

    // Aggregate turns and distinct job count per task_id from usage.recorded events.
    // Uses $queryRaw because Prisma groupBy does not support JSON field extraction.
    const usageRows = await getPrisma().$queryRaw<UsageAggRow[]>`
      SELECT
        payload->>'task_id'            AS task_id,
        COUNT(*)::bigint               AS turns,
        COUNT(DISTINCT payload->>'job_id')::bigint AS job_count
      FROM events
      WHERE feature_id = ${id}
        AND type = 'usage.recorded'
        AND payload->>'task_id' IS NOT NULL
      GROUP BY payload->>'task_id'
    `;

    const usageByTask = new Map(
      usageRows.map((r) => [r.task_id, { turns: Number(r.turns), jobCount: Number(r.job_count) }]),
    );

    const spendGuardThreshold = parseInt(process.env['SPEND_GUARD_MAX_TURNS'] ?? '150', 10);

    const completedIds = new Set(tasks.filter((t) => t.status === 'completed').map((t) => t.id));
    const titleById = new Map(tasks.map((t) => [t.id, t.title]));

    const orderedIds = topoSort(
      tasks.map((t) => ({ id: t.id, dependsOn: t.dependsOn as string[] })),
    );
    const orderIndex = new Map(orderedIds.map((id, i) => [id, i]));

    const rows: TaskRow[] = tasks
      .slice()
      .sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
      .map((t) => {
        const deps = t.dependsOn as string[];
        const blockedBy =
          t.status !== 'completed'
            ? deps.filter((d) => !completedIds.has(d)).map((d) => titleById.get(d) ?? d)
            : [];

        const usage = usageByTask.get(t.id) ?? null;

        return {
          id: t.id,
          title: t.title,
          repo: t.repo,
          side: t.side,
          status: t.status,
          turns: usage?.turns ?? null,
          jobCount: usage?.jobCount ?? null,
          blockedBy,
          coveredByTestPlan: t.coveredByTestPlan,
          testsWritten: t.testsWritten,
          testTaskAttempts: t.testTaskAttempts,
          spendGuardThreshold,
        };
      });

    return reply.send(rows);
  });
}
