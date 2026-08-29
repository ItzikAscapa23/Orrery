import { describe, expect, it } from 'vitest';
import { foldEvents } from '../lib/eventFold.js';
import type { EventRow } from '@orrery/shared';
import type { TaskFailureEntry } from '../types/ui.js';
import serverUptime6Events from './fixtures/server-uptime6-events.json';

function asFailure(f: TaskFailureEntry) {
  if (f.isSeparator) throw new Error('Expected failure entry, got separator');
  return f;
}

function makeRow(seq: number, payload: EventRow['payload'], agent?: string | null): EventRow {
  return {
    id: seq,
    featureId: 'test-feature',
    seq,
    agent: agent ?? null,
    payload,
    createdAt: new Date().toISOString(),
  };
}

describe('foldEvents', () => {
  it('returns null phase for empty event list', () => {
    const state = foldEvents([]);
    expect(state.currentPhase).toBeNull();
  });

  it('derives currentPhase from last phase.changed', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'DRAFTING_SPEC' }),
      makeRow(2, { type: 'phase.changed', from: 'DRAFTING_SPEC', to: 'AWAITING_APPROVAL' }),
    ]);
    expect(state.currentPhase).toBe('AWAITING_APPROVAL');
  });

  it('tracks agent statuses', () => {
    const state = foldEvents([
      makeRow(1, { type: 'agent.status', agent: 'spec', status: 'working' }),
      makeRow(2, { type: 'agent.status', agent: 'spec', status: 'done' }),
      makeRow(3, { type: 'agent.status', agent: 'aws', status: 'working' }),
    ]);
    expect(state.agentStatuses['spec']).toBe('done');
    expect(state.agentStatuses['aws']).toBe('working');
  });

  it('folds agent.status for test-planner', () => {
    const state = foldEvents([
      makeRow(1, { type: 'agent.status', agent: 'test-planner', status: 'working' }),
    ]);
    expect(state.agentStatuses['test-planner']).toBe('working');
  });

  it('accumulates chat entries', () => {
    const state = foldEvents([
      makeRow(1, { type: 'chat.message', who: 'dev', text: 'Hello' }),
      makeRow(2, { type: 'chat.message', who: 'spec', text: 'Understood.' }),
    ]);
    expect(state.chatEntries).toHaveLength(2);
    expect(state.chatEntries[0]?.who).toBe('dev');
    expect(state.chatEntries[1]?.text).toBe('Understood.');
  });

  it('opens gate on gate.opened and clears on gate.resolved', () => {
    // gate.opened always follows phase.changed to the owning awaiting state.
    const afterOpen = foldEvents([
      makeRow(0, { type: 'phase.changed', from: null, to: 'AWAITING_APPROVAL' }),
      makeRow(1, { type: 'gate.opened', gate: 'spec_approval', summary: 'summary', revision: 0 }),
    ]);
    expect(afterOpen.gateOpen).not.toBeNull();
    expect(afterOpen.gateOpen?.gate).toBe('spec_approval');

    const afterResolved = foldEvents([
      makeRow(0, { type: 'phase.changed', from: null, to: 'AWAITING_APPROVAL' }),
      makeRow(1, { type: 'gate.opened', gate: 'spec_approval', summary: 'summary', revision: 0 }),
      makeRow(2, { type: 'gate.resolved', gate: 'spec_approval', resolution: 'approved' }),
      makeRow(3, { type: 'phase.changed', from: 'AWAITING_APPROVAL', to: 'PLANNING' }),
    ]);
    expect(afterResolved.gateOpen).toBeNull();
  });

  it('accumulates event logs per agent', () => {
    const state = foldEvents([
      makeRow(1, { type: 'agent.log', agent: 'spec', severity: 'ok', text: 'done' }),
      makeRow(2, { type: 'agent.log', agent: 'spec', severity: 'info', text: 'info' }),
      makeRow(3, { type: 'agent.log', agent: 'aws', severity: 'action', text: 'act' }),
    ]);
    expect(state.eventLogsByAgent['spec']).toHaveLength(2);
    expect(state.eventLogsByAgent['aws']).toHaveLength(1);
  });

  it('sums usage totals', () => {
    const state = foldEvents([
      makeRow(1, {
        type: 'usage.recorded',
        agent: 'spec',
        model: 'claude-sonnet-5',
        input_tokens: 100,
        output_tokens: 50,
      }),
      makeRow(2, {
        type: 'usage.recorded',
        agent: 'spec',
        model: 'claude-sonnet-5',
        input_tokens: 200,
        output_tokens: 80,
      }),
    ]);
    expect(state.usageTotal.input_tokens).toBe(300);
    expect(state.usageTotal.output_tokens).toBe(130);
  });

  it('is idempotent — folding same events twice gives same result', () => {
    const events = [
      makeRow(1, { type: 'phase.changed', from: null, to: 'DRAFTING_SPEC' }, 'orchestrator'),
      makeRow(2, { type: 'agent.status', agent: 'spec', status: 'working' }),
    ];
    const a = foldEvents(events);
    const b = foldEvents(events);
    expect(a.currentPhase).toBe(b.currentPhase);
    expect(a.agentStatuses).toEqual(b.agentStatuses);
  });

  it('synthesizes a muted log entry for agent.status in eventLogsByAgent', () => {
    const state = foldEvents([
      makeRow(1, { type: 'agent.status', agent: 'spec', status: 'working' }),
    ]);
    const logs = state.eventLogsByAgent['spec'] ?? [];
    expect(logs).toHaveLength(1);
    expect(logs[0]?.severity).toBe('muted');
    expect(logs[0]?.text).toContain('working');
  });

  it('synthesizes an info log entry for phase.changed in orchestrator logs', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'DRAFTING_SPEC' }, 'orchestrator'),
    ]);
    const logs = state.eventLogsByAgent['orchestrator'] ?? [];
    expect(logs).toHaveLength(1);
    expect(logs[0]?.severity).toBe('info');
    expect(logs[0]?.text).toContain('DRAFTING_SPEC');
  });

  it('plan.proposed folds into planGateOpen with summary and task_count', () => {
    // plan.proposed is emitted while the machine is in AWAITING_PLAN_APPROVAL.
    const state = foldEvents([
      makeRow(0, { type: 'phase.changed', from: null, to: 'AWAITING_PLAN_APPROVAL' }),
      makeRow(1, {
        type: 'plan.proposed',
        agent: 'planner',
        spec_rev: 0,
        plan_summary: '2 task(s) across 2 repo(s)',
        task_count: 2,
        tasks: [],
      }),
    ]);
    expect(state.planGateOpen).not.toBeNull();
    expect(state.planGateOpen?.task_count).toBe(2);
    expect(state.planGateOpen?.summary).toBe('2 task(s) across 2 repo(s)');
  });

  it('gate.opened with plan_approval gate sets planGateOpen, not gateOpen', () => {
    const state = foldEvents([
      makeRow(0, { type: 'phase.changed', from: null, to: 'AWAITING_PLAN_APPROVAL' }),
      makeRow(1, {
        type: 'gate.opened',
        gate: 'plan_approval',
        summary: 'plan ready',
        revision: 0,
      }),
    ]);
    expect(state.planGateOpen).not.toBeNull();
    expect(state.gateOpen).toBeNull();
  });

  it('gate.resolved clears planGateOpen when gate is plan_approval', () => {
    const state = foldEvents([
      makeRow(1, {
        type: 'gate.opened',
        gate: 'plan_approval',
        summary: 'plan ready',
        revision: 0,
      }),
      makeRow(2, {
        type: 'gate.resolved',
        gate: 'plan_approval',
        resolution: 'approved',
      }),
    ]);
    expect(state.planGateOpen).toBeNull();
    expect(state.gateOpen).toBeNull();
  });

  it('folds task.failed events into taskFailures', () => {
    const state = foldEvents([
      makeRow(1, {
        type: 'task.failed',
        repo: 'demo-server',
        task_id: 'abc12345-0000-0000-0000-000000000000',
        reason: 'npm install container failed',
        attempt: 2,
        final: true,
      }),
    ]);
    expect(state.taskFailures).toHaveLength(1);
    expect(state.taskFailures[0]).toMatchObject({
      taskId: 'abc12345-0000-0000-0000-000000000000',
      reason: 'npm install container failed',
      attempt: 2,
      final: true,
    });
  });

  it('accumulates multiple task.failed entries in order', () => {
    const state = foldEvents([
      makeRow(1, {
        type: 'task.failed',
        repo: 'demo-server',
        task_id: 'task-a',
        reason: 'first error',
        attempt: 1,
        final: false,
      }),
      makeRow(2, {
        type: 'task.failed',
        repo: 'demo-server',
        task_id: 'task-a',
        reason: 'second error',
        attempt: 2,
        final: true,
      }),
    ]);
    expect(state.taskFailures).toHaveLength(2);
    expect(asFailure(state.taskFailures[0]!).attempt).toBe(1);
    expect(asFailure(state.taskFailures[1]!).final).toBe(true);
  });

  it('tolerates task.failed payload with no fields — fold does not throw, mesh renders safely', () => {
    // Simulate a corrupted or future-variant event that passes only `type`.
    // The fold must degrade gracefully — safe defaults, no throw.
    const malformed = makeRow(1, {
      type: 'task.failed',
      repo: '',
      task_id: '',
      reason: '',
      attempt: 1,
      final: false,
    });
    // Override with a truly minimal payload to test the defensive guards.
    // Cast through unknown to avoid the unsafe-member-access lint rule while
    // still exercising the runtime defensive path.
    (malformed as unknown as { payload: unknown }).payload = { type: 'task.failed' };
    const state = foldEvents([malformed]);
    expect(state.taskFailures).toHaveLength(1);
    const f0 = asFailure(state.taskFailures[0]!);
    expect(f0.taskId).toBe('(unknown)');
    expect(f0.reason).toBe('(no reason)');
    expect(f0.attempt).toBe(0);
    expect(f0.final).toBe(false);
  });

  it('tolerates task.failed with reason="terminated" (server-restart stall marker)', () => {
    // The BullMQ stalled-job handler emits this payload when a job is killed
    // by a server restart. Must fold cleanly without crashing.
    const state = foldEvents([
      makeRow(1, {
        type: 'task.failed',
        repo: 'demo-server',
        task_id: 'abc-123',
        reason: 'terminated',
        attempt: 1,
        final: false,
      }),
    ]);
    expect(asFailure(state.taskFailures[0]!).reason).toBe('terminated');
    expect(asFailure(state.taskFailures[0]!).final).toBe(false);
  });
});

