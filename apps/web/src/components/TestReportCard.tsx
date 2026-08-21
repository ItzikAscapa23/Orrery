import { useState } from 'react';
import type { TestReportState, GateState } from '../types/ui.js';
import type { TestRow } from '@orrery/shared';

interface TestReportCardProps {
  testReport: TestReportState;
  featureId?: string;
  gate?: GateState;
  onAction?: () => void;
}

type CardVariant = 'pass' | 'fail' | 'skipped' | 'parse-error' | 'details-unavailable' | 'legacy';

export function resolveVariant(r: TestReportState): CardVariant {
  if (r.skipped) return 'skipped';
  if (r.parseError) return 'parse-error';
  if (r.tests.length === 0 && r.passed !== null && r.passed > 0) return 'details-unavailable';
  if (r.authoredPassed === undefined) return 'legacy';
  if (r.failed === 0 && r.authoredPassed > 0) return 'pass';
  return 'fail';
}

const VARIANT_BORDER: Record<CardVariant, string> = {
  pass: 'rgba(46,230,201,0.3)',
  fail: 'rgba(255,178,77,0.35)',
  skipped: 'rgba(255,255,255,0.08)',
  'parse-error': 'rgba(255,178,77,0.25)',
  'details-unavailable': 'rgba(255,255,255,0.08)',
  legacy: 'rgba(255,255,255,0.08)',
};

const VARIANT_BG: Record<CardVariant, string> = {
  pass: 'rgba(46,230,201,0.05)',
  fail: 'rgba(255,178,77,0.06)',
  skipped: 'rgba(255,255,255,0.02)',
  'parse-error': 'rgba(255,178,77,0.05)',
  'details-unavailable': 'rgba(255,255,255,0.02)',
  legacy: 'rgba(255,255,255,0.02)',
};

const VARIANT_DOT: Record<CardVariant, string> = {
  pass: '#2ee6c9',
  fail: '#ffb24d',
  skipped: '#6b7290',
  'parse-error': '#ffb24d',
  'details-unavailable': '#6b7290',
  legacy: '#6b7290',
};

function TestRowLine({ row }: { row: TestRow }) {
  const isAuthor = row.authored === true;
  const passed = row.status === 'passed';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        padding: '2px 0',
        opacity: isAuthor ? 1 : 0.55,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: passed ? '#2ee6c9' : '#ff5b45',
          flexShrink: 0,
          width: 10,
        }}
      >
        {passed ? '✓' : '✗'}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: isAuthor ? 'var(--text-primary)' : 'var(--text-muted)',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {row.test_name}
      </span>
      {typeof row.duration_ms === 'number' && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            flexShrink: 0,
          }}
        >
          {row.duration_ms}ms
        </span>
      )}
      {!isAuthor && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            color: 'var(--text-faint)',
            fontStyle: 'italic',
            flexShrink: 0,
          }}
        >
          pre-existing
        </span>
      )}
    </div>
  );
}

