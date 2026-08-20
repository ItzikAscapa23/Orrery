import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { isValidTransition, nextState, applyTransition } from '../lib/orchestrator.js';
import type { FeatureStatus } from '@prisma/client';

afterEach(async () => {
  await disconnectPrisma();
});

beforeEach(async () => {
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
});

// ── Pure logic ────────────────────────────────────────────────────────────────

describe('isValidTransition', () => {
  it('allows defined transitions', () => {
    expect(isValidTransition('DRAFTING_SPEC', 'SUBMIT_SPEC')).toBe(true);
    expect(isValidTransition('AWAITING_APPROVAL', 'APPROVE')).toBe(true);
    expect(isValidTransition('AWAITING_APPROVAL', 'REQUEST_CHANGES')).toBe(true);
    expect(isValidTransition('CODE_REVIEW', 'REVIEW_FAIL')).toBe(true);
  });

  it('rejects transitions not in the table', () => {
    expect(isValidTransition('DRAFTING_SPEC', 'APPROVE')).toBe(false);
    expect(isValidTransition('PLANNING', 'APPROVE')).toBe(false);
    expect(isValidTransition('DONE', 'SUBMIT_SPEC')).toBe(false);
  });

  it('allows FAIL from any non-terminal state', () => {
    const nonTerminal: FeatureStatus[] = [
      'DRAFTING_SPEC',
      'AWS_REVIEW',
      'AWAITING_APPROVAL',
      'PLANNING',
      'IMPLEMENTING',
      'CODE_REVIEW',
      'TESTING',
    ];
    for (const state of nonTerminal) {
      expect(isValidTransition(state, 'FAIL')).toBe(true);
    }
  });

  it('rejects FAIL from DONE and FAILED', () => {
    expect(isValidTransition('DONE', 'FAIL')).toBe(false);
    expect(isValidTransition('FAILED', 'FAIL')).toBe(false);
  });
});

describe('nextState', () => {
  it('returns the correct next state for valid transitions', () => {
    expect(nextState('DRAFTING_SPEC', 'SUBMIT_SPEC')).toBe('AWS_REVIEW');
    expect(nextState('AWS_REVIEW', 'AWS_SKIP')).toBe('AWAITING_APPROVAL');
    expect(nextState('AWS_REVIEW', 'AWS_REJECT')).toBe('DRAFTING_SPEC');
    expect(nextState('AWAITING_APPROVAL', 'APPROVE')).toBe('PLANNING');
    expect(nextState('AWAITING_APPROVAL', 'REQUEST_CHANGES')).toBe('DRAFTING_SPEC');
    // Plan gate transitions (4a)
    expect(nextState('PLANNING', 'SUBMIT_PLAN')).toBe('AWAITING_PLAN_APPROVAL');
    expect(nextState('AWAITING_PLAN_APPROVAL', 'APPROVE_PLAN')).toBe('PLANNING_TESTS');
    expect(nextState('AWAITING_PLAN_APPROVAL', 'REQUEST_PLAN_CHANGES')).toBe('PLANNING');
    expect(nextState('PLANNING', 'START_IMPL')).toBe('IMPLEMENTING');
    expect(nextState('IMPLEMENTING', 'SUBMIT_REVIEW')).toBe('CODE_REVIEW');
    expect(nextState('CODE_REVIEW', 'REVIEW_PASS')).toBe('TESTING');
    expect(nextState('CODE_REVIEW', 'REVIEW_FAIL')).toBe('IMPLEMENTING');
    expect(nextState('TESTING', 'TEST_PASS')).toBe('DONE');
    expect(nextState('TESTING', 'TEST_FAIL')).toBe('IMPLEMENTING');
  });

  it('returns FAILED for FAIL event from non-terminal states', () => {
    expect(nextState('IMPLEMENTING', 'FAIL')).toBe('FAILED');
    expect(nextState('DRAFTING_SPEC', 'FAIL')).toBe('FAILED');
  });

  it('returns null for invalid transitions', () => {
    expect(nextState('DONE', 'SUBMIT_SPEC')).toBeNull();
    expect(nextState('DRAFTING_SPEC', 'APPROVE')).toBeNull();
  });

  it('covers the full loop-back path: CODE_REVIEW → IMPLEMENTING → CODE_REVIEW', () => {
    expect(nextState('CODE_REVIEW', 'REVIEW_FAIL')).toBe('IMPLEMENTING');
    expect(nextState('IMPLEMENTING', 'SUBMIT_REVIEW')).toBe('CODE_REVIEW');
  });

  // ── Light path (14b) ──────────────────────────────────────────────────────

  it('light: SUBMIT_SPEC_LIGHT skips AWS_REVIEW → AWAITING_APPROVAL', () => {
    expect(nextState('DRAFTING_SPEC', 'SUBMIT_SPEC_LIGHT')).toBe('AWAITING_APPROVAL');
  });

  it('light: APPROVE_LIGHT skips PLANNING → LIGHT_IMPLEMENTING', () => {
    expect(nextState('AWAITING_APPROVAL', 'APPROVE_LIGHT')).toBe('LIGHT_IMPLEMENTING');
  });

  it('light: SUBMIT_REVIEW from LIGHT_IMPLEMENTING → CODE_REVIEW', () => {
    expect(nextState('LIGHT_IMPLEMENTING', 'SUBMIT_REVIEW')).toBe('CODE_REVIEW');
  });

  it('light: REVIEW_PASS_LIGHT skips TESTING → DONE', () => {
    expect(nextState('CODE_REVIEW', 'REVIEW_PASS_LIGHT')).toBe('DONE');
  });

  it('light: REVIEW_FAIL_LIGHT bounces back to LIGHT_IMPLEMENTING', () => {
    expect(nextState('CODE_REVIEW', 'REVIEW_FAIL_LIGHT')).toBe('LIGHT_IMPLEMENTING');
  });

  it('full path unaffected: SUBMIT_SPEC still goes to AWS_REVIEW', () => {
    expect(nextState('DRAFTING_SPEC', 'SUBMIT_SPEC')).toBe('AWS_REVIEW');
    expect(nextState('AWAITING_APPROVAL', 'APPROVE')).toBe('PLANNING');
    expect(nextState('CODE_REVIEW', 'REVIEW_PASS')).toBe('TESTING');
  });
});

