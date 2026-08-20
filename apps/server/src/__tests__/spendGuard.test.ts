import { describe, expect, it, vi, beforeEach } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockQueryRaw, mockTransaction } = vi.hoisted(() => {
  const mockTransaction = vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ task: { update: vi.fn() } }),
  );
  const mockQueryRaw = vi.fn();
  return { mockQueryRaw, mockTransaction };
});

vi.mock('../lib/prisma.js', () => ({
  getPrisma: () => ({
    $queryRaw: mockQueryRaw,
    $transaction: mockTransaction,
  }),
  disconnectPrisma: vi.fn(),
}));

vi.mock('../lib/events.js', () => ({
  appendEvent: vi.fn().mockResolvedValue(undefined),
}));

import { checkSpendGuard } from '../lib/spendGuard.js';

function makeQueryResult(turns: number, jobCount = 1) {
  return [{ turns: BigInt(turns), job_count: BigInt(jobCount) }];
}

describe('checkSpendGuard — return shape', () => {
  beforeEach(() => {
    mockQueryRaw.mockClear();
    mockTransaction.mockClear();
    delete process.env['SPEND_GUARD_MAX_TURNS'];
  });

  it('returns { parked: false, remainingBudget } when under threshold', async () => {
    mockQueryRaw.mockResolvedValueOnce(makeQueryResult(0));
    const result = await checkSpendGuard('f1', 't1', 'My task');
    expect(result).toEqual({ parked: false, remainingBudget: 150 });
  });

  it('remainingBudget reflects turns already used', async () => {
    mockQueryRaw.mockResolvedValueOnce(makeQueryResult(148));
    const result = await checkSpendGuard('f1', 't1', 'My task');
    expect(result).toEqual({ parked: false, remainingBudget: 2 });
  });

  it('returns { parked: true } when at threshold', async () => {
    mockQueryRaw.mockResolvedValueOnce(makeQueryResult(150));
    const result = await checkSpendGuard('f1', 't1', 'My task');
    expect(result).toEqual({ parked: true });
  });

  it('returns { parked: true } when over threshold', async () => {
    mockQueryRaw.mockResolvedValueOnce(makeQueryResult(200));
    const result = await checkSpendGuard('f1', 't1', 'My task');
    expect(result).toEqual({ parked: true });
  });

  it('respects SPEND_GUARD_MAX_TURNS env override', async () => {
    process.env['SPEND_GUARD_MAX_TURNS'] = '10';
    mockQueryRaw.mockResolvedValueOnce(makeQueryResult(8));
    const result = await checkSpendGuard('f1', 't1', 'My task');
    expect(result).toEqual({ parked: false, remainingBudget: 2 });
  });

  it('calls $transaction to park when at threshold', async () => {
    mockQueryRaw.mockResolvedValueOnce(makeQueryResult(150));
    await checkSpendGuard('f1', 't1', 'My task');
    expect(mockTransaction).toHaveBeenCalledOnce();
  });

  it('does not call $transaction when under threshold', async () => {
    mockQueryRaw.mockResolvedValueOnce(makeQueryResult(100));
    await checkSpendGuard('f1', 't1', 'My task');
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
