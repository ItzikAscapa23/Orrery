import { useEffect, useState } from 'react';

export interface TaskRow {
  id: string;
  title: string;
  repo: string;
  side: string;
  status: string;
  turns: number | null;
  jobCount: number | null;
  blockedBy: string[];
  coveredByTestPlan: boolean;
  testsWritten: boolean;
  testTaskAttempts: number;
  spendGuardThreshold: number;
}

const STATUS_COLORS: Record<string, string> = {
  completed: 'var(--green, #4ade80)',
  running: 'var(--accent, #818cf8)',
  parked: '#fb923c',
  amendment_paused: '#fb923c',
  pending: 'var(--text-muted)',
};

function StatusChip({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? 'var(--text-muted)';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        whiteSpace: 'nowrap',
      }}
    >
      {status.replace('_', ' ')}
    </span>
  );
}

function TddMarker({ row }: { row: TaskRow }) {
  if (!row.coveredByTestPlan) return null;
  if (row.testsWritten) {
    return (
      <span style={{ color: 'var(--green, #4ade80)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
        ✓ tests
      </span>
    );
  }
  if (row.testTaskAttempts > 0) {
    return (
      <span style={{ color: '#fb923c', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
        ⏳ {row.testTaskAttempts}
      </span>
    );
  }
  return (
    <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
      ○
    </span>
  );
}

function formatTurns(turns: number | null, jobCount: number | null): string {
  if (turns === null) return '—';
  if (jobCount !== null && jobCount > 1) return `${turns} (${jobCount} jobs)`;
  return String(turns);
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  paddingBottom: 4,
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  fontSize: 9,
  whiteSpace: 'nowrap',
  color: 'var(--text-secondary)',
};

const tdStyle: React.CSSProperties = {
  paddingTop: 3,
  paddingBottom: 3,
  paddingRight: 10,
  verticalAlign: 'middle',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--text-primary)',
};

type Props = {
  featureId: string;
  taskEventCount: number;
  onRowClick?: (taskId: string) => void;
};

export function TaskTable({ featureId, taskEventCount, onRowClick }: Props) {
  const [rows, setRows] = useState<TaskRow[] | null>(null);

  useEffect(() => {
    setRows(null);
  }, [featureId]);

  useEffect(() => {
    fetch(`/api/features/${featureId}/tasks`)
      .then((r) => {
        if (!r.ok) throw new Error('fetch failed');
        return r.json() as Promise<TaskRow[]>;
      })
      .then(setRows)
      .catch(() => setRows([]));
  }, [featureId, taskEventCount]);

  if (rows === null) return null;
  if (rows.length === 0) return null;

  return (
    <div
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-faint)',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 10,
          color: 'var(--text-secondary)',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        Tasks
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
          }}
        >
          <thead>
            <tr>
              <th style={thStyle}>Status</th>
              <th style={{ ...thStyle, maxWidth: 260 }}>Title</th>
              <th style={thStyle}>Repo</th>
              <th style={{ ...thStyle, whiteSpace: 'nowrap' }}>Turns</th>
              <th style={thStyle}>Blocked By</th>
              <th style={thStyle}>TDD</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row.id) : undefined}
                style={onRowClick ? { cursor: 'pointer' } : undefined}
              >
                <td style={{ ...tdStyle, paddingRight: 12 }}>
                  <StatusChip status={row.status} />
                </td>
                <td
                  style={{
                    ...tdStyle,
                    maxWidth: 260,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={row.title}
                >
                  {row.title}
                </td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{row.repo}</td>
                <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                  {formatTurns(row.turns, row.jobCount)}
                </td>
                <td
                  style={{
                    ...tdStyle,
                    color: row.blockedBy.length > 0 ? '#fb923c' : 'var(--text-muted)',
                    maxWidth: 200,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={row.blockedBy.join(', ')}
                >
                  {row.blockedBy.length > 0 ? row.blockedBy.join(', ') : ''}
                </td>
                <td style={tdStyle}>
                  <TddMarker row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
