import type { CSSProperties } from 'react';
import type { RepoEntry } from '../hooks/useFeature.js';
import type { PhaseId, PrLink } from '../types/ui.js';

interface RequirementTabProps {
  requirement: string;
  featurePath: 'FULL' | 'LIGHT';
  currentPhase: PhaseId;
  repos: string[];
  repoMeta: RepoEntry[];
  currentBranches: Record<string, string>;
  prLinks: PrLink[];
  createdAt: string;
}

const CELL: CSSProperties = {
  padding: '6px 12px',
  borderBottom: '1px solid var(--border-faint)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--text-primary)',
  verticalAlign: 'top',
};

const HEADER_CELL: CSSProperties = {
  ...CELL,
  color: 'var(--text-muted)',
  fontWeight: 600,
  letterSpacing: '0.08em',
  fontSize: 10,
  borderBottom: '1px solid var(--border-default)',
};

export function RequirementTab({
  requirement,
  featurePath,
  currentPhase,
  repos,
  repoMeta,
  currentBranches,
  prLinks,
  createdAt,
}: RequirementTabProps) {
  const repoMetaById = Object.fromEntries(repoMeta.map((r) => [r.id, r]));
  const prByRepo = Object.fromEntries(prLinks.map((p) => [p.repo, p]));

  return (
    <div
      style={{
        overflowY: 'auto',
        padding: '20px 24px',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
      }}
    >
      {/* Requirement text */}
      <section>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-muted)',
            letterSpacing: '0.08em',
            marginBottom: 8,
          }}
        >
          REQUIREMENT
        </div>
        <pre
          style={{
            margin: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            lineHeight: 1.6,
            color: 'var(--text-primary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'var(--bg-surface-raised, #13152a)',
            border: '1px solid var(--border-faint)',
            borderRadius: 6,
            padding: '12px 16px',
          }}
        >
          {requirement}
        </pre>
      </section>

      {/* Meta row */}
      <section
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
        }}
      >
        <span
          style={{
            background: featurePath === 'FULL' ? 'rgba(124,140,255,0.15)' : 'rgba(91,200,255,0.15)',
            color: featurePath === 'FULL' ? 'var(--accent-primary, #7c8cff)' : '#5bc8ff',
            border: `1px solid ${featurePath === 'FULL' ? 'rgba(124,140,255,0.3)' : 'rgba(91,200,255,0.3)'}`,
            borderRadius: 4,
            padding: '2px 8px',
          }}
        >
          {featurePath}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>
          {currentPhase ?? 'DRAFTING_SPEC'}
        </span>
        <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>
          Created {new Date(createdAt).toLocaleDateString()}
        </span>
      </section>

      {/* Per-repo branch table */}
      <section>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-muted)',
            letterSpacing: '0.08em',
            marginBottom: 8,
          }}
        >
          BRANCHES
        </div>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            border: '1px solid var(--border-faint)',
            borderRadius: 6,
            overflow: 'hidden',
          }}
        >
          <thead>
            <tr>
              <th style={HEADER_CELL}>Repo</th>
              <th style={HEADER_CELL}>Base branch</th>
              <th style={HEADER_CELL}>Feature branch</th>
              <th style={HEADER_CELL}>PR</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((repoId) => {
              const meta = repoMetaById[repoId];
              const baseBranch = meta?.default_branch ?? '—';
              const featureBranch = currentBranches[repoId] ?? '—';
              const pr = prByRepo[repoId];
              return (
                <tr key={repoId}>
                  <td style={CELL}>{repoId}</td>
                  <td style={CELL}>{baseBranch}</td>
                  <td style={CELL}>{featureBranch}</td>
                  <td style={CELL}>
                    {pr ? (
                      <a
                        href={pr.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--accent-primary, #7c8cff)' }}
                      >
                        #{pr.prId}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
