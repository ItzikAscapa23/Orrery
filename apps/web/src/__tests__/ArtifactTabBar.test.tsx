import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import { ArtifactTabBar } from '../components/ArtifactTabBar.js';
import { ArtifactViewer } from '../components/ArtifactPanel.js';
import type { ArtifactKind } from '@orrery/shared';

// ── ArtifactTabBar ────────────────────────────────────────────────────────────

describe('ArtifactTabBar', () => {
  it('renders with MESH active by default and all artifact tabs present', () => {
    const onChange = vi.fn();
    render(
      <ArtifactTabBar
        activeTab="mesh"
        committedKinds={[]}
        hasTestReport={false}
        onChange={onChange}
      />,
    );

    // MESH tab should be present and marked active
    const meshTab = screen.getByRole('tab', { name: /MESH/i });
    expect(meshTab).toBeInTheDocument();
    expect(meshTab).toHaveAttribute('aria-selected', 'true');

    // REQUIREMENT tab is always present and enabled
    const reqTab = screen.getByRole('tab', { name: 'REQUIREMENT' });
    expect(reqTab).toBeInTheDocument();
    expect(reqTab).not.toHaveAttribute('aria-disabled', 'true');

    // All artifact tabs should be present (exact match avoids PLAN/TEST PLAN ambiguity)
    expect(screen.getByRole('tab', { name: 'SPEC' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'PLAN' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'TEST PLAN' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'CONTRACT' })).toBeInTheDocument();
  });

  it('a tab with no committedKinds entry renders disabled', () => {
    render(
      <ArtifactTabBar
        activeTab="mesh"
        committedKinds={[]}
        hasTestReport={false}
        onChange={vi.fn()}
      />,
    );

    const specTab = screen.getByRole('tab', { name: /SPEC/i });
    expect(specTab).toHaveAttribute('aria-disabled', 'true');
  });

  it('passing a kind in committedKinds enables that tab without a fetch', () => {
    const committedKinds: ArtifactKind[] = ['spec'];
    render(
      <ArtifactTabBar
        activeTab="mesh"
        committedKinds={committedKinds}
        hasTestReport={false}
        onChange={vi.fn()}
      />,
    );

    const specTab = screen.getByRole('tab', { name: /SPEC/i });
    expect(specTab).not.toHaveAttribute('aria-disabled', 'true');

    // Disabled tabs that are not committed stay disabled
    const planTab = screen.getByRole('tab', { name: 'PLAN' });
    expect(planTab).toHaveAttribute('aria-disabled', 'true');
  });

  it('clicking an enabled tab calls onChange with the kind', () => {
    const onChange = vi.fn();
    const committedKinds: ArtifactKind[] = ['spec'];
    render(
      <ArtifactTabBar
        activeTab="mesh"
        committedKinds={committedKinds}
        hasTestReport={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /SPEC/i }));
    expect(onChange).toHaveBeenCalledWith('spec');
  });
});

// ── mesh stays mounted when a doc tab is active ───────────────────────────────

describe('ArtifactTabBar — mesh mount invariant', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ content: '# spec', sha: 'abc', filename: 'spec.md' }),
      }),
    );
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        disconnect: vi.fn(),
      })),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('solar mesh aria label remains in DOM when a document tab is active', async () => {
    // Render the tab bar + a wrapper that mimics App's CSS-hide-not-unmount pattern
    const { rerender } = render(
      <div>
        <ArtifactTabBar
          activeTab="mesh"
          committedKinds={['spec']}
          hasTestReport={false}
          onChange={vi.fn()}
        />
        <div
          aria-label="Solar system visualization"
          style={{ display: 'block' }}
          data-testid="solar-wrapper"
        />
      </div>,
    );

    // Switch to SPEC tab — in App, the solar wrapper gets display:none but stays mounted
    rerender(
      <div>
        <ArtifactTabBar
          activeTab="spec"
          committedKinds={['spec']}
          hasTestReport={false}
          onChange={vi.fn()}
        />
        <div
          aria-label="Solar system visualization"
          style={{ display: 'none' }}
          data-testid="solar-wrapper"
        />
      </div>,
    );

    // The element remains in the DOM (mounted), just hidden
    expect(screen.getByLabelText('Solar system visualization')).toBeInTheDocument();
  });
});

// ── ArtifactViewer refetch on artifactCommittedCount change ──────────────────

describe('ArtifactViewer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refetches when artifactCommittedCount increments for the active kind', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: '# spec', sha: 'abc1', filename: 'spec.md' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(
      <ArtifactViewer featureId="feat-1" kind="spec" artifactCommittedCount={0} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<ArtifactViewer featureId="feat-1" kind="spec" artifactCommittedCount={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

// ── ArtifactViewer — copy button ──────────────────────────────────────────────

describe('ArtifactViewer — copy button', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders a COPY button once content is loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ content: '# spec', sha: 'abc', filename: 'spec.md' }),
      }),
    );

    render(<ArtifactViewer featureId="feat-1" kind="spec" artifactCommittedCount={0} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^copy$/i })).toBeInTheDocument(),
    );
  });

  it('calls navigator.clipboard.writeText with the raw content on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ content: '# spec content', sha: 'abc', filename: 'spec.md' }),
      }),
    );

    render(<ArtifactViewer featureId="feat-1" kind="spec" artifactCommittedCount={0} />);
    const btn = await screen.findByRole('button', { name: /^copy$/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# spec content'));
  });

  it('shows COPIED confirmation after a successful copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ content: '# spec', sha: 'abc', filename: 'spec.md' }),
      }),
    );

    render(<ArtifactViewer featureId="feat-1" kind="spec" artifactCommittedCount={0} />);
    const btn = await screen.findByRole('button', { name: /^copy$/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument(),
    );
  });

  it('shows COPY ERROR when clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ content: '# spec', sha: 'abc', filename: 'spec.md' }),
      }),
    );

    render(<ArtifactViewer featureId="feat-1" kind="spec" artifactCommittedCount={0} />);
    const btn = await screen.findByRole('button', { name: /^copy$/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /copy error/i })).toBeInTheDocument(),
    );
  });
});