// ── DB integration ────────────────────────────────────────────────────────────

describe('applyTransition', () => {
  async function createTestFeature(status: FeatureStatus = 'DRAFTING_SPEC') {
    return getPrisma().feature.create({
      data: {
        slug: `feat-${Math.random().toString(36).slice(2)}`,
        name: 'Test',
        requirement: 'r',
        status,
      },
    });
  }

  it('updates the feature status and returns the new state', async () => {
    const feature = await createTestFeature('DRAFTING_SPEC');
    const result = await getPrisma().$transaction(async (tx) => {
      return applyTransition(tx, feature.id, 'DRAFTING_SPEC', 'SUBMIT_SPEC');
    });
    expect(result).toBe('AWS_REVIEW');
    const updated = await getPrisma().feature.findUnique({ where: { id: feature.id } });
    expect(updated?.status).toBe('AWS_REVIEW');
  });

  it('returns null and does not update for invalid transition', async () => {
    const feature = await createTestFeature('DRAFTING_SPEC');
    const result = await getPrisma().$transaction(async (tx) => {
      return applyTransition(tx, feature.id, 'DRAFTING_SPEC', 'APPROVE');
    });
    expect(result).toBeNull();
    const unchanged = await getPrisma().feature.findUnique({ where: { id: feature.id } });
    expect(unchanged?.status).toBe('DRAFTING_SPEC');
  });

  it('transitions AWAITING_APPROVAL → PLANNING via APPROVE', async () => {
    const feature = await createTestFeature('AWAITING_APPROVAL');
    const result = await getPrisma().$transaction(async (tx) => {
      return applyTransition(tx, feature.id, 'AWAITING_APPROVAL', 'APPROVE');
    });
    expect(result).toBe('PLANNING');
  });

  it('transitions AWAITING_APPROVAL → DRAFTING_SPEC via REQUEST_CHANGES', async () => {
    const feature = await createTestFeature('AWAITING_APPROVAL');
    const result = await getPrisma().$transaction(async (tx) => {
      return applyTransition(tx, feature.id, 'AWAITING_APPROVAL', 'REQUEST_CHANGES');
    });
    expect(result).toBe('DRAFTING_SPEC');
  });

  it('transitions any non-terminal state to FAILED via FAIL', async () => {
    const feature = await createTestFeature('IMPLEMENTING');
    const result = await getPrisma().$transaction(async (tx) => {
      return applyTransition(tx, feature.id, 'IMPLEMENTING', 'FAIL');
    });
    expect(result).toBe('FAILED');
    const updated = await getPrisma().feature.findUnique({ where: { id: feature.id } });
    expect(updated?.status).toBe('FAILED');
  });

  it('second APPROVE call returns null (guard: already in PLANNING)', async () => {
    const feature = await createTestFeature('PLANNING');
    const result = await getPrisma().$transaction(async (tx) => {
      return applyTransition(tx, feature.id, 'PLANNING', 'APPROVE');
    });
    expect(result).toBeNull();
  });
});