// ── Phase-gated gate suppression ─────────────────────────────────────────────

describe('foldEvents — phase-gated gate suppression', () => {
  it('amendmentGateOpen does not co-render with a prior spec gate (bleed-through fix)', () => {
    // When phase is IMPLEMENTING, gateOpen (spec) must be null even if a
    // gate.opened{spec_approval} exists earlier in the stream.
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'IMPLEMENTING' }),
      makeRow(2, {
        type: 'contract.amendment.proposed',
        repo: 'demo-server',
        task_id: 'task-1',
        rationale: 'missing field',
        proposed_contract_yaml: 'openapi: "3.0.0"',
      }),
    ]);
    expect(state.gateOpen).toBeNull();
    expect(state.amendmentGateOpen).not.toBeNull();
  });

  it('stale gateOpen is null after phase advances past AWAITING_APPROVAL', () => {
    // Simulates a gate.opened with no matching gate.resolved — occurs when the
    // event stream is truncated or the client reconnects mid-cycle.
    const state = foldEvents([
      makeRow(1, { type: 'gate.opened', gate: 'spec_approval', summary: 's', revision: 0 }),
      makeRow(2, { type: 'gate.resolved', gate: 'spec_approval', resolution: 'approved' }),
      makeRow(3, { type: 'phase.changed', from: 'AWAITING_APPROVAL', to: 'PLANNING' }),
      makeRow(4, { type: 'gate.opened', gate: 'spec_approval', summary: 's2', revision: 1 }),
      makeRow(5, { type: 'phase.changed', from: 'PLANNING', to: 'DONE' }),
    ]);
    expect(state.gateOpen).toBeNull();
  });

  it('planGateOpen is null after phase advances past AWAITING_PLAN_APPROVAL', () => {
    const state = foldEvents([
      makeRow(1, {
        type: 'plan.proposed',
        agent: 'planner',
        spec_rev: 0,
        plan_summary: '1 task',
        task_count: 1,
        tasks: [],
      }),
      makeRow(2, { type: 'gate.resolved', gate: 'plan_approval', resolution: 'approved' }),
      makeRow(3, {
        type: 'phase.changed',
        from: 'AWAITING_PLAN_APPROVAL',
        to: 'IMPLEMENTING',
      }),
    ]);
    expect(state.planGateOpen).toBeNull();
  });

  it('amendmentGateOpen is non-null when phase is IMPLEMENTING (happy path)', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'IMPLEMENTING' }),
      makeRow(2, {
        type: 'contract.amendment.proposed',
        repo: 'demo-client',
        task_id: 'task-2',
        rationale: 'missing humidity field',
        proposed_contract_yaml: 'openapi: "3.0.0"\npaths: {}',
      }),
    ]);
    expect(state.amendmentGateOpen).not.toBeNull();
    expect(state.amendmentGateOpen?.rationale).toBe('missing humidity field');
  });
});

