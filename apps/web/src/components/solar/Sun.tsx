import type { PhaseId, SelectedEntity } from '../../types/ui.js';

interface SunProps {
  phase: PhaseId;
  selected: SelectedEntity;
  motionEnabled: boolean;
  onSelect: () => void;
}

function getSunStatus(phase: PhaseId): { label: string; color: string } {
  switch (phase) {
    case 'AWAITING_APPROVAL':
      return { label: 'AWAITING APPROVAL', color: '#ffb24d' };
    case 'AWAITING_PLAN_APPROVAL':
      return { label: 'AWAITING PLAN', color: '#ffb24d' };
    case 'AWAITING_TEST_PLAN_APPROVAL':
      return { label: 'AWAITING TEST PLAN', color: '#ffb24d' };
    case 'PLANNING':
    case 'PLANNING_TESTS':
    case 'IMPLEMENTING':
    case 'LIGHT_IMPLEMENTING':
    case 'CODE_REVIEW':
    case 'TESTING':
      return { label: 'ORCHESTRATING', color: '#8b7bff' };
    case 'DONE':
      return { label: 'DONE', color: '#37e0a0' };
    case 'FAILED':
      return { label: 'FAILED', color: '#ff5b45' };
    case null:
    case 'DRAFTING_SPEC':
    case 'AWS_REVIEW':
      return { label: 'WAITING', color: '#ffb24d' };
  }
}

export function Sun({ phase, selected, motionEnabled, onSelect }: SunProps) {
  const { label: statusLabel, color: statusColor } = getSunStatus(phase);
  const isSelected = selected === 'orchestrator';
  const isAwaiting = phase === 'AWAITING_APPROVAL';
  const coronaColor = isAwaiting ? '#ffb24d' : '#ff5b45';
  const playState = motionEnabled ? 'running' : 'paused';

  return (
    <div
      className="sun-wrapper"
      onClick={onSelect}
      role="button"
      aria-label="Select Orchestrator"
      aria-pressed={isSelected}
      style={isSelected ? { filter: 'brightness(1.15)' } : undefined}
    >
      <div className="sun-core">
        {/* Corona pulse */}
        <div
          className="sun-corona"
          style={{
            background: `radial-gradient(${coronaColor}55 0%, transparent 70%)`,
            animationPlayState: playState,
          }}
        />
        {/* Flare ring */}
        <div className="sun-flare" style={{ animationPlayState: playState }} />

        {/* Label plate — overlaid at the visual centre of the disc */}
        <div className="sun-label-plate">
          <div className="sun-tag">SOL · ORCHESTRATOR</div>
          <div className="sun-name">Orchestrator</div>
          <div
            className="sun-status-pill"
            style={{
              borderColor: `${statusColor}55`,
              background: `${statusColor}14`,
              color: statusColor,
            }}
          >
            <span
              className="status-dot"
              style={{
                background: statusColor,
                boxShadow: `0 0 4px ${statusColor}`,
                width: 6,
                height: 6,
              }}
            />
            {statusLabel}
          </div>
        </div>
      </div>
    </div>
  );
}
