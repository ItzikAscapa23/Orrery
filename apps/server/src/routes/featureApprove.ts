import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { findFeatureById } from '../lib/features.js';
import { getMessagesByFeatureId, saveMessage, sanitizeAssistantContent } from '../lib/messages.js';
import { commitSpecDraft, ArtifactCommitError } from '../lib/artifacts.js';
import { getPrisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/events.js';
import { applyTransition } from '../lib/orchestrator.js';
import { runSpecAgentTurn } from '../agents/specAgent.js';
import { dispatchForState } from '../lib/dispatch.js';
import { gateOpenedCount } from '../lib/reviewCycle.js';
import type { FeatureStatus } from '@prisma/client';
import { usageEventPayload } from '../lib/usageEvent.js';

const RequestChangesBodySchema = z.object({
  comment: z.string().min(1),
});

function sseWrite(raw: import('node:http').ServerResponse, payload: Record<string, unknown>): void {
  raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function featureApproveRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /approve ──────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/features/:id/approve', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }
    if (feature.status !== 'AWAITING_APPROVAL') {
      return reply.status(409).send({ error: 'Feature is not awaiting approval' });
    }
    if (!feature.proposed_spec) {
      return reply.status(409).send({ error: 'No proposed spec to approve' });
    }

    // Only findings from the CURRENT review cycle gate approval. Findings
    // from a superseded review (before request-changes → re-propose) do not
    // carry forward, per spec 03.
    const currentCycleRev = (await gateOpenedCount(feature.id)) - 1;
    const unresolvedBlockers = await getPrisma().finding.count({
      where: {
        featureId: feature.id,
        severity: 'blocker',
        resolution: null,
        specRev: currentCycleRev,
      },
    });
    if (unresolvedBlockers > 0) {
      return reply.status(409).send({
        error: `${unresolvedBlockers} blocker finding(s) must be resolved before approval`,
      });
    }

    // spec.md was already committed (and artifact.committed emitted) at specProposed
    // time (featureMessages / request-changes). Approval does not re-commit.
    const isLight = feature.feature_path === 'LIGHT';
    let nextStateAfterApprove: FeatureStatus | null = null;
    await getPrisma().$transaction(async (tx) => {
      await appendEvent(tx, feature.id, {
        type: 'gate.resolved',
        gate: 'spec_approval',
        resolution: 'approved',
      });
      // Light path: APPROVE_LIGHT → LIGHT_IMPLEMENTING; full path: APPROVE → PLANNING
      const event = isLight ? ('APPROVE_LIGHT' as const) : ('APPROVE' as const);
      const next = await applyTransition(tx, feature.id, feature.status as FeatureStatus, event);
      if (next) {
        nextStateAfterApprove = next;
        await appendEvent(tx, feature.id, {
          type: 'phase.changed',
          from: feature.status,
          to: next,
        });
      }
    });

    // Dispatch the job for the new state.
    // Full path: PLANNING → 'plan' job. Light path: LIGHT_IMPLEMENTING → 'light-dev' jobs.
    if (nextStateAfterApprove) {
      await dispatchForState(feature.id, nextStateAfterApprove, feature);
    }

    const updated = await findFeatureById(feature.id);
    return reply.status(200).send(updated);
  });

  // ── POST /request-changes ──────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/features/:id/request-changes', async (request, reply) => {
    const feature = await findFeatureById(request.params.id);
    if (!feature) {
      return reply.status(404).send({ error: 'Feature not found' });
    }
    if (feature.status !== 'AWAITING_APPROVAL') {
      return reply.status(409).send({ error: 'Feature is not awaiting approval' });
    }

    let comment: string;
    try {
      ({ comment } = RequestChangesBodySchema.parse(request.body));
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: err.issues.map((i) => i.message).join(', ') });
      }
      throw err;
    }

    // Atomic: gate.resolved + chat.message(dev) + DRAFTING_SPEC + clear proposed_spec cache
    await getPrisma().$transaction(async (tx) => {
      await appendEvent(tx, feature.id, {
        type: 'gate.resolved',
        gate: 'spec_approval',
        resolution: 'changes_requested',
        comment,
      });
      await appendEvent(tx, feature.id, {
        type: 'chat.message',
        who: 'dev',
        text: comment,
      });
      const next = await applyTransition(
        tx,
        feature.id,
        feature.status as FeatureStatus,
        'REQUEST_CHANGES',
      );
      if (next) {
        await appendEvent(tx, feature.id, {
          type: 'phase.changed',
          from: feature.status,
          to: next,
        });
      }
      // Clear proposed_spec cache on re-open
      await tx.feature.update({ where: { id: feature.id }, data: { proposedSpec: null } });
    });

    // Persist the comment as a user message and run the spec agent synchronously (SSE response)
    const history = await getMessagesByFeatureId(feature.id);
    await saveMessage(feature.id, 'user', [{ type: 'text', text: comment }]);

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
        text: '▸ addressing requested changes',
      });

      const isLightReq = feature.feature_path === 'LIGHT';

      const result = await runSpecAgentTurn(
        feature.id,
        feature.name,
        feature.requirement,
        feature.slug,
        [...history, { role: 'user', content: [{ type: 'text', text: comment }] }],
        (text) => sseWrite(raw, { type: 'token', text }),
        async (specMarkdown) => {
          specProposed = true;

          // Commit spec.md on write (same pattern as featureMessages — ruling: artifacts
          // committed on write, not on approval).
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

          if (isLightReq) {
            // Light path: skip AWS_REVIEW; go directly to AWAITING_APPROVAL and open spec gate.
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
                'SUBMIT_SPEC_LIGHT',
              );
              if (afterSubmit) {
                await appendEvent(tx, feature.id, {
                  type: 'phase.changed',
                  from: currentFeature.status,
                  to: afterSubmit,
                });
              }
              await appendEvent(tx, feature.id, {
                type: 'gate.opened',
                gate: 'spec_approval',
                summary: specMarkdown.slice(0, 200),
                revision: rev,
                counts: { blockers: 0, warnings: 0, suggestions: 0 },
                spec_commit: specCommitResult.commit,
              });
            });
            await appendEvent(getPrisma(), feature.id, {
              type: 'agent.log',
              agent: 'orchestrator',
              severity: 'info',
              text: '◦ light path — spec approval gate opened (AWS review skipped)',
            });
          } else {
            // Full path: SUBMIT_SPEC → AWS_REVIEW
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

            // Dispatch the AWS review job via dispatchForState.
            await dispatchForState(feature.id, 'AWS_REVIEW', feature);
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
      app.log.error({ feature_id: feature.id, err }, 'Spec agent error on request-changes');
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
