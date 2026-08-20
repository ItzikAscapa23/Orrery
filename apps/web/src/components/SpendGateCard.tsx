import { useState } from 'react';
import type { SpendGateState } from '../types/ui.js';

interface SpendGateCardProps {
  featureId: string;
  gate: SpendGateState;
  onAction: () => void;
}

export function SpendGateCard({ featureId, gate, onAction }: SpendGateCardProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResume() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/features/${featureId}/tasks/${gate.taskId}/resume-spend-gate`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Resume failed: ${res.status}`);
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
        border: '1px solid rgba(255,178,77,0.4)',
        background: 'rgba(255,178,77,0.07)',
        borderRadius: 'var(--r-card)',
        padding: 13,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <div
          className="status-dot"
          style={{
            background: '#ffb24d',
            boxShadow: '0 0 5px #ffb24d',
            animation: 'blink 1.1s ease-in-out infinite',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            fontSize: 9,
            color: '#ffb24d',
            letterSpacing: '0.13em',
            textTransform: 'uppercase',
          }}
        >
          Spend Limit Reached
        </span>
      </div>

      <div
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 12,
          color: '#d9dcec',
          marginBottom: 4,
        }}
      >
        {gate.taskTitle}
      </div>

      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--text-secondary)',
          marginBottom: 6,
          display: 'flex',
          gap: 12,
        }}
      >
        <span>{gate.turns} turns</span>
        <span>{gate.jobCount} jobs</span>
        <span>limit: {gate.threshold}</span>
      </div>

      <div
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 11,
          color: 'var(--text-secondary)',
          marginBottom: 12,
          lineHeight: 1.4,
        }}
      >
        {gate.summary}
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
        onClick={() => void handleResume()}
        disabled={loading}
        style={{
          width: '100%',
          padding: 9,
          borderRadius: 'var(--r-btn)',
          background: '#ffb24d',
          color: '#1a1c2e',
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          fontSize: 10,
          boxShadow: '0 0 14px rgba(255,178,77,0.3)',
          opacity: loading ? 0.6 : 1,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          cursor: loading ? 'not-allowed' : 'pointer',
          border: 'none',
        }}
      >
        {loading ? '…' : 'Resume'}
      </button>
    </div>
  );
}
