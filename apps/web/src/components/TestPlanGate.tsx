import { useState } from 'react';
import type { TestPlanGateState } from '../types/ui.js';
import type { ArtifactKind } from '@orrery/shared';

interface TestPlanGateProps {
  featureId: string;
  gate: TestPlanGateState;
  onAction: () => void;
  onViewArtifact?: (kind: ArtifactKind) => void;
}

export function TestPlanGate({ featureId, gate, onAction, onViewArtifact }: TestPlanGateProps) {
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const coveredCount = gate.coverage.filter((c) => c.covered).length;
  const skippedCount = gate.coverage.length - coveredCount;

  async function handleApprove() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/features/${featureId}/approve-test-plan`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Approve failed: ${res.status}`);
      }
      onAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleRequestChanges() {
    if (!comment.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/features/${featureId}/request-test-plan-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: comment.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Request changes failed: ${res.status}`);
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
        border: '1px solid rgba(126,184,247,0.4)',
        background: 'rgba(126,184,247,0.07)',
        borderRadius: 'var(--r-card)',
        padding: 13,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <div
          className="status-dot"
          style={{
            background: '#7eb8f7',
            boxShadow: '0 0 5px #7eb8f7',
            animation: 'blink 1.1s ease-in-out infinite',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            fontSize: 9,
            color: '#7eb8f7',
            letterSpacing: '0.13em',
            textTransform: 'uppercase',
          }}
        >
          Test Coverage Plan
        </span>
      </div>

      {/* Summary */}
      <div
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 12,
          lineHeight: 1.5,
          color: '#d9dcec',
          marginBottom: 8,
        }}
      >
        <em style={{ color: 'var(--text-secondary)' }}>{gate.summary}</em>
      </div>

      {/* Coverage badges */}
      {gate.coverage.length > 0 && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-secondary)',
            letterSpacing: '0.06em',
            marginBottom: 10,
          }}
        >
          {coveredCount} covered · {skippedCount} skipped
        </div>
      )}

      {/* Coverage table */}
      {gate.coverage.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            maxHeight: 200,
            overflowY: 'auto',
            border: '1px solid var(--border-faint)',
            borderRadius: 4,
          }}
        >
          {gate.coverage.map((c) => (
            <div
              key={c.taskId}
              style={{
                padding: '5px 8px',
                borderBottom: '1px solid var(--border-faint)',
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: c.covered ? '#5aff8a' : 'var(--text-secondary)',
                  flexShrink: 0,
                  paddingTop: 1,
                }}
              >
                {c.covered ? '✓' : '✗'}
              </span>
              <div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: '#c3c8dc',
                    marginBottom: c.behaviour || c.skipReason ? 2 : 0,
                  }}
                >
                  {c.taskId.slice(0, 8)}
                </div>
                {c.covered && c.behaviour && (
                  <div
                    style={{
                      fontFamily: 'var(--font-ui)',
                      fontSize: 10,
                      color: 'var(--text-secondary)',
                      lineHeight: 1.4,
                    }}
                  >
                    {c.behaviour}
                  </div>
                )}
                {!c.covered && c.skipReason && (
                  <div
                    style={{
                      fontFamily: 'var(--font-ui)',
                      fontSize: 10,
                      color: 'var(--text-secondary)',
                      lineHeight: 1.4,
                    }}
                  >
                    {c.skipReason}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* View artifact link */}
      {onViewArtifact && (
        <div style={{ marginBottom: 10 }}>
          <button
            onClick={() => onViewArtifact('test-plan')}
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
            view test plan →
          </button>
        </div>
      )}

      {/* Comment input */}
      {showComment && (
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Describe the coverage changes needed…"
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
              onClick={() => void handleApprove()}
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
              {loading ? '…' : 'Approve Test Plan'}
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
              onClick={() => void handleRequestChanges()}
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
