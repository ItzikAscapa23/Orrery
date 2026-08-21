import { useState } from 'react';
import { AGENT_REGISTRY } from '@orrery/shared';
import type { AgentId, AgentLogPayload } from '@orrery/shared';
import type { AgentDisplayStatus, PhaseId, SelectedEntity, TaskFailureEntry } from '../types/ui.js';
import { getStatusColor, getStatusLabel } from './solar/statusStyles.js';
import { StateMachineChips } from './StateMachineChips.js';
import { EventLog } from './EventLog.js';
import { CostCard } from './CostCard.js';

interface InspectorProps {
  selected: SelectedEntity;
  phase: PhaseId;
  agentStatuses: Record<string, AgentDisplayStatus>;
  eventLogsByAgent: Record<string, AgentLogPayload[]>;
  taskFailures: TaskFailureEntry[];
  featureId: string;
  usageEventCount: number;
}

const TIER_COLOR: Record<string, string> = {
  spec: '#2ee6c9',
  build: '#ff5b45',
  qa: '#8b7bff',
  core: '#ffc98a',
};

const ROLE_TEXT: Record<string, string> = {
  spec: 'Elicits requirements and writes the feature specification.',
  aws: 'Reviews AWS architecture and IAM policy implications.',
  client: 'Implements frontend code changes.',
  server: 'Implements backend code changes.',
  review: 'Reviews code quality and coverage.',
  test: 'Runs the test suite and reports results.',
  orchestrator: 'Coordinates the multi-agent pipeline and manages gates.',
};

export function Inspector({
  selected,
  phase,
  agentStatuses,
  eventLogsByAgent,
  taskFailures,
  featureId,
  usageEventCount,
}: InspectorProps) {
  const entityId = selected ?? 'orchestrator';
  const isOrchestrator = entityId === 'orchestrator';
  const agentId = isOrchestrator ? 'orchestrator' : (entityId as AgentId);
  const meta = AGENT_REGISTRY[agentId];
  const color = isOrchestrator ? '#ffc98a' : (TIER_COLOR[meta.tier] ?? '#8b7bff');

  const status: AgentDisplayStatus = isOrchestrator
    ? (() => {
        switch (phase) {
          case 'PLANNING':
          case 'IMPLEMENTING':
          case 'CODE_REVIEW':
          case 'TESTING':
            return 'working';
          case 'DONE':
            return 'done';
          default:
            return 'waiting';
        }
      })()
    : (agentStatuses[agentId] ?? 'queued');

  const statusColor = getStatusColor(status);
  const statusLabel = isOrchestrator
    ? ((): string => {
        if (status === 'working') return 'ORCHESTRATING';
        if (status === 'done') return 'DONE';
        return 'WAITING';
      })()
    : getStatusLabel(status);

  const logs = eventLogsByAgent[agentId] ?? [];

  const [expandedFailures, setExpandedFailures] = useState<Set<number>>(new Set());

  function toggleFailure(i: number) {
    setExpandedFailures((prev) => {
      const next = new Set(prev);
      if (next.has(i)) {
        next.delete(i);
      } else {
        next.add(i);
      }
      return next;
    });
  }

  return (
    <aside className="app-panel-right" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div className="panel-header">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 6,
          }}
        >
          <span
            className="mono-tag"
            style={{ color, letterSpacing: '0.13em', textTransform: 'uppercase' }}
          >
            {isOrchestrator ? 'CORE' : meta.tier.toUpperCase()}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              className="status-dot"
              style={{ background: statusColor, boxShadow: `0 0 4px ${statusColor}` }}
            />
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 8.5,
                color: statusColor,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              {statusLabel}
            </span>
          </div>
        </div>
        <div
          style={{
            fontFamily: 'var(--font-ui)',
            fontWeight: 700,
            fontSize: 16,
            color: 'var(--text-primary)',
            marginBottom: 4,
          }}
        >
          {meta.displayName}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 11,
            lineHeight: 1.45,
            color: 'var(--text-secondary)',
          }}
        >
          {ROLE_TEXT[agentId]}
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          overflowY: 'auto',
          flex: 1,
        }}
      >
        {/* State machine chips — Orchestrator only */}
        {isOrchestrator && <StateMachineChips currentPhase={phase} />}

        {/* Task failures — all entries in event order, separators mark redispatch runs */}
        {taskFailures.length > 0 && (
          <div
            data-testid="failure-list"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                letterSpacing: '0.1em',
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
              }}
            >
              Task failures
            </span>
            {taskFailures.map((f, i) =>
              f.isSeparator ? (
                <div
                  key={i}
                  style={{
                    borderTop: '1px solid #2a2d3d',
                    paddingTop: 4,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: '#5f6684',
                    letterSpacing: '0.06em',
                  }}
                >
                  ↻ redispatch {new Date(f.ts).toLocaleTimeString()}
                </div>
              ) : (
                <div
                  key={i}
                  data-testid="failure-entry"
                  onClick={() => toggleFailure(i)}
                  style={{
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: f.orphaned
                      ? f.final
                        ? '#c9a227' // orphan cap — amber: structural, not agent
                        : '#5f6684' // vanished job — gray: env restart, will retry
                      : f.final
                        ? '#ff5b45' // agent final failure — red
                        : '#ffc98a', // agent retrying — orange
                    ...(expandedFailures.has(i)
                      ? { whiteSpace: 'pre-wrap', wordBreak: 'break-all' }
                      : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
                  }}
                >
                  <span style={{ color: '#5f6684', marginRight: 4 }}>
                    {new Date(f.ts).toLocaleTimeString()}
                  </span>
                  {f.orphaned
                    ? f.final
                      ? '⊘' // orphan cap
                      : '↻' // vanished, retrying
                    : f.final
                      ? '✗' // agent failure
                      : '↻'}{' '}
                  {f.taskId.slice(0, 8)} attempt {f.attempt}: {f.reason}
                </div>
              ),
            )}
          </div>
        )}

        {/* Event log */}
        <EventLog logs={logs} />

        {/* Cost breakdown — below event log */}
        <CostCard featureId={featureId} usageEventCount={usageEventCount} />
      </div>
    </aside>
  );
}
