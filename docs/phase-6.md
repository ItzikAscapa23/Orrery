# Phase 6 — Backlog

Items carried from Phase 5 closeout. All are pre-diagnosed; none blocked
5b shipping. Severity labels are informal: C = correctness, R = representation,
O = observability, U = UI/state.

Priority tiers (orthogonal to thematic sections): **BLOCKING** — can let bad code
through or make the boot ritual unsatisfiable; **WATCH LIST** — diagnosis incomplete,
confidence marker present; **STANDING** — known, non-urgent.

---

## Gate & pipeline integrity

**C-1. Review findings never deleted on re-review.** ✅ DONE (3734edf) `BLOCKING`
`reviewJob.ts` / `awsReviewJob.ts` upsert but have no `deleteMany`. Round 1
raises f1+f2; round 2 raises only f1 → f2 survives at the same `specRev` with
`resolution: null`, blocking `approve-review` on a finding the current round
doesn't report. Nothing in the event log explains it.

**C-2. Resolution reset silently discards operator decisions.** ✅ DONE (3734edf) `BLOCKING`
0a394cf sets `resolution: null, reason: null` on re-review at the same
`specRev`. A human dismissal (with its reason) is wiped with no event
recording that it happened.

**U-16. `activeCount` conflates `working` with `waiting`.** ✅ DONE (99b655c) `BLOCKING`
`apps/web/src/components/TopBar.tsx:45-47`. `working` means "don't interrupt";
`waiting` means "a human is the blocker". One number can't carry both, and the
boot ritual's "0 ACTIVE" precondition is unsatisfiable whenever any feature
parks at a gate.

**U-17. `WORKER_CODE_COMMIT` stamped at launch, never refreshed.** ✅ DONE (0da753b, c498c2f) `BLOCKING`
`agentWorker.ts:26`, `apps/server/package.json:7`. Under tsx watch it certifies
process start time, not loaded code — it drifted three commits this session
(worker on ae36a0f, HEAD at 9ea013e) while the check nominally passed.
Re-evaluate `git rev-parse` at dispatch and compare.

---

## Phase 6 shipped

- **Usage instrumentation** — `anthropic_usage` events recorded on every API call (8bc9980, 1e12ced)
- **Rate table** — model_rates seed, time-aware lookup (629f8b4, 2e32244)
- **Cost endpoint + UI card** — GET /features/:id/cost, GET /cost, CostCard with live refetch on usage events and staleness timestamp (82a058f, 439883e, 4a0b424)

---

## Correctness

**C-3. `detectJsonCommand` infers test runner from CLAUDE.md prose.** `MITIGATED`
`testJob.ts:360-379`. `probe_command` from `repo-manifest.yaml` is now the
primary source and is passed as the first argument to `detectJsonCommand`.
CLAUDE.md inference (`lower.includes('jest')`) is a fallback-only path used
only when no `probe_command` is set. The original bug (jest repo mentioning
vitest → wrong runner) only triggers on repos without `probe_command`. Fix:
ensure `probe_command` is set in `repo-manifest.yaml` for every repo; the
inference fallback should be removed in a future phase.

**C-4. Double suite execution on reporter miss.** ✅ DONE (f260973 area; already fixed in earlier phases)
`testJob.ts:701-733`. The `--outputFile` flag writes the JSON report to a
temp file; the suite runs once. On parse failure the fallback re-runs a
plain command (no JSON re-parse) — no double execution.

**C-5. Fallback path never re-parses.** ✅ DONE by design
`testJob.ts:724-726`. The fallback run preserves `parsed.parseError`
intentionally — exit code is authoritative, and keeping `parseError` makes
the `test.report` payload honest about missing counts rather than fabricating
zeros. Comment at line 726 explains the choice.

