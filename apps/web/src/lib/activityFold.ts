import type { EventRow } from '@orrery/shared';
import { computeCostUsd } from './costCalc.js';

// Structural subset of TaskRow that foldActivityEvents actually reads.
// TaskRow satisfies this interface; tests can pass narrower fixtures.
interface TaskLike {
  id: string;
  title: string;
  side: string;
  repo: string;
  status: string;
  turns: number | null;
  spendGuardThreshold: number;
}

export interface ActivityRow {
  kind: 'turn' | 'violation';
  seq: number;
  text: string;
}

export interface ActivityJob {
  jobId: string;
  jobIndex: number;
  rows: ActivityRow[];
  turns: number;
  agent: string;
  isRunning: boolean;
}

export interface ActivityTask {
  taskId: string;
  taskTitle: string;
  side: string;
  repo: string;
  status: 'running' | 'completed' | 'failed' | 'parked';
  turns: number;
  testTurns: number;
  spendGuardThreshold: number;
  jobs: ActivityJob[];
  firstSeq: number;
}

export const AGENT_LABELS: Record<string, string> = {
  spec: 'Spec',
  aws: 'AWS Review',
  planner: 'Planning',
  'test-planner': 'Test Planning',
  review: 'Code Review',
  test: 'Testing',
};

export interface FeatureAgentSection {
  sectionId: string;
  agent: string;
  label: string;
  jobId: string | null;
  rows: ActivityRow[];
  turns: number;
  costUsd: number;
  isRunning: boolean;
  firstSeq: number;
}

export type ActivitySection =
  | { kind: 'task'; task: ActivityTask; firstSeq: number }
  | { kind: 'feature-agent'; section: FeatureAgentSection };

interface Span {
  taskId: string;
  startSeq: number;
  endSeq: number | null;
  terminated: boolean;
  termStatus: 'completed' | 'failed';
}

interface UsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  seq: number;
}

