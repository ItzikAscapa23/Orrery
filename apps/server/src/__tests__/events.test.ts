import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { appendEvent, subscribeToFeature, unsubscribeFromFeature, _test } from '../lib/events.js';
import type { EventRow } from '../lib/events.js';

afterEach(async () => {
  await disconnectPrisma();
});

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
});

async function createFeature(slug = 'test') {
  return getPrisma().feature.create({
    data: { slug: `${slug}-${Math.random().toString(36).slice(2)}`, name: 'T', requirement: 'r' },
  });
}

// ── seq assignment ────────────────────────────────────────────────────────────

describe('appendEvent — seq', () => {
  it('assigns seq=1 to the first event for a feature', async () => {
    const feature = await createFeature();
    const row = await getPrisma().$transaction((tx) =>
      appendEvent(tx, feature.id, { type: 'phase.changed', from: null, to: 'DRAFTING_SPEC' }),
    );
    expect(row.seq).toBe(1);
  });

  it('increments seq monotonically for subsequent events', async () => {
    const feature = await createFeature();
    const r1 = await getPrisma().$transaction((tx) =>
      appendEvent(tx, feature.id, { type: 'phase.changed', from: null, to: 'DRAFTING_SPEC' }),
    );
    const r2 = await getPrisma().$transaction((tx) =>
      appendEvent(tx, feature.id, {
        type: 'phase.changed',
        from: 'DRAFTING_SPEC',
        to: 'AWS_REVIEW',
      }),
    );
    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(2);
  });

  it('N concurrent bare-client appendEvents all succeed with distinct consecutive seqs', async () => {
    const N = 8;
    const feature = await createFeature();
    // Fire all N appends simultaneously — no transaction wrapper, bare getPrisma()
    const rows = await Promise.all(
      Array.from({ length: N }, () =>
        appendEvent(getPrisma(), feature.id, {
          type: 'agent.log',
          agent: 'spec',
          severity: 'info',
          text: 'concurrent',
        }),
      ),
    );
    const seqs = rows.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toHaveLength(N);
    // All seqs must be unique
    expect(new Set(seqs).size).toBe(N);
    // Must form a contiguous range starting at 1
    expect(seqs[0]).toBe(1);
    expect(seqs[N - 1]).toBe(N);
  });

  it('two concurrent $transaction-wrapped appends for the same feature both succeed with distinct seqs', async () => {
    const feature = await createFeature();
    const [r1, r2] = await Promise.all([
      getPrisma().$transaction((tx) =>
        appendEvent(tx, feature.id, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'muted',
          text: 'concurrent-a',
        }),
      ),
      getPrisma().$transaction((tx) =>
        appendEvent(tx, feature.id, {
          type: 'agent.log',
          agent: 'orchestrator',
          severity: 'muted',
          text: 'concurrent-b',
        }),
      ),
    ]);
    expect(r1.seq).not.toBe(r2.seq);
    expect([r1.seq, r2.seq].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('sequences are independent per feature', async () => {
    const f1 = await createFeature('f1');
    const f2 = await createFeature('f2');
    const [a, b] = await Promise.all([
      getPrisma().$transaction((tx) =>
        appendEvent(tx, f1.id, { type: 'phase.changed', from: null, to: 'DRAFTING_SPEC' }),
      ),
      getPrisma().$transaction((tx) =>
        appendEvent(tx, f2.id, { type: 'phase.changed', from: null, to: 'DRAFTING_SPEC' }),
      ),
    ]);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
  });
});

// ── payload and agent ─────────────────────────────────────────────────────────

describe('appendEvent — payload and agent', () => {
  it('persists payload and returns EventRow with correct fields', async () => {
    const feature = await createFeature();
    const payload = {
      type: 'agent.log' as const,
      agent: 'spec',
      severity: 'info' as const,
      text: 'hello',
    };
    const row = await getPrisma().$transaction((tx) => appendEvent(tx, feature.id, payload));
    expect(row.type).toBe('agent.log');
    expect(row.agent).toBe('spec');
    expect(row.payload).toMatchObject(payload);
    expect(row.featureId).toBe(feature.id);
    expect(typeof row.createdAt).toBe('string');
  });

  it('derives agent=orchestrator for phase.changed', async () => {
    const feature = await createFeature();
    const row = await getPrisma().$transaction((tx) =>
      appendEvent(tx, feature.id, { type: 'phase.changed', from: null, to: 'DRAFTING_SPEC' }),
    );
    expect(row.agent).toBe('orchestrator');
  });

  it('derives agent=spec for chat.message from agent', async () => {
    const feature = await createFeature();
    const row = await getPrisma().$transaction((tx) =>
      appendEvent(tx, feature.id, { type: 'chat.message', who: 'spec', text: 'hello' }),
    );
    expect(row.agent).toBe('spec');
  });

  it('derives agent=null for chat.message from dev', async () => {
    const feature = await createFeature();
    const row = await getPrisma().$transaction((tx) =>
      appendEvent(tx, feature.id, { type: 'chat.message', who: 'dev', text: 'hi' }),
    );
    expect(row.agent).toBeNull();
  });

  it('derives agent=orchestrator for gate.resolved', async () => {
    const feature = await createFeature();
    const row = await getPrisma().$transaction((tx) =>
      appendEvent(tx, feature.id, {
        type: 'gate.resolved',
        gate: 'spec_approval',
        resolution: 'approved',
      }),
    );
    expect(row.agent).toBe('orchestrator');
  });
});

// ── pub/sub ───────────────────────────────────────────────────────────────────

describe('subscribeToFeature / unsubscribeFromFeature', () => {
  it('calls subscriber when an event is appended for that feature', async () => {
    const feature = await createFeature();
    const received: EventRow[] = [];
    const cb = (row: EventRow) => received.push(row);

    subscribeToFeature(feature.id, cb);
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, feature.id, { type: 'phase.changed', from: null, to: 'DRAFTING_SPEC' }),
    );
    unsubscribeFromFeature(feature.id, cb);

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('phase.changed');
  });

  it('does not call subscriber after unsubscribe', async () => {
    const feature = await createFeature();
    const cb = vi.fn();

    subscribeToFeature(feature.id, cb);
    unsubscribeFromFeature(feature.id, cb);
    await getPrisma().$transaction((tx) =>
      appendEvent(tx, feature.id, { type: 'phase.changed', from: null, to: 'DRAFTING_SPEC' }),
    );

    expect(cb).not.toHaveBeenCalled();
  });

  it('only notifies subscribers for the matching feature', async () => {
    const f1 = await createFeature('fa');
    const f2 = await createFeature('fb');
    const f1Events: EventRow[] = [];
    const f2Events: EventRow[] = [];

    subscribeToFeature(f1.id, (r) => f1Events.push(r));
    subscribeToFeature(f2.id, (r) => f2Events.push(r));

    await getPrisma().$transaction((tx) =>
      appendEvent(tx, f1.id, { type: 'phase.changed', from: null, to: 'DRAFTING_SPEC' }),
    );

    unsubscribeFromFeature(f1.id, (r) => f1Events.push(r));
    unsubscribeFromFeature(f2.id, (r) => f2Events.push(r));

    expect(f1Events).toHaveLength(1);
    expect(f2Events).toHaveLength(0);
  });
});

