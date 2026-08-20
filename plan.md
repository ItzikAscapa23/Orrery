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
