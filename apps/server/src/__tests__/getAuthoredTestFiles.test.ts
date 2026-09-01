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

describe('getAuthoredTestFiles — scratch-file filter', () => {
  it('excludes debug-prefixed files (e.g. debug-clubs.test.js)', async () => {
    const debugFile = 'src/__tests__/debug-clubs.test.js';
    const realFile = 'src/__tests__/orderCardClubsListStrongId.test.js';

    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockReturnValue(`\n${debugFile}\n${realFile}\n`);

    const result = getAuthoredTestFiles('/fake/worktree', 'src/__tests__');

    expect(result).toContain(realFile);
    expect(result).not.toContain(debugFile);
  });

  it('excludes files with Debug in the name (e.g. orderCardClubsListDebug.test.js)', async () => {
    const debugFile = 'src/__tests__/orderCardClubsListDebug.test.js';
    const realFile = 'src/__tests__/orderCardClubsListStrongId.test.js';

    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockReturnValue(`\n${debugFile}\n${realFile}\n`);

    const result = getAuthoredTestFiles('/fake/worktree', 'src/__tests__');

    expect(result).toContain(realFile);
    expect(result).not.toContain(debugFile);
  });

  it('still includes a normal test file that does not contain debug or scratch', async () => {
    const realFile = 'src/__tests__/orderCardClubsListStrongId.test.js';

    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockReturnValue(`\n${realFile}\n`);

    const result = getAuthoredTestFiles('/fake/worktree', 'src/__tests__');

    expect(result).toContain(realFile);
  });
});
