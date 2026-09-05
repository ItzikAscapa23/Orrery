import { useEffect, useRef, useState } from 'react';
import { AttachmentList } from './AttachmentList.js';
import type {
  ChatEntry,
  GateState,
  PlanGateState,
  TestPlanGateState,
  TaskAcceptanceGateState,
  AmendmentGateState,
  SpendGateState,
  PrLink,
  FindingEntry,
  QuestionEntry,
  TestReportState,
} from '../types/ui.js';
import { ChatBubble } from './ChatBubble.js';
import { ApprovalGate } from './ApprovalGate.js';
import { PlanGate } from './PlanGate.js';
import { TestPlanGate } from './TestPlanGate.js';
import { TaskAcceptanceGate } from './TaskAcceptanceGate.js';
import { AmendmentGate } from './AmendmentGate.js';
import { SpendGateCard } from './SpendGateCard.js';
import { RedispatchCard } from './RedispatchCard.js';
import { resolveVariant } from './TestReportCard.js';
import type { ArtifactKind } from '@orrery/shared';

const CHIP_DOT: Record<string, string> = {
  pass: '#2ee6c9',
  fail: '#ffb24d',
  skipped: '#6b7290',
  'parse-error': '#ffb24d',
  'details-unavailable': '#6b7290',
  legacy: '#6b7290',
};

function TestReportSummaryChip({
  testReport,
  onView,
}: {
  testReport: TestReportState;
  onView?: (() => void) | undefined;
}) {
  const variant = resolveVariant(testReport);
  const dotColor = CHIP_DOT[variant] ?? '#6b7290';

  let label: string;
  if (variant === 'pass') {
    label = `TEST REPORT — ${testReport.passed ?? 0} passed`;
  } else if (variant === 'fail') {
    label = `TEST REPORT — ${testReport.passed ?? 0} passed / ${testReport.failed ?? 0} failed`;
  } else if (variant === 'skipped') {
    label = 'TEST REPORT — skipped';
  } else if (variant === 'parse-error') {
    label = 'TEST REPORT — parse error';
  } else {
    label = `TEST REPORT — ${testReport.passed ?? '?'} passed`;
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 12px',
        borderRadius: 6,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--border-faint)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.08em',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <span style={{ color: 'var(--text-secondary)', flex: 1 }}>{label}</span>
      {onView && (
        <button
          onClick={onView}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.08em',
            color: 'var(--accent-primary, #7c8cff)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '0 4px',
          }}
        >
          → VIEW
        </button>
      )}
    </div>
  );
}

interface MissionControlProps {
  featureId: string;
  chatEntries: ChatEntry[];
  gateOpen: GateState | null;
  planGateOpen: PlanGateState | null;
  testPlanGateOpen: TestPlanGateState | null;
  taskAcceptanceGateOpen: TaskAcceptanceGateState | null;
  amendmentGateOpen: AmendmentGateState | null;
  spendGates: SpendGateState[];
  findings: FindingEntry[];
  questions: QuestionEntry[];
  prLinks: PrLink[];
  testReport: TestReportState | null;
  sseError: string | null;
  showRedispatch: boolean;
  onGateAction: () => void;
  onViewArtifact?: (kind: ArtifactKind) => void;
  onViewTestReport?: () => void;
}

