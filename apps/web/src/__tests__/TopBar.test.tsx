import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TopBar } from '../components/TopBar.js';
import type { FeatureSummary } from '../hooks/useFeature.js';

const baseProps = {
  feature: null,
  phase: null,
  motionEnabled: false,
  onToggleMotion: () => {},
  corpLinkReachable: null,
  features: [] as FeatureSummary[],
  selectedId: null as string | null,
  onSelectFeature: () => {},
  featuresLoading: false,
  createFeature: vi.fn().mockRejectedValue(new Error('not implemented')),
  loadRepos: vi.fn().mockResolvedValue([]),
};

describe('TopBar — RUNNING/PARKED indicators', () => {
  it('shows RUNNING 1 and PARKED 1 when one agent is working and one is waiting', () => {
    render(
      <TopBar
        {...baseProps}
        agentStatuses={{ a: 'working', b: 'waiting' }}
      />,
    );
    expect(screen.getByText('1 RUNNING')).toBeInTheDocument();
    expect(screen.getByText('1 PARKED')).toBeInTheDocument();
    expect(screen.queryByText(/IDLE/)).not.toBeInTheDocument();
  });

  it('shows IDLE when all agents are done', () => {
    render(
      <TopBar
        {...baseProps}
        agentStatuses={{ a: 'done', b: 'done', c: 'done' }}
      />,
    );
    expect(screen.getByText('IDLE')).toBeInTheDocument();
    expect(screen.queryByText(/RUNNING/)).not.toBeInTheDocument();
    expect(screen.queryByText(/PARKED/)).not.toBeInTheDocument();
  });

  it('shows IDLE when the only agent is queued (queued = unknown, not executing)', () => {
    render(
      <TopBar
        {...baseProps}
        agentStatuses={{ a: 'queued' }}
      />,
    );
    expect(screen.getByText('IDLE')).toBeInTheDocument();
    expect(screen.queryByText(/RUNNING/)).not.toBeInTheDocument();
    expect(screen.queryByText(/PARKED/)).not.toBeInTheDocument();
  });
});

describe('TopBar — feature navigation', () => {
  it('renders FeatureSelector when a feature IS selected (always-visible requirement)', () => {
    const feature: FeatureSummary = {
      id: 'f1',
      slug: 'f-slug',
      name: 'My Feature',
      requirement: 'r',
      status: 'DONE',
      proposed_spec: null,
      repos: [],
      feature_path: 'FULL',
      current_branches: {},
      created_at: '2026-01-01T00:00:00Z',
      review_skipped: false,
    };
    render(
      <TopBar
        {...baseProps}
        agentStatuses={{}}
        features={[feature]}
        selectedId="f1"
        feature={feature}
      />,
    );
    expect(screen.getByLabelText('Select feature')).toBeInTheDocument();
  });

  it('opens CreateFeatureForm when "+ New feature" button is clicked', () => {
    render(<TopBar {...baseProps} agentStatuses={{}} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New feature/i }));
    expect(screen.getByText('New Feature')).toBeInTheDocument();
  });
});
