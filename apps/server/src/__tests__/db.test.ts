import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';

afterEach(async () => {
  await disconnectPrisma();
});

describe('prisma', () => {
  beforeEach(async () => {
    await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  });

  it('returns a PrismaClient instance', () => {
    const prisma = getPrisma();
    expect(prisma).toBeDefined();
  });

  it('returns the same instance on subsequent calls', () => {
    const a = getPrisma();
    const b = getPrisma();
    expect(a).toBe(b);
  });

  it('round-trips a feature row', async () => {
    const prisma = getPrisma();
    const created = await prisma.feature.create({
      data: {
        slug: 'my-feature',
        name: 'My Feature',
        requirement: 'Do a thing',
        status: 'DRAFTING_SPEC',
      },
    });

    const found = await prisma.feature.findUnique({ where: { id: created.id } });
    expect(found?.slug).toBe('my-feature');
    expect(found?.status).toBe('DRAFTING_SPEC');
    expect(found?.proposedSpec).toBeNull();
  });

  it('creates the features and messages tables (via Prisma)', async () => {
    const prisma = getPrisma();
    // These would throw if the tables didn't exist
    await expect(prisma.feature.findMany()).resolves.toBeDefined();
    await expect(prisma.message.findMany()).resolves.toBeDefined();
  });
});
