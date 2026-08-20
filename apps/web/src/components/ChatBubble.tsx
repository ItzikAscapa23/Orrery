import type { ChatEntry } from '../types/ui.js';

interface ChatBubbleProps {
  entry: ChatEntry;
  streaming?: boolean;
}

function getVariant(who: ChatEntry['who']): 'system' | 'orchestrator' | 'you' | 'agent' {
  if (who === 'dev') return 'you';
  if (who === 'orchestrator') return 'orchestrator';
  if (who === 'system') return 'system';
  return 'agent';
}

const AUTHOR_LABELS: Record<string, string> = {
  dev: 'YOU',
  orchestrator: 'ORCHESTRATOR',
  system: 'SYSTEM',
  spec: 'SPEC AGENT',
  aws: 'AWS EXPERT',
  client: 'CLIENT DEV',
  server: 'SERVER DEV',
  review: 'REVIEW AGENT',
  test: 'TEST AGENT',
};

export function ChatBubble({ entry, streaming }: ChatBubbleProps) {
  const variant = getVariant(entry.who);
  const authorLabel = AUTHOR_LABELS[entry.who] ?? entry.who.toUpperCase();

  if (variant === 'system') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            letterSpacing: '0.16em',
            color: '#5f6684',
            textTransform: 'uppercase',
          }}
        >
          {authorLabel}
        </span>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1.5,
            color: '#8a91ad',
          }}
        >
          {entry.text}
          {streaming && <span style={{ opacity: 0.5 }}>▋</span>}
        </div>
      </div>
    );
  }

  const isRight = variant === 'you';

  const bubbleStyle: React.CSSProperties =
    variant === 'orchestrator' || variant === 'agent'
      ? {
          background: 'rgba(139,123,255,0.10)',
          border: '1px solid rgba(139,123,255,0.28)',
          borderRadius: '3px 13px 13px 13px',
          padding: '9px 11px',
          color: '#d9d5ff',
          maxWidth: '90%',
          alignSelf: 'flex-start',
        }
      : {
          background: 'rgba(255,91,69,0.13)',
          border: '1px solid rgba(255,91,69,0.33)',
          borderRadius: '13px 13px 3px 13px',
          padding: '9px 11px',
          color: '#ffe7e2',
          maxWidth: '90%',
          alignSelf: 'flex-end',
        };

  const authorColor = variant === 'you' ? '#ff5b45' : '#8b7bff';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        alignItems: isRight ? 'flex-end' : 'flex-start',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 8,
          letterSpacing: '0.16em',
          color: authorColor,
          textTransform: 'uppercase',
        }}
      >
        {authorLabel}
      </span>
      <div style={bubbleStyle}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, lineHeight: 1.5 }}>
          {entry.text}
          {streaming && <span style={{ opacity: 0.5 }}>▋</span>}
        </span>
      </div>
    </div>
  );
}
