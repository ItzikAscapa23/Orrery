# Orrery — Plan

Spec file. **Read-only during execution.** All state lives in `HANDOVER.md`.
Task checkboxes here stay unticked forever — they are a template. The live
copy that gets ticked lives in `HANDOVER.md` under `## Current phase progress`.

PRD: `./PRD.md`

---

## Working model

One task = one brief. Briefs are numbered (`58-something-short`) and carry their
own evidence, numbered requirements, fail-first test list, and acceptance block.
A phase groups several briefs into one session-sized unit of review.

The phase `Verification:` block is the standing four, run once at the end of the
phase. Per-brief fail-first evidence stays in the brief and does not appear here.

Phases 0–6 predate this plan. Their record is `docs/specs/` and `docs/phase-6.md`.

---

## Phase 7 — Agent spend and test redundancy

**Goal:** Stop the two failure modes that dominate cost — test agents rewriting
the same file blind, and the spend guard failing to bound a job it already
admitted.

**PRD refs:** §2 C6, C7; §3 R6, R7

**Tasks:**
- [ ] `58-test-file-reuse` — test agent is told which test files already exist
      for the feature and what they cover; extends rather than duplicating.
      Must reuse `getAuthoredTestFiles` / `getAuthoredTestFilesForTask`, not
      reimplement trailer parsing.
- [ ] `60-spend-guard-budget` — spend guard becomes a budget, not an entry
      condition. Effective turn cap derived at dispatch as
      `min(repo max_turns, threshold − turnsSoFar)`; park at dispatch when the
      remaining budget falls below a usable floor.
- [ ] `61-empty-fix-task-guard` — a clean review must not produce a "Fix review
      blockers" task with no findings to act on. Such a task currently wanders
      into unrelated flaky tests and parks, spending turns on nothing.
- [ ] `62-agent-status-from-tasks` — derive agent display status from
      `task.status` aggregates rather than trusting the last `agent.status`
      event. Structural fix for backlog O-14; removes the need for corrective
      events.

**Definition of Done:**
- A feature with existing test-agent-authored files passes their names and
  describe titles into the test agent prompt; a feature with none behaves as
  before.
- No dev-agent-authored file appears in that list.
- A task cannot exceed `SPEND_GUARD_MAX_TURNS` cumulative turns; the cap is
  enforced structurally by the turn budget, not detected afterwards.
- A review round with zero blockers creates zero fix tasks.
- Agent display status is computed from task rows; no code path can leave it
  stale.

**Verification:**
```bash
npm test            # from the REPO ROOT — apps/server under-reports by ~130
npm run typecheck
npm run lint     # baseline 364 problems (358 errors) - must not increase
```

**Entry conditions for next phase:**
- Full suite green from the repo root.
- A real feature run completes without a task exceeding the turn threshold.

---

## Phase 8 — Planner efficiency

**Goal:** Make coverage decisions cheap and consistent. Coverage dominates cost —
the test agent runs once per covered task plus once at the final gate.

**PRD refs:** §3 R4, R6

**Tasks:**
- [ ] Planner granularity: the same requirement yields 3–6 tasks across runs, and
      nothing tells the planner that each covered task costs a test-agent run.
- [ ] Test planner covered a task whose deliverable is tests — inconsistent with
      skipping the unit-test task on the same grounds. One round of
      request-changes did not shift it.

**Definition of Done:**
- Task count for a fixed requirement varies by no more than one across three runs.
- The planner prompt states the per-covered-task cost.
- A task whose deliverable is tests is never itself covered.

**Verification:**
```bash
npm test
npm run typecheck
npm run lint     # baseline 364 problems (358 errors) - must not increase
```

**Entry conditions for next phase:**
- Cost for a reference feature measured and recorded in `HANDOVER.md`.

---

## Phase 9 — Backlog sweep

**Goal:** Close the small carried items so the backlog stops being consulted as
if it were accurate.

**PRD refs:** §2 C6

**Tasks:**
- [ ] Correct `docs/phase-6.md` — C-3, C-4 and C-5 are resolved in code but still
      listed STANDING in the Phase 7 carry-forward.
- [ ] R-8 gate card header uses spec-approval copy on other gate types.
- [ ] R-9 `discoverTestDir` fallback reaches the event log, not just `console.warn`.
- [ ] R-10 stale docblock at `maybeAdvance.ts:13`.
- [ ] O-13 `POST /simulate` has no status guard; should 409 like `retry-test`.
- [ ] O-12 duplicate `pr.opened` events — diagnose before fixing.
- [ ] C-6 nested test directories in `resolveReal` — hypothesis, never tested.
- [ ] R-7 `test.report` reuses the review blocker/warning/suggestion vocabulary,
      so test failures are dismissible as review findings.

