import { useEffect, useMemo, useState } from 'react';
import type { EventRow } from '@orrery/shared';
import {
  foldActivityEvents,
  type ActivitySection,
  type ActivityTask,
  type ActivityJob,
  type FeatureAgentSection,
} from '../lib/activityFold.js';
import { TaskTable } from './TaskTable.js';
import type { TaskRow } from './TaskTable.js';

interface Props {
  featureId: string;
  events: EventRow[];
  agentLogEventCount: number;
  taskEventCount: number;
}

function useTasks(featureId: string, taskEventCount: number): TaskRow[] {
  const [rows, setRows] = useState<TaskRow[]>([]);

  useEffect(() => {
    setRows([]);
  }, [featureId]);

  useEffect(() => {
    fetch(`/api/features/${featureId}/tasks`)
      .then((r) => {
        if (!r.ok) throw new Error('fetch failed');
        return r.json() as Promise<TaskRow[]>;
      })
      .then(setRows)
      .catch(() => undefined);
  }, [featureId, taskEventCount]);

  return rows;
}

function spendRatio(turns: number, threshold: number): number {
  return threshold > 0 ? turns / threshold : 0;
}

function spendColor(ratio: number): string {
  if (ratio >= 0.9) return '#e04f4f';
  if (ratio >= 0.67) return '#f5a623';
  return 'var(--text-secondary)';
}

function TurnCounter({ turns, threshold }: { turns: number; threshold: number }) {
  const ratio = spendRatio(turns, threshold);
  const color = spendColor(ratio);
  const pct = Math.min(ratio * 100, 100);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 100 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color }}>
        {ratio >= 0.9 ? '⚠ ' : ''}
        {turns} / {threshold} turns
      </span>
      <div
        style={{
          height: 2,
          background: 'var(--border-faint)',
          borderRadius: 1,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: color,
            borderRadius: 1,
            transition: 'width 0.3s',
          }}
        />
      </div>
    </div>
  );
}

