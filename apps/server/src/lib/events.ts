import { EventEmitter } from 'node:events';
import { Prisma } from '@prisma/client';
import type { EventPayload } from '@orrery/shared';
import { getPrisma } from './prisma.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EventRow {
  id: number; // BigInt serialised to number for SSE/JSON
  featureId: string;
  seq: number;
  type: string;
  agent: string | null;
  payload: EventPayload;
  createdAt: string; // ISO string
}

// ── In-process pub/sub ────────────────────────────────────────────────────────

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // one listener per open SSE connection

function featureChannel(featureId: string): string {
  return `feature:${featureId}`;
}

export function subscribeToFeature(featureId: string, cb: (row: EventRow) => void): void {
  emitter.on(featureChannel(featureId), cb);
}

export function unsubscribeFromFeature(featureId: string, cb: (row: EventRow) => void): void {
  emitter.off(featureChannel(featureId), cb);
}

// ── appendEvent ───────────────────────────────────────────────────────────────

type TxClient = Prisma.TransactionClient;

// Derives the top-level agent field from the validated payload so misattribution
// is structurally impossible — no caller-supplied opts that can be forgotten.
function deriveAgent(payload: EventPayload): string | null {
  switch (payload.type) {
    case 'phase.changed':
      return 'orchestrator';
    case 'agent.status':
      return payload.agent;
    case 'agent.log':
      return payload.agent;
    case 'chat.message':
      return payload.who === 'dev' ? null : payload.who;
    case 'gate.opened':
      return 'orchestrator';
    case 'gate.resolved':
      return 'orchestrator';
    case 'usage.recorded':
      return payload.agent;
    case 'artifact.committed':
      return 'orchestrator';
    case 'review.findings':
      return payload.agent;
    case 'finding.resolved':
      return 'orchestrator';
    case 'spec.revised':
    case 'spec.questions':
    case 'spec.question_answered':
      return 'orchestrator';
    case 'plan.proposed':
      return payload.agent;
    case 'task.started':
    case 'task.completed':
    case 'task.failed':
      return 'orchestrator';
    case 'contract.amendment.proposed':
      return 'orchestrator';
    case 'contract.revised':
      return 'orchestrator';
    case 'amendment.rejected':
      return 'orchestrator';
    case 'pr.created':
      return 'orchestrator';
    case 'review.started':
      return payload.agent;
    case 'review.skipped':
      return payload.agent;
    case 'test.started':
      return payload.agent;
    case 'test.report':
      return payload.agent;
    case 'test_plan.proposed':
      return payload.agent;
    case 'task.tests_written':
      return 'orchestrator';
    case 'light_dev.completed':
      return 'orchestrator';
    case 'test.shared_infra_changed':
      return 'test';
  }
}

// Per-feature promise-chain mutex. Serialises same-process appendEvent calls so
// only one read+insert unit is in-flight per feature at any moment.
// Two paths, selected by appendEvent at call time:
//   - Caller-transaction path (tx is an interactive-tx client): doAppend runs
//     directly inside the caller's already-open $transaction. It acquires a
//     SELECT … FOR UPDATE on the feature row before reading seq, holding the
//     lock until the caller's tx commits. Errors propagate for ROLLBACK.
//   - Bare-pool path (tx is the top-level PrismaClient): appendViaFreshTx wraps
//     each insert in its own short $transaction that also acquires the feature
//     row FOR UPDATE before the CTE INSERT, with two retry layers: 25P02 (dirty
//     recycled connection) and P2002 (safety net — should not fire with lock).
//
// The FOR UPDATE on the feature row is the cross-process coordination point:
// both paths lock the same row, so no two processes can race on MAX(seq).
const seqLocks = new Map<string, Promise<unknown>>();

