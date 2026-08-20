// Unit tests for appendEvent P2028 error isolation.
//
// insertWithCte calls getPrisma().$transaction(cb) then tx.$queryRaw inside cb.
// The mock routes $transaction through its callback so tx.$queryRaw calls land
// on mockQueryRaw, keeping P2028 injection accurate.
//
// Real-DB tests are in events.test.ts — see "N concurrent bare-client appendEvents"
// as the canonical "normal appends unaffected" regression guard.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

// vi.hoisted ensures mockQueryRaw is initialised before the vi.mock factory runs.
// Without hoisting, vi.mock is lifted to the top of the file at runtime but
// const declarations are not — the factory would see undefined.
const { mockQueryRaw } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  // $transaction present so duck-type check routes to bare-pool path.
  // The mock calls the callback so insertWithCte's tx.$queryRaw calls land on
  // mockQueryRaw, keeping P2028 injection working after the $transaction wrap.
  getPrisma: () => ({
    $transaction: vi.fn().mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (cb: (tx: { $queryRaw: typeof mockQueryRaw }) => any) =>
        cb({ $queryRaw: mockQueryRaw }),
    ),
    $queryRaw: mockQueryRaw,
  }),
  disconnectPrisma: vi.fn(),
}));

// Import events.ts AFTER the mock is registered
import { appendEvent } from '../lib/events.js';
import { getPrisma } from '../lib/prisma.js';

const FAKE_FEATURE_ID = 'test-feature-00000000';

function makeP2028(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction already closed: the timeout for this transaction was 5000 ms, however 5519 ms passed since the start of the transaction.',
    { code: 'P2028', clientVersion: '4.16.2', meta: {} },
  );
}

const LOG_PAYLOAD = {
  type: 'agent.log' as const,
  agent: 'spec' as const,
  severity: 'info' as const,
  text: 'test-event',
};

beforeEach(() => {
  mockQueryRaw.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('appendEvent — P2028 is surfaced, not swallowed', () => {
  it('rejects with P2028 when $queryRaw throws it (append fails, process lives)', async () => {
    // Ensure process.exit is NOT called as a side effect of this failure
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as typeof process.exit);

    mockQueryRaw.mockRejectedValue(makeP2028());

    await expect(
      appendEvent(getPrisma() as Parameters<typeof appendEvent>[0], FAKE_FEATURE_ID, LOG_PAYLOAD),
    ).rejects.toMatchObject({ code: 'P2028' });

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs event=append_event_tx_timeout when P2028 is thrown', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    mockQueryRaw.mockRejectedValue(makeP2028());

    await appendEvent(
      getPrisma() as Parameters<typeof appendEvent>[0],
      FAKE_FEATURE_ID,
      LOG_PAYLOAD,
    ).catch(() => undefined); // suppress the rejection — we only care about the log

    const loggedEvents = consoleSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((v): v is Record<string, unknown> => v !== null);

    expect(loggedEvents.some((e) => e['event'] === 'append_event_tx_timeout')).toBe(true);
    expect(
      loggedEvents.find((e) => e['event'] === 'append_event_tx_timeout')?.['featureId'],
    ).toBe(FAKE_FEATURE_ID);
  });

  it('a subsequent append succeeds after a P2028 (seq-lock chain is not poisoned)', async () => {
    // First call fails with P2028 (on the FOR UPDATE step inside insertWithCte)
    mockQueryRaw.mockRejectedValueOnce(makeP2028());

    await appendEvent(
      getPrisma() as Parameters<typeof appendEvent>[0],
      FAKE_FEATURE_ID,
      LOG_PAYLOAD,
    ).catch(() => undefined);

    // Second call: insertWithCte makes two $queryRaw calls — FOR UPDATE then CTE INSERT.
    const fakeRow = [
      {
        id: BigInt(1),
        feature_id: FAKE_FEATURE_ID,
        seq: 1,
        type: 'agent.log',
        agent: 'spec',
        payload: LOG_PAYLOAD,
        created_at: new Date(),
      },
    ];
    mockQueryRaw.mockResolvedValueOnce([]); // FOR UPDATE: result is discarded
    mockQueryRaw.mockResolvedValueOnce(fakeRow); // CTE INSERT RETURNING

    const row = await appendEvent(
      getPrisma() as Parameters<typeof appendEvent>[0],
      FAKE_FEATURE_ID,
      LOG_PAYLOAD,
    );

    expect(row.seq).toBe(1);
    expect(row.featureId).toBe(FAKE_FEATURE_ID);
  });
});