describe('foldEvents — pr.created', () => {
  it('accumulates prLinks from pr.created events', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'CODE_REVIEW' }),
      makeRow(2, {
        type: 'pr.created',
        repo: 'demo-server',
        pr_id: 42,
        pr_url: 'https://dev.azure.com/my-org/my-project/_git/demo-server/pullrequest/42',
        title: 'feat: my-feature',
      }),
      makeRow(3, {
        type: 'pr.created',
        repo: 'demo-client',
        pr_id: 43,
        pr_url: 'https://dev.azure.com/my-org/my-project/_git/demo-client/pullrequest/43',
        title: 'feat: my-feature',
      }),
    ]);
    expect(state.prLinks).toHaveLength(2);
    expect(state.prLinks[0]).toMatchObject({ repo: 'demo-server', prId: 42 });
    expect(state.prLinks[1]).toMatchObject({ repo: 'demo-client', prId: 43 });
  });

  it('pr.created also pushes an agent.log entry for orchestrator', () => {
    const state = foldEvents([
      makeRow(1, {
        type: 'pr.created',
        repo: 'demo-server',
        pr_id: 99,
        pr_url: 'https://example.com/pr/99',
        title: 'feat: test',
      }),
    ]);
    const orchLogs = state.eventLogsByAgent['orchestrator'] ?? [];
    expect(orchLogs.some((l) => l.text.includes('#99'))).toBe(true);
  });
});

