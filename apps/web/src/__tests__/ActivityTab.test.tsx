import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { ActivityTab } from '../components/ActivityTab.js';
import type { EventRow } from '@orrery/shared';

function makeRow(seq: number, payload: EventRow['payload']): EventRow {
  return {
    id: seq,
    featureId: 'f1',
    seq,
    agent: null,
    payload,
    createdAt: new Date().toISOString(),
  };
}

// Minimal completed task with one job — completed job should collapse by default.
const TASKS = [
  {
    id: 't1',
    title: 'Add endpoint',
    repo: 'server',
    side: 'server',
    status: 'completed',
    turns: 1,
    jobCount: 1,
    blockedBy: [],
    coveredByTestPlan: false,
    testsWritten: false,
    testTaskAttempts: 0,
    spendGuardThreshold: 150,
  },
];

// Events: one completed task, one job, one turn line.
const EVENTS: EventRow[] = [
  makeRow(1, { type: 'task.started', repo: 'server', task_id: 't1', attempt: 1 }),
  makeRow(2, {
    type: 'usage.recorded',
    agent: 'server',
    model: 'm',
    input_tokens: 10,
    output_tokens: 5,
    job_id: 'job-1',
    task_id: 't1',
  }),
  makeRow(3, {
    type: 'agent.log',
    agent: 'server',
    severity: 'muted',
    text: '◦ turn 1 · bash ls (10 chars)',
  }),
  makeRow(4, { type: 'task.completed', repo: 'server', task_id: 't1' }),
];

describe('ActivityTab — feature-level sections', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders feature-level spec section', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }),
    );
    const specEvents: EventRow[] = [
      makeRow(1, {
        type: 'usage.recorded',
        agent: 'spec',
        model: 'claude-sonnet-4-20250514',
        input_tokens: 100,
        output_tokens: 50,
      }),
      makeRow(2, {
        type: 'agent.log',
        agent: 'spec',
        severity: 'muted',
        text: '◦ turn 1 · bash ls (5 chars)',
      }),
    ];
    render(
      <ActivityTab featureId="f1" events={specEvents} agentLogEventCount={1} taskEventCount={0} />,
    );
    await waitFor(() => expect(screen.getByText('Spec')).toBeInTheDocument());
  });

  it('renders final test agent section', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }),
    );
    const testEvents: EventRow[] = [
      makeRow(1, {
        type: 'usage.recorded',
        agent: 'test',
        model: 'm',
        input_tokens: 100,
        output_tokens: 50,
      }),
      makeRow(2, {
        type: 'agent.log',
        agent: 'test',
        severity: 'muted',
        text: '◦ turn 1 · bash npm test (20 chars)',
      }),
    ];
    render(
      <ActivityTab featureId="f1" events={testEvents} agentLogEventCount={1} taskEventCount={0} />,
    );
    await waitFor(() => expect(screen.getByText('Testing')).toBeInTheDocument());
  });

  it('TaskTable renders at top of ActivityTab', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(TASKS) }),
    );
    render(
      <ActivityTab featureId="f1" events={EVENTS} agentLogEventCount={1} taskEventCount={1} />,
    );
    await waitFor(() => {
      expect(document.querySelector('table')).toBeInTheDocument();
    });
  });

  it('clicking TaskTable row scrolls to task group', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(TASKS) }),
    );
    const scrollIntoViewMock = vi.fn();
    // jsdom does not implement scrollIntoView — install it directly.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: scrollIntoViewMock,
      writable: true,
      configurable: true,
    });
    render(
      <ActivityTab featureId="f1" events={EVENTS} agentLogEventCount={1} taskEventCount={1} />,
    );
    // Wait for the TaskTable to render its data row
    await waitFor(() => expect(document.querySelector('table')).toBeInTheDocument());
    const table = document.querySelector('table')!;
    const row = within(table).getByText('Add endpoint').closest('tr');
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });
});

describe('ActivityTab — collapse/expand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completed jobs are collapsed by default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(TASKS) }),
    );
    render(
      <ActivityTab featureId="f1" events={EVENTS} agentLogEventCount={1} taskEventCount={1} />,
    );
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /job 1/i });
      expect(btn).toHaveAttribute('aria-expanded', 'false');
    });
  });

  it('clicking a collapsed job header expands it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(TASKS) }),
    );
    render(
      <ActivityTab featureId="f1" events={EVENTS} agentLogEventCount={1} taskEventCount={1} />,
    );
    await waitFor(() => screen.getByRole('button', { name: /job 1/i }));
    fireEvent.click(screen.getByRole('button', { name: /job 1/i }));
    expect(screen.getByRole('button', { name: /job 1/i })).toHaveAttribute('aria-expanded', 'true');
  });
});
