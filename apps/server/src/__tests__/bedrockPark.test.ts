import { describe, expect, it } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

import { isEnvironmentalBedrockError } from '../lib/bedrockPark.js';

describe('isEnvironmentalBedrockError', () => {
  it('returns true for expired credentials', () => {
    expect(
      isEnvironmentalBedrockError(
        new Error('Bedrock credentials expired. Refresh with: aws sso login'),
      ),
    ).toBe(true);
  });

  it('returns true for bedrock unreachable', () => {
    expect(isEnvironmentalBedrockError(new Error('Bedrock unreachable — check VPN'))).toBe(true);
  });

  it('returns true for 503 proxy block', () => {
    const err = Object.assign(new Error('503 file blocked'), { status: 503 });
    expect(isEnvironmentalBedrockError(err)).toBe(true);
  });

  it('returns true for SDK request timeout', () => {
    expect(isEnvironmentalBedrockError(new Error('Request timed out.'))).toBe(true);
  });

  it('returns true for timeout with mixed case', () => {
    expect(isEnvironmentalBedrockError(new Error('request timed out after 900s'))).toBe(true);
  });

  it('returns false for a genuine agent error', () => {
    expect(isEnvironmentalBedrockError(new Error('SyntaxError: unexpected token'))).toBe(false);
  });

  it('returns false for a non-Error value', () => {
    expect(isEnvironmentalBedrockError('string error')).toBe(false);
    expect(isEnvironmentalBedrockError(null)).toBe(false);
    expect(isEnvironmentalBedrockError(42)).toBe(false);
  });
});