// ── Phase 5 event types: review.started, review.skipped, test.started ─────────

describe('foldEvents — Phase 5 event types', () => {
  it('review.started emits a muted agent.log for the review agent', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'CODE_REVIEW' }),
      makeRow(2, { type: 'review.started', agent: 'review', repos: ['sim-server', 'sim-client'] }),
    ]);
    const logs = state.eventLogsByAgent['review'] ?? [];
    expect(logs.some((l) => l.text.includes('sim-server') && l.severity === 'muted')).toBe(true);
  });

  it('review.skipped emits a muted log and sets agentStatus to failed', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'CODE_REVIEW' }),
      makeRow(2, {
        type: 'review.skipped',
        agent: 'review',
        reason: 'two consecutive parse failures',
      }),
    ]);
    const logs = state.eventLogsByAgent['review'] ?? [];
    expect(logs.some((l) => l.text.includes('two consecutive parse failures'))).toBe(true);
    expect(state.agentStatuses['review']).toBe('failed');
  });

  it('test.started emits a muted agent.log for the test agent', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'TESTING' }),
      makeRow(2, { type: 'test.started', agent: 'test', repos: ['sim-server'] }),
    ]);
    const logs = state.eventLogsByAgent['test'] ?? [];
    expect(logs.some((l) => l.text.includes('sim-server') && l.severity === 'muted')).toBe(true);
  });

  it('review.findings with agent=review folds into findings (schema widening)', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'CODE_REVIEW' }),
      makeRow(2, {
        type: 'review.findings',
        agent: 'review',
        spec_rev: 0,
        findings: [
          {
            id: 'rf1',
            severity: 'blocker',
            section: 'POST /api/features',
            issue: 'Missing id field',
            repo: 'sim-server',
          },
        ],
      }),
    ]);
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]).toMatchObject({ id: 'rf1', repo: 'sim-server', resolution: null });
  });

  it('gateOpen is non-null when phase is CODE_REVIEW (gate suppression relaxed)', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'CODE_REVIEW' }),
      makeRow(2, {
        type: 'gate.opened',
        gate: 'code_review',
        summary: '1 unresolved blocker',
        revision: 0,
        counts: { blockers: 1, warnings: 0, suggestions: 0 },
      }),
    ]);
    expect(state.gateOpen).not.toBeNull();
    expect(state.gateOpen?.gate).toBe('code_review');
  });

  it('gateOpen is non-null when phase is TESTING', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'TESTING' }),
      makeRow(2, {
        type: 'gate.opened',
        gate: 'test_report',
        summary: '2 test failures',
        revision: 0,
      }),
    ]);
    expect(state.gateOpen).not.toBeNull();
    expect(state.gateOpen?.gate).toBe('test_report');
  });

  it('gateOpen is still null in IMPLEMENTING (bleed-through guard unchanged)', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'IMPLEMENTING' }),
      makeRow(2, {
        type: 'gate.opened',
        gate: 'code_review',
        summary: 'stale gate',
        revision: 0,
      }),
    ]);
    expect(state.gateOpen).toBeNull();
  });
});

