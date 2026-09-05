import { useEffect, useMemo, useRef, useState } from 'react';
import './styles/globals.css';
import { useFeature } from './hooks/useFeature.js';
import { useEventStream } from './hooks/useEventStream.js';
import { foldEvents, EMPTY_STATE } from './lib/eventFold.js';
import { TopBar } from './components/TopBar.js';
import { SolarMesh } from './components/solar/SolarMesh.js';
import { Inspector } from './components/Inspector.js';
import { MissionControl } from './components/MissionControl.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ArtifactViewer } from './components/ArtifactPanel.js';
import { ArtifactTabBar } from './components/ArtifactTabBar.js';
import type { CentreTab } from './components/ArtifactTabBar.js';
import { TestReportCard } from './components/TestReportCard.js';
import { RequirementTab } from './components/RequirementTab.js';
import { ActivityTab } from './components/ActivityTab.js';
import type { ArtifactKind } from '@orrery/shared';
import { FILE_TO_KIND } from '@orrery/shared';
import type { RepoEntry } from './hooks/useFeature.js';
import type { SelectedEntity } from './types/ui.js';
import type { TaskRow } from './components/TaskTable.js';

// Respect prefers-reduced-motion on first render
const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function App() {
  const {
    features,
    selectedId,
    selectFeature,
    createFeature,
    loadRepos,
    refreshFeatures,
    loading,
  } = useFeature();
  const { events, error: sseError } = useEventStream(selectedId);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  useEffect(() => {
    setTasks([]);
  }, [selectedId]);
  const runState = useMemo(
    () => (events.length > 0 ? foldEvents(events, tasks) : EMPTY_STATE),
    [events, tasks],
  );
  const showRedispatch =
    tasks.some((t) => t.status === 'parked') &&
    (runState.currentPhase === 'IMPLEMENTING' || runState.currentPhase === 'LIGHT_IMPLEMENTING');
  const usageEventCount = useMemo(
    () => events.filter((e) => e.payload.type === 'usage.recorded').length,
    [events],
  );
  const taskEventCount = useMemo(
    () =>
      events.filter((e) =>
        ['task.started', 'task.completed', 'task.failed', 'task.tests_written'].includes(
          e.payload.type,
        ),
      ).length,
    [events],
  );
  useEffect(() => {
    if (!selectedId) return;
    fetch(`/api/features/${selectedId}/tasks`)
      .then(async (r) => {
        if (r.ok) setTasks((await r.json()) as TaskRow[]);
      })
      .catch(() => undefined);
  }, [selectedId, taskEventCount]);
  const agentLogEventCount = useMemo(
    () => events.filter((e) => e.payload.type === 'agent.log').length,
    [events],
  );
  const artifactCommittedCounts = useMemo(() => {
    const counts: Partial<Record<ArtifactKind, number>> = {};
    for (const e of events) {
      if (e.payload.type === 'artifact.committed') {
        const basename = e.payload.path.split('/').at(-1) ?? '';
        const kind = FILE_TO_KIND[basename];
        if (kind !== undefined) counts[kind] = (counts[kind] ?? 0) + 1;
      }
    }
    return counts;
  }, [events]);

  const [selected, setSelected] = useState<SelectedEntity>('orchestrator');
  const [motionEnabled, setMotionEnabled] = useState(!prefersReducedMotion);
  const [corpLinkReachable, setCorpLinkReachable] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState<CentreTab>('mesh');
  const [repoMeta, setRepoMeta] = useState<RepoEntry[]>([]);
  // Prevents the auto-switch effect from overriding a user's manual tab choice.
  const userDismissedRef = useRef(false);

  useEffect(() => {
    loadRepos()
      .then(setRepoMeta)
      .catch(() => undefined);
  }, [loadRepos]);

  useEffect(() => {
    const check = () => {
      fetch('/api/health/connectivity')
        .then((r) => r.json())
        .then((d: { reachable: boolean; provider: string }) => {
          // Only show the dot in bedrock mode — irrelevant for direct API
          setCorpLinkReachable(d.provider === 'bedrock' ? d.reachable : null);
        })
        .catch(() => setCorpLinkReachable(false));
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  // Auto-switch to the relevant artifact tab when a gate opens; return to MESH when resolved.
  useEffect(() => {
    const { gateOpen, planGateOpen, amendmentGateOpen } = runState;
    const anyGate = gateOpen !== null || planGateOpen !== null || amendmentGateOpen !== null;

    if (!anyGate) {
      setActiveTab('mesh');
      userDismissedRef.current = false;
      return;
    }

    if (userDismissedRef.current) return;

    if (gateOpen?.gate === 'spec_approval') {
      setActiveTab('spec');
    } else if (gateOpen?.gate === 'test_report') {
      setActiveTab('test-report');
    } else if (planGateOpen !== null) {
      setActiveTab('plan');
    } else if (amendmentGateOpen !== null) {
      setActiveTab('contract');
    }
  }, [runState.gateOpen, runState.planGateOpen, runState.amendmentGateOpen]);

  const selectedFeature = features.find((f) => f.id === selectedId) ?? null;

  const motionClass = motionEnabled ? '' : 'motion-off';

  return (
    <div className={`app-root ${motionClass}`}>
      <div className="app-bg" aria-hidden="true" />

      {/* Top bar */}
      <TopBar
        feature={selectedFeature}
        phase={runState.currentPhase}
        agentStatuses={runState.agentStatuses}
        motionEnabled={motionEnabled}
        onToggleMotion={() => setMotionEnabled((m) => !m)}
        corpLinkReachable={corpLinkReachable}
        features={features}
        selectedId={selectedId}
        onSelectFeature={selectFeature}
        featuresLoading={loading}
        createFeature={createFeature}
        loadRepos={loadRepos}
      />

      {/* Body */}
      <div className="app-body">
        {/* Left panel — mission control or feature picker */}
        {selectedId ? (
          <MissionControl
            featureId={selectedId}
            chatEntries={runState.chatEntries}
            gateOpen={runState.gateOpen}
            planGateOpen={runState.planGateOpen}
            testPlanGateOpen={runState.testPlanGateOpen}
            taskAcceptanceGateOpen={runState.taskAcceptanceGateOpen}
            amendmentGateOpen={runState.amendmentGateOpen}
            spendGates={runState.spendGates}
            showRedispatch={showRedispatch}
            findings={runState.findings}
            questions={runState.questions}
            prLinks={runState.prLinks}
            testReport={runState.testReport}
            sseError={sseError}
            onGateAction={() => void refreshFeatures()}
            onViewArtifact={(kind) => {
              userDismissedRef.current = false;
              setActiveTab(kind);
            }}
            onViewTestReport={() => {
              userDismissedRef.current = true;
              setActiveTab('test-report');
            }}
          />
        ) : (
          <aside className="app-panel-left">
            <div className="panel-header">
              <div className="mono-tag" style={{ color: '#cfd3e6', letterSpacing: '0.13em' }}>
                WEB UI · MISSION CONTROL
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-ui)',
                  fontSize: 10.5,
                  color: 'var(--text-secondary)',
                  marginTop: 4,
                }}
              >
                Select or create a feature to begin.
              </div>
            </div>
          </aside>
        )}

        {/* Center — tab bar + solar mesh / artifact viewer */}
        <div className="app-center-stack">
          <ArtifactTabBar
            activeTab={activeTab}
            committedKinds={runState.committedKinds}
            hasTestReport={runState.testReport !== null}
            onChange={(tab) => {
              userDismissedRef.current = true;
              setActiveTab(tab);
            }}
          />
          <main className="app-center">
            {/* SolarMesh always mounted; hidden via CSS when a doc tab is active */}
            <div style={{ display: activeTab === 'mesh' ? undefined : 'none', height: '100%' }}>
              <ErrorBoundary
                fallback={
                  <div
                    className="solar-mesh"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--text-secondary)',
                      opacity: 0.5,
                    }}
                  >
                    ⚠ solar mesh failed to render — see console
                  </div>
                }
              >
                <SolarMesh
                  phase={runState.currentPhase}
                  agentStatuses={runState.agentStatuses}
                  selected={selected}
                  motionEnabled={motionEnabled}
                  onSelect={setSelected}
                />
              </ErrorBoundary>
            </div>
            {activeTab !== 'mesh' &&
              activeTab !== 'requirement' &&
              activeTab !== 'test-report' &&
              activeTab !== 'activity' &&
              selectedId && (
                <ArtifactViewer
                  featureId={selectedId}
                  kind={activeTab}
                  artifactCommittedCount={artifactCommittedCounts[activeTab] ?? 0}
                />
              )}
            {activeTab === 'requirement' && selectedFeature && (
              <RequirementTab
                requirement={selectedFeature.requirement}
                featurePath={selectedFeature.feature_path}
                currentPhase={runState.currentPhase}
                repos={selectedFeature.repos}
                repoMeta={repoMeta}
                currentBranches={selectedFeature.current_branches}
                prLinks={runState.prLinks}
                createdAt={selectedFeature.created_at}
              />
            )}
            {activeTab === 'test-report' && selectedId && runState.testReport && (
              <div style={{ overflowY: 'auto', padding: 16, height: '100%' }}>
                <TestReportCard
                  testReport={runState.testReport}
                  featureId={selectedId}
                  onAction={() => void refreshFeatures()}
                  {...(runState.gateOpen?.gate === 'test_report'
                    ? { gate: runState.gateOpen }
                    : {})}
                />
              </div>
            )}
            {activeTab === 'activity' && selectedId && (
              <ActivityTab
                featureId={selectedId}
                events={events}
                agentLogEventCount={agentLogEventCount}
                taskEventCount={taskEventCount}
              />
            )}
          </main>
        </div>

        {/* Right panel — inspector */}
        <ErrorBoundary
          fallback={
            <aside
              className="app-panel-right"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-secondary)',
                opacity: 0.5,
              }}
            >
              ⚠ inspector failed to render — see console
            </aside>
          }
        >
          <Inspector
            selected={selected}
            phase={runState.currentPhase}
            agentStatuses={runState.agentStatuses}
            eventLogsByAgent={runState.eventLogsByAgent}
            taskFailures={runState.taskFailures}
            featureId={selectedId ?? ''}
            usageEventCount={usageEventCount}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}
