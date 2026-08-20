import type { Finding } from '@orrery/shared';
import { getPrisma } from './prisma.js';

export type SyntheticTaskResult = { repo: string; taskId: string };

/**
 * Create one pending Task row per repo that has at least one blocker finding.
 * Called from reviewJob (REVIEW_FAIL bounce-back) and featureRetryBounce (recovery).
 *
 * repo-to-side mapping: look up the most recent completed task for the repo —
 * that's the ground truth. Fall back to 'server' when no prior task exists
 * (conservative; client-only repos are uncommon and can be corrected manually).
 *
 * Returns the list of created { repo, taskId } pairs so callers can log them.
 */
export async function createSyntheticFixTasks(
  featureId: string,
  findings: Finding[],
  fallbackRepos: string[],
): Promise<SyntheticTaskResult[]> {
  const blockers = findings.filter((f) => f.severity === 'blocker');

  // Collect repos from blockers; fall back to all currentBranches repos when
  // the finding has no repo field (e.g. older AWS review agent output).
  const repoSet = new Set<string>();
  for (const f of blockers) {
    if (f.repo) {
      repoSet.add(f.repo);
    }
  }
  if (repoSet.size === 0 && blockers.length > 0) {
    for (const r of fallbackRepos) repoSet.add(r);
  }

  const results: SyntheticTaskResult[] = [];

  for (const repo of repoSet) {
    const repoBlockers = blockers.filter((f) => !f.repo || f.repo === repo);
    const description = repoBlockers.map((f) => `- ${f.issue}`).join('\n');

    // Derive side from most recent completed task for this repo; default 'server'.
    const prior = await getPrisma().task.findFirst({
      where: { featureId, repo },
      orderBy: { createdAt: 'desc' },
      select: { side: true },
    });
    const side = prior?.side ?? 'server';

    const task = await getPrisma().task.create({
      data: {
        featureId,
        repo,
        side,
        title: `Fix review blockers — ${repo}`,
        description,
        specRefs: [],
        dependsOn: [],
        status: 'pending',
      },
    });

    results.push({ repo, taskId: task.id });
  }

  return results;
}
