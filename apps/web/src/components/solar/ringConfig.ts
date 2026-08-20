import type { AgentId } from '@orrery/shared';

export type RingId = 'orbit';

/**
 * Distributes `count` angles evenly around a ring, ensuring none falls within
 * ±exclusionZoneDeg of the top pole (90°) or bottom pole (270°). Angles that
 * still violate after the best base-rotation search are nudged to the nearest
 * valid position just outside the relevant zone.
 *
 * The function is pure and deterministic: identical arguments always produce
 * identical output.
 */
export function computeAngles(count: number, exclusionZoneDeg = 25): number[] {
  const step = 360 / count;

  function inZone(a: number): boolean {
    const norm = ((a % 360) + 360) % 360;
    const topLo = 90 - exclusionZoneDeg;
    const topHi = 90 + exclusionZoneDeg;
    const botLo = 270 - exclusionZoneDeg;
    const botHi = 270 + exclusionZoneDeg;
    return (norm > topLo && norm < topHi) || (norm > botLo && norm < botHi);
  }

  function nudge(a: number): number {
    const norm = ((a % 360) + 360) % 360;
    const topLo = 90 - exclusionZoneDeg;
    const topHi = 90 + exclusionZoneDeg;
    const botLo = 270 - exclusionZoneDeg;
    const botHi = 270 + exclusionZoneDeg;
    if (norm > topLo && norm < topHi) {
      // Push to whichever boundary is closer
      return norm - topLo < topHi - norm ? topLo : topHi;
    }
    if (norm > botLo && norm < botHi) {
      return norm - botLo < botHi - norm ? botLo : botHi;
    }
    return norm;
  }

  // Try each integer rotation offset in [0, step) to find one where all angles
  // are clear; fall back to per-angle nudging if none is fully clean.
  for (let offset = 0; offset < step; offset++) {
    const candidate = Array.from(
      { length: count },
      (_, i) => (((offset + i * step) % 360) + 360) % 360,
    );
    if (candidate.every((a) => !inZone(a))) return candidate;
  }

  // No clean rotation — nudge each violating angle individually.
  return Array.from({ length: count }, (_, i) => {
    const raw = (((i * step) % 360) + 360) % 360;
    return inZone(raw) ? nudge(raw) : raw;
  });
}

export interface RingConfig {
  id: RingId;
  radius: number;
  period: number;
  color: string;
  litClass: string;
  agents: AgentId[];
}

/** Design table: single orbit ring — all pipeline agents */
export const RINGS: RingConfig[] = [
  {
    id: 'orbit',
    radius: 250,
    period: 120,
    color: '#8b7bff',
    litClass: 'ring-lit',
    agents: ['spec', 'aws', 'planner', 'test-planner', 'server', 'client', 'review', 'test'],
  },
];

/** Design table: per-agent planet config */
export interface PlanetConfig {
  agentId: AgentId;
  ring: RingId;
  orbSize: number;
  startAngle: number; // degrees, clockwise from 12-o'clock
  color: string;
}

/** Pipeline order clockwise from 12-o'clock, evenly spaced at 45°. */
export const PLANETS: PlanetConfig[] = [
  { agentId: 'spec', ring: 'orbit', orbSize: 52, startAngle: 0, color: '#8b7bff' },
  { agentId: 'aws', ring: 'orbit', orbSize: 52, startAngle: 45, color: '#8b7bff' },
  { agentId: 'planner', ring: 'orbit', orbSize: 52, startAngle: 90, color: '#8b7bff' },
  { agentId: 'test-planner', ring: 'orbit', orbSize: 52, startAngle: 135, color: '#8b7bff' },
  { agentId: 'server', ring: 'orbit', orbSize: 52, startAngle: 180, color: '#8b7bff' },
  { agentId: 'client', ring: 'orbit', orbSize: 52, startAngle: 225, color: '#8b7bff' },
  { agentId: 'review', ring: 'orbit', orbSize: 52, startAngle: 270, color: '#8b7bff' },
  { agentId: 'test', ring: 'orbit', orbSize: 52, startAngle: 315, color: '#8b7bff' },
];

export function getRingForAgent(_agentId: AgentId): RingConfig {
  return RINGS[0]!;
}
