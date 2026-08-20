import { describe, expect, it } from 'vitest';
import { computeAngles, PLANETS, getRingForAgent } from '../components/solar/ringConfig.js';
import { LABEL_GAP, LABEL_PLATE_H } from '../components/solar/Planet.js';

// Z-index invariant (not assertable at unit level — enforced by CSS value):
//   .orbit-square { z-index: 10 }  >  .sun-wrapper { z-index: 5 }
// Planets are geometrically clear of the sun disc at all ring radii (see
// viewport containment tests below), but without z-index: 10 the sun paints
// over them in the browser stacking context. Verified visually in smoke test.

const EXCLUSION_ZONE = 25;
const TOP_LO = 90 - EXCLUSION_ZONE; // 65
const TOP_HI = 90 + EXCLUSION_ZONE; // 115
const BOT_LO = 270 - EXCLUSION_ZONE; // 245
const BOT_HI = 270 + EXCLUSION_ZONE; // 295

function inExclusionZone(angle: number): boolean {
  const a = ((angle % 360) + 360) % 360;
  return (a > TOP_LO && a < TOP_HI) || (a > BOT_LO && a < BOT_HI);
}

// ── Group 1: computeAngles is pure and deterministic ─────────────────────────

describe('computeAngles — determinism', () => {
  it('returns identical results on repeated calls with count=2', () => {
    expect(computeAngles(2)).toEqual(computeAngles(2));
  });

  it('returns identical results on repeated calls with count=2 and explicit zone', () => {
    expect(computeAngles(2, 25)).toEqual(computeAngles(2, 25));
  });

  it('returns identical results on repeated calls with count=6', () => {
    expect(computeAngles(6)).toEqual(computeAngles(6));
  });

  it('returns the requested number of angles', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(computeAngles(n)).toHaveLength(n);
    }
  });

  it('all returned angles are in [0, 360)', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      for (const a of computeAngles(n)) {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(360);
      }
    }
  });
});

// ── Group 2: no angle falls in the exclusion zone ────────────────────────────

describe('computeAngles — exclusion zone (default 25°)', () => {
  for (let n = 1; n <= 6; n++) {
    it(`count=${n}: no angle inside [${TOP_LO}°–${TOP_HI}°] or [${BOT_LO}°–${BOT_HI}°]`, () => {
      for (const angle of computeAngles(n)) {
        expect(inExclusionZone(angle)).toBe(false);
      }
    });
  }
});

describe('computeAngles — exclusion zone (30°)', () => {
  const zone = 30;
  const tLo = 90 - zone;
  const tHi = 90 + zone;
  const bLo = 270 - zone;
  const bHi = 270 + zone;

  function inZone30(angle: number): boolean {
    const a = ((angle % 360) + 360) % 360;
    return (a > tLo && a < tHi) || (a > bLo && a < bHi);
  }

  for (let n = 1; n <= 6; n++) {
    it(`count=${n}: no angle inside 30° exclusion zones`, () => {
      for (const angle of computeAngles(n, zone)) {
        expect(inZone30(angle)).toBe(false);
      }
    });
  }
});

// ── Group 3: PLANETS structure ───────────────────────────────────────────────

describe('PLANETS — single orbit ring', () => {
  it('has exactly 8 entries (orchestrator is the Sun, not a planet)', () => {
    expect(PLANETS).toHaveLength(8);
  });

  it('all planets are on the orbit ring', () => {
    for (const planet of PLANETS) {
      expect(planet.ring).toBe('orbit');
    }
  });

  it('pipeline order: angles increase in 45° steps', () => {
    const ORDER = [
      'spec',
      'aws',
      'planner',
      'test-planner',
      'server',
      'client',
      'review',
      'test',
    ] as const;
    for (let i = 0; i < ORDER.length; i++) {
      const p = PLANETS.find((x) => x.agentId === ORDER[i]);
      expect(p).toBeDefined();
      expect(p!.startAngle).toBe(i * 45);
    }
  });
});

// ── Group 4: PLANETS viewport bounds ─────────────────────────────────────────

describe('PLANETS — viewport containment', () => {
  const HALF_CANVAS = 372; // half of 745px design canvas

  it('every planet orb disc fits fully inside the design canvas', () => {
    for (const planet of PLANETS) {
      const ring = getRingForAgent(planet.agentId);
      const reach = ring.radius + planet.orbSize / 2;
      expect(reach).toBeLessThan(HALF_CANVAS);
    }
  });

  it('every planet label arm fits fully inside the design canvas', () => {
    for (const planet of PLANETS) {
      const ring = getRingForAgent(planet.agentId);
      const labelReach = ring.radius + planet.orbSize / 2 + LABEL_GAP + LABEL_PLATE_H;
      expect(labelReach).toBeLessThan(HALF_CANVAS);
    }
  });
});

// ── Group 5: test-planner registration ───────────────────────────────────────

describe('PLANETS — test-planner registration', () => {
  it('includes a test-planner planet on the orbit ring', () => {
    const tp = PLANETS.find((p) => p.agentId === 'test-planner');
    expect(tp).toBeDefined();
    expect(tp!.ring).toBe('orbit');
    expect(tp!.startAngle).toBe(135);
  });
});