function withSeqLock<T>(featureId: string, fn: () => Promise<T>): Promise<T> {
  const prev = seqLocks.get(featureId) ?? Promise.resolve();
  const next = prev.then(fn);
  seqLocks.set(
    featureId,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Insert an event row and publish it to in-process SSE subscribers.
 *
 * For state-changing writes pass the Prisma transaction client so the event
 * INSERT is atomic with the status update. For pure log lines (agent.log,
 * usage.recorded) the top-level PrismaClient is acceptable.
 *
 * Attribution is derived from the validated payload — never from a caller
 * argument — per the agent activity contract in docs/specs/02-orchestrator.md.
 */
export function appendEvent(
  tx: TxClient,
  featureId: string,
  payload: EventPayload,
): Promise<EventRow> {
  // Interactive-transaction clients lack $transaction; bare PrismaClient has it.
  const isCallerTransaction = !('$transaction' in (tx as Record<string, unknown>));
  return withSeqLock(
    featureId,
    () =>
      isCallerTransaction
        ? doAppend(tx, featureId, payload) // inside caller's $tx — errors propagate
        : appendViaFreshTx(featureId, payload), // bare pool — own $tx + retry layers
  );
}

// Bare-pool path. Two retry layers (outer wraps inner):
//   Outer — 25P02 (dirty connection recycled from pool). Known-transient: one
//            automatic retry, level-40 warn.
//          — P2028 (insertWithCte opens a short $transaction for the FOR UPDATE
//            lock; under extreme contention the 5s timeout could fire — logged
//            explicitly if it ever surfaces, then re-thrown).
//   Inner — P2002 (safety net: should not fire now that both paths hold the
//            feature-row lock, but retained to catch structural regressions).
async function appendViaFreshTx(featureId: string, payload: EventPayload): Promise<EventRow> {
  try {
    return await doWithP2002Retry(featureId, payload);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === '25P02') {
      console.warn(
        JSON.stringify({
          event: 'append_event_dirty_connection_retry',
          featureId,
          error: err.message,
        }),
      );
      return doWithP2002Retry(featureId, payload);
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2028') {
      // Transaction timeout — log explicitly so any regression is visible in
      // structured logs, then re-throw so the job fails rather than the server.
      console.error(
        JSON.stringify({
          event: 'append_event_tx_timeout',
          featureId,
          error: err.message,
          code: err.code,
        }),
      );
    }
    throw err;
  }
}

async function doWithP2002Retry(featureId: string, payload: EventPayload): Promise<EventRow> {
  const MAX_ATTEMPTS = 5;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // insertWithCte holds the feature-row FOR UPDATE lock so cross-process
      // collisions on seq are serialised rather than retried. P2002 is kept as
      // a structural safety net in case a future code path skips the lock.
      return await insertWithCte(featureId, payload);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr; // exhausted MAX_ATTEMPTS — structural problem, propagate
}

// Lock the feature row before reading seq so no concurrent transaction can read
// the same MAX(seq) and collide on INSERT. The FOR UPDATE is held until the
// caller's $transaction commits or rolls back — exactly the right scope.
// withSeqLock handles same-process serialisation; this handles cross-process.
async function doAppend(tx: TxClient, featureId: string, payload: EventPayload): Promise<EventRow> {
  await tx.$queryRaw`SELECT id FROM features WHERE id = ${featureId} FOR UPDATE`;
  const seq = await readNextSeq(tx, featureId);
  return insertRow(tx, featureId, seq, payload);
}

async function readNextSeq(tx: TxClient, featureId: string): Promise<number> {
  const agg = await tx.event.aggregate({ where: { featureId }, _max: { seq: true } });
  return (agg._max.seq ?? 0) + 1;
}

async function insertRow(
  tx: TxClient,
  featureId: string,
  seq: number,
  payload: EventPayload,
): Promise<EventRow> {
  const agent = deriveAgent(payload);

  const row = await tx.event.create({
    data: {
      featureId,
      seq,
      type: payload.type,
      agent,
      payload: payload,
    },
  });

  const eventRow: EventRow = {
    id: Number(row.id),
    featureId: row.featureId,
    seq: row.seq,
    type: row.type,
    agent: row.agent,
    payload,
    createdAt: row.createdAt.toISOString(),
  };

  // Emit after insert completes; SSE subscribers run async so the transaction
  // will have committed by the time they process the event.
  emitter.emit(featureChannel(featureId), eventRow);
  return eventRow;
}

// Test-only: exposes doAppend without withSeqLock so tests can send concurrent
// $transaction calls to the same feature and verify no P2002 escapes.
export const _test = {
  doAppend: (tx: TxClient, featureId: string, payload: EventPayload) =>
    doAppend(tx, featureId, payload),
};

// Bare-pool insert: lock the feature row then INSERT via CTE.
//
// The short $transaction (lock + CTE) runs in <5ms — well within Prisma's 5s
// interactive-transaction timeout — so no P2028 risk. The lock is the same
// coordination point as doAppend's FOR UPDATE, serialising all paths
// cross-process. doWithP2002Retry is retained as a safety net but should not
// fire in practice once both paths hold the lock.
async function insertWithCte(featureId: string, payload: EventPayload): Promise<EventRow> {
  const agent = deriveAgent(payload);
  const rows = await getPrisma().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM features WHERE id = ${featureId} FOR UPDATE`;
    return tx.$queryRaw<
      Array<{
        id: bigint;
        feature_id: string;
        seq: number;
        type: string;
        agent: string | null;
        payload: Prisma.JsonValue;
        created_at: Date;
      }>
    >`
      WITH next_seq AS (
        SELECT COALESCE(MAX(seq), 0) + 1 AS seq
        FROM   events
        WHERE  feature_id = ${featureId}
      )
      INSERT INTO events (feature_id, seq, type, agent, payload)
      SELECT
        ${featureId},
        next_seq.seq,
        ${payload.type},
        ${agent},
        ${JSON.stringify(payload)}::jsonb
      FROM next_seq
      RETURNING id, feature_id, seq, type, agent, payload, created_at
    `;
  });

  const row = rows[0];
  if (!row) throw new Error(`insertWithCte: no row returned for featureId=${featureId}`);

  const eventRow: EventRow = {
    id: Number(row.id),
    featureId: row.feature_id,
    seq: row.seq,
    type: row.type,
    agent: row.agent,
    payload,
    createdAt: row.created_at.toISOString(),
  };
  emitter.emit(featureChannel(featureId), eventRow);
  return eventRow;
}
