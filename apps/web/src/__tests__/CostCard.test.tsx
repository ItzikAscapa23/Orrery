import { render, screen, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { CostCard } from '../components/CostCard.js';

const mockCostResult = {
  total_usd: 0.012345,
  priced_events: 5,
  partial_events: 0,
  unpriceable_events: 0,
  rate_unknown_events: 0,
  tagged_simulated_events: 0,
  by_agent: [],
};

function makeFetch(result = mockCostResult) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(result),
  });
}

describe('CostCard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('refetches when usageEventCount changes', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<CostCard featureId="feat-1" usageEventCount={0} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<CostCard featureId="feat-1" usageEventCount={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('does not refetch when unrelated re-render leaves usageEventCount unchanged', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<CostCard featureId="feat-1" usageEventCount={2} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<CostCard featureId="feat-1" usageEventCount={2} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders timestamp and updates it on successful refetch', async () => {
    vi.setSystemTime(new Date('2026-01-01T14:30:00'));

    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<CostCard featureId="feat-1" usageEventCount={0} />);

    await waitFor(() => expect(screen.getByText(/as of/i)).toBeInTheDocument());

    vi.setSystemTime(new Date('2026-01-01T14:35:00'));
    await act(async () => {
      rerender(<CostCard featureId="feat-1" usageEventCount={1} />);
    });

    // Locale may render 12h ("2:35 PM") or 24h ("14:35") — assert on minutes only
    await waitFor(() => expect(screen.getByText(/:35/)).toBeInTheDocument());
  });
});
