import { useState } from 'react';
import type { TaskAcceptanceGateState } from '../types/ui.js';

interface TaskAcceptanceGateProps {
  featureId: string;
  gate: TaskAcceptanceGateState;
  onAction: () => void;
}

export function TaskAcceptanceGate({ featureId, gate, onAction }: TaskAcceptanceGateProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleOverride() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/features/${featureId}/tasks/${gate.taskId}/override-acceptance`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Override failed: ${res.status}`);
      }
      onAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleRetry() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/features/${featureId}/tasks/${gate.taskId}/retry-acceptance`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Retry failed: ${res.status}`);
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
        border: '1px solid rgba(255,91,69,0.4)',
        background: 'rgba(255,91,69,0.07)',
        borderRadius: 'var(--r-card)',
        padding: 13,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <div
          className="status-dot"
          style={{
            background: '#ff5b45',
            boxShadow: '0 0 5px #ff5b45',
            animation: 'blink 1.1s ease-in-out infinite',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            fontSize: 9,
            color: '#ff5b45',
            letterSpacing: '0.13em',
            textTransform: 'uppercase',
          }}
        >
          Acceptance Tests Failing
        </span>
      </div>

      {/* Task title */}
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

      {/* Summary */}
      <div
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 11,
          color: 'var(--text-secondary)',
          marginBottom: gate.findings.length > 0 ? 8 : 12,
          lineHeight: 1.4,
        }}
      >
        {gate.summary}
      </div>

      {/* Failing tests */}
      {gate.findings.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            maxHeight: 120,
            overflowY: 'auto',
            border: '1px solid var(--border-faint)',
            borderRadius: 4,
          }}
        >
          {gate.findings.map((f) => (
            <div
              key={f.id}
              style={{
                padding: '4px 8px',
                borderBottom: '1px solid var(--border-faint)',
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                color: '#ff8a75',
                lineHeight: 1.4,
              }}
            >
              {f.issue}
            </div>
          ))}
        </div>
      )}

      {error && (
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

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => void handleRetry()}
          disabled={loading}
          style={{
            flex: 1,
            padding: 9,
            borderRadius: 'var(--r-btn)',
            background: '#ff5b45',
            color: '#fff',
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            fontSize: 10,
            boxShadow: '0 0 14px rgba(255,91,69,0.4)',
            opacity: loading ? 0.6 : 1,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {loading ? '…' : 'Retry'}
        </button>
        <button
          onClick={() => void handleOverride()}
          disabled={loading}
          style={{
            flex: 1,
            padding: 9,
            borderRadius: 'var(--r-btn)',
            border: '1px solid var(--border-strong)',
            background: 'transparent',
            color: '#c3c8dc',
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            fontSize: 10,
            opacity: loading ? 0.6 : 1,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Override
        </button>
      </div>
    </div>
  );
}
