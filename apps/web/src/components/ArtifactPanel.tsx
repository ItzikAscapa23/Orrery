import { useEffect, useState, useCallback } from 'react';
import type { ArtifactKind } from '@orrery/shared';

export type { ArtifactKind };

const KIND_LABELS: Record<ArtifactKind, string> = {
  spec: 'SPEC',
  plan: 'PLAN',
  contract: 'CONTRACT',
  'test-plan': 'TEST PLAN',
};

interface ArtifactViewerProps {
  featureId: string;
  kind: ArtifactKind;
  artifactCommittedCount: number;
}

interface ArtifactResponse {
  content: string;
  sha: string | null;
  filename: string;
}

type CopyState = 'idle' | 'copied' | 'error';

export function ArtifactViewer({ featureId, kind, artifactCommittedCount }: ArtifactViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [sha, setSha] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');

  const handleCopy = useCallback(async () => {
    if (content === null) return;
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API not available');
      await navigator.clipboard.writeText(content);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 2500);
    }
  }, [content]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent(null);

    fetch(`/api/features/${featureId}/artifacts/${kind}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<ArtifactResponse>;
      })
      .then((data) => {
        setContent(data.content);
        setSha(data.sha);
        setFilename(data.filename);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load artifact');
      })
      .finally(() => setLoading(false));
  }, [featureId, kind, artifactCommittedCount]);

  const isYaml = filename?.endsWith('.yaml') ?? false;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--bg-surface, #0d0f1c)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          borderBottom: '1px solid var(--border-faint)',
          flexShrink: 0,
        }}
      >
        <span className="mono-tag" style={{ color: '#cfd3e6', letterSpacing: '0.13em' }}>
          {KIND_LABELS[kind]}
        </span>
        {filename && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-muted)',
            }}
          >
            {filename}
          </span>
        )}
        {sha && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--text-muted)',
              opacity: 0.6,
            }}
          >
            @ {sha}
          </span>
        )}
        <button
          onClick={() => void handleCopy()}
          disabled={content === null}
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: '0.1em',
            padding: '2px 7px',
            background: 'none',
            border: '1px solid var(--border-faint)',
            borderRadius: 3,
            color:
              copyState === 'copied'
                ? '#4caf50'
                : copyState === 'error'
                  ? '#ff5b45'
                  : 'var(--text-muted)',
            cursor: content !== null ? 'pointer' : 'not-allowed',
            opacity: content !== null ? 1 : 0.4,
            transition: 'color 0.1s',
          }}
        >
          {copyState === 'copied' ? 'COPIED' : copyState === 'error' ? 'COPY ERROR' : 'COPY'}
        </button>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 16px',
        }}
      >
        {loading && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-muted)',
            }}
          >
            Loading…
          </div>
        )}
        {error && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: '#ff5b45',
            }}
          >
            {error}
          </div>
        )}
        {content !== null && (
          <pre
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: isYaml ? 11 : 12,
              lineHeight: 1.6,
              color: 'var(--text-primary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
            }}
          >
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}

// Keep backward-compat export name — gate cards still import ArtifactPanel
// (they only use the type, which is now re-exported from @orrery/shared above)
export { ArtifactViewer as ArtifactPanel };