**C-6. Nested test directories — confirmed bug on macOS.** `WATCH LIST`
`testAgent.ts:209-221`. Code analysis (Phase 9): when the nested parent
(`acceptance/`) doesn't exist, `resolveReal` falls back to returning the
un-`realpathSync`-resolved path. On macOS `/var → /private/var` symlink
setups, `absTestDir` is realpathSync'd (`/private/var/…/__tests__`) but the
candidate is unresolved (`/var/…/__tests__/acceptance/api.test.ts`). The jail
check then fails — `path.relative(absTestDir, abs)` starts with `..` — and
the write is blocked before `mkdirSync(recursive)` ever runs. Hypothesis
confirmed by static analysis. Fix: in the inner catch of `resolveReal`, use
`path.resolve` rather than `fs.realpathSync.native` for the parent, so the
unresolved macOS prefix is stripped. Not fixed in Phase 9; scheduled forward.

---

## Representation

**R-7. `test.report` shares the review-counts vocabulary.** ✅ MOOT (Phase 9 analysis)
`MissionControl.tsx:341` explicitly excludes `gate === 'test_report'` from
`ApprovalGate`. The `featureFindings` accept/dismiss routes require
`AWAITING_APPROVAL` or `CODE_REVIEW`; `TESTING` is neither, so test-failure
findings cannot be dismissed via the findings API. The `counts.blockers` field
in the `gate.opened` payload is cosmetic and not read by the approval logic.
No action required.

**R-8. Gate card header uses spec-approval copy on other gate types.** ✅ DONE (f260973)
`ApprovalGate.tsx` now switches on `gate.gate`: `spec_approval` → "Spec
revision #N is ready for review", `code_review` → "Code review round #N is
open.", fallthrough → generic "Gate #N requires your decision."

**R-9. `discoverTestDir`'s fallback is `console.warn` only.** ✅ DONE (f260973)
`testJob.ts:164`. `discoverTestDir` now returns `{ dir: string; method:
'candidate' | 'deep-scan' | 'fallback' }`. `runTestJob` and
`runTaskTestJob` emit `agent.log` (severity 'info') when `method ===
'fallback'`, making the guessed jail visible in the event log and UI.

**R-10. Stale docblock at `maybeAdvance.ts:13`.** ✅ DONE (f260973)
Stale "auto-advances CODE_REVIEW → TESTING → DONE" lines removed; docblock
now matches the actual behavior (both paths stop at CODE_REVIEW for the
caller to dispatchForState).

---

## Observability / API hygiene

**O-11. `/features/:id/events/history` caps at 100 events silently.** ~~WATCH LIST~~ RESOLVED
The route accepts a `limit` query param (default 100); the client (`useEventStream.ts`) passes
`limit=500`. The alarm was the default cap, not a missing param. Residual: 500 is still a
ceiling — an initial-history baseline for a long-running feature is silently truncated beyond
event 500. Not blocking.

