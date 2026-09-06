import { useState } from 'react';
import type { PhaseId, AgentDisplayStatus } from '../types/ui.js';
import type { FeatureSummary, RepoEntry } from '../hooks/useFeature.js';
import { FeatureSelector } from './FeatureSelector.js';
import { CreateFeatureForm } from './CreateFeatureForm.js';
import { productName } from '../lib/productName.js';

const PHASE_NAMES: Partial<Record<NonNullable<PhaseId>, string>> = {
  DRAFTING_SPEC: 'Drafting Spec',
  AWS_REVIEW: 'AWS Review',
  AWAITING_APPROVAL: 'Awaiting Approval',
  PLANNING: 'Planning',
  IMPLEMENTING: 'Building',
  LIGHT_IMPLEMENTING: 'Light Build',
  CODE_REVIEW: 'Code Review',
  TESTING: 'Testing',
  DONE: 'Complete',
  FAILED: 'Failed',
};

const PHASE_COLORS: Partial<Record<NonNullable<PhaseId>, string>> = {
  DRAFTING_SPEC: '#ffb24d',
  AWS_REVIEW: '#ffb24d',
  AWAITING_APPROVAL: '#ffb24d',
  PLANNING: '#8b7bff',
  IMPLEMENTING: '#8b7bff',
  LIGHT_IMPLEMENTING: '#5bc8ff',
  CODE_REVIEW: '#8b7bff',
  TESTING: '#ffb24d',
  DONE: '#37e0a0',
  FAILED: '#ff5b45',
};

interface TopBarProps {
  feature: FeatureSummary | null;
  phase: PhaseId;
  agentStatuses: Record<string, AgentDisplayStatus>;
  motionEnabled: boolean;
  onToggleMotion: () => void;
  corpLinkReachable: boolean | null;
  features: FeatureSummary[];
  selectedId: string | null;
  onSelectFeature: (id: string | null) => void;
  featuresLoading: boolean;
  createFeature: (name: string, requirement: string, repos: string[]) => Promise<FeatureSummary>;
  loadRepos: () => Promise<RepoEntry[]>;
}