// ── P2002 retry loop ──────────────────────────────────────────────────────────
//
// doWithP2002Retry is not exported, so we test the observable behaviour via
// the bare-pool appendEvent path, which routes through it.
// We verify that successive P2002 collisions are absorbed up to MAX_ATTEMPTS
// by simulating a burst of concurrent bare-pool appends that would race on seq.

describe('P2002 bounded retry (bare-pool path)', () => {
  it('three concurrent bare-pool appendEvents all succeed (regression: void onUsage race)', async () => {
    // Simulates the pattern: usage.recorded fires concurrently with specProposed appends.
    // All three must resolve without P2002 surfacing.
    const feature = await createFeature();
    const [r1, r2, r3] = await Promise.all([
      appendEvent(getPrisma(), feature.id, {
        type: 'usage.recorded',
        agent: 'spec',
        model: 'claude-sonnet-5',
        input_tokens: 100,
        output_tokens: 50,
      }),
      appendEvent(getPrisma(), feature.id, {
        type: 'artifact.committed',
        path: 'features/t/spec.md',
        commit: 'abc1234',
        message: 'spec: t draft r0',
      }),
      appendEvent(getPrisma(), feature.id, {
        type: 'phase.changed',
        from: 'DRAFTING_SPEC',
        to: 'AWS_REVIEW',
      }),
    ]);
    const seqs = [r1.seq, r2.seq, r3.seq].sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(3);
    expect(seqs).toEqual([1, 2, 3]);
  });
});

