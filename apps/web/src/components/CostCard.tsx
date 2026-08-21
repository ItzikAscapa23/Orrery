import { useEffect, useState } from 'react';

type AgentRow = {
  agent: string;
  in_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  out_tokens: number;
  cost_usd: number;
  elapsed_ms: number;
};

type CostResult = {
  total_usd: number;
  priced_events: number;
  partial_events: number;
  unpriceable_events: number;
  rate_unknown_events: number;
  tagged_simulated_events: number;
  by_agent: AgentRow[];
};

type Props = { featureId: string; usageEventCount: number };

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export function CostCard({ featureId, usageEventCount }: Props) {
  const [data, setData] = useState<CostResult | null>(null);
  const [error, setError] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  // Full reset when the feature changes; keep stale data visible during refetches
  useEffect(() => {
    setData(null);
    setError(false);
    setFetchedAt(null);
  }, [featureId]);

  // Refetch on mount and whenever a new usage.recorded event arrives
  useEffect(() => {
    setError(false);
    fetch(`/api/features/${featureId}/cost`)
      .then((r) => {
        if (!r.ok) throw new Error('fetch failed');
        return r.json() as Promise<CostResult>;
      })
      .then((result) => {
        setData(result);
        setFetchedAt(new Date());
      })
      .catch(() => setError(true));
  }, [featureId, usageEventCount]);

  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 'var(--r-card)',
        background: 'rgba(255,255,255,0.04)',
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
          textTransform: 'uppercase',
        }}
      >
        Estimated Cost
      </div>

      {error && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>
          Cost unavailable
        </div>
      )}

      {!error && data === null && fetchedAt === null && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>
          Computing cost…
        </div>
      )}

      {!error && data && (
        <>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              color: 'var(--text-primary)',
              marginBottom: 4,
            }}
          >
            ${data.total_usd.toFixed(6)} USD
          </div>
          {fetchedAt && (
            <div
              style={{
                fontFamily: 'var(--font-ui)',
                fontSize: 10,
                color: 'var(--text-muted)',
                marginBottom: 8,
              }}
            >
              as of {fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          )}

          {data.by_agent.length > 0 && (
            <div style={{ marginBottom: 6, overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                }}
              >
                <thead>
                  <tr style={{ color: 'var(--text-secondary)' }}>
                    <th style={thStyle}>Agent</th>
                    <th style={{ ...thStyle, textAlign: 'right', minWidth: 44 }}>IN</th>
                    <th style={{ ...thStyle, textAlign: 'right', minWidth: 52 }}>CACHE R</th>
                    <th style={{ ...thStyle, textAlign: 'right', minWidth: 52 }}>CACHE W</th>
                    <th style={{ ...thStyle, textAlign: 'right', minWidth: 44 }}>OUT</th>
                    <th style={{ ...thStyle, textAlign: 'right', minWidth: 64 }}>EST. COST</th>
                    <th style={{ ...thStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      ELAPSED*
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_agent.map((row) => (
                    <tr key={row.agent} style={{ color: 'var(--text-primary)' }}>
                      <td style={tdStyle}>{row.agent}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {row.in_tokens.toLocaleString()}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {row.cache_read_tokens.toLocaleString()}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {row.cache_write_tokens.toLocaleString()}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {row.out_tokens.toLocaleString()}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        ${row.cost_usd.toFixed(6)}
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          textAlign: 'right',
                          whiteSpace: 'nowrap',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {formatElapsed(row.elapsed_ms)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ color: 'var(--text-primary)' }}>
                    <td
                      style={{
                        ...tdStyle,
                        fontWeight: 700,
                        borderTop: '1px solid var(--border-subtle)',
                        paddingTop: 6,
                      }}
                    >
                      Total
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        fontWeight: 700,
                        borderTop: '1px solid var(--border-subtle)',
                        paddingTop: 6,
                      }}
                    >
                      {data.by_agent.reduce((s, r) => s + r.in_tokens, 0).toLocaleString()}
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        fontWeight: 700,
                        borderTop: '1px solid var(--border-subtle)',
                        paddingTop: 6,
                      }}
                    >
                      {data.by_agent.reduce((s, r) => s + r.cache_read_tokens, 0).toLocaleString()}
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        fontWeight: 700,
                        borderTop: '1px solid var(--border-subtle)',
                        paddingTop: 6,
                      }}
                    >
                      {data.by_agent.reduce((s, r) => s + r.cache_write_tokens, 0).toLocaleString()}
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        fontWeight: 700,
                        borderTop: '1px solid var(--border-subtle)',
                        paddingTop: 6,
                      }}
                    >
                      {data.by_agent.reduce((s, r) => s + r.out_tokens, 0).toLocaleString()}
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        fontWeight: 700,
                        borderTop: '1px solid var(--border-subtle)',
                        paddingTop: 6,
                      }}
                    >
                      ${data.total_usd.toFixed(6)}
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        color: 'var(--text-secondary)',
                        borderTop: '1px solid var(--border-subtle)',
                        paddingTop: 6,
                      }}
                    >
                      —
                    </td>
                  </tr>
                </tfoot>
              </table>
              <div
                style={{
                  fontFamily: 'var(--font-ui)',
                  fontSize: 9,
                  color: 'var(--text-muted)',
                  marginTop: 4,
                }}
              >
                * Wall-clock span across turns — not billing time
              </div>
            </div>
          )}

          <GapStatement data={data} />
        </>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  paddingBottom: 4,
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  fontSize: 9,
};

const tdStyle: React.CSSProperties = {
  paddingTop: 2,
  paddingBottom: 2,
  paddingRight: 6,
  verticalAlign: 'middle',
};

function GapStatement({ data }: { data: CostResult }) {
  const lines: string[] = [];

  const unpriced = data.unpriceable_events + data.rate_unknown_events;
  if (unpriced > 0) {
    lines.push(
      `${unpriced} event${unpriced === 1 ? '' : 's'} could not be priced and are excluded from the total.`,
    );
  }

  if (data.partial_events > 0) {
    lines.push(
      `${data.partial_events} event${data.partial_events === 1 ? '' : 's'} lack cache-token data; the total is a lower bound.`,
    );
  }

  if (data.tagged_simulated_events > 0) {
    lines.push(
      `${data.tagged_simulated_events} event${data.tagged_simulated_events === 1 ? '' : 's'} tagged as simulated; excluded from total.`,
    );
  }

  if (lines.length === 0) {
    lines.push('All events priced.');
  }

  return (
    <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-secondary)' }}>
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}
