import { render, screen } from '@testing-library/react';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { App } from '../App.js';

// Stub fetch so useFeature doesn't fail in jsdom
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    }),
  );
  vi.stubGlobal(
    'EventSource',
    vi.fn().mockImplementation(() => ({ close: vi.fn() })),
  );
  vi.stubGlobal(
    'ResizeObserver',
    vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      disconnect: vi.fn(),
    })),
  );
});

afterEach(() => vi.unstubAllEnvs());

describe('App', () => {
  it('renders the app shell without crashing', () => {
    vi.stubEnv('VITE_PRODUCT_NAME', 'TestBrand');
    render(<App />);
    expect(screen.getByText('TestBrand')).toBeInTheDocument();
  });

  it('renders the solar mesh center pane', () => {
    render(<App />);
    expect(screen.getByLabelText('Solar system visualization')).toBeInTheDocument();
  });

  it('renders the inspector panel defaulting to Orchestrator', () => {
    render(<App />);
    expect(screen.getByText('SOL · ORCHESTRATOR')).toBeInTheDocument();
  });

  it('renders the mission control panel', () => {
    render(<App />);
    expect(screen.getByText(/MISSION CONTROL/i)).toBeInTheDocument();
  });
});