// ── Real-world fixture: server-uptime6 (312 events, all failure species) ──────
//
// This feature's history is the best worst-case fixture in the project:
// 14 task.failed entries covering 403/InvokeModel, terminated (stall),
// metachar violations, 20-turn cap exhaustion; review.findings fallthrough;
// 14 resurrections via /redispatch. Any fold regression against future event
// schema changes will surface here before reaching production.

// ── Findings panel (T-4c-2) ──────────────────────────────────────────────────

describe('foldEvents — review.findings and finding.resolved', () => {
  it('folds review.findings into the findings array with resolution null', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'AWAITING_APPROVAL' }),
      makeRow(2, {
        type: 'review.findings',
        agent: 'aws',
        spec_rev: 0,
        findings: [
          { id: 'f1', severity: 'blocker', section: 'API endpoints', issue: 'Missing /health' },
          { id: 'f2', severity: 'warning', section: 'Auth', issue: 'No JWT validation described' },
        ],
      }),
    ]);
    expect(state.findings).toHaveLength(2);
    expect(state.findings[0]).toMatchObject({ id: 'f1', severity: 'blocker', resolution: null });
    expect(state.findings[1]).toMatchObject({ id: 'f2', severity: 'warning', resolution: null });
  });

  it('finding.resolved updates resolution in-place without replacing other findings', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'AWAITING_APPROVAL' }),
      makeRow(2, {
        type: 'review.findings',
        agent: 'aws',
        spec_rev: 0,
        findings: [
          { id: 'f1', severity: 'blocker', section: 'API', issue: 'Missing endpoint' },
          { id: 'f2', severity: 'warning', section: 'Auth', issue: 'No JWT' },
        ],
      }),
      makeRow(3, {
        type: 'finding.resolved',
        finding_id: 'f1',
        resolution: 'dismissed',
        reason: 'out of scope',
      }),
    ]);
    expect(state.findings[0]).toMatchObject({ id: 'f1', resolution: 'dismissed' });
    expect(state.findings[1]).toMatchObject({ id: 'f2', resolution: null });
  });

  it('finding.resolved with accepted sets accepted resolution', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'AWAITING_APPROVAL' }),
      makeRow(2, {
        type: 'review.findings',
        agent: 'aws',
        spec_rev: 0,
        findings: [
          {
            id: 'f1',
            severity: 'suggestion',
            section: 'Perf',
            issue: 'Cache missing',
            suggested_text: 'Add Cache-Control header',
          },
        ],
      }),
      makeRow(3, { type: 'finding.resolved', finding_id: 'f1', resolution: 'accepted' }),
    ]);
    expect(state.findings[0]).toMatchObject({ id: 'f1', resolution: 'accepted' });
  });

  it('spec_approval gate renders AWS findings while gate is open', () => {
    // Regression #2: findings were cleared on gate.opened instead of gate.resolved,
    // wiping the AWS findings that were emitted just before the gate opened.
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'AWAITING_APPROVAL' }),
      makeRow(2, {
        type: 'review.findings',
        agent: 'aws',
        spec_rev: 0,
        findings: [{ id: 'f1', severity: 'warning', section: 'API', issue: 'missing endpoint' }],
      }),
      makeRow(3, {
        type: 'gate.opened',
        gate: 'spec_approval',
        summary: 'review ready',
        revision: 0,
      }),
    ]);
    // AWS findings must remain visible while the spec-approval gate is open.
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]).toMatchObject({ id: 'f1', resolution: null });
  });

  it('prior-cycle findings cleared after gate.resolved{spec_approval}', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'AWAITING_APPROVAL' }),
      makeRow(2, {
        type: 'review.findings',
        agent: 'aws',
        spec_rev: 0,
        findings: [{ id: 'f1', severity: 'blocker', section: 'API', issue: 'old finding' }],
      }),
      makeRow(3, {
        type: 'gate.opened',
        gate: 'spec_approval',
        summary: 'review ready',
        revision: 0,
      }),
      // Findings still visible while gate is open
      makeRow(4, { type: 'gate.resolved', gate: 'spec_approval', resolution: 'changes_requested' }),
      // Cycle exit clears findings
      makeRow(5, { type: 'phase.changed', from: 'AWAITING_APPROVAL', to: 'DRAFTING_SPEC' }),
      makeRow(6, { type: 'phase.changed', from: 'DRAFTING_SPEC', to: 'AWAITING_APPROVAL' }),
      makeRow(7, { type: 'gate.opened', gate: 'spec_approval', summary: 're-review', revision: 1 }),
    ]);
    // Prior findings cleared on gate.resolved; new cycle has no findings yet.
    expect(state.findings).toHaveLength(0);
  });

  it('findings are empty array when no review.findings event present', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'AWAITING_APPROVAL' }),
      makeRow(2, { type: 'gate.opened', gate: 'spec_approval', summary: 'ready', revision: 0 }),
    ]);
    expect(state.findings).toEqual([]);
  });
});

