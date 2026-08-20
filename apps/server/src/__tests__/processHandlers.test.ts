import { afterEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

import { onUnhandledRejection, onUncaughtException } from '../lib/processHandlers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function parseLogs(consoleSpy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return consoleSpy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(c[0] as string) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((v): v is Record<string, unknown> => v !== null);
}

describe('onUnhandledRejection', () => {
  it('logs event=unhandled_rejection and does NOT call process.exit', () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as typeof process.exit);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    onUnhandledRejection(new Error('P2028: transaction timed out'));

    expect(exitSpy).not.toHaveBeenCalled();
    const logs = parseLogs(consoleSpy);
    expect(logs.some((e) => e['event'] === 'unhandled_rejection')).toBe(true);
  });

  it('includes the error message in the log', () => {
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    onUnhandledRejection(new Error('P2028: some tx error'));

    const logs = parseLogs(consoleSpy);
    const entry = logs.find((e) => e['event'] === 'unhandled_rejection');
    expect(entry?.['error']).toContain('P2028');
  });

  it('handles non-Error reason without throwing', () => {
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    onUnhandledRejection('plain string reason');

    const logs = parseLogs(consoleSpy);
    expect(logs.some((e) => e['event'] === 'unhandled_rejection')).toBe(true);
  });
});

describe('onUncaughtException', () => {
  it('logs event=uncaught_exception and does NOT call process.exit', () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as typeof process.exit);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    onUncaughtException(new Error('something exploded'), 'uncaughtException');

    expect(exitSpy).not.toHaveBeenCalled();
    const logs = parseLogs(consoleSpy);
    expect(logs.some((e) => e['event'] === 'uncaught_exception')).toBe(true);
  });

  it('includes the origin in the log', () => {
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    onUncaughtException(new Error('boom'), 'uncaughtException');

    const logs = parseLogs(consoleSpy);
    const entry = logs.find((e) => e['event'] === 'uncaught_exception');
    expect(entry?.['origin']).toBe('uncaughtException');
  });
});
