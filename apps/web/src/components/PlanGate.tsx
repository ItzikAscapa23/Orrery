import { useState } from 'react';
import type { PlanGateState } from '../types/ui.js';
import type { ArtifactKind } from '@orrery/shared';

interface PlanGateProps {
  featureId: string;
  gate: PlanGateState;
  onAction: () => void;
  onViewArtifact?: (kind: ArtifactKind) => void;
}

export function PlanGate({ featureId, gate, onAction, onViewArtifact }: PlanGateProps) {
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApprovePlan() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/features/${featureId}/approve-plan`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Approve plan failed: ${res.status}`);
      }
      onAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleRequestPlanChanges() {
    if (!comment.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/features/${featureId}/request-plan-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: comment.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Request plan changes failed: ${res.status}`);
      }
      setComment('');
      setShowComment(false);
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
      {/* Header */}
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
          Plan Gate
        </span>
      </div>

      {/* Summary */}
      <div
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 12,
          lineHeight: 1.5,
          color: '#d9dcec',
          marginBottom: gate.task_count > 0 ? 6 : 12,
        }}
      >
        <em style={{ color: 'var(--text-secondary)' }}>{gate.summary}</em>
      </div>

      {/* Task count badge */}
      {gate.task_count > 0 && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: '#8b7bff',
            letterSpacing: '0.06em',
            marginBottom: 12,
          }}
        >
          {gate.task_count} task{gate.task_count !== 1 ? 's' : ''} planned
        </div>
      )}

      {/* View artifact links */}
      {onViewArtifact && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
          <button
            onClick={() => onViewArtifact('plan')}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: '#7eb8f7',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              letterSpacing: '0.06em',
            }}
          >
            view plan →
          </button>
          <button
            onClick={() => onViewArtifact('contract')}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: '#7eb8f7',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              letterSpacing: '0.06em',
            }}
          >
            view contract →
          </button>
        </div>
      )}

      {/* Comment input */}
      {showComment && (
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Describe the plan changes needed…"
          rows={3}
          style={{
            width: '100%',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid var(--border-medium)',
            borderRadius: 'var(--r-input)',
            padding: '8px 10px',
            fontSize: 12,
            color: 'var(--text-primary)',
            resize: 'vertical',
            marginBottom: 10,
            fontFamily: 'var(--font-ui)',
          }}
          autoFocus
        />
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
        {!showComment ? (
          <>
            <button
              onClick={() => void handleApprovePlan()}
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
              {loading ? '…' : 'Approve Plan'}
            </button>
            <button
              onClick={() => setShowComment(true)}
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
              Request Changes
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => void handleRequestPlanChanges()}
              disabled={loading || !comment.trim()}
              style={{
                flex: 1,
                padding: 9,
                borderRadius: 'var(--r-btn)',
                background: '#ff5b45',
                color: '#fff',
                fontFamily: 'var(--font-mono)',
                fontWeight: 700,
                fontSize: 10,
                opacity: loading || !comment.trim() ? 0.6 : 1,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {loading ? '…' : 'Send'}
            </button>
            <button
              onClick={() => {
                setShowComment(false);
                setComment('');
              }}
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
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
