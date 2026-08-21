import { useState } from 'react';
import type { GateState, FindingEntry } from '../types/ui.js';
import type { ArtifactKind } from '@orrery/shared';

interface ApprovalGateProps {
  featureId: string;
  gate: GateState;
  findings?: FindingEntry[];
  onAction: () => void; // called after approve/request-changes completes
  onViewArtifact?: (kind: ArtifactKind) => void;
}

const SEVERITY_COLOR: Record<string, string> = {
  blocker: '#ff5b45',
  warning: '#ffb24d',
  suggestion: '#7eb8f7',
};

function FindingRow({
  featureId,
  finding,
  onResolved,
}: {
  featureId: string;
  finding: FindingEntry;
  onResolved: () => void;
}) {
  const [mode, setMode] = useState<'idle' | 'dismiss'>('idle');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const color = SEVERITY_COLOR[finding.severity] ?? '#c3c8dc';
  const resolved = finding.resolution !== null;

  async function handleAccept() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/features/${featureId}/findings/${finding.id}/accept`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Accept failed: ${res.status}`);
      }
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleDismiss() {
    if (finding.severity === 'blocker' && !reason.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/features/${featureId}/findings/${finding.id}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Dismiss failed: ${res.status}`);
      }
      setMode('idle');
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        borderLeft: `2px solid ${color}`,
        paddingLeft: 8,
        marginBottom: 10,
        opacity: resolved ? 0.45 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            color,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            flexShrink: 0,
          }}
        >
          {finding.severity}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-secondary)',
            flexShrink: 0,
          }}
        >
          {finding.section}
        </span>
        {resolved && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 8,
              color: 'var(--text-muted)',
              marginLeft: 'auto',
              flexShrink: 0,
            }}
          >
            {finding.resolution}
          </span>
        )}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 11,
          color: '#d9dcec',
          lineHeight: 1.45,
          marginBottom: resolved ? 0 : 6,
        }}
      >
        {finding.issue}
      </div>
      {!resolved && mode === 'idle' && (
        <div style={{ display: 'flex', gap: 6 }}>
          {finding.suggested_text && (
            <button
              onClick={() => void handleAccept()}
              disabled={loading}
              style={{
                padding: '3px 8px',
                borderRadius: 3,
                background: 'rgba(255,91,69,0.15)',
                border: '1px solid rgba(255,91,69,0.35)',
                color: '#ff5b45',
                fontFamily: 'var(--font-mono)',
                fontSize: 8,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                opacity: loading ? 0.6 : 1,
              }}
            >
              {loading ? '…' : 'Accept'}
            </button>
          )}
          <button
            onClick={() => setMode('dismiss')}
            disabled={loading}
            style={{
              padding: '3px 8px',
              borderRadius: 3,
              border: '1px solid var(--border-strong)',
              background: 'transparent',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)',
              fontSize: 8,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              opacity: loading ? 0.6 : 1,
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {!resolved && mode === 'dismiss' && (
        <div>
          {finding.severity === 'blocker' && (
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason required for blocker dismissal…"
              rows={2}
              style={{
                width: '100%',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--border-medium)',
                borderRadius: 'var(--r-input)',
                padding: '6px 8px',
                fontSize: 11,
                color: 'var(--text-primary)',
                resize: 'vertical',
                marginBottom: 6,
                fontFamily: 'var(--font-ui)',
              }}
              autoFocus
            />
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => void handleDismiss()}
              disabled={loading || (finding.severity === 'blocker' && !reason.trim())}
              style={{
                padding: '3px 8px',
                borderRadius: 3,
                border: '1px solid var(--border-strong)',
                background: 'transparent',
                color: '#c3c8dc',
                fontFamily: 'var(--font-mono)',
                fontSize: 8,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                opacity: loading || (finding.severity === 'blocker' && !reason.trim()) ? 0.4 : 1,
              }}
            >
              {loading ? '…' : 'Confirm'}
            </button>
            <button
              onClick={() => {
                setMode('idle');
                setReason('');
                setError(null);
              }}
              disabled={loading}
              style={{
                padding: '3px 8px',
                borderRadius: 3,
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
                fontSize: 8,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                opacity: loading ? 0.6 : 1,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <div
          style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: '#ff5b45', marginTop: 4 }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

export function ApprovalGate({
  featureId,
  gate,
  findings = [],
  onAction,
  onViewArtifact,
}: ApprovalGateProps) {
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApprove() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/features/${featureId}/approve`, { method: 'POST' });
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
      // request-changes returns an SSE stream — consume it fully
      const res = await fetch(`/api/features/${featureId}/request-changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: comment.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Request changes failed: ${res.status}`);
      }
      // Drain the SSE body (the event stream adds events that useEventStream will pick up)
      const reader = res.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
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
          Approval Gate
        </span>
      </div>

      {/* Summary */}
      <div
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 12,
          lineHeight: 1.5,
          color: '#d9dcec',
          marginBottom: 12,
        }}
      >
        {gate.gate === 'spec_approval'
          ? `Spec revision #${gate.revision + 1} is ready for review.`
          : gate.gate === 'code_review'
            ? `Code review round #${gate.revision + 1} is open.`
            : `Gate #${gate.revision + 1} requires your decision.`}{' '}
        <em style={{ color: 'var(--text-secondary)' }}>{gate.summary}</em>
      </div>

      {/* View artifact link */}
      {onViewArtifact && (
        <button
          onClick={() => onViewArtifact('spec')}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: '#7eb8f7',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '0 0 10px 0',
            display: 'block',
            letterSpacing: '0.06em',
          }}
        >
          view spec →
        </button>
      )}

      {/* Findings from the AWS review agent */}
      {findings.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 8,
              color: 'var(--text-secondary)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              marginBottom: 8,
            }}
          >
            Review findings ({findings.filter((f) => f.resolution === null).length} unresolved)
          </div>
          {findings.map((f) => (
            <FindingRow key={f.id} featureId={featureId} finding={f} onResolved={onAction} />
          ))}
          <div style={{ borderBottom: '1px solid var(--border-faint)', marginBottom: 10 }} />
        </div>
      )}

      {/* Comment input (shown when requesting changes) */}
      {showComment && (
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Describe the changes needed…"
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
              {loading ? '…' : 'Approve'}
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