**Definition of Done:**
- Every item above is either fixed or re-recorded with current evidence.
- `docs/phase-6.md` describes the code as it actually is.

**Verification:**
```bash
npm test
npm run typecheck
npm run lint     # baseline 364 problems (358 errors) - must not increase
```

---

## Phase 10 — Spec reconciliation

**Goal:** Close PRD Q1. The specs are two phases behind the code, so an agent
reading them for orientation gets a machine that no longer exists.

**PRD refs:** §5 Q1, Q2

**Tasks:**
- [ ] Document the three approval states, the light path, the spend guard, the
      amendment gate, `task_acceptance_gate`, and the ADO PR job — either as
      `docs/specs/06-*.md` or as an amendment pass over 02 and 05.
- [ ] Close `docs/specs/05` OQ1, OQ4, OQ5.
- [ ] Resolve PRD Q3 — commit an example for the `bff` skill and its
      architecture doc, as `repo-manifest.yaml` already does.

**Definition of Done:**
- No state in `orchestrator.ts` lacks spec coverage.
- A fresh checkout has a working `bff` skill or an explicit note that it is
  operator-supplied.

**Verification:**
```bash
npm test
npm run typecheck
```

---

## Phase 11 — Lint debt

**Goal:** Make `npm run lint` a gate that can pass, so a phase's Definition of
Done stops carrying a permanent known failure.

**PRD refs:** §2 C6, C7

The 364 baseline problems are two unrelated jobs and must not share a commit.
Doing them together produces a diff nobody can review: a mechanical reformat of
~80 files interleaved with judgement calls about type safety.

**Tasks:**
- [ ] Formatting sweep — 232 `prettier/prettier` errors, resolved with
      `--fix`. One mechanical commit, on its own branch, touching nothing else.
      No feature work in the same commit. Verify the suite count is unchanged
      before and after: a formatter should not alter behaviour, and if the count
      moves, something else did.
- [ ] Scoped ESLint override for test files — roughly 100 `no-unsafe-*`,
      `no-explicit-any` and related errors, concentrated in
      `apps/server/src/__tests__/`. These come from `vi.mocked()`, payload casts
      and `as unknown as Anthropic.Message`, which are correct in test code.
      Editing a hundred call sites to satisfy a rule that should not apply there
      is the wrong fix. Declare the exemption once in the ESLint config for
      `**/__tests__/**` rather than suppressing per line.
- [ ] Whatever remains after those two — triage individually. Report the list
      with rule and file; do not blanket-disable.

**Definition of Done:**
- `npm run lint` exits 0, or the residual count is recorded in `HANDOVER.md`
  with a per-item reason for why each remaining problem is not fixable here.
- No `eslint-disable` comment added to a source file to reach that state.
  Exemptions are declared in config, scoped to a path glob.
- Suite count unchanged across the formatting commit.

**Verification:**
```bash
npm test
npm run typecheck
npm run lint
```

**Entry conditions for next phase:**
- The lint baseline line in every earlier phase's Verification block is removed,
  since the gate is now zero rather than a ceiling.
---
## Phase 12 — Dispatch identity and gate baseline
**Goal:** One live agent per task, and a test gate that fails only on new failures.
**PRD refs:** §3 R8, R9
**Tasks:**
- [ ] `63-dispatch-records-job-id` — `queue.ts:56` captures the job returned by
      `add()` and persists its `id` with the dispatch status write. Remove the
      redundant write at `devJob.ts:389`
- [ ] Rewrite the `taskReconciler.ts:69` predicate so null `bullJobId` means
      "not yet dispatched", not "orphaned"; quote the new form in the handover
- [ ] Make both attempt-counter updates at `taskReconciler.ts:82` atomic —
      `{ decrement: 1 }` currently sits beside `Math.max(0, attemptCount - 1)`
- [ ] Enumerate every path that can enqueue for a running task — list, not
      summary: `taskReconciler.ts:185` (immediate + 60s), `featureRedispatch.ts:113`,
      `startupResume.ts:14`, BullMQ `maxStalledCount: 1` (`agentWorker.ts:204`).
      Confirm `queue.ts:56` is still the only `add()` call site
- [ ] Report whether anything writes `parkReason: 'orphan'` — `startupResume.ts:31,40`
      filters on it, the reconciler only writes `'orphan_cap'` (line 122). If
      nothing does, say the path is dead; do not silently fix
