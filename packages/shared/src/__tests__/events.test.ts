import { describe, expect, it } from 'vitest';
import { TestReportPayloadSchema } from '../types/events.js';

const historicalPayload = {
  type: 'test.report',
  agent: 'test',
  spec_rev: 1,
  passed: 70,
  failed: 0,
  findings: [],
};

describe('TestReportPayloadSchema — wall_time_ms', () => {
  it('parses a historical payload (no wall_time_ms field) without error', () => {
    expect(() => TestReportPayloadSchema.parse(historicalPayload)).not.toThrow();
    const result = TestReportPayloadSchema.parse(historicalPayload);
    expect(result.wall_time_ms).toBeUndefined();
  });

  it('surfaces wall_time_ms when present in the payload', () => {
    const result = TestReportPayloadSchema.parse({
      ...historicalPayload,
      wall_time_ms: 12345,
    });
    expect(result.wall_time_ms).toBe(12345);
  });

  it('rejects a negative wall_time_ms', () => {
    expect(() =>
      TestReportPayloadSchema.parse({ ...historicalPayload, wall_time_ms: -1 }),
    ).toThrow();
  });
});