describe('foldEvents — server-uptime6 real-world fixture', () => {
  it('folds all 312 events without throwing', () => {
    expect(() => foldEvents(serverUptime6Events as unknown as EventRow[])).not.toThrow();
  });

  it('produces IMPLEMENTING as the current phase', () => {
    const state = foldEvents(serverUptime6Events as unknown as EventRow[]);
    expect(state.currentPhase).toBe('IMPLEMENTING');
  });

  it('accumulates all 16 task.failed entries including terminated and 20-turn cap', () => {
    const state = foldEvents(serverUptime6Events as unknown as EventRow[]);
    const failures = state.taskFailures.filter((f) => !f.isSeparator).map(asFailure);
    expect(failures).toHaveLength(16);
    const reasons = failures.map((f) => f.reason);
    expect(reasons).toContain('terminated');
    expect(reasons.some((r) => r.includes('20-turn safety cap'))).toBe(true);
    expect(reasons.some((r) => r.includes('InvokeModel'))).toBe(true);
  });

  it('all taskFailures have valid taskId strings — defensive defaults never triggered', () => {
    const state = foldEvents(serverUptime6Events as unknown as EventRow[]);
    const failures = state.taskFailures.filter((f) => !f.isSeparator).map(asFailure);
    for (const f of failures) {
      expect(f.taskId).not.toBe('(unknown)');
      expect(typeof f.taskId).toBe('string');
      expect(f.taskId.length).toBeGreaterThan(0);
    }
  });

  it('review.findings does not corrupt agentStatuses', () => {
    const state = foldEvents(serverUptime6Events as unknown as EventRow[]);
    // review.findings folds into state.findings, not agentStatuses
    const keys = Object.keys(state.agentStatuses);
    expect(keys).not.toContain('undefined');
    expect(keys.every((k) => k.length > 0)).toBe(true);
  });
});

// ── testReport fold ──────────────────────────────────────────────────────────

describe('foldEvents — testReport', () => {
  it('is null before any test.report event', () => {
    const state = foldEvents([makeRow(1, { type: 'phase.changed', from: null, to: 'TESTING' })]);
    expect(state.testReport).toBeNull();
  });

  it('populates testReport from a passing test.report event', () => {
    const state = foldEvents([
      makeRow(1, {
        type: 'test.report',
        agent: 'test',
        spec_rev: 0,
        passed: 14,
        failed: 0,
        findings: [],
        tests: [
          { test_name: 'works', status: 'passed', duration_ms: 12, authored: true },
          { test_name: 'old test', status: 'passed', duration_ms: 5, authored: false },
        ],
        authored_passed: 11,
        authored_failed: 0,
      }),
    ]);
    expect(state.testReport).not.toBeNull();
    expect(state.testReport?.passed).toBe(14);
    expect(state.testReport?.failed).toBe(0);
    expect(state.testReport?.authoredPassed).toBe(11);
    expect(state.testReport?.tests).toHaveLength(2);
    expect(state.testReport?.skipped).toBe(false);
    expect(state.testReport?.parseError).toBeNull();
  });

  it('populates testReport.skipped when skipped: true', () => {
    const state = foldEvents([
      makeRow(1, {
        type: 'test.report',
        agent: 'test',
        spec_rev: 0,
        passed: null,
        failed: null,
        findings: [],
        skipped: true,
        skip_reason: 'no repos in currentBranches',
      }),
    ]);
    expect(state.testReport?.skipped).toBe(true);
    expect(state.testReport?.skipReason).toBe('no repos in currentBranches');
    expect(state.testReport?.passed).toBeNull();
  });

  it('populates testReport.parseError when parse_error is present', () => {
    const state = foldEvents([
      makeRow(1, {
        type: 'test.report',
        agent: 'test',
        spec_rev: 0,
        passed: null,
        failed: null,
        findings: [],
        parse_error: 'JSON parse failed: no JSON object found in stdout',
      }),
    ]);
    expect(state.testReport?.parseError).toBe('JSON parse failed: no JSON object found in stdout');
    expect(state.testReport?.passed).toBeNull();
  });

  it('updates testReport.findings resolution on finding.resolved', () => {
    const state = foldEvents([
      makeRow(1, {
        type: 'test.report',
        agent: 'test',
        spec_rev: 0,
        passed: null,
        failed: 1,
        findings: [
          {
            id: 'f1',
            severity: 'blocker' as const,
            section: 'auth',
            issue: 'test broke',
            test_name: 'login works',
          },
        ],
      }),
      makeRow(2, {
        type: 'finding.resolved',
        finding_id: 'f1',
        resolution: 'dismissed',
      }),
    ]);
    expect(state.testReport?.findings[0]?.resolution).toBe('dismissed');
  });

  it('authored_passed absent → authoredPassed is undefined', () => {
    const state = foldEvents([
      makeRow(1, {
        type: 'test.report',
        agent: 'test',
        spec_rev: 0,
        passed: 5,
        failed: 1,
        findings: [],
        tests: [{ test_name: 'works', status: 'passed', duration_ms: 10, authored: true }],
        // authored_passed / authored_failed intentionally absent
      }),
    ]);
    expect(state.testReport?.authoredPassed).toBeUndefined();
    expect(state.testReport?.authoredFailed).toBeUndefined();
  });
});

