#!/usr/bin/env tsx
/**
 * Seed a feature in a specific state for manual smoke-testing.
 *
 * Usage:
 *   tsx --env-file=.env scripts/seed-feature.ts \
 *     --name "My Feature" \
 *     --state AWAITING_APPROVAL
 *
 * Supported states: DRAFTING_SPEC, AWS_REVIEW, AWAITING_APPROVAL, PLANNING,
 *                   AWAITING_PLAN_APPROVAL, IMPLEMENTING, CODE_REVIEW, TESTING
 *
 * The script emits the minimal event log needed to reach the target state,
 * so event replay in the UI works correctly.
 */

import { PrismaClient } from '@prisma/client';

const VALID_STATES = [
  'DRAFTING_SPEC',
  'AWS_REVIEW',
  'AWAITING_APPROVAL',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'IMPLEMENTING',
  'CODE_REVIEW',
  'TESTING',
] as const;

type SeedState = (typeof VALID_STATES)[number];

function parseArgs(): { name: string; state: SeedState } {
  const args = process.argv.slice(2);
  let name = `Seed Feature ${Date.now()}`;
  let state: string = 'DRAFTING_SPEC';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) name = args[++i]!;
    if (args[i] === '--state' && args[i + 1]) state = args[++i]!;
  }

  if (!VALID_STATES.includes(state as SeedState)) {
    console.error(`Invalid state: ${state}`);
    console.error(`Valid states: ${VALID_STATES.join(', ')}`);
    process.exit(1);
  }

  return { name, state: state as SeedState };
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// State progression for minimal event seeding
const STATE_TRANSITIONS: Array<{ from: string; to: string; event: string }> = [
  { from: 'DRAFTING_SPEC', to: 'AWS_REVIEW', event: 'SUBMIT_SPEC' },
  { from: 'AWS_REVIEW', to: 'AWAITING_APPROVAL', event: 'AWS_DONE' },
  { from: 'AWAITING_APPROVAL', to: 'PLANNING', event: 'APPROVE' },
  { from: 'PLANNING', to: 'AWAITING_PLAN_APPROVAL', event: 'SUBMIT_PLAN' },
  { from: 'AWAITING_PLAN_APPROVAL', to: 'IMPLEMENTING', event: 'APPROVE_PLAN' },
  { from: 'IMPLEMENTING', to: 'CODE_REVIEW', event: 'SUBMIT_REVIEW' },
  { from: 'CODE_REVIEW', to: 'TESTING', event: 'REVIEW_PASS' },
];

void (async () => {
  const { name, state } = parseArgs();
  const prisma = new PrismaClient();

  try {
    const slug = toSlug(name);
    let seq = 1;

    // Create feature
    const feature = await prisma.feature.create({
      data: {
        slug: `${slug}-${Date.now()}`,
        name,
        requirement: `Seeded feature for smoke testing state: ${state}`,
        status: state,
        proposedSpec:
          state !== 'DRAFTING_SPEC'
            ? `## Overview\nSeeded spec for ${name}\n## User stories\n- As a user, I want to test ${name}`
            : null,
      },
    });

    // Emit phase.changed events for each transition up to the target state
    const transitions: Array<{ from: string | null; to: string }> = [
      { from: null, to: 'DRAFTING_SPEC' },
    ];

    for (const t of STATE_TRANSITIONS) {
      transitions.push({ from: t.from, to: t.to });
      if (t.to === state) break;
    }

    for (const t of transitions) {
      await prisma.event.create({
        data: {
          featureId: feature.id,
          seq: seq++,
          type: 'phase.changed',
          agent: 'orchestrator',
          payload: { type: 'phase.changed', from: t.from, to: t.to },
        },
      });
    }

    // Emit gate.opened for gate states so the UI shows the right card
    if (state === 'AWAITING_APPROVAL' || state === 'AWAITING_PLAN_APPROVAL') {
      const gate =
        state === 'AWAITING_APPROVAL' ? 'spec_approval' : 'plan_approval';
      const summary =
        state === 'AWAITING_APPROVAL'
          ? `Seeded spec for ${name}`
          : `1 task(s) across 1 repo(s)`;
      await prisma.event.create({
        data: {
          featureId: feature.id,
          seq: seq++,
          type: 'gate.opened',
          agent: 'orchestrator',
          payload: { type: 'gate.opened', gate, summary, revision: 0 },
        },
      });
    }

    console.log(`\n✅ Feature seeded`);
    console.log(`   id:     ${feature.id}`);
    console.log(`   name:   ${name}`);
    console.log(`   slug:   ${feature.slug}`);
    console.log(`   state:  ${state}`);
    console.log(`   events: ${seq - 1}`);
    console.log(`\nOpen: http://localhost:5173/features/${feature.id}`);
  } finally {
    await prisma.$disconnect();
  }
})();
