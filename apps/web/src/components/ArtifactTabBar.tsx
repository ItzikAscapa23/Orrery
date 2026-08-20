import { ARTIFACT_KINDS } from '@orrery/shared';
import type { ArtifactKind } from '@orrery/shared';

export type CentreTab = 'mesh' | 'requirement' | ArtifactKind | 'test-report' | 'activity';

const TAB_LABELS: Record<CentreTab, string> = {
  mesh: 'MESH',
  requirement: 'REQUIREMENT',
  spec: 'SPEC',
  plan: 'PLAN',
  contract: 'CONTRACT',
  'test-plan': 'TEST PLAN',
  'test-report': 'TEST REPORT',
  activity: 'ACTIVITY',
};

const ALL_TABS: CentreTab[] = ['mesh', 'requirement', ...ARTIFACT_KINDS, 'test-report', 'activity'];

interface ArtifactTabBarProps {
  activeTab: CentreTab;
  committedKinds: ArtifactKind[];
  hasTestReport: boolean;
  onChange: (tab: CentreTab) => void;
}

export function ArtifactTabBar({
  activeTab,
  committedKinds,
  hasTestReport,
  onChange,
}: ArtifactTabBarProps) {
  return (
    <div
      role="tablist"
      aria-label="Centre pane tabs"
      style={{
        display: 'flex',
        flexShrink: 0,
        borderBottom: '1px solid var(--border-faint)',
        padding: '0 12px',
        gap: 2,
        background: 'var(--bg-surface, #0d0f1c)',
      }}
    >
      {ALL_TABS.map((tab) => {
        const isActive = tab === activeTab;
        const isEnabled =
          tab === 'mesh' || tab === 'requirement' || tab === 'activity'
            ? true
            : tab === 'test-report'
              ? hasTestReport
              : committedKinds.includes(tab);

        return (
          <button
            key={tab}
            role="tab"
            aria-selected={isActive}
            aria-disabled={!isEnabled}
            disabled={!isEnabled}
            onClick={() => {
              if (isEnabled) onChange(tab);
            }}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.1em',
              padding: '7px 10px 6px',
              borderBottom: isActive
                ? '2px solid var(--accent-primary, #7c8cff)'
                : '2px solid transparent',
              color: isActive
                ? 'var(--accent-primary, #7c8cff)'
                : isEnabled
                  ? 'var(--text-secondary)'
                  : 'var(--text-muted)',
              opacity: isEnabled ? 1 : 0.35,
              cursor: isEnabled ? 'pointer' : 'not-allowed',
              background: 'none',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {TAB_LABELS[tab]}
          </button>
        );
      })}
    </div>
  );
}
