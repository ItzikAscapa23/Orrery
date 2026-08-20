import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../components/solar/OrbitRing.js', () => ({ OrbitRing: () => null }));
vi.mock('../components/solar/Planet.js', () => ({ Planet: () => null }));
vi.mock('../components/solar/Sun.js', () => ({ Sun: () => null }));

import { SolarMesh } from '../components/solar/SolarMesh.js';

const baseProps = {
  phase: null,
  agentStatuses: {},
  selected: null,
  motionEnabled: false,
  onSelect: () => {},
};

describe('SolarMesh — watermark product name', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({ observe: vi.fn(), disconnect: vi.fn() })),
    );
  });

  afterEach(() => vi.unstubAllEnvs());

  it('watermark shows the fallback brand when VITE_PRODUCT_NAME is unset', () => {
    vi.stubEnv('VITE_PRODUCT_NAME', undefined as unknown as string);
    render(<SolarMesh {...baseProps} />);
    expect(screen.getByText(/Orrery/)).toBeInTheDocument();
  });

  it('watermark shows the configured brand when VITE_PRODUCT_NAME is set', () => {
    vi.stubEnv('VITE_PRODUCT_NAME', 'TestBrand');
    render(<SolarMesh {...baseProps} />);
    expect(screen.getByText(/TestBrand/)).toBeInTheDocument();
  });
});
