import { describe, expect, it } from 'vitest';
import { foldActivityEvents } from '../lib/activityFold.js';
import type { EventRow } from '@orrery/shared';

// Minimal TaskRow shape that foldActivityEvents consumes; matches the updated
// featureTasks API response (side + spendGuardThreshold added in step 4).
interface TestTaskRow {
  id: string;
  title: string;
  repo: string;
  side: string;
  status: string;
  turns: number | null;
  jobCount: number | null;
  spendGuardThreshold: number;
}

function makeRow(seq: number, payload: EventRow['payload']): EventRow {
  return {
    id: seq,
    featureId: 'test-feature',
    seq,
    agent: null,
    payload,
    createdAt: new Date().toISOString(),
  };
}

const BASE_TASK: TestTaskRow = {
  id: 'task-1',
  title: 'Add endpoint',
  repo: 'server',
  side: 'server',
  status: 'completed',
  turns: 2,
  jobCount: 2,
  spendGuardThreshold: 150,
};

describe('foldActivityEvents', () => {
  it('groups agent.log entries into two jobs when job_id changes in usage.recorded', () => {
    const events: EventRow[] = [
      makeRow(1, { type: 'task.started', repo: 'server', task_id: 'task-1', attempt: 1 }),
      makeRow(2, {
        type: 'usage.recorded',
        agent: 'server',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
        job_id: 'job-A',
        task_id: 'task-1',
      }),
      makeRow(3, {
        type: 'agent.log',
        agent: 'server',
        severity: 'muted',
        text: '◦ turn 1 · bash ls (42 chars)',
      }),
      makeRow(4, {
        type: 'usage.recorded',
        agent: 'server',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
        job_id: 'job-B',
        task_id: 'task-1',
      }),
      makeRow(5, {
        type: 'agent.log',
        agent: 'server',
        severity: 'muted',
        text: '◦ turn 1 · bash npm test (100 chars)',
      }),
      makeRow(6, { type: 'task.completed', repo: 'server', task_id: 'task-1' }),
    ];

    const result = foldActivityEvents(events, [BASE_TASK]);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('task');
    const task = result[0]?.kind === 'task' ? result[0].task : undefined;
    expect(task?.jobs).toHaveLength(2);
    expect(task?.jobs[0]?.jobId).toBe('job-A');
    expect(task?.jobs[0]?.rows).toHaveLength(1);
    expect(task?.jobs[1]?.jobId).toBe('job-B');
    expect(task?.jobs[1]?.rows).toHaveLength(1);
  });

  it('assigns kind=violation to non-turn lines and preserves seq order inline', () => {
    const events: EventRow[] = [
      makeRow(1, { type: 'task.started', repo: 'server', task_id: 'task-1', attempt: 1 }),
      makeRow(2, {
        type: 'usage.recorded',
        agent: 'server',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
        job_id: 'job-A',
        task_id: 'task-1',
      }),
      makeRow(3, {
        type: 'agent.log',
        agent: 'server',
        severity: 'muted',
        text: '◦ turn 1 · bash ls (42 chars)',
      }),
      makeRow(4, {
        type: 'agent.log',
        agent: 'server',
        severity: 'muted',
        text: '⚠ violation 1/3: allowlist — git status',
      }),
      makeRow(5, {
        type: 'agent.log',
        agent: 'server',
        severity: 'muted',
        text: '◦ turn 2 · bash npm ci (99 chars)',
      }),
      makeRow(6, { type: 'task.completed', repo: 'server', task_id: 'task-1' }),
    ];

    const result = foldActivityEvents(events, [BASE_TASK]);
    const task = result[0]?.kind === 'task' ? result[0].task : undefined;
    const rows = task?.jobs[0]?.rows ?? [];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.kind).toBe('turn');
    expect(rows[1]?.kind).toBe('violation');
    expect(rows[2]?.kind).toBe('turn');
    // Seq order preserved
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
    expect(rows[1]!.seq).toBeLessThan(rows[2]!.seq);
  });

  it('carries spendGuardThreshold from the task row; turns come from usage events in the span', () => {
    const taskWith100Threshold: TestTaskRow = {
      ...BASE_TASK,
      turns: 90, // DB value — should NOT flow through; event-counted turns are used instead
      spendGuardThreshold: 100,
    };
    const events: EventRow[] = [
      makeRow(1, { type: 'task.started', repo: 'server', task_id: 'task-1', attempt: 1 }),
      makeRow(2, {
        type: 'usage.recorded',
        agent: 'server',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
        job_id: 'job-A',
        task_id: 'task-1',
      }),
      makeRow(3, {
        type: 'usage.recorded',
        agent: 'server',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
        job_id: 'job-A',
        task_id: 'task-1',
      }),
      makeRow(4, { type: 'task.completed', repo: 'server', task_id: 'task-1' }),
    ];

    const result = foldActivityEvents(events, [taskWith100Threshold]);
    expect(result).toHaveLength(1);
    const task = result[0]?.kind === 'task' ? result[0].task : undefined;
    // turns = 2 (two usage events for the dev agent), not the DB value 90
    expect(task?.turns).toBe(2);
    expect(task?.spendGuardThreshold).toBe(100);
  });

  it('separates dev-agent turns from test-agent turns within a task span', () => {
    const events: EventRow[] = [
      makeRow(1, { type: 'task.started', repo: 'server', task_id: 'task-1', attempt: 1 }),
      // test agent — 3 turns
      makeRow(2, {
        type: 'usage.recorded',
        agent: 'test',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
        job_id: 'job-test-1',
        task_id: 'task-1',
      }),
      makeRow(3, {
        type: 'usage.recorded',
        agent: 'test',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
        job_id: 'job-test-1',
        task_id: 'task-1',
      }),
      makeRow(4, {
        type: 'usage.recorded',
        agent: 'test',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
        job_id: 'job-test-1',
        task_id: 'task-1',
      }),
      // dev agent — 2 turns
      makeRow(5, {
        type: 'usage.recorded',
        agent: 'server',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
        job_id: 'job-dev-1',
        task_id: 'task-1',
      }),
      makeRow(6, {
        type: 'usage.recorded',
        agent: 'server',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
        job_id: 'job-dev-1',
        task_id: 'task-1',
      }),
      makeRow(7, { type: 'task.completed', repo: 'server', task_id: 'task-1' }),
    ];

    const result = foldActivityEvents(events, [BASE_TASK]);
    const task = result[0]?.kind === 'task' ? result[0].task : undefined;
    expect(task?.turns).toBe(2);       // dev turns only
    expect(task?.testTurns).toBe(3);   // test-agent turns
    // Each job carries its own turn count and agent name
    const testJob = task?.jobs.find((j) => j.jobId === 'job-test-1');
    const devJob = task?.jobs.find((j) => j.jobId === 'job-dev-1');
    expect(testJob?.turns).toBe(3);
    expect(testJob?.agent).toBe('test');
    expect(devJob?.turns).toBe(2);
    expect(devJob?.agent).toBe('server');
  });
});