function JobSection({
  job,
  isExpanded,
  onToggle,
}: {
  job: ActivityJob;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={{ marginTop: 6 }}>
      <button
        aria-expanded={isExpanded}
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '3px 0',
          color: 'var(--text-secondary)',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          width: '100%',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 9 }}>{isExpanded ? '▼' : '▶'}</span>
        <span>
          Job {job.jobIndex} · {job.rows.length} ops{job.isRunning ? ' · ● running' : ''}
        </span>
      </button>
      {isExpanded && (
        <div style={{ paddingLeft: 16, marginTop: 2 }}>
          {job.rows.length === 0 ? (
            <span
              style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
            >
              (no tool calls recorded)
            </span>
          ) : (
            job.rows.map((row) => (
              <div
                key={row.seq}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  lineHeight: 1.6,
                  color: row.kind === 'violation' ? '#f5a623' : 'var(--text-muted)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {row.kind === 'violation' ? '⚠ ' : ''}
                {row.text}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function FeatureSection({
  section,
  isExpanded,
  onToggle,
}: {
  section: FeatureAgentSection;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      style={{
        borderBottom: '1px solid var(--border-faint)',
        padding: '12px 0',
      }}
    >
      <button
        aria-expanded={isExpanded}
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '3px 0',
          width: '100%',
          textAlign: 'left',
        }}
      >
        <span
          style={{ fontSize: 9, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
        >
          {isExpanded ? '▼' : '▶'}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 12,
            color: 'var(--text-primary)',
          }}
        >
          {section.label}
        </span>
        {section.turns > 0 && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-secondary)',
            }}
          >
            {section.turns} turns
          </span>
        )}
        {section.costUsd > 0 && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-secondary)',
            }}
          >
            ${section.costUsd.toFixed(4)}
          </span>
        )}
        {section.isRunning && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--accent-primary, #7c8cff)',
            }}
          >
            ● running
          </span>
        )}
      </button>
      {isExpanded && (
        <div style={{ paddingLeft: 16, marginTop: 2 }}>
          {section.rows.length === 0 ? (
            <span
              style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
            >
              (no tool calls recorded)
            </span>
          ) : (
            section.rows.map((row) => (
              <div
                key={row.seq}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  lineHeight: 1.6,
                  color: row.kind === 'violation' ? '#f5a623' : 'var(--text-muted)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {row.kind === 'violation' ? '⚠ ' : ''}
                {row.text}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function TaskSection({
  task,
  collapseMap,
  onToggle,
}: {
  task: ActivityTask;
  collapseMap: Map<string, boolean>;
  onToggle: (jobId: string) => void;
}) {
  const statusColor =
    task.status === 'running'
      ? 'var(--accent-primary, #7c8cff)'
      : task.status === 'completed'
        ? 'var(--green, #4ade80)'
        : task.status === 'parked'
          ? '#fb923c'
          : '#e04f4f';

  return (
    <div
      id={`task-${task.taskId}`}
      style={{
        borderBottom: '1px solid var(--border-faint)',
        padding: '12px 0',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 12,
              color: 'var(--text-primary)',
              marginBottom: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {task.taskTitle}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: statusColor,
                textTransform: 'uppercase',
              }}
            >
              {task.status}
            </span>
            <span
              style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}
            >
              {task.side} · {task.repo}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <TurnCounter turns={task.turns} threshold={task.spendGuardThreshold} />
          {task.testTurns > 0 && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-muted)',
              }}
            >
              tests: {task.testTurns} turns
            </span>
          )}
        </div>
      </div>
      <div style={{ marginTop: 4 }}>
        {task.jobs.length === 0 ? (
          <span
            style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
          >
            (no jobs recorded)
          </span>
        ) : (
          task.jobs.map((job) => (
            <JobSection
              key={job.jobId}
              job={job}
              isExpanded={collapseMap.get(job.jobId) ?? false}
              onToggle={() => onToggle(job.jobId)}
            />
          ))
        )}
      </div>
    </div>
  );
}

export function ActivityTab({
  featureId,
  events,
  agentLogEventCount: _agentLogEventCount,
  taskEventCount,
}: Props) {
  const tasks = useTasks(featureId, taskEventCount);
  const sections = useMemo(() => foldActivityEvents(events, tasks), [events, tasks]);

  const [collapseMap, setCollapseMap] = useState<Map<string, boolean>>(new Map());

  // Apply default collapse state: running → expanded, completed → collapsed.
  useEffect(() => {
    setCollapseMap((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const sec of sections) {
        if (sec.kind === 'task') {
          for (const job of sec.task.jobs) {
            if (!next.has(job.jobId)) {
              next.set(job.jobId, job.isRunning);
              changed = true;
            } else if (job.isRunning && !next.get(job.jobId)) {
              next.set(job.jobId, true);
              changed = true;
            }
          }
        } else {
          const { sectionId, isRunning } = sec.section;
          if (!next.has(sectionId)) {
            next.set(sectionId, isRunning);
            changed = true;
          } else if (isRunning && !next.get(sectionId)) {
            next.set(sectionId, true);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [sections]);

  const handleToggle = (key: string) => {
    setCollapseMap((prev) => {
      const next = new Map(prev);
      next.set(key, !next.get(key));
      return next;
    });
  };

  const handleTaskClick = (taskId: string) => {
    const sec = sections.find((s) => s.kind === 'task' && s.task.taskId === taskId);
    if (!sec || sec.kind !== 'task') return;
    setCollapseMap((prev) => {
      const next = new Map(prev);
      for (const job of sec.task.jobs) next.set(job.jobId, true);
      return next;
    });
    document.getElementById(`task-${taskId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: '0 16px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <TaskTable
        featureId={featureId}
        taskEventCount={taskEventCount}
        onRowClick={handleTaskClick}
      />
      {sections.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-ui)',
            fontSize: 13,
          }}
        >
          No agent activity recorded yet.
        </div>
      ) : (
        sections.map((sec, i) => {
          if (sec.kind === 'task') {
            return (
              <TaskSection
                key={`${sec.task.taskId}-${i}`}
                task={sec.task}
                collapseMap={collapseMap}
                onToggle={handleToggle}
              />
            );
          }
          return (
            <FeatureSection
              key={sec.section.sectionId}
              section={sec.section}
              isExpanded={collapseMap.get(sec.section.sectionId) ?? false}
              onToggle={() => handleToggle(sec.section.sectionId)}
            />
          );
        })
      )}
    </div>
  );
}
