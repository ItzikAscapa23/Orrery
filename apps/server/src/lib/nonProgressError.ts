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
 * same command has been issued `threshold` times in a row. Output variation
 * is irrelevant — repeated command strings are what counts.
 */
export function checkNonProgress(
  recentHashes: string[],
  _results: Array<{ content?: unknown; is_error?: boolean }>,
  threshold: number,
  command: string,
  firstLine: string,
): NonProgressError | null {
  // Authoring turns (write/edit) are transparent to the buffer — they neither
  // add entries nor clear it. Only execution outcomes (bash, read) are tracked.
  if (command === 'write_file' || command === 'edit_file') return null;

  // Hash only the command string — not the output. Repeated invocations of the
  // same command accumulate regardless of whether the output varies turn-to-turn.
  // Distinct commands produce distinct hashes (Phase 37 invariant is preserved).
  const hash = createHash('sha256').update(command).digest('hex');

  recentHashes.push(hash);
  if (recentHashes.length > threshold) {
    recentHashes.splice(0, recentHashes.length - threshold);
  }

  if (recentHashes.length === threshold && recentHashes.every((h) => h === recentHashes[0])) {
    return new NonProgressError(command, firstLine, threshold);
  }

  return null;
}
