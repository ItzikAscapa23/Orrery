import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { Inspector } from '../components/Inspector.js';
import type { TaskFailureEntry } from '../types/ui.js';

vi.mock('../components/EventLog.js', () => ({ EventLog: () => null }));
vi.mock('../components/CostCard.js', () => ({ CostCard: () => null }));
vi.mock('../components/StateMachineChips.js', () => ({ StateMachineChips: () => null }));

const LONG_REASON =
  'toolchain probe failed (exit 1): ' + 'PASS test/foo.test.js '.repeat(40);

const baseProps = {
  selected: null as null,
  phase: 'IMPLEMENTING' as const,
  agentStatuses: {},
  eventLogsByAgent: {},
  featureId: 'feat-1',
  usageEventCount: 0,
};

function makeFailure(reason = LONG_REASON): TaskFailureEntry[] {
  return [
    {
      isSeparator: false,
      taskId: 'abc12345def',
      reason,
      attempt: 1,
      final: false,
      orphaned: false,
      ts: new Date().toISOString(),
    },
  ];
}

describe('Inspector — task failures panel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a long failure does not escape the container (overflow hidden, min-width 0)', () => {
    render(<Inspector {...baseProps} taskFailures={makeFailure()} />);
    const list = screen.getByTestId('failure-list');
    expect(list.style.overflow).toBe('hidden');
    expect(list.style.minWidth).toBe('0');
  });

  it('collapsed entry shows ellipsis styles; clicking expands to full wrap', () => {
    render(<Inspector {...baseProps} taskFailures={makeFailure()} />);
    const entry = screen.getByTestId('failure-entry');

    // Collapsed: truncation styles present
    expect(entry.style.overflow).toBe('hidden');
    expect(entry.style.textOverflow).toBe('ellipsis');
    expect(entry.style.whiteSpace).toBe('nowrap');

    // Expand
    fireEvent.click(entry);
    expect(entry.style.overflow).toBe('');
    expect(entry.style.whiteSpace).toBe('pre-wrap');

    // Collapse again
    fireEvent.click(entry);
    expect(entry.style.overflow).toBe('hidden');
  });

  it('timestamp and reason prefix are present in the collapsed entry text', () => {
    render(<Inspector {...baseProps} taskFailures={makeFailure()} />);
    const entry = screen.getByTestId('failure-entry');
    // Timestamp span is the first child; toLocaleTimeString always contains ':'
    const timestampSpan = entry.querySelector('span');
    expect(timestampSpan?.textContent).toMatch(/:/);
    // Task id prefix (first 8 chars) and reason beginning are in the rendered text
    expect(entry.textContent).toMatch(/abc12345/);
    expect(entry.textContent).toMatch(/toolchain probe failed/);
  });
});
