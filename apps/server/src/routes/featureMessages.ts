import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { z, ZodError } from 'zod';
import { findFeatureById } from '../lib/features.js';
import {
  saveMessage,
  getMessagesByFeatureId,
  sanitizeAssistantContent,
  type AnyContentBlock,
} from '../lib/messages.js';
import { runSpecAgentTurn } from '../agents/specAgent.js';
import { parseFigmaUrl, fetchFigmaImage } from '../lib/figma.js';
import { parseImageAttachments } from '../lib/imageAttachments.js';
import { commitSpecDraft, ArtifactCommitError } from '../lib/artifacts.js';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { dispatchJob } from '../lib/dispatch.js';
import { resolveCharterPath } from '../lib/charterResolver.js';
import { submitSpecSkip } from '../lib/specSubmit.js';
import { persistSpecQuestions } from '../lib/specQuestions.js';
import type Anthropic from '@anthropic-ai/sdk';
import { usageEventPayload } from '../lib/usageEvent.js';

const MessageBodySchema = z.object({
  text: z.string().min(1),
});

function sseWrite(raw: import('node:http').ServerResponse, payload: Record<string, unknown>): void {
  raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function featureMessagesRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, { attachFieldsToBody: false });

  app.post<{ Params: { id: string } }>('/features/:id/messages', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }

    // Chat dispatch is only valid while the Spec Agent owns the conversation.
    if (feature.status !== 'DRAFTING_SPEC') {
      return reply.status(409).send({
        error: `Chat input is not accepted in ${feature.status} state`,
      });
    }

    // Support both JSON body (text only) and multipart (text + files)
    let textContent = '';
    const uploadedImages: Anthropic.ImageBlockParam[] = [];

    const contentType = request.headers['content-type'] ?? '';
    if (contentType.includes('multipart/form-data')) {
      // File streams must be consumed inside the iteration — reading toBuffer()
      // after the loop completes causes a busboy backpressure deadlock.
      for await (const part of (
        request as Parameters<typeof parseImageAttachments>[0] & {
          parts: () => AsyncIterable<unknown>;
        }
      ).parts()) {
        const p = part as {
          type: string;
          fieldname?: string;
          value?: string;
          mimetype?: string;
          toBuffer?: () => Promise<Buffer>;
        };
        if (p.type === 'field' && p.fieldname === 'text') {
          textContent = p.value ?? '';
        } else if (
          p.type === 'file' &&
          p.mimetype &&
          ['image/png', 'image/jpeg'].includes(p.mimetype) &&
          p.toBuffer
        ) {
          const buffer = await p.toBuffer();
          uploadedImages.push({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: p.mimetype as 'image/png' | 'image/jpeg',
              data: buffer.toString('base64'),
            },
          });
        }
      }
    } else {
      try {
        const parsed = MessageBodySchema.parse(request.body);
        textContent = parsed.text;
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({ error: err.issues.map((i) => i.message).join(', ') });
        }
        throw err;
      }
    }

    if (!textContent) {
      return reply.status(400).send({ error: 'text field is required' });
    }

    // Resolve Figma links found in the text
    const figmaImages: Anthropic.ImageBlockParam[] = [];
    const figmaRef = parseFigmaUrl(textContent);
    if (figmaRef && process.env['FIGMA_TOKEN']) {
      try {
        const figmaSource = await fetchFigmaImage(figmaRef.fileKey, figmaRef.nodeId);
        figmaImages.push({ type: 'image', source: figmaSource });
      } catch (err) {
        app.log.warn(
          { feature_id: feature.id, err },
          'Figma image fetch failed — continuing without it',
        );
      }
    }

    const history = await getMessagesByFeatureId(feature.id);
    const userContent: AnyContentBlock[] = [
      { type: 'text', text: textContent },
      ...figmaImages,
      ...uploadedImages,
    ];

    // Persist user message + emit chat.message (pure log, no tx needed)
    await saveMessage(feature.id, 'user', userContent);
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, feature.id, { type: 'chat.message', who: 'dev', text: textContent }),
    );

    const userMessage: Anthropic.MessageParam = { role: 'user', content: userContent };

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
        text: '▸ processing developer message',
      });

      const result = await runSpecAgentTurn(
        feature.id,
        feature.name,
        feature.requirement,
        feature.slug,
        [...history, userMessage],
        (text) => sseWrite(raw, { type: 'token', text }),
        async (specMarkdown, questions) => {
          specProposed = true;

          // Commit spec.md to the artifacts repo immediately on write (not at approval).
          // The SHA travels in artifact.committed → gate.opened so the viewer can pin
          // to the exact draft that was under review even after a browser reload.
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

          // Persist structured questions for this revision and emit spec.questions.
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
            // No charter configured — skip AWS review, go directly to AWAITING_APPROVAL.
            await submitSpecSkip(feature.id, specMarkdown, specCommitResult, rev, questions.length);
            await appendEvent(getPrisma(), feature.id, {
              type: 'agent.log',
              agent: 'orchestrator',
              severity: 'info',
              text: '◦ no review charter configured — spec approval gate opened (AWS review skipped)',
            });
          } else {
            // Charter found — full path: SUBMIT_SPEC → AWS_REVIEW
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
          // usage.recorded — pure log, no state change, no tx needed
          await getPrisma().$transaction((tx) =>
            appendEvent(tx, feature.id, usageEventPayload(usage, 'spec')),
          );
        },
        feature.feature_path,
      );

      // Strip blocks that cannot be safely replayed (thinking, tool_use).
      const persistableContent = sanitizeAssistantContent(result.content);
      if (persistableContent.length > 0) {
        await saveMessage(feature.id, 'assistant', persistableContent);
      }

      // Emit assistant chat.message (first text block only)
      const firstText = persistableContent.find((b) => (b as { type: string }).type === 'text') as
        { type: 'text'; text: string } | undefined;
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
      app.log.error({ feature_id: feature.id, err }, 'Spec agent error');
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
  });
}
