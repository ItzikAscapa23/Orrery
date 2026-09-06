import { describe, expect, it } from 'vitest';
import { resolveVariant } from '../components/TestReportCard.js';
import type { TestReportState } from '../types/ui.js';

function makeReport(overrides: Partial<TestReportState>): TestReportState {
  return {
    passed: null,
    failed: 0,
    tests: [],
    authoredPassed: undefined,
    authoredFailed: undefined,
    skipped: false,
    skipReason: null,
    parseError: null,
    wallTimeMs: null,
    findings: [],
    ...overrides,
  };
}

describe('resolveVariant', () => {
  it('returns legacy when authoredPassed is undefined', () => {
    expect(resolveVariant(makeReport({}))).toBe('legacy');
  });

  it('returns fail (not legacy) when authoredPassed is 0', () => {
    expect(resolveVariant(makeReport({ authoredPassed: 0, authoredFailed: 0 }))).toBe('fail');
  });

  it('returns pass when failed is 0 and authoredPassed > 0', () => {
    const row = { test_name: 'works', status: 'passed' as const, duration_ms: 10, authored: true };
    expect(
      resolveVariant(makeReport({ failed: 0, authoredPassed: 3, authoredFailed: 0, tests: [row] })),
    ).toBe('pass');
  });
});
