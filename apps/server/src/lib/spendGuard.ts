import { getPrisma } from './prisma.js';
import { appendEvent } from './events.js';

export type SpendGuardResult = { parked: true } | { parked: false; remainingBudget: number };

/**
 * Checks whether cumulative turns exceed the threshold. When admitted, returns
 * the remaining budget so callers can cap the per-job maxTurns to
 * min(repoMaxTurns, remainingBudget) and structurally prevent overrun.
 * When the threshold is reached, parks the task and returns { parked: true }.
 */
export async function checkSpendGuard(
  featureId: string,
  taskId: string,
  taskTitle: string,
): Promise<SpendGuardResult> {
  const threshold = parseInt(process.env['SPEND_GUARD_MAX_TURNS'] ?? '150', 10);

  // Count only turns after the last spend-guard override for this task.
  // A gate.resolved(spend_guard) event acts as a logical epoch boundary: each
  // RESUME grants one fresh SPEND_GUARD_MAX_TURNS window without touching the
  // immutable event log. COALESCE(…, 0) makes the baseline case (no prior
  // override) count all historical events, preserving existing behaviour.
  const result = await getPrisma().$queryRaw<[{ turns: bigint; job_count: bigint }]>`
    SELECT
      COUNT(*)::bigint                           AS turns,
      COUNT(DISTINCT payload->>'job_id')::bigint AS job_count
    FROM events
    WHERE feature_id = ${featureId}
      AND type       = 'usage.recorded'
      AND payload->>'task_id' = ${taskId}
      AND seq > COALESCE(
        (SELECT MAX(seq) FROM events
         WHERE feature_id    = ${featureId}
           AND type          = 'gate.resolved'
           AND payload->>'gate'   = 'spend_guard'
           AND payload->>'taskId' = ${taskId}),
        0
      )
  `;

  const turns = Number(result[0]?.turns ?? 0);
  const jobCount = Number(result[0]?.job_count ?? 0);

  if (turns < threshold) return { parked: false, remainingBudget: threshold - turns };

  const summary =
    `Task "${taskTitle}" accumulated ${turns} turns across ${jobCount} jobs ` +
    `(threshold: ${threshold}). Parked for human review.`;

  await getPrisma().$transaction(async (tx) => {
    await tx.task.update({
      where: { id: taskId },
      data: { status: 'parked', parkReason: 'spend_limit', bullJobId: null },
    });
    await appendEvent(tx, featureId, {
      type: 'gate.opened',
      gate: 'spend_guard',
      summary,
      revision: 0,
      taskId,
      taskTitle,
      turns,
      jobCount,
      threshold,
    });
  });

  console.error(
    JSON.stringify({ event: 'spend_guard_triggered', featureId, taskId, turns, threshold }),
  );
  return { parked: true };
}
