import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { persistSpecQuestions, getUnansweredQuestionCount } from '../lib/specQuestions.js';

const FID = 'feat-sq-test';

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  await getPrisma().$executeRaw`
    INSERT INTO features (id, slug, name, requirement, status, simulated_run, created_at)
    VALUES (${FID}, 'sq-test', 'SQ Test', 'req', 'AWAITING_APPROVAL', false, NOW())
  `;
});

afterEach(async () => {
  await disconnectPrisma();
});

describe('persistSpecQuestions', () => {
  it('inserts questions for a given specRev', async () => {
    await persistSpecQuestions(FID, 0, [
      { id: 'q1', text: 'What is the scope?' },
      { id: 'q2', text: 'Who are the users?' },
    ]);
    const rows = await getPrisma().specQuestion.findMany({ where: { featureId: FID, specRev: 0 } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['q1', 'q2']);
    expect(rows.every((r) => r.resolution === null)).toBe(true);
  });

  it('replaces existing rows for the same (featureId, specRev) on re-call', async () => {
    await persistSpecQuestions(FID, 0, [{ id: 'q1', text: 'Original?' }]);
    await persistSpecQuestions(FID, 0, [{ id: 'q2', text: 'Replacement?' }]);
    const rows = await getPrisma().specQuestion.findMany({ where: { featureId: FID, specRev: 0 } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('q2');
  });

  it('handles empty questions array without error', async () => {
    await expect(persistSpecQuestions(FID, 0, [])).resolves.toBeUndefined();
    const rows = await getPrisma().specQuestion.findMany({ where: { featureId: FID, specRev: 0 } });
    expect(rows).toHaveLength(0);
  });

  it('104-id-recurrence: same id at different specRevs coexist as separate rows', async () => {
    await persistSpecQuestions(FID, 0, [{ id: 'q1', text: 'Rev 0 question' }]);
    await persistSpecQuestions(FID, 1, [{ id: 'q1', text: 'Rev 1 same id' }]);

    const rev0 = await getPrisma().specQuestion.findUnique({
      where: { featureId_specRev_id: { featureId: FID, specRev: 0, id: 'q1' } },
    });
    const rev1 = await getPrisma().specQuestion.findUnique({
      where: { featureId_specRev_id: { featureId: FID, specRev: 1, id: 'q1' } },
    });

    expect(rev0?.text).toBe('Rev 0 question');
    expect(rev1?.text).toBe('Rev 1 same id');
  });
});

describe('getUnansweredQuestionCount', () => {
  it('returns 0 when no questions exist', async () => {
    const count = await getUnansweredQuestionCount(FID, 0);
    expect(count).toBe(0);
  });

  it('returns count of questions with resolution=null', async () => {
    await getPrisma().specQuestion.createMany({
      data: [
        { id: 'q1', featureId: FID, specRev: 0, text: 'Unanswered one' },
        { id: 'q2', featureId: FID, specRev: 0, text: 'Unanswered two' },
        {
          id: 'q3',
          featureId: FID,
          specRev: 0,
          text: 'Answered',
          resolution: 'answered',
          answer: 'yes',
        },
      ],
    });
    const count = await getUnansweredQuestionCount(FID, 0);
    expect(count).toBe(2);
  });

  it('returns 0 when all questions are answered', async () => {
    await getPrisma().specQuestion.createMany({
      data: [
        { id: 'q1', featureId: FID, specRev: 0, text: 'Q1', resolution: 'answered', answer: 'a1' },
        { id: 'q2', featureId: FID, specRev: 0, text: 'Q2', resolution: 'answered', answer: 'a2' },
      ],
    });
    const count = await getUnansweredQuestionCount(FID, 0);
    expect(count).toBe(0);
  });

  it('scopes count to the requested specRev', async () => {
    await getPrisma().specQuestion.createMany({
      data: [
        { id: 'q1', featureId: FID, specRev: 0, text: 'Rev 0 unanswered' },
        {
          id: 'q1',
          featureId: FID,
          specRev: 1,
          text: 'Rev 1 answered',
          resolution: 'answered',
          answer: 'yes',
        },
      ],
    });
    expect(await getUnansweredQuestionCount(FID, 0)).toBe(1);
    expect(await getUnansweredQuestionCount(FID, 1)).toBe(0);
  });
});
