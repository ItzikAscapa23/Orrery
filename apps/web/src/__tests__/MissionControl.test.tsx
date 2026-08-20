import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MissionControl } from '../components/MissionControl.js';

// AttachmentList makes a fetch call; keep the test self-contained
vi.mock('../components/AttachmentList.js', () => ({
  AttachmentList: () => null,
}));

const baseProps = {
  featureId: 'f1',
  chatEntries: [],
  gateOpen: null,
  planGateOpen: null,
  testPlanGateOpen: null,
  taskAcceptanceGateOpen: null,
  amendmentGateOpen: null,
  spendGates: [],
  findings: [],
  prLinks: [],
  testReport: null,
  sseError: null,
  usageEventCount: 0,
  onGateAction: vi.fn(),
};

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

describe('MissionControl — test_report gate card', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  it('shows summary chip and VIEW button when test report exists; no APPROVE/RETRY inline', () => {
    render(
      <MissionControl
        {...baseProps}
        testReport={testReportBase}
        gateOpen={{ gate: 'test_report', summary: 'no authored tests', revision: 0 }}
      />,
    );

    // Summary chip is present
    expect(screen.getByText(/TEST REPORT/i)).toBeInTheDocument();
    // Gate actions are NOT in the chat pane — they live on the tab
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request changes/i })).not.toBeInTheDocument();
  });

  it('does not show "Spec revision" header copy on a test_report gate', () => {
    render(
      <MissionControl
        {...baseProps}
        testReport={testReportBase}
        gateOpen={{ gate: 'test_report', summary: 'no authored tests', revision: 0 }}
      />,
    );

    expect(screen.queryByText(/spec revision/i)).not.toBeInTheDocument();
  });

  it('VIEW button calls onViewTestReport when provided', () => {
    const onViewTestReport = vi.fn();
    render(
      <MissionControl
        {...baseProps}
        testReport={testReportBase}
        onViewTestReport={onViewTestReport}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /→ VIEW/i }));
    expect(onViewTestReport).toHaveBeenCalledTimes(1);
  });
});

describe('MissionControl — attachment kind selector', () => {
  it('does not show kind selector before attach button is clicked', () => {
    render(<MissionControl {...baseProps} />);

    expect(screen.queryByText(/Requirements \/ context/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/External contract/i)).not.toBeInTheDocument();
  });

  it('shows both kind options after clicking the attach button', () => {
    render(<MissionControl {...baseProps} />);

    fireEvent.click(screen.getByLabelText('Attach file'));

    expect(screen.getByText(/Requirements \/ context/i)).toBeInTheDocument();
    expect(screen.getByText(/External contract/i)).toBeInTheDocument();
  });

  it('neither kind option is pre-selected', () => {
    render(<MissionControl {...baseProps} />);

    fireEvent.click(screen.getByLabelText('Attach file'));

    const buttons = screen.getAllByRole('button', {
      name: /Requirements \/ context|External contract/i,
    });
    expect(buttons).toHaveLength(2);
    buttons.forEach((btn) => {
      expect(btn).not.toHaveAttribute('aria-pressed', 'true');
      expect(btn).not.toHaveClass('selected');
      expect(btn).not.toHaveClass('active');
    });
  });
});
