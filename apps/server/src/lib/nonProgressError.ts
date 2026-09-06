import { createHash } from 'node:crypto';

export class NonProgressError extends Error {
  readonly command: string;
  readonly firstLine: string;

  constructor(command: string, firstLine: string, threshold: number) {
    super(
      `Non-progress stop: '${command}' returned the same result ${threshold} times. First line: ${firstLine}`,
    );
    this.name = 'NonProgressError';
    this.command = command;
    this.firstLine = firstLine;
  }
}

/**
 * Update the non-progress ring buffer and return a NonProgressError if the
 * threshold of consecutive identical tool results has been reached.
 *
 * @param recentHashes - mutable ring buffer (mutated in place)
 * @param results - tool result content/is_error pairs for the current turn
 * @param hadWriteOrEdit - true if any write_file or edit_file call was in this turn
 * @param threshold - number of consecutive identical results that trigger a stop
 * @param command - tool name to embed in the error (for diagnostics)
 * @param firstLine - first line of the last result to embed in the error
 */
export function checkNonProgress(
  recentHashes: string[],
  results: Array<{ content?: unknown; is_error?: boolean }>,
  hadWriteOrEdit: boolean,
  threshold: number,
  command: string,
  firstLine: string,
): NonProgressError | null {
  if (hadWriteOrEdit) {
    recentHashes.length = 0;
    return null;
  }

  const hash = createHash('sha256')
    .update(JSON.stringify(results.map((r) => ({ content: r.content, is_error: r.is_error }))))
    .digest('hex');

  recentHashes.push(hash);
  if (recentHashes.length > threshold) {
    recentHashes.splice(0, recentHashes.length - threshold);
  }

  if (recentHashes.length === threshold && recentHashes.every((h) => h === recentHashes[0])) {
    return new NonProgressError(command, firstLine, threshold);
  }

  return null;
}
