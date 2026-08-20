import type { FeatureSummary } from '../hooks/useFeature.js';

interface FeatureSelectorProps {
  features: FeatureSummary[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  loading: boolean;
}

export function FeatureSelector({ features, selectedId, onSelect, loading }: FeatureSelectorProps) {
  const sorted = [...features].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return (
    <select
      value={selectedId ?? ''}
      onChange={(e) => onSelect(e.target.value || null)}
      disabled={loading}
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid var(--border-medium)',
        borderRadius: 'var(--r-btn)',
        padding: '5px 10px',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        cursor: 'pointer',
        maxWidth: 200,
      }}
      aria-label="Select feature"
    >
      <option value="">— Select feature —</option>
      {sorted.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name} [{f.status}]
        </option>
      ))}
    </select>
  );
}
