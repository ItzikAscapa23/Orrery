import { afterEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';
process.env['WORKTREES_ROOT'] = '/tmp/test-worktrees';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFileSync: vi.fn().mockReturnValue('') };
});

import { getAuthoredTestFiles } from '../jobs/testJob.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('getAuthoredTestFiles — trailer filter', () => {
  it('includes only files from commits stamped X-Orrery-Agent: test, not dev-agent commits', async () => {
    const testFile = 'src/__tests__/coinFlip.acceptance.test.ts';
    const devFile = 'src/__tests__/coinFlip.test.ts';

    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const gitArgs = args[1] as string[];
      if (gitArgs.includes('log') && gitArgs.some((a) => a.startsWith('--grep'))) {
        return `\n${testFile}\n`;
      }
      if (gitArgs.includes('log')) {
        return `\n${testFile}\n\n${devFile}\n`;
      }
      return '';
    });

    const result = getAuthoredTestFiles('/fake/worktree', 'src/__tests__');

    expect(result).toContain(testFile);
    expect(result).not.toContain(devFile);
  });
});
