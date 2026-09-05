import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { findFeatureById } from '../lib/features.js';
import { getMessagesByFeatureId, saveMessage, sanitizeAssistantContent } from '../lib/messages.js';
import { commitSpecDraft, ArtifactCommitError } from '../lib/artifacts.js';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { runSpecAgentTurn } from '../agents/specAgent.js';
import { dispatchJob } from '../lib/dispatch.js';
import { resolveCharterPath } from '../lib/charterResolver.js';
import { submitSpecSkip } from '../lib/specSubmit.js';
import { persistSpecQuestions } from '../lib/specQuestions.js';
import { gateOpenedCount } from '../lib/reviewCycle.js';
import { usageEventPayload } from '../lib/usageEvent.js';

const AnswerBodySchema = z.object({
  answer: z.string().min(1),
});

function sseWrite(raw: import('node:http').ServerResponse, payload: Record<string, unknown>): void {
  raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureQuestionsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string; qId: string } }>(
    '/features/:id/questions/:qId/answer',
    async (request, reply) => {
      const feature = await findFeatureById(request.params.id);
      if (!feature) {
        return reply.status(404).send({ error: 'Feature not found' });
      }
      if (feature.status !== 'AWAITING_APPROVAL') {
        return reply.status(409).send({ error: 'Feature is not awaiting approval' });
      }

      let answer: string;
      try {
        ({ answer } = AnswerBodySchema.parse(request.body));
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: err.issues.map((i) => i.message).join(', ') });
        }
        throw err;
      }

      const gateCount = await gateOpenedCount(feature.id);
      const currentCycleRev = gateCount - 1;

      const question = await getPrisma().specQuestion.findFirst({
        where: { featureId: feature.id, id: request.params.qId },
        orderBy: { specRev: 'desc' },
      });
      if (!question) {
        return reply.status(404).send({ error: 'Question not found' });
      }
      if (question.specRev !== currentCycleRev) {
        return reply.status(409).send({
          error: `Question belongs to spec revision ${question.specRev}, but current revision is ${currentCycleRev}`,
        });
      }
      if (question.resolution !== null) {
        return reply.status(409).send({ error: 'Question has already been answered' });
      }

      // Atomic: mark question answered + resolve gate + REQUEST_CHANGES transition
      await getPrisma().$transaction(async (tx) => {
        await tx.specQuestion.update({
          where: {
            featureId_specRev_id: {
              featureId: feature.id,
              specRev: question.specRev,
              id: question.id,
            },
          },
          data: { resolution: 'answered', answer },
        });
        await appendEvent(tx, feature.id, {
          type: 'spec.question_answered',
          spec_rev: currentCycleRev,
          question_id: question.id,
          answer,
        });
        await appendEvent(tx, feature.id, {
          type: 'gate.resolved',
          gate: 'spec_approval',
          resolution: 'changes_requested',
          comment: `Question answered: ${question.text}`,
        });
        const next = await applyTransition(
          tx,
          feature.id,
          feature.status as import('@prisma/client').FeatureStatus,
          'REQUEST_CHANGES',
        );
        if (next) {
          await appendEvent(tx, feature.id, {
            type: 'phase.changed',
            from: feature.status,
            to: next,
          });
        }
        await tx.feature.update({ where: { id: feature.id }, data: { proposedSpec: null } });
      });

      const history = await getMessagesByFeatureId(feature.id);
      const prompt =
        `The operator has provided an answer to an open question in the spec. ` +
        `Please update the spec to incorporate the answer and call save_spec.\n\n` +
        `**Q: ${question.text}**\n` +
        `A: ${answer}\n\n` +
        `Incorporate this answer into the spec text and remove it from ## Open questions.`;

      await saveMessage(feature.id, 'user', [{ type: 'text', text: prompt }]);

      const raw = reply.raw;
      raw.setHeader('Content-Type', 'text/event-stream');
      raw.setHeader('Cache-Control', 'no-cache');
      raw.setHeader('Connection', 'keep-alive');
      raw.setHeader('X-Accel-Buffering', 'no');
      raw.flushHeaders();

      try {
        let specProposed = false;

        await appendEvent(getPrisma(), feature.id, {
          type: 'agent.status',
          agent: 'spec',
          status: 'working',
        });
        await appendEvent(getPrisma(), feature.id, {
          type: 'agent.log',
          agent: 'spec',
          severity: 'action',
          text: `▸ incorporating answer for question: ${question.text.slice(0, 80)}`,
        });

        const result = await runSpecAgentTurn(
          feature.id,
          feature.name,
          feature.requirement,
          feature.slug,
          [...history, { role: 'user', content: [{ type: 'text', text: prompt }] }],
          (text) => sseWrite(raw, { type: 'token', text }),
          async (specMarkdown, questions) => {
            specProposed = true;

            const rev = await getPrisma().event.count({
              where: { featureId: feature.id, type: 'gate.opened' },
            });
            let specCommitResult: ReturnType<typeof commitSpecDraft> | null = null;
            try {
              specCommitResult = commitSpecDraft(feature.slug, specMarkdown, rev);
            } catch (err) {
              if (err instanceof ArtifactCommitError) {
                sseWrite(raw, { type: 'error', message: `Artifact commit failed: ${err.message}` });
                return;
              }
              throw err;
            }

            await persistSpecQuestions(feature.id, rev, questions);
            if (questions.length > 0) {
              await appendEvent(getPrisma(), feature.id, {
                type: 'spec.questions',
                spec_rev: rev,
                questions,
              });
            }

            const charterPath = resolveCharterPath(feature.repos);

            if (!charterPath) {
              await submitSpecSkip(
                feature.id,
                specMarkdown,
                specCommitResult,
                rev,
                questions.length,
              );
              await appendEvent(getPrisma(), feature.id, {
                type: 'agent.log',
                agent: 'orchestrator',
                severity: 'info',
                text: '◦ no review charter configured — spec approval gate reopened (AWS review skipped)',
              });
            } else {
              await getPrisma().$transaction(async (tx) => {
                await appendEvent(tx, feature.id, {
                  type: 'artifact.committed',
                  path: specCommitResult.path,
                  commit: specCommitResult.commit,
                  message: specCommitResult.message,
                });
                await tx.feature.update({
                  where: { id: feature.id },
                  data: { proposedSpec: specMarkdown },
                });
                const currentFeature = await tx.feature.findUniqueOrThrow({
                  where: { id: feature.id },
                });
                const afterSubmit = await applyTransition(
                  tx,
                  feature.id,
                  currentFeature.status,
                  'SUBMIT_SPEC',
                );
                if (afterSubmit) {
                  await appendEvent(tx, feature.id, {
                    type: 'phase.changed',
                    from: currentFeature.status,
                    to: afterSubmit,
                  });
                }
              });
              await dispatchJob(feature.id, 'aws-review', { charterPath });
              await appendEvent(getPrisma(), feature.id, {
                type: 'agent.log',
                agent: 'orchestrator',
                severity: 'info',
                text: '◦ AWS review queued',
              });
            }

            sseWrite(raw, { type: 'spec_proposed', spec_markdown: specMarkdown });
          },
          async (usage) => {
            await getPrisma().$transaction((tx) =>
              appendEvent(tx, feature.id, usageEventPayload(usage, 'spec')),
            );
          },
          feature.feature_path,
        );

        const persistableContent = sanitizeAssistantContent(result.content);
        if (persistableContent.length > 0) {
          await saveMessage(feature.id, 'assistant', persistableContent);
        }

        const firstText = persistableContent.find(
          (b) => (b as { type: string }).type === 'text',
        ) as { type: 'text'; text: string } | undefined;
        if (firstText) {
          await getPrisma().$transaction((tx) =>
            appendEvent(tx, feature.id, {
              type: 'chat.message',
              who: 'spec',
              text: firstText.text,
            }),
          );
        }

        await appendEvent(getPrisma(), feature.id, {
          type: 'agent.status',
          agent: 'spec',
          status: specProposed ? 'done' : 'waiting',
        });

        sseWrite(raw, { type: 'done' });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        app.log.error({ feature_id: feature.id, err }, 'Spec agent error on question answer');
        await appendEvent(getPrisma(), feature.id, {
          type: 'agent.status',
          agent: 'spec',
          status: 'failed',
        });
        sseWrite(raw, { type: 'error', message: msg });
      } finally {
        raw.end();
      }

      return reply;
    },
  );
}
