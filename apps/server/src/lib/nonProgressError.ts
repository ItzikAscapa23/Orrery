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

  // A passing test run (zero failures) is progress — agent is verifying, not stuck.
  // Clear the buffer so repeated green checks never trigger the stop.
  const resultText = results
    .map((r) =>
      typeof r.content === 'string'
        ? r.content
        : Array.isArray(r.content)
          ? (r.content as Array<{ type?: string; text?: string }>)
              .filter((b) => b?.type === 'text')
              .map((b) => b.text ?? '')
              .join('\n')
          : '',
    )
    .join('\n');
  if (/TESTS:\s*\d+\s+passed,\s*0\s+failed/.test(resultText)) {
    recentHashes.length = 0;
    return null;
  }

  // Include the command in the hash so distinct commands returning identical
  // summaries (e.g. three verification runs all reporting "97 passed, 0 failed")
  // never count as repetition of the same stuck loop.
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        command,
        results: results.map((r) => ({ content: r.content, is_error: r.is_error })),
      }),
    )
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