describe('foldActivityEvents — feature-level agent sections', () => {
  it('feature-level spec turns render in a feature-agent section', () => {
    const events: EventRow[] = [
      makeRow(1, {
        type: 'usage.recorded',
        agent: 'spec',
        model: 'claude-sonnet-4-20250514',
        input_tokens: 100,
        output_tokens: 50,
      }),
      makeRow(2, {
        type: 'agent.log',
        agent: 'spec',
        severity: 'muted',
        text: '◦ turn 1 · bash ls (5 chars)',
      }),
    ];
    const result = foldActivityEvents(events, []);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('feature-agent');
    if (result[0]?.kind === 'feature-agent') {
      expect(result[0].section.agent).toBe('spec');
      expect(result[0].section.label).toBe('Spec');
      expect(result[0].section.rows).toHaveLength(1);
    }
  });

  it('feature-level review turns render in feature-agent section after task', () => {
    const events: EventRow[] = [
      makeRow(1, { type: 'task.started', repo: 'server', task_id: 'task-1', attempt: 1 }),
      makeRow(2, {
        type: 'usage.recorded',
        agent: 'server',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
        job_id: 'j1',
        task_id: 'task-1',
      }),
      makeRow(3, {
        type: 'agent.log',
        agent: 'server',
        severity: 'muted',
        text: '◦ turn 1 · bash x (5 chars)',
      }),
      makeRow(4, { type: 'task.completed', repo: 'server', task_id: 'task-1' }),
      makeRow(5, {
        type: 'usage.recorded',
        agent: 'review',
        model: 'm',
        input_tokens: 200,
        output_tokens: 100,
      }),
      makeRow(6, {
        type: 'agent.log',
        agent: 'review',
        severity: 'muted',
        text: '◦ turn 1 · bash grep (20 chars)',
      }),
    ];
    const result = foldActivityEvents(events, [BASE_TASK]);
    const reviewSection = result.find(
      (s) => s.kind === 'feature-agent' && s.section.agent === 'review',
    );
    expect(reviewSection).toBeDefined();
    if (reviewSection?.kind === 'feature-agent') {
      expect(reviewSection.section.label).toBe('Code Review');
      expect(reviewSection.section.rows).toHaveLength(1);
    }
  });

  it('final test agent turns render in feature-agent section', () => {
    const events: EventRow[] = [
      makeRow(1, {
        type: 'usage.recorded',
        agent: 'test',
        model: 'm',
        input_tokens: 500,
        output_tokens: 200,
      }),
      makeRow(2, {
        type: 'agent.log',
        agent: 'test',
        severity: 'muted',
        text: '◦ turn 1 · bash npm test (30 chars)',
      }),
      makeRow(3, {
        type: 'agent.log',
        agent: 'test',
        severity: 'muted',
        text: '◦ turn 2 · bash npm test (30 chars)',
      }),
    ];
    const result = foldActivityEvents(events, []);
    const testSection = result.find(
      (s) => s.kind === 'feature-agent' && s.section.agent === 'test',
    );
    expect(testSection).toBeDefined();
    if (testSection?.kind === 'feature-agent') {
      expect(testSection.section.label).toBe('Testing');
      expect(testSection.section.rows).toHaveLength(2);
    }
  });

  it('sections ordered chronologically across feature-agent and task kinds', () => {
    const events: EventRow[] = [
      // spec at seq 1-2 (before task)
      makeRow(1, {
        type: 'usage.recorded',
        agent: 'spec',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
      }),
      makeRow(2, {
        type: 'agent.log',
        agent: 'spec',
        severity: 'muted',
        text: '◦ turn 1 · x (1 chars)',
      }),
      // task at seq 3-5
      makeRow(3, { type: 'task.started', repo: 'server', task_id: 'task-1', attempt: 1 }),
      makeRow(4, {
        type: 'usage.recorded',
        agent: 'server',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
        job_id: 'j1',
        task_id: 'task-1',
      }),
      makeRow(5, { type: 'task.completed', repo: 'server', task_id: 'task-1' }),
      // review at seq 6-7 (after task)
      makeRow(6, {
        type: 'usage.recorded',
        agent: 'review',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
      }),
      makeRow(7, {
        type: 'agent.log',
        agent: 'review',
        severity: 'muted',
        text: '◦ turn 1 · y (1 chars)',
      }),
    ];
    const result = foldActivityEvents(events, [BASE_TASK]);
    expect(result).toHaveLength(3);
    expect(result[0]?.kind).toBe('feature-agent');
    if (result[0]?.kind === 'feature-agent') expect(result[0].section.agent).toBe('spec');
    expect(result[1]?.kind).toBe('task');
    expect(result[2]?.kind).toBe('feature-agent');
    if (result[2]?.kind === 'feature-agent') expect(result[2].section.agent).toBe('review');
  });

  it('agent.log before first usage.recorded does not produce a duplicate empty header', () => {
    // When agent.log arrives before any usage.recorded for the same run, a synthetic
    // section is created. The subsequent usage.recorded with job_id must upgrade (rename)
    // that synthetic section instead of creating a second one.
    const events: EventRow[] = [
      makeRow(1, {
        type: 'agent.log',
        agent: 'aws',
        severity: 'muted',
        text: '◦ turn 1 · bash ls (5 chars)',
      }),
      makeRow(2, {
        type: 'usage.recorded',
        agent: 'aws',
        model: 'm',
        input_tokens: 100,
        output_tokens: 50,
        job_id: 'aws-job-1',
      }),
      makeRow(3, {
        type: 'agent.log',
        agent: 'aws',
        severity: 'muted',
        text: '◦ turn 2 · bash grep (10 chars)',
      }),
    ];
    const result = foldActivityEvents(events, []);
    // Must produce exactly ONE section for 'aws', not two.
    const awsSections = result.filter((s) => s.kind === 'feature-agent' && s.section.agent === 'aws');
    expect(awsSections).toHaveLength(1);
    if (awsSections[0]?.kind === 'feature-agent') {
      expect(awsSections[0].section.turns).toBe(1);
      expect(awsSections[0].section.rows).toHaveLength(2);
    }
  });

  it('turns counted from usage.recorded for feature-level agents', () => {
    const events: EventRow[] = [
      makeRow(1, {
        type: 'usage.recorded',
        agent: 'planner',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
      }),
      makeRow(2, {
        type: 'usage.recorded',
        agent: 'planner',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
      }),
      makeRow(3, {
        type: 'usage.recorded',
        agent: 'planner',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
      }),
    ];
    const result = foldActivityEvents(events, []);
    expect(result).toHaveLength(1);
    if (result[0]?.kind === 'feature-agent') {
      expect(result[0].section.turns).toBe(3);
    }
  });

  it('costUsd computed from token counts', () => {
    // claude-sonnet-4 pricing: $3/1M input, $15/1M output
    // 1000 input + 500 output = 0.003 + 0.0075 = 0.0105
    const events: EventRow[] = [
      makeRow(1, {
        type: 'usage.recorded',
        agent: 'spec',
        model: 'claude-sonnet-4-20250514',
        input_tokens: 1000,
        output_tokens: 500,
      }),
    ];
    const result = foldActivityEvents(events, []);
    if (result[0]?.kind === 'feature-agent') {
      expect(result[0].section.costUsd).toBeGreaterThan(0);
      expect(result[0].section.costUsd).toBeCloseTo(0.0105, 4);
    }
  });
});
