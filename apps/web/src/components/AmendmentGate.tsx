import { useState } from 'react';
import type { AmendmentGateState } from '../types/ui.js';
import type { ArtifactKind } from '@orrery/shared';

interface AmendmentGateProps {
  featureId: string;
  gate: AmendmentGateState;
  onAction: () => void;
  onViewArtifact?: (kind: ArtifactKind) => void;
}

const MAX_YAML_LINES = 30;

export function AmendmentGate({ featureId, gate, onAction, onViewArtifact }: AmendmentGateProps) {
  const [showRejectComment, setShowRejectComment] = useState(false);
  const [comment, setComment] = useState('');
  const [showFullYaml, setShowFullYaml] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const yamlLines = gate.proposedContractYaml.split('\n');
  const truncated = yamlLines.length > MAX_YAML_LINES;
  const displayedYaml =
    truncated && !showFullYaml
      ? yamlLines.slice(0, MAX_YAML_LINES).join('\n') + '\n…'
      : gate.proposedContractYaml;

  async function handleApprove() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/features/${featureId}/approve-amendment`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Approve amendment failed: ${res.status}`);
      }
      onAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleReject() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/features/${featureId}/reject-amendment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(comment.trim() ? { comment: comment.trim() } : {}),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Reject amendment failed: ${res.status}`);
      }
      setComment('');
      setShowRejectComment(false);
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
            boxShadow: '0 0 6px #ffb24d',
            animation: 'pulse 1.4s ease-in-out infinite',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: '0.13em',
            color: '#ffb24d',
            textTransform: 'uppercase',
          }}
        >
          Amendment Gate
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            marginLeft: 4,
          }}
        >
          {gate.repo}
        </span>
      </div>

      {/* Rationale */}
      <div
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 12,
          color: '#d9dcec',
          lineHeight: 1.5,
          marginBottom: 8,
        }}
      >
        {gate.rationale}
      </div>

      {/* View proposal in panel */}
      {onViewArtifact && (
        <button
          onClick={() => onViewArtifact('contract')}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: '#7eb8f7',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '0 0 8px 0',
            display: 'block',
            letterSpacing: '0.06em',
          }}
        >
          view proposal →
        </button>
      )}

      {/* Proposed contract preview */}
      <div style={{ marginBottom: 10 }}>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-secondary)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            marginBottom: 4,
          }}
        >
          Proposed contract.yaml
        </div>
        <pre
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-secondary)',
            background: 'rgba(0,0,0,0.25)',
            borderRadius: 4,
            padding: '6px 8px',
            overflowX: 'auto',
            maxHeight: 220,
            overflowY: 'auto',
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {displayedYaml}
        </pre>
        {truncated && (
          <button
            onClick={() => setShowFullYaml((v) => !v)}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: '#8b7bff',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 0',
            }}
          >
            {showFullYaml ? 'show less' : `show all ${yamlLines.length} lines`}
          </button>
        )}
      </div>

      {/* Error */}
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

      {/* Reject comment textarea */}
      {showRejectComment && (
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Reason for rejection (optional)…"
          rows={3}
          style={{
            width: '100%',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid var(--border-strong)',
            borderRadius: 4,
            color: 'var(--text-primary)',
            padding: '6px 8px',
            resize: 'vertical',
            marginBottom: 8,
            boxSizing: 'border-box',
          }}
        />
      )}

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        {!showRejectComment ? (
          <>
            <button
              disabled={loading}
              onClick={() => void handleApprove()}
              style={{
                flex: 1,
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.08em',
                padding: '6px 12px',
                background: '#ff5b45',
                boxShadow: '0 0 14px rgba(255,91,69,0.4)',
                border: 'none',
                borderRadius: 4,
                color: '#fff',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.6 : 1,
              }}
            >
              {loading ? 'Working…' : 'Approve Contract'}
            </button>
            <button
              disabled={loading}
              onClick={() => setShowRejectComment(true)}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.08em',
                padding: '6px 12px',
                background: 'transparent',
                border: '1px solid var(--border-strong)',
                borderRadius: 4,
                color: 'var(--text-secondary)',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.6 : 1,
              }}
            >
              Reject
            </button>
          </>
        ) : (
          <>
            <button
              disabled={loading}
              onClick={() => void handleReject()}
              style={{
                flex: 1,
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.08em',
                padding: '6px 12px',
                background: '#ff5b45',
                boxShadow: '0 0 14px rgba(255,91,69,0.4)',
                border: 'none',
                borderRadius: 4,
                color: '#fff',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.6 : 1,
              }}
            >
              {loading ? 'Working…' : 'Send Rejection'}
            </button>
            <button
              disabled={loading}
              onClick={() => {
                setShowRejectComment(false);
                setComment('');
              }}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.08em',
                padding: '6px 12px',
                background: 'transparent',
                border: '1px solid var(--border-strong)',
                borderRadius: 4,
                color: 'var(--text-secondary)',
                cursor: 'pointer',
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