**O-12. Duplicate `pr.created` event / duplicate ADO PRs.** `WATCH LIST`
Phase 9 diagnosis: `createAdoPrJob.ts:146-154` builds `alreadyCreated` once at
job start from existing `pr.created` events, then loops per repo. The ADO API
call and `appendEvent(pr.created)` are NOT in the same DB transaction. If the
job fails after the ADO API call succeeds but before the event is appended
(network timeout, Bedrock error, process crash), BullMQ retries the job. On
retry, `alreadyCreated` is empty → second PR created → second event appended.
The confirmed duplicates (ping-feature PRs #89905/#89906, coin-flip PR #89853)
fit this pattern. Fix: re-query existing `pr.created` events inside the
per-repo loop (after the set is built), immediately before the ADO API call.
Not fixed in Phase 9.

**O-13. `POST /simulate` has no status guard.** ✅ DONE (f260973)
Route now 409s unless `feature.status` is `DRAFTING_SPEC` or
`AWAITING_APPROVAL`. Test added in `featureSimulate.test.ts`.

**O-14. Agent status not terminal on the gate-resolved path.** ✅ DONE (Phase 7 task 62-agent-status-from-tasks)
Agent display status is now derived from `task.status` aggregates rather than
the last `agent.status` event. See HANDOVER.md `## Decisions`: "Task-derived
agent status applied after the event-sourced fold." Structural root cause
eliminated; no corrective events needed.

**O-15. AWS review returned 8 output tokens.** `WATCH LIST`
1843 in / 8 out on the coin-flip run — that's an empty findings array, not a
review. Plausibly correct for a trivial feature, plausibly a degenerate
response nobody would notice. Low confidence; Phase 3 territory.

---

## Phase 7 backlog (carried from Phase 6)

All 12 remaining STANDING / WATCH LIST items above carry forward unchanged:
C-3, C-4, C-5, C-6, R-7, R-8, R-9, R-10, O-12, O-13, O-14, O-15.

---

## Phase 9 sweep (2026-08-21)

Resolved or diagnosed all Phase 7 carry-forwards. Remaining open items:

- **C-3** MITIGATED — `probe_command` is primary; CLAUDE.md inference is fallback-only. Still open for repos without `probe_command`.
- **C-6** WATCH LIST — confirmed macOS jail bug by static analysis. Fix scheduled forward.
- **O-12** WATCH LIST — root cause diagnosed (non-atomic ADO call + event append). Fix not implemented.
- **O-14** ✅ DONE — structural fix (agent status from task rows) shipped in Phase 7 (62-agent-status-from-tasks). Item closed above.
- **O-15** WATCH LIST — 8-output-token review; low confidence, low priority. Carry forward.
- **O-16** Dispatch never persists `bullJobId`. `queue.ts:56` discards the job
  returned by `add()`; the only write is `devJob.ts:389`, inside the running
  handler, and `testJob.ts` never writes it. `taskReconciler.ts:69`
  (`if (task.bullJobId && liveJobIds.has(task.bullJobId)) continue;`)
  short-circuits on null before consulting `liveJobIds`, so a task in the
  running-but-not-yet-registered window is declared orphaned and re-enqueued.
  Observed 2026-08-21: task 5c34af00 ran jobs 623/624/625 concurrently on one
  worktree — identical turn numbers and token deltas (8855 → 4952 → 1848 → 529)
  through turn 7, diverging at turn 8. 84 `usage.recorded` on one task_id.
- **R-11** `parseTestOutput()` failure *list* includes skipped/disabled entries
  while the count does not. Agent run reported `1 failed` with six names listed,
  two of them `"temporarily disabled"`. The count was correct; the list was not.
- **R-12** Test gate has no baseline diff. BFF clean-branch baseline is
  `1 failed, 16 skipped, 2146 passed`; the agent run reported `2145 passed,
  1 failed` — the same inherited failure. Correct work was rejected.
  `assessProbeResult()` already embodies the principle; the gate doesn't apply it.
- **R-13** Environmental failures consume agent retry slots. `task.failed
  {"final": true, "reason": "Bedrock unreachable — check VPN / aws sso login",
  "attempt": 2}` parked a task permanently. `taskReconciler.ts:73` already states
  the opposite principle for orphans. Fifth occurrence of one rule in two places.

Items closed in Phase 9: C-4, C-5, R-7 (moot), R-8, R-9, R-10, O-13.

**Intermittent test failure (6b/2a, resolved 2026-08-02)** — featureFindings timeout; root cause was git subprocess at dispatch.ts module load; fixed by stubbing `_headCommit` in featureFindings.test.ts (6-U17-flake).

---

## Follow-up: derive agent display status from task rows (structural fix)

**7-o14** emits a corrective `agent.status(failed)` from the reconciler — a symptom fix.
The structural root cause is the same class of defect as the `activeCount` conflating
`working` with `waiting`: agent display state trusts the last `agent.status` event rather
than being computed from the current state of task rows. A future task should replace the
event-driven agent status read path with a query that derives status directly from
`task.status` aggregates — then no corrective event is needed and stale agent state
becomes impossible regardless of which code path moves a task.