export function foldActivityEvents(events: EventRow[], tasks: TaskLike[]): ActivitySection[] {
  const taskInfoMap = new Map(tasks.map((t) => [t.id, t]));

  // Pass 1 — build task spans (one per task.started; retries get separate spans).
  const spans: Span[] = [];
  const openSpans = new Map<string, Span>();

  for (const ev of events) {
    const p = ev.payload;
    if (p.type === 'task.started') {
      const existing = openSpans.get(p.task_id);
      if (existing) {
        // Unexpected restart without close — forcibly close the prior span.
        existing.endSeq = ev.seq;
        existing.terminated = true;
      }
      const span: Span = {
        taskId: p.task_id,
        startSeq: ev.seq,
        endSeq: null,
        terminated: false,
        termStatus: 'completed',
      };
      openSpans.set(p.task_id, span);
      spans.push(span);
    } else if (p.type === 'task.completed') {
      const s = openSpans.get(p.task_id);
      if (s) {
        s.endSeq = ev.seq;
        s.terminated = true;
        s.termStatus = 'completed';
        openSpans.delete(p.task_id);
      }
    } else if (p.type === 'task.failed') {
      const s = openSpans.get(p.task_id);
      if (s) {
        s.endSeq = ev.seq;
        s.terminated = true;
        s.termStatus = 'failed';
        openSpans.delete(p.task_id);
      }
    }
  }

  // Pass 2 — for each span, partition log events into jobs.
  const taskSections: ActivityTask[] = [];

  for (const span of spans) {
    const taskInfo = taskInfoMap.get(span.taskId);
    if (!taskInfo) continue;

    const inRange = events.filter(
      (e) => e.seq > span.startSeq && (span.endSeq === null || e.seq < span.endSeq),
    );

    // Ordered job IDs by first usage.recorded appearance.
    const jobOrder: string[] = [];
    const seenJobs = new Set<string>();
    for (const e of inRange) {
      if (e.payload.type === 'usage.recorded') {
        const jid = e.payload.job_id;
        if (jid && !seenJobs.has(jid)) {
          seenJobs.add(jid);
          jobOrder.push(jid);
        }
      }
    }

    const jobRows = new Map<string, ActivityRow[]>();
    const jobUsageCounts = new Map<string, number>();
    const jobAgentMap = new Map<string, string>();
    for (const jid of jobOrder) {
      jobRows.set(jid, []);
      jobUsageCounts.set(jid, 0);
    }

    // Walk in seq order; advance currentJobId on each new usage.recorded job_id.
    let currentJobId = jobOrder[0] ?? '';
    if (currentJobId && !jobRows.has(currentJobId)) jobRows.set(currentJobId, []);

    for (const e of inRange) {
      if (e.payload.type === 'usage.recorded') {
        const jid = e.payload.job_id;
        if (jid) {
          currentJobId = jid;
          jobUsageCounts.set(jid, (jobUsageCounts.get(jid) ?? 0) + 1);
          if (!jobAgentMap.has(jid)) jobAgentMap.set(jid, e.payload.agent ?? '');
        }
        continue;
      }
      if (e.payload.type === 'agent.log' && e.payload.agent === taskInfo.side) {
        const text = e.payload.text;
        const kind: 'turn' | 'violation' = text.startsWith('◦ turn ') ? 'turn' : 'violation';
        const bucket = jobRows.get(currentJobId);
        if (bucket) bucket.push({ kind, seq: e.seq, text });
      }
    }

    const isTaskRunning = !span.terminated;
    const lastJobId = jobOrder[jobOrder.length - 1];

    const jobs: ActivityJob[] = jobOrder.map((jid, i) => ({
      jobId: jid,
      jobIndex: i + 1,
      rows: jobRows.get(jid) ?? [],
      turns: jobUsageCounts.get(jid) ?? 0,
      agent: jobAgentMap.get(jid) ?? '',
      isRunning: isTaskRunning && jid === lastJobId,
    }));

    const devTurns = jobs
      .filter((j) => j.agent === taskInfo.side)
      .reduce((sum, j) => sum + j.turns, 0);
    const testTurns = jobs
      .filter((j) => j.agent !== taskInfo.side && j.agent !== '')
      .reduce((sum, j) => sum + j.turns, 0);

    const status: ActivityTask['status'] =
      taskInfo.status === 'parked' ? 'parked' : !span.terminated ? 'running' : span.termStatus;

    taskSections.push({
      taskId: span.taskId,
      taskTitle: taskInfo.title,
      side: taskInfo.side,
      repo: taskInfo.repo,
      status,
      turns: devTurns,
      testTurns,
      spendGuardThreshold: taskInfo.spendGuardThreshold,
      jobs,
      firstSeq: span.startSeq,
    });
  }

  // Pass 3 — feature-level sections (events outside all task spans).
  function inAnySpan(seq: number): boolean {
    for (const span of spans) {
      if (seq > span.startSeq && (span.endSeq === null || seq < span.endSeq)) return true;
    }
    return false;
  }

  const featureEvents = events.filter((e) => !inAnySpan(e.seq));

  // Track current sectionId per agent and accumulate section data.
  const currentSectionIdByAgent = new Map<string, string>();
  const sectionData = new Map<
    string,
    {
      rows: ActivityRow[];
      usages: UsageEntry[];
      firstSeq: number;
      agent: string;
      jobId: string | null;
    }
  >();
  const sectionOrder: string[] = [];

  for (const ev of featureEvents) {
    const p = ev.payload;

    if (p.type === 'usage.recorded') {
      const agent = p.agent;
      if (!agent || agent === 'orchestrator') continue;

      const jobId = p.job_id ?? null;
      let sectionId: string;

      if (jobId !== null) {
        sectionId = `${agent}-${jobId}`;
        // Upgrade a synthetic (no-job, no-usages) section for this agent in-place to avoid
        // a duplicate empty header when agent.log arrives before the first usage.recorded.
        const prevId = currentSectionIdByAgent.get(agent);
        if (prevId !== undefined && prevId !== sectionId && !sectionData.has(sectionId)) {
          const prev = sectionData.get(prevId);
          if (prev && prev.jobId === null && prev.usages.length === 0) {
            prev.jobId = jobId;
            sectionData.delete(prevId);
            sectionData.set(sectionId, prev);
            const idx = sectionOrder.indexOf(prevId);
            if (idx >= 0) sectionOrder[idx] = sectionId;
          }
        }
      } else {
        // Reuse the current section for this agent when job_id is absent (e.g. spec agent).
        sectionId = currentSectionIdByAgent.get(agent) ?? `${agent}-${ev.seq}`;
      }

      if (!sectionData.has(sectionId)) {
        sectionData.set(sectionId, { rows: [], usages: [], firstSeq: ev.seq, agent, jobId });
        sectionOrder.push(sectionId);
      }
      sectionData.get(sectionId)!.usages.push({
        model: p.model,
        inputTokens: p.input_tokens,
        outputTokens: p.output_tokens,
        cacheCreate: p.cache_creation_input_tokens ?? 0,
        cacheRead: p.cache_read_input_tokens ?? 0,
        seq: ev.seq,
      });
      currentSectionIdByAgent.set(agent, sectionId);
    } else if (p.type === 'agent.log') {
      const agent = p.agent;
      if (!agent || agent === 'orchestrator') continue;

      let sectionId = currentSectionIdByAgent.get(agent);
      if (sectionId === undefined) {
        // agent.log arrived before any usage.recorded — open synthetic section.
        sectionId = `${agent}-${ev.seq}`;
        sectionData.set(sectionId, { rows: [], usages: [], firstSeq: ev.seq, agent, jobId: null });
        sectionOrder.push(sectionId);
        currentSectionIdByAgent.set(agent, sectionId);
      }
      const kind: 'turn' | 'violation' = p.text.startsWith('◦ turn ') ? 'turn' : 'violation';
      sectionData.get(sectionId)!.rows.push({ kind, seq: ev.seq, text: p.text });
    }
  }

  // Determine the max usage seq across all feature-level events to identify running sections.
  let maxUsageSeq = -1;
  for (const [, d] of sectionData) {
    for (const u of d.usages) {
      if (u.seq > maxUsageSeq) maxUsageSeq = u.seq;
    }
  }

  const featureSections: FeatureAgentSection[] = [];
  for (const sectionId of sectionOrder) {
    const d = sectionData.get(sectionId)!;
    const turns = d.usages.length;
    const costUsd = d.usages.reduce(
      (acc, u) =>
        acc + computeCostUsd(u.model, u.inputTokens, u.outputTokens, u.cacheCreate, u.cacheRead),
      0,
    );
    const lastUsageSeq = d.usages.length > 0 ? Math.max(...d.usages.map((u) => u.seq)) : -1;
    const isRunning = maxUsageSeq >= 0 && lastUsageSeq === maxUsageSeq;
    featureSections.push({
      sectionId,
      agent: d.agent,
      label: AGENT_LABELS[d.agent] ?? d.agent,
      jobId: d.jobId,
      rows: d.rows,
      turns,
      costUsd,
      isRunning,
      firstSeq: d.firstSeq,
    });
  }

  // Pass 4 — merge and sort chronologically by firstSeq.
  const allSections: ActivitySection[] = [
    ...taskSections.map((task) => ({ kind: 'task' as const, task, firstSeq: task.firstSeq })),
    ...featureSections.map((section) => ({ kind: 'feature-agent' as const, section })),
  ];
  allSections.sort((a, b) => {
    const seqA = a.kind === 'task' ? a.firstSeq : a.section.firstSeq;
    const seqB = b.kind === 'task' ? b.firstSeq : b.section.firstSeq;
    return seqA - seqB;
  });

  return allSections;
}
