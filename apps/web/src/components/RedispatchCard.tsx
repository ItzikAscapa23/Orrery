import { useState } from 'react';

interface RedispatchCardProps {
  featureId: string;
  onAction: () => void;
}

export function RedispatchCard({ featureId, onAction }: RedispatchCardProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRedispatch() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/features/${featureId}/redispatch`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Redispatch failed: ${res.status}`);
      }
      onAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        border: '1px solid rgba(251,146,60,0.35)',
        background: 'rgba(251,146,60,0.07)',
        borderRadius: 'var(--r-card)',
        padding: 13,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <div
          className="status-dot"
          style={{ background: '#fb923c', boxShadow: '0 0 5px #fb923c' }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            fontSize: 9,
            color: '#fb923c',
            letterSpacing: '0.13em',
            textTransform: 'uppercase',
          }}
        >
          Tasks Parked or Stuck
        </span>
      </div>

      <div
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 12,
          color: '#d9dcec',
          marginBottom: 12,
          lineHeight: 1.45,
        }}
      >
        One or more tasks are parked or stuck running. Redispatch to release them and retry with a
        fresh attempt budget.
      </div>

      {error !== null && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: '#ff5b45',
            marginBottom: 8,
          }}
        >
          {error}
        </div>
      )}

      <button
        onClick={() => void handleRedispatch()}
        disabled={loading}
        style={{
          width: '100%',
          padding: 9,
          borderRadius: 'var(--r-btn)',
          background: '#7eb8f7',
          color: '#1a1c2e',
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          fontSize: 10,
          boxShadow: '0 0 14px rgba(126,184,247,0.3)',
          opacity: loading ? 0.6 : 1,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          cursor: loading ? 'not-allowed' : 'pointer',
          border: 'none',
        }}
      >
        {loading ? '…' : 'Redispatch'}
      </button>
    </div>
  );
}