// ── O-39: terminal-phase and gate-derived agent status cleanup ───────────────

describe('foldEvents — terminal-phase and gate-derived status cleanup (O-39)', () => {
  it('DONE feature: waiting agent shows done, not waiting', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'TESTING' }),
      makeRow(2, { type: 'agent.status', agent: 'test', status: 'waiting' }),
      makeRow(3, { type: 'gate.resolved', gate: 'test_report', resolution: 'approved' }),
      makeRow(4, { type: 'phase.changed', from: 'TESTING', to: 'DONE' }),
    ]);
    expect(state.agentStatuses['test']).toBe('done');
  });

  it('FAILED feature: waiting agent shows failed, not waiting', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'TESTING' }),
      makeRow(2, { type: 'agent.status', agent: 'test', status: 'waiting' }),
      makeRow(3, { type: 'phase.changed', from: 'TESTING', to: 'FAILED' }),
    ]);
    expect(state.agentStatuses['test']).toBe('failed');
  });

  it('DONE feature: working agent shows done, not working', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'IMPLEMENTING' }),
      makeRow(2, { type: 'agent.status', agent: 'server', status: 'working' }),
      makeRow(3, { type: 'phase.changed', from: 'IMPLEMENTING', to: 'DONE' }),
    ]);
    expect(state.agentStatuses['server']).toBe('done');
  });

  it('active test gate preserves waiting status — no over-clearing', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'TESTING' }),
      makeRow(2, { type: 'gate.opened', gate: 'test_report', summary: '2 failures', revision: 0 }),
      makeRow(3, { type: 'agent.status', agent: 'test', status: 'waiting' }),
    ]);
    expect(state.agentStatuses['test']).toBe('waiting');
  });

  it('non-terminal with no gate open: stale waiting agent shows done', () => {
    // Gate resolved, phase advanced past TESTING, but test agent never emitted 'done'
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'TESTING' }),
      makeRow(2, { type: 'agent.status', agent: 'test', status: 'waiting' }),
      makeRow(3, { type: 'gate.resolved', gate: 'test_report', resolution: 'approved' }),
      makeRow(4, { type: 'phase.changed', from: 'TESTING', to: 'IMPLEMENTING' }),
    ]);
    expect(state.agentStatuses['test']).toBe('done');
  });

  it('DONE feature: header RUNNING and PARKED counts are both zero', () => {
    const state = foldEvents([
      makeRow(1, { type: 'phase.changed', from: null, to: 'TESTING' }),
      makeRow(2, { type: 'agent.status', agent: 'test', status: 'waiting' }),
      makeRow(3, { type: 'agent.status', agent: 'server', status: 'working' }),
      makeRow(4, { type: 'phase.changed', from: 'TESTING', to: 'DONE' }),
    ]);
    const running = Object.values(state.agentStatuses).filter((s) => s === 'working').length;
    const parked = Object.values(state.agentStatuses).filter((s) => s === 'waiting').length;
    expect(running).toBe(0);
    expect(parked).toBe(0);
  });
});

