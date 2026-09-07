import { createHash } from 'node:crypto';

export class NonProgressError extends Error {
  readonly command: string;
  readonly firstLine: string;

  constructor(command: string, firstLine: string, threshold: number) {
    super(
      `Non-progress stop: '${command}' was issued ${threshold} times in a row. First line: ${firstLine}`,
    );
    this.name = 'NonProgressError';
    this.command = command;
    this.firstLine = firstLine;
  }
}

/**
 * Update the non-progress ring buffer and throw a NonProgressError if the
 * same bash command has been issued `threshold` times in a row.
 *
 * Only bash tool invocations are counted — reads, file listings and writes
 * are orientation or authoring, not churn. The hash covers the full command
 * string including arguments so `jest --a` and `jest --b` are distinct.
 */
export function checkNonProgress(
  recentHashes: string[],
  _results: Array<{ content?: unknown; is_error?: boolean }>,
  threshold: number,
  toolName: string,
  fullCommand: string,
  firstLine: string,
): NonProgressError | null {
  // Only bash commands contribute to the loop guard.
  if (toolName !== 'bash') return null;

  // Hash the full bash command — arguments included. Distinct commands (even
  // with identical output) produce distinct hashes (Phase 37 invariant).
  const hash = createHash('sha256').update(fullCommand).digest('hex');

  recentHashes.push(hash);
  if (recentHashes.length > threshold) {
    recentHashes.splice(0, recentHashes.length - threshold);
  }

  if (recentHashes.length === threshold && recentHashes.every((h) => h === recentHashes[0])) {
    return new NonProgressError(fullCommand, firstLine, threshold);
  }

  return null;
}
