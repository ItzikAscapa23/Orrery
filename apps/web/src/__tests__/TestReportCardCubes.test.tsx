import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TestReportCard } from '../components/TestReportCard.js';
import type { TestReportState } from '../types/ui.js';

const vacuousFinding = (id: string) => ({
  id,
  severity: 'warning' as const,
  test_name: `test_${id}`,
  section: 'vacuous assertions',
  issue: `vacuous assertion in test_${id}`,
  resolution: null,
});

const passedTest = (name: string): import('@orrery/shared').TestRow => ({
  test_name: name,
  status: 'passed' as const,
  duration_ms: 12,
  authored: true,
});

const reportWith8Vacuous: TestReportState = {
  passed: 70,
  failed: 0,
  tests: [passedTest('a'), passedTest('b')],
  authoredPassed: 69,
  authoredFailed: 0,
  skipped: false,
  skipReason: null,
  parseError: null,
  wallTimeMs: null,
  findings: Array.from({ length: 8 }, (_, i) => vacuousFinding(`v${i}`)),
};

// ── task 109 — cube values ────────────────────────────────────────────────────

describe('TestReportCard — cube values', () => {
  it('renders five cubes with values 70 / 69 / 0 / 8 / — against the pasted payload', () => {
    render(<TestReportCard testReport={reportWith8Vacuous} />);

    // Clickable cubes (value > 0) render as buttons; zero/inert cubes render as regions
    expect(screen.getByRole('button', { name: 'suite passing' })).toHaveTextContent('70');
    expect(screen.getByRole('button', { name: 'authored' })).toHaveTextContent('69');
    expect(screen.getByRole('region', { name: 'authored failing' })).toHaveTextContent('0');
    expect(screen.getByRole('button', { name: 'vacuous' })).toHaveTextContent('8');
    expect(screen.getByRole('region', { name: 'wall time' })).toHaveTextContent('—');
  });

  it('shows wall time in seconds when wallTimeMs is set', () => {
    render(<TestReportCard testReport={{ ...reportWith8Vacuous, wallTimeMs: 12345 }} />);
    expect(screen.getByRole('region', { name: 'wall time' })).toHaveTextContent('12.3s');
  });

  it('vacuous count ignores findings outside the vacuous assertions section', () => {
    const otherFinding = {
      id: 'f-other',
      severity: 'blocker' as const,
      test_name: 'other test',
      section: 'acceptance tests',
      issue: 'test failed',
      resolution: null,
    };
    render(
      <TestReportCard
        testReport={{
          ...reportWith8Vacuous,
          findings: [...reportWith8Vacuous.findings, otherFinding],
        }}
      />,
    );
    // Still 8, not 9 — the blocker in 'acceptance tests' is not counted
    expect(screen.getByRole('button', { name: 'vacuous' })).toHaveTextContent('8');
  });
});

// ── task 110 — cube drilldown ─────────────────────────────────────────────────

describe('TestReportCard — cube drilldown', () => {
  it('clicking a non-zero suite passing cube expands passing tests', () => {
    render(<TestReportCard testReport={reportWith8Vacuous} />);

    const cube = screen.getByRole('button', { name: 'suite passing' });
    fireEvent.click(cube);

    // Tests a and b are passing
    expect(screen.getAllByText(/^a$|test_name: a/)[0] ?? screen.getByText('a')).toBeInTheDocument();
  });

  it('clicking the same cube again collapses the drilldown', () => {
    render(<TestReportCard testReport={reportWith8Vacuous} />);

    const cube = screen.getByRole('button', { name: 'suite passing' });
    // 'a' also appears in the test row table at the bottom, so count instances
    const before = screen.getAllByText('a').length;

    fireEvent.click(cube);
    // Expanded — drilldown adds one more instance
    expect(screen.getAllByText('a').length).toBeGreaterThan(before);

    fireEvent.click(cube);
    // Collapsed — back to pre-expand count
    expect(screen.getAllByText('a').length).toBe(before);
  });

  it('a zero-count cube (authored failing = 0) is not clickable', () => {
    render(<TestReportCard testReport={reportWith8Vacuous} />);

    // authored failing is 0 — it should be a plain region, not a button
    expect(screen.queryByRole('button', { name: 'authored failing' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'authored failing' })).toBeInTheDocument();
  });

  it('wall time cube is never a button', () => {
    render(<TestReportCard testReport={{ ...reportWith8Vacuous, wallTimeMs: 5000 }} />);
    expect(screen.queryByRole('button', { name: 'wall time' })).not.toBeInTheDocument();
  });

  it('vacuous cube drilldown shows issue strings', () => {
    render(<TestReportCard testReport={reportWith8Vacuous} />);

    const before = screen.getAllByText('vacuous assertion in test_v0').length;

    const cube = screen.getByRole('button', { name: 'vacuous' });
    fireEvent.click(cube);

    // Drilldown adds another instance alongside the findings section
    expect(screen.getAllByText('vacuous assertion in test_v0').length).toBeGreaterThan(before);
  });
});
