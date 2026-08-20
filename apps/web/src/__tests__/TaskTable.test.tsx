import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { TaskTable, type TaskRow } from '../components/TaskTable.js';

const baseRow: TaskRow = {
  id: 'task-1',
  title: 'Add auth endpoints',
  repo: 'server',
  side: 'server',
  status: 'pending',
  turns: null,
  jobCount: null,
  blockedBy: [],
  coveredByTestPlan: false,
  testsWritten: false,
  testTaskAttempts: 0,
  spendGuardThreshold: 150,
};

function makeFetch(rows: TaskRow[] = [baseRow]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(rows),
  });
}

describe('TaskTable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing while loading', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    const { container } = render(<TaskTable featureId="f1" taskEventCount={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for an empty task list', async () => {
    vi.stubGlobal('fetch', makeFetch([]));
    const { container } = render(<TaskTable featureId="f1" taskEventCount={0} />);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('renders task titles', async () => {
    vi.stubGlobal('fetch', makeFetch());
    render(<TaskTable featureId="f1" taskEventCount={0} />);
    await waitFor(() => expect(screen.getByText('Add auth endpoints')).toBeInTheDocument());
  });

  it('shows "—" for turns when null', async () => {
    vi.stubGlobal('fetch', makeFetch());
    render(<TaskTable featureId="f1" taskEventCount={0} />);
    await waitFor(() => expect(screen.getByText('—')).toBeInTheDocument());
  });

  it('formats turns with job count: "24 (3 jobs)"', async () => {
    vi.stubGlobal('fetch', makeFetch([{ ...baseRow, turns: 24, jobCount: 3 }]));
    render(<TaskTable featureId="f1" taskEventCount={0} />);
    await waitFor(() => expect(screen.getByText('24 (3 jobs)')).toBeInTheDocument());
  });

  it('formats turns without job count when only 1 job', async () => {
    vi.stubGlobal('fetch', makeFetch([{ ...baseRow, turns: 10, jobCount: 1 }]));
    render(<TaskTable featureId="f1" taskEventCount={0} />);
    await waitFor(() => expect(screen.getByText('10')).toBeInTheDocument());
  });

  it('shows blocked-by titles in orange', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([{ ...baseRow, status: 'pending', blockedBy: ['Build login UI'] }]),
    );
    render(<TaskTable featureId="f1" taskEventCount={0} />);
    await waitFor(() => expect(screen.getByText('Build login UI')).toBeInTheDocument());
  });

  it('shows TDD ✓ tests when testsWritten', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([{ ...baseRow, coveredByTestPlan: true, testsWritten: true }]),
    );
    render(<TaskTable featureId="f1" taskEventCount={0} />);
    await waitFor(() => expect(screen.getByText('✓ tests')).toBeInTheDocument());
  });

  it('shows TDD ⏳ with attempt count when test task ran but no tests written', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([{ ...baseRow, coveredByTestPlan: true, testsWritten: false, testTaskAttempts: 2 }]),
    );
    render(<TaskTable featureId="f1" taskEventCount={0} />);
    await waitFor(() => expect(screen.getByText('⏳ 2')).toBeInTheDocument());
  });

  it('shows TDD ○ when covered but no test task has run', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([{ ...baseRow, coveredByTestPlan: true, testsWritten: false, testTaskAttempts: 0 }]),
    );
    render(<TaskTable featureId="f1" taskEventCount={0} />);
    await waitFor(() => expect(screen.getByText('○')).toBeInTheDocument());
  });

  it('refetches when taskEventCount increments', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<TaskTable featureId="f1" taskEventCount={0} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<TaskTable featureId="f1" taskEventCount={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('calls onRowClick with taskId when row clicked', async () => {
    const onRowClick = vi.fn();
    vi.stubGlobal('fetch', makeFetch());
    render(<TaskTable featureId="f1" taskEventCount={0} onRowClick={onRowClick} />);
    await waitFor(() => screen.getByText('Add auth endpoints'));
    fireEvent.click(screen.getByText('Add auth endpoints').closest('tr')!);
    expect(onRowClick).toHaveBeenCalledWith('task-1');
  });

  it('does not refetch when taskEventCount is unchanged', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<TaskTable featureId="f1" taskEventCount={5} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<TaskTable featureId="f1" taskEventCount={5} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
