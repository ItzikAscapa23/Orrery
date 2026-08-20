import type { CSSProperties } from 'react';
import type { AgentId } from '@orrery/shared';
import { AGENT_REGISTRY } from '@orrery/shared';
import type { AgentDisplayStatus, SelectedEntity } from '../../types/ui.js';
import { getOrbStyle, getStatusColor, getStatusLabel } from './statusStyles.js';
import type { PlanetConfig, RingConfig } from './ringConfig.js';

/** Estimated rendered height of .planet-label-plate (px). Must stay in sync with
 *  planetLayout.test.ts LABEL_PLATE_H constant and the CSS font/padding values. */
export const LABEL_PLATE_H = 34;
/** Gap between orb outer edge and label plate inner edge (px). */
export const LABEL_GAP = 7;

interface PlanetProps {
  config: PlanetConfig;
  ring: RingConfig;
  status: AgentDisplayStatus;
  selected: SelectedEntity;
  motionEnabled: boolean;
  onSelect: (id: AgentId) => void;
}

export function Planet({ config, ring, status, selected, motionEnabled, onSelect }: PlanetProps) {
  const { agentId, orbSize, startAngle, color } = config;
  const ringRadius = ring.radius;
  const meta = AGENT_REGISTRY[agentId];
  const isSelected = selected === agentId;
  const isWorking = status === 'working' || status === 'waiting';

  const orbStyle = getOrbStyle(status, color, isSelected);
  const statusColor = getStatusColor(status);
  const statusLabel = getStatusLabel(status);

  // Negative delay pre-advances the animation so the planet starts at startAngle.
  const startDelay = `${-(startAngle / 360) * ring.period}s`;
  const playState = motionEnabled ? 'running' : 'paused';

  // Arm positions: negative top = outward from orbit-square centre.
  const orbArmTop = -(ringRadius + orbSize / 2);
  const labelArmTop = -(ringRadius + orbSize / 2 + LABEL_GAP + LABEL_PLATE_H);

  // Energy beam: spans from orbit-square centre up to just below the orb inward edge.
  const beamHeight = ringRadius - orbSize / 2 - 4;

  return (
    <div
      className="orbit-square"
      style={
        {
          '--start-delay': startDelay,
          animationPlayState: playState,
        } as CSSProperties
      }
    >
      {/* Energy beam: centre → planet, behind the orb */}
      {isWorking && (
        <div
          className="energy-beam"
          style={{
            top: -beamHeight,
            height: beamHeight,
            background: `linear-gradient(to top, transparent, ${color})`,
            zIndex: 0,
          }}
        >
          <div
            className="beam-dot"
            style={{
              background: color,
              boxShadow: `0 0 6px ${color}`,
              animationPlayState: playState,
            }}
          />
        </div>
      )}

      {/* Orb arm — centred on the ring circle, counter-rotated for upright text */}
      <div
        className="orb-arm"
        style={
          {
            top: orbArmTop,
            left: 0,
            animationPlayState: playState,
            zIndex: 1,
          } as CSSProperties
        }
        onClick={() => onSelect(agentId)}
        role="button"
        aria-label={`Select ${meta.displayName}`}
        aria-pressed={isSelected}
      >
        <div
          className="planet-orb"
          style={{
            width: orbSize,
            height: orbSize,
            background: orbStyle.background,
            borderColor: orbStyle.borderColor,
            boxShadow: orbStyle.boxShadow,
          }}
        >
          {orbStyle.haloColor && (
            <div
              className="planet-halo"
              style={{
                background: `radial-gradient(${orbStyle.haloColor} 0%, transparent 70%)`,
              }}
            />
          )}
          <span className="planet-orb-tag" style={{ color: orbStyle.tagColor }}>
            {agentId.toUpperCase().slice(0, 4)}
          </span>
          <div
            className={`planet-status-dot${orbStyle.blinking ? ' blinking' : ''}`}
            style={{
              background: statusColor,
              boxShadow: `0 0 4px ${statusColor}`,
            }}
          />
        </div>
      </div>

      {/* Label arm — beyond the orb, radially outward from the Sun */}
      <div
        className="label-arm"
        style={
          {
            top: labelArmTop,
            left: 0,
            animationPlayState: playState,
          } as CSSProperties
        }
        onClick={() => onSelect(agentId)}
        aria-hidden="true"
      >
        <div className="planet-label-plate">
          <div className="planet-name">{meta.displayName}</div>
          <div className="planet-status-text" style={{ color: statusColor }}>
            {statusLabel}
          </div>
        </div>
      </div>
    </div>
  );
}
