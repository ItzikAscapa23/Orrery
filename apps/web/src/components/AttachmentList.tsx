import { useEffect, useState } from 'react';

interface AttachmentItem {
  name: string;
  kind: string;
  size: number;
  sha: string | null;
}

interface AttachmentListProps {
  featureId: string;
  refreshTick: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentList({ featureId, refreshTick }: AttachmentListProps) {
  const [items, setItems] = useState<AttachmentItem[]>([]);

  useEffect(() => {
    void fetch(`/api/features/${featureId}/attachments`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: unknown) => {
        if (Array.isArray(data)) setItems(data as AttachmentItem[]);
      })
      .catch(() => undefined);
  }, [featureId, refreshTick]);

  if (items.length === 0) return null;

  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 6,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--border-faint)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 10,
          color: 'var(--text-secondary)',
          letterSpacing: '0.1em',
          marginBottom: 6,
        }}
      >
        ATTACHED FILES
      </div>
      {items.map((item) => (
        <div
          key={item.name}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 4,
            fontSize: 11,
          }}
        >
          <span
            style={{
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.name.replace(/^attachment-/, '')}
          </span>
          <span
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 9,
              padding: '1px 5px',
              borderRadius: 3,
              background:
                item.kind === 'reference' ? 'rgba(126,184,247,0.15)' : 'rgba(255,200,100,0.15)',
              color: item.kind === 'reference' ? '#7eb8f7' : '#ffc864',
              letterSpacing: '0.05em',
              flexShrink: 0,
            }}
          >
            {item.kind}
          </span>
          <span style={{ color: 'var(--text-secondary)', fontSize: 10, flexShrink: 0 }}>
            {formatBytes(item.size)}
          </span>
        </div>
      ))}
    </div>
  );
}
