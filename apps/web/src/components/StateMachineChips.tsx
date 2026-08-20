import { CHIP_STATE_MAP } from '@orrery/shared';
import type { PhaseId } from '../types/ui.js';

const PHASE_ORDER: NonNullable<PhaseId>[] = [
  'DRAFTING_SPEC',
  'AWS_REVIEW',
  'AWAITING_APPROVAL',
  'PLANNING',
  'IMPLEMENTING',
  'LIGHT_IMPLEMENTING',
  'CODE_REVIEW',
  'TESTING',
  'DONE',
];

type ChipStatus = 'done' | 'current' | 'upcoming';

function getChipStatus(chipStates: readonly string[], currentPhase: PhaseId): ChipStatus {
  if (!currentPhase) return 'upcoming';

  if (chipStates.includes(currentPhase)) return 'current';

  const currentIdx = PHASE_ORDER.indexOf(currentPhase);
  const allBefore = chipStates.every(
    (s) => PHASE_ORDER.indexOf(s as NonNullable<PhaseId>) < currentIdx,
  );
  return allBefore ? 'done' : 'upcoming';
}

const CHIP_COLORS: Record<ChipStatus, { border: string; bg: string; text: string }> = {
  done: { border: 'rgba(55,224,160,0.27)', bg: 'rgba(55,224,160,0.07)', text: '#37e0a0' },
  current: { border: 'rgba(139,123,255,0.27)', bg: 'rgba(139,123,255,0.07)', text: '#8b7bff' },
  upcoming: { border: 'rgba(75,81,112,0.27)', bg: 'rgba(75,81,112,0.07)', text: '#4b5170' },
};

interface StateMachineChipsProps {
  currentPhase: PhaseId;
}

export function StateMachineChips({ currentPhase }: StateMachineChipsProps) {
  return (
    <div>
      <div className="section-label">State Machine</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {(Object.entries(CHIP_STATE_MAP) as [string, readonly string[]][]).map(
          ([chipLabel, states]) => {
            const status = getChipStatus(states, currentPhase);
            const colors = CHIP_COLORS[status];
            return (
              <span
                key={chipLabel}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 600,
                  fontSize: 8.5,
                  borderRadius: 'var(--r-chip)',
                  padding: '5px 7px',
                  border: `1px solid ${colors.border}`,
                  background: colors.bg,
                  color: colors.text,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                }}
              >
                {chipLabel}
              </span>
            );
          },
        )}
      </div>
    </div>
  );
}
