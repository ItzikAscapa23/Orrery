import type { AgentLogPayload } from '@orrery/shared';

const SEVERITY_PREFIX: Record<AgentLogPayload['severity'], string> = {
  ok: '✓',
  action: '▸',
  info: '◦',
  muted: '·',
};

const SEVERITY_COLOR: Record<AgentLogPayload['severity'], string> = {
  ok: '#37e0a0',
  action: '#ffb24d',
  info: '#8b7bff',
  muted: '#5f6684',
};

interface EventLogProps {
  logs: AgentLogPayload[];
}

export function EventLog({ logs }: EventLogProps) {
  return (
    <div>
      <div className="section-label">Event Log</div>
      <div
        style={{
          overflowY: 'auto',
          maxHeight: 280,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {logs.length === 0 ? (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-faint)',
              letterSpacing: '0.06em',
            }}
          >
            No events yet
          </div>
        ) : (
          logs.map((log, i) => (
            <div
              key={i}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                lineHeight: 1.4,
                color: SEVERITY_COLOR[log.severity],
                display: 'flex',
                gap: 6,
              }}
            >
              <span style={{ flexShrink: 0 }}>{SEVERITY_PREFIX[log.severity]}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{log.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
