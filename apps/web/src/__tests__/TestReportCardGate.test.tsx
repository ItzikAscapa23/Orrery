import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestReportCard } from '../components/TestReportCard.js';

const testReportBase = {
  passed: 2,
  failed: 1,
  tests: [],
  authoredPassed: 0,
  authoredFailed: 0,
  skipped: false,
  skipReason: null,
  parseError: null,
  findings: [
    {
      id: 'no-authored-tests',
      severity: 'blocker' as const,
      test_name: '(no authored tests)',
      section: 'acceptance tests',
      issue: 'Test suite passed but agent wrote no new test files.',
      resolution: null,
    },
  ],
};

describe('TestReportCard — gate actions', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
    );
  });

  it('renders APPROVE and RETRY when gate is open', () => {
    render(
      <TestReportCard
        testReport={testReportBase}
        featureId="feat-123"
        gate={{ gate: 'test_report', summary: 'no authored tests', revision: 0 }}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('approve button POSTs to approve-test and fires onAction', async () => {
    const onAction = vi.fn();
    render(
      <TestReportCard
        testReport={testReportBase}
        featureId="feat-123"
        gate={{ gate: 'test_report', summary: 'no authored tests', revision: 0 }}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        '/api/features/feat-123/approve-test',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(onAction).toHaveBeenCalled();
    });
  });

  it('does not render gate buttons when no gate prop is passed', () => {
    render(<TestReportCard testReport={testReportBase} featureId="feat-123" />);

    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