// ── artifact.committed → committedKinds ─────────────────────────────────────

describe('foldEvents — committedKinds', () => {
  it('artifact.committed for spec.md adds spec to committedKinds', () => {
    const state = foldEvents([
      makeRow(1, {
        type: 'artifact.committed',
        path: 'features/my-feature/spec.md',
        commit: 'abc1234',
        message: 'spec: my-feature draft r1',
      }),
    ]);
    expect(state.committedKinds).toContain('spec');
  });

  it('two artifact.committed events for the same kind do not duplicate entries', () => {
    const state = foldEvents([
      makeRow(1, {
        type: 'artifact.committed',
        path: 'features/my-feature/spec.md',
        commit: 'abc1234',
        message: 'spec: my-feature draft r1',
      }),
      makeRow(2, {
        type: 'artifact.committed',
        path: 'features/my-feature/spec.md',
        commit: 'def5678',
        message: 'spec: my-feature draft r2',
      }),
    ]);
    expect(state.committedKinds.filter((k) => k === 'spec')).toHaveLength(1);
  });
});

describe('foldEvents — task-based agent status derivation', () => {
  const baseTask = {
    side: 'server',
    status: 'pending',
    coveredByTestPlan: false,
    testsWritten: false,
  };

  it('returns no agent statuses when no tasks provided', () => {
    const state = foldEvents([]);
    expect(state.agentStatuses).toEqual({});
  });

  it('derives server=working when a server task is running', () => {
    const state = foldEvents([], [{ ...baseTask, status: 'running' }]);
    expect(state.agentStatuses['server']).toBe('working');
  });

  it('derives server=waiting when a server task is parked', () => {
    const state = foldEvents([], [{ ...baseTask, status: 'parked' }]);
    expect(state.agentStatuses['server']).toBe('waiting');
  });

  it('derives server=waiting when a server task is amendment_paused', () => {
    const state = foldEvents([], [{ ...baseTask, status: 'amendment_paused' }]);
    expect(state.agentStatuses['server']).toBe('waiting');
  });

  it('derives server=done when all server tasks are completed', () => {
    const state = foldEvents([], [{ ...baseTask, status: 'completed' }]);
    expect(state.agentStatuses['server']).toBe('done');
  });

  it('derives server=queued when all server tasks are pending', () => {
    const state = foldEvents([], [{ ...baseTask, status: 'pending' }]);
    expect(state.agentStatuses['server']).toBe('queued');
  });

  it('derives test=working when a covered task is running', () => {
    const state = foldEvents([], [{ ...baseTask, coveredByTestPlan: true, status: 'running' }]);
    expect(state.agentStatuses['test']).toBe('working');
  });

  it('derives test=done when all covered tasks have testsWritten', () => {
    const state = foldEvents(
      [],
      [{ ...baseTask, coveredByTestPlan: true, testsWritten: true, status: 'pending' }],
    );
    expect(state.agentStatuses['test']).toBe('done');
  });

  it('does not set test status when no tasks are covered', () => {
    const state = foldEvents([], [{ ...baseTask, status: 'running' }]);
    expect(state.agentStatuses['test']).toBeUndefined();
  });

  it('task-derived working is overridden to done when feature is DONE', () => {
    const state = foldEvents(
      [makeRow(1, { type: 'phase.changed', from: 'IMPLEMENTING', to: 'DONE' })],
      [{ ...baseTask, status: 'running' }],
    );
    expect(state.agentStatuses['server']).toBe('done');
  });

  it('event-sourced review agent status is preserved when tasks only cover server', () => {
    const state = foldEvents(
      [makeRow(1, { type: 'agent.status', agent: 'review', status: 'done' })],
      [{ ...baseTask, status: 'running' }],
    );
    expect(state.agentStatuses['review']).toBe('done');
  });

  it('feature-level test job working is not overridden by task-derived done', () => {
    // All covered tasks have testsWritten — deriveAgentStatusesFromTasks returns 'done'.
    // But the feature-level test job is actively running (emitted agent.status working).
    // The event-sourced 'working' must win.
    const state = foldEvents(
      [makeRow(1, { type: 'agent.status', agent: 'test', status: 'working' })],
      [{ ...baseTask, coveredByTestPlan: true, testsWritten: true, status: 'completed' }],
    );
    expect(state.agentStatuses['test']).toBe('working');
  });
});
