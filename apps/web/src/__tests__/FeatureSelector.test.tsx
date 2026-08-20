import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { FeatureSelector } from '../components/FeatureSelector.js';
import type { FeatureSummary } from '../hooks/useFeature.js';

function makeFeature(overrides: Partial<FeatureSummary> = {}): FeatureSummary {
  return {
    id: 'f1',
    slug: 'my-feature',
    name: 'My Feature',
    requirement: 'req',
    status: 'IMPLEMENTING',
    proposed_spec: null,
    repos: [],
    feature_path: 'FULL',
    current_branches: {},
    created_at: '2026-01-01T00:00:00.000Z',
    review_skipped: false,
    ...overrides,
  };
}

describe('FeatureSelector', () => {
  it('renders the select element', () => {
    render(
      <FeatureSelector
        features={[makeFeature()]}
        selectedId={null}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    expect(screen.getByLabelText('Select feature')).toBeInTheDocument();
  });

  it('renders when a feature IS selected (selectedId truthy)', () => {
    render(
      <FeatureSelector
        features={[makeFeature()]}
        selectedId="f1"
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    expect(screen.getByDisplayValue('My Feature [IMPLEMENTING]')).toBeInTheDocument();
  });

  it('changing selection calls onSelect with the new id', () => {
    const onSelect = vi.fn();
    render(
      <FeatureSelector
        features={[
          makeFeature({ id: 'f1', name: 'Alpha', status: 'DONE' }),
          makeFeature({ id: 'f2', name: 'Beta', status: 'IMPLEMENTING' }),
        ]}
        selectedId="f1"
        onSelect={onSelect}
        loading={false}
      />,
    );
    fireEvent.change(screen.getByLabelText('Select feature'), { target: { value: 'f2' } });
    expect(onSelect).toHaveBeenCalledWith('f2');
  });

  it('sorts features newest-first by created_at', () => {
    render(
      <FeatureSelector
        features={[
          makeFeature({ id: 'f-old', name: 'Older', created_at: '2025-06-01T00:00:00.000Z' }),
          makeFeature({ id: 'f-new', name: 'Newer', created_at: '2026-01-01T00:00:00.000Z' }),
        ]}
        selectedId={null}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    const options = screen.getAllByRole('option');
    // options[0] is the placeholder "— Select feature —"
    expect(options[1]?.textContent).toContain('Newer');
    expect(options[2]?.textContent).toContain('Older');
  });

  it('is disabled when loading=true', () => {
    render(
      <FeatureSelector
        features={[makeFeature()]}
        selectedId={null}
        onSelect={vi.fn()}
        loading={true}
      />,
    );
    expect(screen.getByLabelText('Select feature')).toBeDisabled();
  });

  it('calls onSelect(null) when the empty placeholder option is chosen', () => {
    const onSelect = vi.fn();
    render(
      <FeatureSelector
        features={[makeFeature()]}
        selectedId="f1"
        onSelect={onSelect}
        loading={false}
      />,
    );
    fireEvent.change(screen.getByLabelText('Select feature'), { target: { value: '' } });
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