// ── Sequential caller-transaction appends ─────────────────────────────────────
//
// Verifies that when usage.recorded and specProposed appends are issued
// sequentially (awaited in order), the seq numbers are assigned correctly.

describe('sequential caller-transaction appends', () => {
  it('usage.recorded followed by artifact.committed get consecutive seqs', async () => {
    const feature = await createFeature();

    // Simulate the fixed specAgent flow: usage append awaited first
    const r1 = await getPrisma().$transaction((tx) =>
      appendEvent(tx, feature.id, {
        type: 'usage.recorded',
        agent: 'spec',
        model: 'claude-sonnet-5',
        input_tokens: 100,
        output_tokens: 50,
      }),
    );
    const r2 = await getPrisma().$transaction((tx) =>
      appendEvent(tx, feature.id, {
        type: 'artifact.committed',
        path: 'features/t/spec.md',
        commit: 'abc1234',
        message: 'spec: t draft r0',
      }),
    );

    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(2);
  });
});

// ── Cross-process P2002 protection (caller-tx path) ───────────────────────────
//
// withSeqLock only serialises same-process callers. Cross-process races require
// a database-level lock. _test.doAppend bypasses withSeqLock so concurrent
// $transaction callbacks execute in Postgres without the in-process queue.
//
// Before fix (no FOR UPDATE): a burst of N concurrent caller-tx doAppend calls
// will have some transactions read the same MAX(seq) before any INSERT commits,
// causing P2002 on those that arrive second. Promise.allSettled surfaces the
// failures — expect(failures).toHaveLength(0) is RED.
//
// After fix (FOR UPDATE on feature row): each transaction acquires the row lock
// before reading seq. Only one holds the lock at a time; the rest serialise
// through it. All N complete with distinct consecutive seqs — PASSES GREEN.

describe('caller-tx seq: cross-process P2002 protection', () => {
  it('burst of concurrent caller-tx doAppend calls all produce distinct seqs without P2002', async () => {
    // N=15 opens more concurrent transactions than the seq-read round-trip allows
    // to serialise naturally, reliably triggering the race window before the fix.
    const N = 15;
    const feature = await createFeature();
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        getPrisma().$transaction((tx) =>
          _test.doAppend(tx, feature.id, {
            type: 'agent.log',
            agent: 'spec',
            severity: 'info',
            text: `concurrent-${i}`,
          }),
        ),
      ),
    );
    const failures = results.filter((r) => r.status === 'rejected');
    // Before fix: some failures with P2002 (race window exists) — expect RED.
    // After fix: 0 failures.
    expect(failures).toHaveLength(0);

    const seqs = results
      .filter((r): r is PromiseFulfilledResult<EventRow> => r.status === 'fulfilled')
      .map((r) => r.value.seq)
      .sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it('concurrent caller-tx and bare-pool appends both resolve without P2002', async () => {
    const feature = await createFeature();
    // _test.doAppend (caller-tx, no seqLock) races with the bare-pool path.
    const [r1, r2] = await Promise.all([
      getPrisma().$transaction((tx) =>
        _test.doAppend(tx, feature.id, {
          type: 'gate.resolved',
          gate: 'spec_approval',
          resolution: 'approved',
        }),
      ),
      appendEvent(getPrisma(), feature.id, {
        type: 'agent.log',
        agent: 'spec',
        severity: 'info',
        text: 'concurrent bare-pool',
      }),
    ]);
    expect(r1.seq).not.toBe(r2.seq);
    expect([r1.seq, r2.seq].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
