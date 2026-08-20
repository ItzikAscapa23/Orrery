import { describe, it, expect } from 'vitest';
import type { HealthResponse } from '../types/health.js';

describe('HealthResponse', () => {
  it('satisfies the HealthResponse shape at runtime', () => {
    const response: HealthResponse = { status: 'ok' };
    expect(response.status).toBe('ok');
  });
});
