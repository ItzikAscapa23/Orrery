import { z } from 'zod';

export const AgentTierSchema = z.enum(['spec', 'build', 'qa', 'core']);
export type AgentTier = z.infer<typeof AgentTierSchema>;

export const AgentIdSchema = z.enum([
  'spec',
  'aws',
  'planner',
  'test-planner',
  'client',
  'server',
  'review',
  'test',
  'orchestrator',
]);
export type AgentId = z.infer<typeof AgentIdSchema>;

export interface AgentMeta {
  id: AgentId;
  displayName: string;
  tier: AgentTier;
}

export const AGENT_REGISTRY: Record<AgentId, AgentMeta> = {
  spec: { id: 'spec', displayName: 'Spec Agent', tier: 'spec' },
  aws: { id: 'aws', displayName: 'AWS Expert', tier: 'spec' },
  planner: { id: 'planner', displayName: 'Planner', tier: 'build' },
  'test-planner': { id: 'test-planner', displayName: 'Test Planner', tier: 'build' },
  client: { id: 'client', displayName: 'Client Dev', tier: 'build' },
  server: { id: 'server', displayName: 'Server Dev', tier: 'build' },
  review: { id: 'review', displayName: 'Review Agent', tier: 'qa' },
  test: { id: 'test', displayName: 'Test Agent', tier: 'qa' },
  orchestrator: { id: 'orchestrator', displayName: 'Orchestrator', tier: 'core' },
};

/** UI chip grouping: maps chip label → one or more machine states */
export const CHIP_STATE_MAP = {
  SPEC: ['DRAFTING_SPEC'],
  AWS: ['AWS_REVIEW'],
  APPROVE: ['AWAITING_APPROVAL'],
  BUILD: ['PLANNING', 'AWAITING_PLAN_APPROVAL', 'IMPLEMENTING', 'LIGHT_IMPLEMENTING'],
  QA: ['CODE_REVIEW', 'TESTING'],
  SHIP: ['DONE'],
} as const;

/** Feature pipeline path: FULL uses the complete pipeline; LIGHT skips AWS review, planning, and testing. */
export type FeaturePath = 'FULL' | 'LIGHT';