export function MissionControl({
  featureId,
  chatEntries,
  gateOpen,
  planGateOpen,
  testPlanGateOpen,
  taskAcceptanceGateOpen,
  amendmentGateOpen,
  spendGates,
  findings,
  questions,
  prLinks,
  testReport,
  sseError,
  showRedispatch,
  onGateAction,
  onViewArtifact,
  onViewTestReport,
}: MissionControlProps) {
  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attachRefreshTick, setAttachRefreshTick] = useState(0);
  const [localErrors, setLocalErrors] = useState<ChatEntry[]>([]);
  const [kindSelectorOpen, setKindSelectorOpen] = useState(false);
  const [_pendingKind, setPendingKind] = useState<'input' | 'reference' | null>(null);
  const pendingKindRef = useRef<'input' | 'reference' | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const errorIdRef = useRef(0);

  function pushError(text: string) {
    const id = `err-${String(++errorIdRef.current)}`;
    setLocalErrors((prev) => [...prev, { id, who: 'system' as const, text }]);
  }

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatEntries, streamingText, localErrors, sseError]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');
    setStreamingText('');

    try {
      const res = await fetch(`/api/features/${featureId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        // Surface the server's error message when available (e.g. the state-routing
        // 409 body "Chat input is not accepted in AWS_REVIEW state"), falling back
        // to the status code so the system bubble is never just a number.
        let errorText = `Send failed — server returned ${res.status}`;
        try {
          const errBody = (await res.json()) as { error?: string };
          if (errBody.error) errorText = errBody.error;
        } catch {
          /* non-JSON body — keep status code fallback */
        }
        pushError(errorText);
        setStreamingText(null);
        setSending(false);
        return;
      }
      if (!res.body) {
        pushError(`Send failed — server returned ${res.status}`);
        setStreamingText(null);
        setSending(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const frame = JSON.parse(line.slice(6)) as {
              type: string;
              text?: string;
              message?: string;
            };
            if (frame.type === 'token' && frame.text) {
              setStreamingText((prev) => (prev ?? '') + frame.text!);
            } else if (frame.type === 'done') {
              setStreamingText(null);
            } else if (frame.type === 'error') {
              pushError(frame.message ?? 'An error occurred');
              setStreamingText(null);
            }
          } catch {
            // ignore malformed SSE frames
          }
        }
      }
    } catch (err: unknown) {
      pushError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setStreamingText(null);
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  async function uploadFile(file: File, kind: 'input' | 'reference') {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('kind', kind);
      form.append('file', file);
      const res = await fetch(`/api/features/${featureId}/attachments`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        let msg = `Upload failed — server returned ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          /* non-JSON */
        }
        pushError(msg);
      } else {
        const body = (await res.json()) as { filename: string };
        const id = `attach-ok-${Date.now()}`;
        setLocalErrors((prev) => [
          ...prev,
          { id, who: 'system' as const, text: `Attached: ${body.filename}` },
        ]);
        setAttachRefreshTick((t) => t + 1);
      }
    } catch (err: unknown) {
      pushError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      setPendingKind(null);
      pendingKindRef.current = null;
      setKindSelectorOpen(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <aside className="app-panel-left" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div className="panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: '#ff5b45',
              boxShadow: '0 0 5px #ff5b45',
            }}
            aria-hidden="true"
          />
          <span className="mono-tag" style={{ color: '#cfd3e6', letterSpacing: '0.13em' }}>
            WEB UI · MISSION CONTROL
          </span>
        </div>
        <div
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 10.5,
            color: 'var(--text-secondary)',
          }}
        >
          Chat, Figma links &amp; approvals — you are the human in the loop.
        </div>
      </div>

      {/* Message list */}
      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 15,
          minHeight: 0,
        }}
      >
        {chatEntries.map((entry) => (
          <ChatBubble key={entry.id} entry={entry} />
        ))}
        {localErrors.map((entry) => (
          <ChatBubble key={entry.id} entry={entry} />
        ))}
        {sseError && <ChatBubble entry={{ id: 'sse-error', who: 'system', text: sseError }} />}

        {/* Streaming in-progress bubble */}
        {streamingText !== null && (
          <ChatBubble entry={{ id: 'streaming', who: 'spec', text: streamingText }} streaming />
        )}

        {/* Gate cards */}
        {gateOpen && gateOpen.gate !== 'test_report' && (
          <ApprovalGate
            featureId={featureId}
            gate={gateOpen}
            findings={findings}
            questions={questions}
            onAction={onGateAction}
            {...(onViewArtifact ? { onViewArtifact } : {})}
          />
        )}
        {planGateOpen && (
          <PlanGate
            featureId={featureId}
            gate={planGateOpen}
            onAction={onGateAction}
            {...(onViewArtifact ? { onViewArtifact } : {})}
          />
        )}
        {amendmentGateOpen && (
          <AmendmentGate
            featureId={featureId}
            gate={amendmentGateOpen}
            onAction={onGateAction}
            {...(onViewArtifact ? { onViewArtifact } : {})}
          />
        )}
        {testPlanGateOpen && (
          <TestPlanGate
            featureId={featureId}
            gate={testPlanGateOpen}
            onAction={onGateAction}
            {...(onViewArtifact ? { onViewArtifact } : {})}
          />
        )}
        {taskAcceptanceGateOpen && (
          <TaskAcceptanceGate
            featureId={featureId}
            gate={taskAcceptanceGateOpen}
            onAction={onGateAction}
          />
        )}
        {spendGates.map((sg) => (
          <SpendGateCard key={sg.taskId} featureId={featureId} gate={sg} onAction={onGateAction} />
        ))}
        {showRedispatch && <RedispatchCard featureId={featureId} onAction={onGateAction} />}

        {/* Test report summary chip — links to the TEST REPORT tab in the centre pane */}
        {testReport && <TestReportSummaryChip testReport={testReport} onView={onViewTestReport} />}

        {/* Attached files list — shown once at least one file has been uploaded */}
        <AttachmentList featureId={featureId} refreshTick={attachRefreshTick} />

        {/* Pull request links — shown once PRs are opened in Azure DevOps */}
        {prLinks.length > 0 && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--border-faint)',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-ui)',
                fontSize: 10,
                color: 'var(--text-secondary)',
                letterSpacing: '0.1em',
                marginBottom: 6,
              }}
            >
              PULL REQUESTS
            </div>
            {prLinks.map((pr) => (
              <a
                key={pr.prId}
                href={pr.prUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'block',
                  fontSize: 12,
                  color: '#7eb8f7',
                  textDecoration: 'none',
                  marginBottom: 3,
                }}
              >
                #{pr.prId} · {pr.repo} — {pr.title}
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Kind selector — shown after clicking 📎, before file picker opens */}
      {kindSelectorOpen && (
        <div
          style={{
            padding: '10px 14px',
            borderTop: '1px solid var(--border-faint)',
            display: 'flex',
            gap: 8,
            flexShrink: 0,
            background: 'rgba(255,255,255,0.03)',
          }}
        >
          <button
            onClick={() => {
              pendingKindRef.current = 'input';
              setPendingKind('input');
              setKindSelectorOpen(false);
              fileInputRef.current?.click();
            }}
            style={{
              flex: 1,
              padding: '7px 10px',
              borderRadius: 'var(--r-input)',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid var(--border-medium)',
              color: 'var(--text-primary)',
              fontSize: 11,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            Requirements / context
          </button>
          <button
            onClick={() => {
              pendingKindRef.current = 'reference';
              setPendingKind('reference');
              setKindSelectorOpen(false);
              fileInputRef.current?.click();
            }}
            style={{
              flex: 1,
              padding: '7px 10px',
              borderRadius: 'var(--r-input)',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid var(--border-medium)',
              color: 'var(--text-primary)',
              fontSize: 11,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            External contract (a system we integrate with)
          </button>
        </div>
      )}

      {/* Input row */}
      <div
        style={{
          padding: '12px 14px',
          borderTop: '1px solid var(--border-faint)',
          display: 'flex',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.yml,.yaml"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            const kind = pendingKindRef.current;
            if (file && kind) void uploadFile(file, kind);
          }}
        />
        <button
          onClick={() => {
            setKindSelectorOpen((open) => !open);
            setPendingKind(null);
          }}
          disabled={uploading || sending}
          aria-label="Attach file"
          title="Attach .txt / .md / .yml / .yaml"
          style={{
            width: 38,
            height: 38,
            borderRadius: 'var(--r-input)',
            background: kindSelectorOpen ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
            border: '1px solid var(--border-medium)',
            color: uploading ? 'var(--text-secondary)' : 'var(--text-primary)',
            fontSize: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            cursor: uploading || sending ? 'not-allowed' : 'pointer',
          }}
        >
          📎
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message the Orchestrator…"
          disabled={sending}
          style={{
            flex: 1,
            padding: '10px 12px',
            borderRadius: 'var(--r-input)',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid var(--border-medium)',
            fontSize: 12,
            color: 'var(--text-primary)',
          }}
        />
        <button
          onClick={() => void sendMessage()}
          disabled={sending || !input.trim()}
          aria-label="Send message"
          style={{
            width: 38,
            height: 38,
            borderRadius: 'var(--r-input)',
            background: '#ff5b45',
            boxShadow: '0 0 10px rgba(255,91,69,0.4)',
            color: '#fff',
            fontSize: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            opacity: sending || !input.trim() ? 0.6 : 1,
          }}
        >
          ↑
        </button>
      </div>
    </aside>
  );
}