export function TestReportCard({ testReport: r, featureId, gate, onAction }: TestReportCardProps) {
  const variant = resolveVariant(r);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  async function postGateAction(path: string) {
    setLoading(true);
    try {
      await fetch(`/api/features/${featureId}/${path}`, { method: 'POST' });
      onAction?.();
    } finally {
      setLoading(false);
    }
  }

  // Sort: failures first, then authored before pre-existing within each group.
  const sortedTests = [...r.tests].sort((a, b) => {
    const failOrder = (t: TestRow) => (t.status === 'failed' ? 0 : 1);
    const authorOrder = (t: TestRow) => (t.authored === true ? 0 : 1);
    return failOrder(a) - failOrder(b) || authorOrder(a) - authorOrder(b);
  });

  const COLLAPSE_THRESHOLD = 8;
  const showToggle = sortedTests.length > COLLAPSE_THRESHOLD;
  const visibleTests =
    showToggle && !expanded ? sortedTests.slice(0, COLLAPSE_THRESHOLD) : sortedTests;
  const hiddenCount = sortedTests.length - COLLAPSE_THRESHOLD;

  // Headline text
  let headline: string;
  let subline: string | null = null;

  if (variant === 'skipped') {
    headline = 'Not tested — test agent did not run';
  } else if (variant === 'parse-error') {
    headline = 'Tests ran; results could not be parsed';
  } else if (variant === 'details-unavailable') {
    headline = 'Passed — per-test details unavailable';
  } else if (variant === 'legacy') {
    if (r.failed !== null && r.failed > 0) {
      headline = `${r.failed} test${r.failed === 1 ? '' : 's'} failed`;
    } else {
      headline = 'Tests ran';
    }
    const totalPassed = r.passed !== null ? String(r.passed) : 'unknown';
    subline = `${totalPassed} passed · ${r.failed ?? 0} failed`;
  } else if (variant === 'pass') {
    const ap = r.authoredPassed!;
    headline = `${ap} authored test${ap === 1 ? '' : 's'} passed`;
    const totalPassed = r.passed !== null ? String(r.passed) : 'unknown';
    subline = `${totalPassed} total · ${r.failed ?? 0} failed`;
  } else {
    // fail
    if (r.failed !== null && r.failed > 0) {
      headline = `${r.failed} test${r.failed === 1 ? '' : 's'} failed`;
    } else {
      headline = 'No authored tests written';
    }
    const passedText = r.passed !== null ? `${r.passed} passed` : 'pass count unavailable';
    subline = passedText;
  }

  return (
    <div
      style={{
        border: `1px solid ${VARIANT_BORDER[variant]}`,
        background: VARIANT_BG[variant],
        borderRadius: 'var(--r-card)',
        padding: 13,
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <div className="status-dot" style={{ background: VARIANT_DOT[variant] }} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            fontSize: 9,
            color: VARIANT_DOT[variant],
            letterSpacing: '0.13em',
            textTransform: 'uppercase',
          }}
        >
          Test Report
        </span>
      </div>

      {/* Headline */}
      <div
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-primary)',
          lineHeight: 1.35,
          marginBottom: subline ? 3 : 0,
        }}
      >
        {headline}
      </div>

      {/* Secondary context */}
      {subline && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-secondary)',
            marginBottom:
              r.parseError || r.skipReason || r.findings.length > 0 || sortedTests.length > 0
                ? 10
                : 0,
          }}
        >
          {subline}
        </div>
      )}

      {/* Skip reason */}
      {r.skipReason && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-secondary)',
            marginTop: 4,
            marginBottom: 0,
          }}
        >
          {r.skipReason}
        </div>
      )}

      {/* Parse error detail */}
      {r.parseError && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-secondary)',
            marginTop: 4,
            wordBreak: 'break-all',
          }}
        >
          {r.parseError}
        </div>
      )}

      {/* Failure findings (test findings — read-only, no accept/dismiss here) */}
      {r.findings.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="section-label" style={{ marginBottom: 6 }}>
            Failed tests ({r.findings.length})
          </div>
          {r.findings.map((f) => (
            <div
              key={f.id}
              style={{
                borderLeft: '2px solid #ff5b45',
                paddingLeft: 8,
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: 'var(--text-secondary)',
                  marginBottom: 2,
                }}
              >
                {f.test_name ?? f.section}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-ui)',
                  fontSize: 11,
                  color: '#d9dcec',
                  lineHeight: 1.4,
                }}
              >
                {f.issue}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Legacy note — shown when authored_passed was absent from the event payload */}
      {variant === 'legacy' && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            fontStyle: 'italic',
            marginTop: 4,
          }}
        >
          This report predates authored-test tracking
        </div>
      )}

      {/* Test row table */}
      {sortedTests.length > 0 && (
        <div style={{ marginTop: r.findings.length > 0 ? 10 : subline ? 10 : 6 }}>
          <div className="section-label" style={{ marginBottom: 4 }}>
            {r.authoredPassed !== undefined && r.authoredFailed !== undefined
              ? `Test results (${r.authoredPassed + r.authoredFailed} authored / ${sortedTests.length} total)`
              : `Test results (${sortedTests.length} total)`}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {visibleTests.map((row, i) => (
              <TestRowLine key={`${row.test_name}-${i}`} row={row} />
            ))}
          </div>
          {showToggle && (
            <button
              onClick={() => setExpanded((v) => !v)}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                color: 'var(--text-muted)',
                background: 'none',
                border: 'none',
                padding: '4px 0 0 16px',
                cursor: 'pointer',
                letterSpacing: '0.06em',
              }}
            >
              {expanded ? '▴ show less' : `▾ show ${hiddenCount} more`}
            </button>
          )}
        </div>
      )}

      {/* Gate action bar — only rendered when this card is the active gate */}
      {featureId && gate && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginTop: 14,
            paddingTop: 12,
            borderTop: '1px solid rgba(255,178,77,0.2)',
          }}
        >
          <button
            disabled={loading}
            onClick={() => void postGateAction('approve-test')}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              padding: '6px 14px',
              borderRadius: 4,
              border: '1px solid rgba(46,230,201,0.5)',
              background: 'rgba(46,230,201,0.08)',
              color: '#2ee6c9',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.5 : 1,
            }}
          >
            APPROVE
          </button>
          <button
            disabled={loading}
            onClick={() => void postGateAction('retry-test')}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              padding: '6px 14px',
              borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-secondary)',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.5 : 1,
            }}
          >
            RETRY
          </button>
        </div>
      )}
    </div>
  );
}
