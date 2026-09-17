import { z } from 'zod';
import { getPrisma } from './prisma.js';
import { appendEvent } from './events.js';
import type { FeatureStatus, FeaturePath } from '@prisma/client';

export { FeatureStatus, FeaturePath };

export const CreateFeatureBodySchema = z.object({
  name: z.string().min(1).max(200),
  requirement: z.string().min(1),
  repos: z.array(z.string()).min(1),
});

export type CreateFeatureBody = z.infer<typeof CreateFeatureBodySchema>;

export interface Feature {
  id: string;
  slug: string;
  name: string;
  requirement: string;
  status: string;
  proposed_spec: string | null;
  simulated_run: boolean;
  repos: string[];
  feature_path: 'FULL' | 'LIGHT';
  created_at: string;
  current_branches: Record<string, string>;
  review_skipped: boolean;
}

export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function toFeature(row: {
  id: string;
  slug: string;
  name: string;
  requirement: string;
  status: string;
  proposedSpec: string | null;
  simulatedRun: boolean;
  repos: string[];
  featurePath: FeaturePath;
  createdAt: Date;
  currentBranches: unknown;
  reviewSkipped: boolean;
}): Feature {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    requirement: row.requirement,
    status: row.status,
    proposed_spec: row.proposedSpec,
    simulated_run: row.simulatedRun,
    repos: row.repos,
    feature_path: row.featurePath,
    created_at: row.createdAt.toISOString(),
    current_branches: (row.currentBranches as Record<string, string>) ?? {},
    review_skipped: row.reviewSkipped,
  };
}

// The HTTP schema requires repos; lib callers (tests, legacy code) may omit it (defaults to []).
// featurePath defaults to 'FULL'; the route handler derives it from the repos' manifest path fields.
export async function createFeature(body: {
  name: string;
  requirement: string;
  repos?: string[];
  featurePath?: FeaturePath;
}): Promise<Feature> {
  const slug = toSlug(body.name);
  const repos = body.repos ?? [];
  const featurePath: FeaturePath = body.featurePath ?? 'FULL';

  const row = await getPrisma().$transaction(async (tx) => {
    const created = await tx.feature.create({
      data: {
        slug,
        name: body.name,
        requirement: body.requirement,
        repos,
        featurePath,
        status: 'DRAFTING_SPEC',
      },
    });
    await appendEvent(tx, created.id, { type: 'phase.changed', from: null, to: 'DRAFTING_SPEC' });
    return created;
  });

  return toFeature(row);
}

export async function findAllFeatures(): Promise<Feature[]> {
  const rows = await getPrisma().feature.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(toFeature);
}

export async function findFeatureById(id: string): Promise<Feature | undefined> {
  const row = await getPrisma().feature.findUnique({ where: { id } });
  return row ? toFeature(row) : undefined;
}

export async function updateFeatureStatus(id: string, status: FeatureStatus): Promise<void> {
  await getPrisma().feature.update({ where: { id }, data: { status } });
}

export async function updateFeatureProposedSpec(
  id: string,
  proposedSpec: string | null,
): Promise<void> {
  await getPrisma().feature.update({ where: { id }, data: { proposedSpec } });
}