export function TopBar({
  feature,
  phase,
  agentStatuses,
  motionEnabled,
  onToggleMotion,
  corpLinkReachable,
  features,
  selectedId,
  onSelectFeature,
  featuresLoading,
  createFeature,
  loadRepos,
}: TopBarProps) {
  const [showCreate, setShowCreate] = useState(false);
  // 'queued' excluded from RUNNING — it doubles as "no event received yet" in SolarMesh
  const runningCount = Object.values(agentStatuses).filter((s) => s === 'working').length;
  const parkedCount = Object.values(agentStatuses).filter((s) => s === 'waiting').length;

  const phaseColor = (phase && PHASE_COLORS[phase]) ?? '#6b7290';
  const phaseName = (phase && PHASE_NAMES[phase]) ?? 'Idle';

  return (
    <header className="app-topbar">
      {/* Left group */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {/* Logo */}
        <img
          src="/favicon.svg"
          alt=""
          aria-hidden="true"
          style={{ width: 26, height: 26, flexShrink: 0 }}
        />

        {/* Wordmark */}
        <div>
          <div
            style={{
              fontFamily: 'var(--font-ui)',
              fontWeight: 700,
              fontSize: 13,
              color: '#f2f0ff',
            }}
          >
            {productName()}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontWeight: 500,
              fontSize: 8,
              letterSpacing: '0.16em',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
            }}
          >
            {import.meta.env['VITE_TENANT_LINE'] ?? 'AGENT SOLAR SYSTEM'}
          </div>
        </div>

        {/* Divider */}
        <div
          style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.1)', flexShrink: 0 }}
          aria-hidden="true"
        />

        {/* Run ID */}
        {feature && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              display: 'flex',
              gap: 5,
            }}
          >
            <span style={{ color: 'var(--text-muted)' }}>RUN</span>
            <span style={{ color: '#cfd3e6' }}>{feature.slug}</span>
          </div>
        )}

        {/* Feature selector — always visible */}
        <FeatureSelector
          features={features}
          selectedId={selectedId}
          onSelect={onSelectFeature}
          loading={featuresLoading}
        />

        {/* New feature affordance */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowCreate((v) => !v)}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-muted)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              padding: '6px 0',
            }}
          >
            {showCreate ? '▼ Hide form' : '+ New feature'}
          </button>
          {showCreate && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                zIndex: 100,
                background: 'var(--bg-panel-solid)',
                border: '1px solid var(--border-medium)',
                borderRadius: 'var(--r-card)',
                minWidth: 280,
                backdropFilter: 'blur(8px)',
                marginTop: 4,
              }}
            >
              <CreateFeatureForm
                loadRepos={loadRepos}
                onCreate={async (name, req, repos) => {
                  const f = await createFeature(name, req, repos);
                  setShowCreate(false);
                  return f;
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Right group */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Agent status indicators */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {runningCount === 0 && parkedCount === 0 ? (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                fontSize: 10,
                color: '#6b7080',
              }}
            >
              IDLE
            </span>
          ) : (
            <>
              {runningCount > 0 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    fontSize: 10,
                    color: '#9096b0',
                  }}
                >
                  <div
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: '#37e0a0',
                      boxShadow: '0 0 5px #37e0a0',
                    }}
                    aria-hidden="true"
                  />
                  {runningCount} RUNNING
                </div>
              )}
              {parkedCount > 0 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    fontSize: 10,
                    color: '#9096b0',
                  }}
                >
                  <div
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: '#b8a060',
                      boxShadow: '0 0 5px #b8a060',
                    }}
                    aria-hidden="true"
                  />
                  {parkedCount} PARKED
                </div>
              )}
            </>
          )}
        </div>

        {/* Corp-link indicator — shown only in bedrock mode (null = loading or direct API) */}
        {corpLinkReachable !== null && (
          <div
            title={
              corpLinkReachable ? 'Corp link up' : 'Bedrock unreachable — check VPN / aws sso login'
            }
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: '#9096b0',
              cursor: 'default',
            }}
          >
            <div
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: corpLinkReachable ? '#37e0a0' : '#ff5b45',
                boxShadow: corpLinkReachable ? '0 0 5px #37e0a0' : '0 0 5px #ff5b45',
              }}
              aria-hidden="true"
            />
            CORP LINK
          </div>
        )}

        {/* Phase pill */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            borderRadius: 'var(--r-pill)',
            border: `1px solid ${phaseColor}55`,
            background: `${phaseColor}14`,
            padding: '4px 10px',
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            fontSize: 10,
            color: phaseColor,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: phaseColor,
              boxShadow: `0 0 4px ${phaseColor}`,
              display: 'inline-block',
            }}
            aria-hidden="true"
          />
          {phaseName}
        </div>

        {/* Review-skipped warning badge */}
        {feature?.review_skipped && (
          <div
            style={{
              borderRadius: 'var(--r-pill)',
              border: '1px solid rgba(255,178,77,0.3)',
              background: 'rgba(255,178,77,0.12)',
              padding: '4px 10px',
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              fontSize: 9,
              letterSpacing: '0.1em',
              color: '#ffb24d',
            }}
          >
            ⚠ REVIEW SKIPPED
          </div>
        )}

        {/* Motion toggle */}
        <button
          onClick={onToggleMotion}
          title={motionEnabled ? 'Pause ambient motion' : 'Resume ambient motion'}
          style={{
            padding: '7px 11px',
            borderRadius: 'var(--r-btn)',
            border: '1px solid var(--border-strong)',
            background: 'rgba(255,255,255,0.04)',
            color: motionEnabled ? 'var(--text-primary)' : 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            fontSize: 10,
          }}
        >
          {motionEnabled ? '⏸ MOTION' : '▶ MOTION'}
        </button>
      </div>
    </header>
  );
}