- [ ] `64-gate-baseline-diff` — capture the pre-agent probe result and fail a task
      only on tests that newly fail relative to it (R-12)
- [ ] `parseTestOutput()` failure list excludes skipped/disabled entries; list and
      count agree (R-11)
- [ ] Report whether `spendGuard` needs dedup by `job_id` — duplicates consumed 84
      of a 150 budget on one task. Do not implement
**Definition of Done:**
- No task row is queryable with a dispatched status and `bullJobId` null
- Two reconciler passes over one running task produce exactly one enqueue
- A repo with a pre-existing failing test can complete a task
- Failure list and failure count agree on a suite with skipped tests
- Enqueue-path and `parkReason` enumerations recorded in HANDOVER.md
- Fail-first red output captured per case
**Verification:**
```bash
npm test          # baseline 84 files / 1064 tests — must not decrease
npm run typecheck
npm run lint      # baseline 364 problems (358 errors) — must not increase
```
**Entry conditions for next phase:**
- A restart mid-dispatch produces exactly one container
---
## Phase 13 — Recovery paths account for live work
**Goal:** No recovery path re-dispatches a task whose agent is still running.
**PRD refs:** §3 R8
**Tasks:**
- [ ] `65-container-task-identity` — container names carry the task id
      (`container.ts`, currently `orrery-agent-<epoch-ms>`). Add targeted
      termination; `sweepOrphanContainers` (`container.ts:478`) stays as the
      crash-recovery blanket path
- [ ] Any re-dispatch terminates the incumbent container first. Covers the
      residue R8 could not reach: BullMQ `maxStalledCount: 1`
      (`agentWorker.ts:204`) bypasses `queue.ts` and cannot be gated there
- [ ] `66-environmental-retry-slots` — environmental failures do not consume
      agent retry slots (R-13). `taskReconciler.ts:73` already states this
      principle for orphans; `devJob`'s retry policy does not apply it. Evidence:
      `task.failed {"final": true, "reason": "Bedrock unreachable — check VPN /
      aws sso login", "attempt": 2}` parked a task permanently
- [ ] Audit — list, not summary — every classification of a failure as
      agent-caused vs environmental, and confirm they share one definition
- [ ] `67-duplicate-pr-opened` — O-12, non-atomic ADO call plus event append.
      Root cause already diagnosed in `docs/phase-6.md`; implement the fix
**Definition of Done:**
- Container name contains the task id; targeted kill terminates only that task's
  container
- A re-dispatch while an agent is live leaves one running container, not two
- A Bedrock-unreachable failure does not advance the attempt counter
- One shared definition of environmental failure, cited from every call site
- A single ADO PR creation emits exactly one `pr.opened`
**Verification:**
```bash
npm test          # baseline 84 files / 1070 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A restart mid-dispatch produces exactly one container
---
## Phase 14 — Agents see what actually happened
**Goal:** A degenerate tool result is never presented to an agent as a valid one.
**PRD refs:** §3 R9
**Tasks:**
- [ ] `68-empty-report-falls-through` — `summarizeBashTestRun`
      (`testOutputSummary.ts:116`) treats a zero-total parse as a failed
      intercept, not a clean run. Evidence: an empty report file yields
      `parsed.passed ?? 0` and `parsed.failed ?? 0`, so `formatTestSummary`
      returns `TESTS: 0 passed, 0 failed` — exactly the 25-char result the test
      agent received on turns 21, 22, 26 and 27 of feature `0be2aa39`, five
      times, while burning its violation budget trying to make tests appear.
      `parseError` never fires because empty input parses to nothing
- [ ] `69-tool-result-forensics` — `devJob.ts:735-741` logs
      `(${info.resultSize} chars)` and discards the body. Preserve the first
      line of every tool result in the event log. Five identical failures left
      nothing diagnosable after the run
- [ ] `parseTestOutput(catResult.stdout, '')` at `testOutputSummary.ts:115`
      passes empty `stagedFiles`, so no row is ever marked `authored` on the
      intercept path. Determine whether the intercept needs the staged list or
      whether `authored` is meaningless here — report before changing
- [ ] Audit — list, not summary — every site that renders a parsed test result
      into agent-visible or operator-visible text, and confirm each distinguishes
      "ran, zero tests" from "did not run"
**Definition of Done:**
- An empty or missing report file yields raw output, not `TESTS: 0 passed, 0 failed`
- A test command that executes zero tests is distinguishable from one that failed
  to execute
- Event log carries the first line of each tool result
- Render-site audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 84 files / 1079 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- Feature `0be2aa39` passes its test gate on retry-test
