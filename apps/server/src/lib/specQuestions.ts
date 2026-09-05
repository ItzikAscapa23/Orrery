import { getPrisma } from './prisma.js';

export async function persistSpecQuestions(
  featureId: string,
  specRev: number,
  questions: Array<{ id: string; text: string }>,
): Promise<void> {
  await getPrisma().$transaction([
    getPrisma().specQuestion.deleteMany({ where: { featureId, specRev } }),
    ...questions.map((q) =>
      getPrisma().specQuestion.create({
        data: { id: q.id, featureId, specRev, text: q.text },
      }),
    ),
  ]);
}

export async function getUnansweredQuestionCount(
  featureId: string,
  specRev: number,
): Promise<number> {
  return getPrisma().specQuestion.count({
    where: { featureId, specRev, resolution: null },
  });
}
