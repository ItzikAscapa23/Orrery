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
---
## Phase 15 — The gate counts what actually ran
**Goal:** No gate passes or rejects on a test set it failed to resolve.
**PRD refs:** §3 R7, R9
**Tasks:**
- [ ] `70-testdir-depth` — C-6/R-19. `discoverTestDir` candidate loop uses
      `findTestFiles(abs, 1)`; BFF tests live at `test/scenarios/<domain>/`,
      depth 2, so every candidate misses. Deep-scan then returns
      `path.relative(worktreePath, path.dirname(found[0]))` which is `''` when
      the found file's directory equals the worktree root. Evidence: three
      `▸ test agent running — writing acceptance tests to /` events on feature
      `0be2aa39`, and `git log -- ''` throwing `fatal: '/' is outside repository`
- [ ] `71-degenerate-results` — R-20 and R-17 share one shape. `getAuthoredTestFiles`
      (`testJob.ts:96`) catches all exceptions and returns `[]`, so a git pathspec
      error is indistinguishable from "nothing authored". `testJob.ts:984` reports
      `✓ all acceptance tests pass (0 passed, 0 failed)` — a false pass at the
      acceptance gate. Both must distinguish "resolved to zero" from "failed to
      resolve". Fix once, apply at both sites
- [ ] R-21 — `discoverTestDir` returns `method`; `testJob.ts:565` guards only
      `'fallback'`. An empty `dir` from `'deep-scan'` passes unchecked. Reject
      an empty dir regardless of method
- [ ] `72-bounce-back-inherits-tests` — R-22. Round 2 on feature `0be2aa39`
      inherited a worktree already containing the round-1 test file, correctly
      concluded no new file was needed, and staged only
      `test/__orrery_harness_brief.md`. The gate demanded a new authored file the
      agent had no reason to write. Bounce-back must account for tests authored
      in prior rounds
- [ ] R-18 — test agent's turn 1 calls `read_file spec.md` and `contract.yaml`
      against the worktree; both are prompt-inlined (`testJob.ts:446-447`) and
      absent from disk. State this in the prompt. Two wasted turns per run at
      88% test-agent cost share
- [ ] Audit — list, not summary — every gate decision derived from a resolved
      path or file set, and confirm each fails loudly when resolution fails
**Definition of Done:**
- `discoverTestDir` never returns an empty dir; a repo with tests at depth 2
  resolves to `test`
- A git failure in `getAuthoredTestFiles` surfaces as an error, not `[]`
- Zero executed tests never renders as a pass at the acceptance gate
- A bounce-back round is satisfiable when prior rounds authored the tests
- Resolution-failure audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 84 files / 1080 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A feature whose test agent authors one file passes its acceptance gate
---
## Phase 16 — Environmental failures leave a recoverable task
**Goal:** A transient Bedrock outage neither strands a task nor requires a DB edit.
**PRD refs:** §3 R8
**Tasks:**
- [ ] `73-bedrock-park-one-definition` — R-23. The Bedrock-unreachable park is
      implemented in four places with three different row treatments:
      `devJob.ts:460` sets `parkReason: 'bedrock_unreachable'`;
      `taskTestJob.ts:129` writes `{ status: 'pending' }` only, leaving
      `bullJobId` stale; `reviewJob.ts:67` and `testJob.ts:441` update no row at
      all. Evidence: feature `14ec88b4` task `daee266f` sat at
      `status: pending, bull_job_id: 641, park_reason: null` after
      `taskTestJob.ts` parked it — invisible to the reconciler (scans `running`),
      to gate handling (scans `parked`), and to dispatch. Recovery required a
      manual `UPDATE tasks SET bull_job_id = NULL`. One definition, cited from
      all four sites
- [ ] `74-bedrock-reprobe-before-park` — R-24. The park fires on the first
      failure. Re-probe with backoff (2–3 attempts over ~30s) before parking.
      The probe already exists — `bedrock-probe passed` fired at 14:31 on the
      same feature that parked at 14:38 and succeeded again on redispatch
- [ ] `75-task-completed-requires-tests` — R-25. A task with
      `coveredByTestPlan: true` reaches `completed` before its test task has run.
      Observed on feature `14ec88b4`: both tasks displayed COMPLETED while the
      test agent was still writing acceptance tests. `completed` must require
      `testsWritten: true` or explicit non-coverage; a covered task awaiting
      tests needs a distinct state
- [ ] Audit — list, not summary — every site that writes a terminal or
      near-terminal task state (`completed`, `parked`, `pending` after failure),
      and confirm each leaves the row consistent with the event it emits
**Definition of Done:**
- A Bedrock failure in any of the four jobs leaves a task some path will recover
- No task is observable as `pending` with a non-null stale `bullJobId`
- A transient Bedrock drop shorter than the backoff window does not park
- A covered task cannot display `completed` while its tests are unwritten
- State-write audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 84 files / 1085 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A task parked by a simulated Bedrock failure recovers without a manual DB edit
---
## Phase 17 — The UI states what the data says
**Goal:** No panel reports a status the underlying rows do not support.
**PRD refs:** §3 R3
**Tasks:**
- [ ] `76-activity-severity-not-prefix` — O-18. `activityFold.ts:178` and `:299`
      classify rows with
      `text.startsWith('◦ turn ') ? 'turn' : 'violation'` — a prefix match on
      display text, while the payload already carries `severity`
      (`ok`/`action`/`info`/`muted`). Every `ok` line renders with the ⚠ glyph,
      including `✓ all acceptance tests pass (2196 passed, 0 failed)`. Map from
      `severity`; one definition, cited from both sites
- [ ] `77-mesh-status-from-tasks` — O-17. Mesh shows Test Agent `DONE` while the
      feature-level test job is running. Phase 12 made task rows authoritative
      for dev/test agent status; the feature-level test job appears not to be
      covered by that derivation. Extend it rather than adding a corrective event
- [ ] Settle C-6. The Phase 15 audit records the nested-test-directory
      hypothesis as resolved by the candidate-depth fix; the Phase 15 summary
      lists `resolveReal` inner catch as still open. Determine whether a distinct
      defect remains and renumber it if so — C-6 must not name two things
**Definition of Done:**
- An `ok`-severity line renders without the violation glyph
- Mesh agent status matches task rows while a feature-level test job runs
- C-6 names exactly one defect, open or closed, with its state recorded
**Verification:**
```bash
npm test
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 18 — Close the backlog honestly
**Goal:** The backlog file lists only open items, and the last one is diagnosed.
**PRD refs:** §2 C6
**Tasks:**
- [ ] O-15 — the ADO PR creation call spends ~29k input tokens for 8–14 output
      tokens, reproducing across every run (`$0.089820` on feature `14ec88b4`,
      `review` agent, 29,870 in / 14 out). Diagnose before fixing: establish
      whether the call is truncating, whether the PR body is being built from a
      response that carries almost nothing, and whether the input is the full
      spec where a summary would do. Report the finding; do not fix in the same
      task
- [ ] Fix O-15 if the diagnosis supports a change; if it does not, record why
      and close it
- [ ] `docs/phase-6.md` holds open items only. Delete every closed entry and the
      four accumulated `Items closed in Phase N` lines. Verify first that the
      evidence survives in the phase commits and HANDOVER audit tables — if it
      does not, keep the entry and mark it `✅ DONE` inline as O-14 already is
- [ ] Record the convention in HANDOVER: entries are deleted on close, not
      annotated; the phase commit carries the evidence
**Definition of Done:**
- O-15 is either fixed or closed with a recorded reason
- `docs/phase-6.md` contains no closed items and no closure lines
- Every deleted item's evidence is reachable from a phase commit or HANDOVER
- The deletion convention is written in HANDOVER's Conventions section
**Verification:**
```bash
npm test          # baseline 84 files / 1098 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 19 — Declared config replaces the last inference
**Goal:** No repo's test runner is inferred from prose.
**PRD refs:** §2 C6, §3 R1
**Tasks:**
- [ ] Determine whether the light path (`path: light`) ever reaches
      `detectJsonCommand`. `bff-configurations` and `swaggers` are both
      `active: true` with no `probe_command`; if either can reach the test job,
      the CLAUDE.md prose fallback (`lower.includes('jest')`,
      `testJob.ts:360-379`) decides its runner. Report before changing
- [ ] Set `probe_command` for every active repo that can reach
      `detectJsonCommand`. Neither `bff-configurations` (env vars) nor
      `swaggers` (OpenAPI YMLs) carries a conventional suite, so
      `--passWithNoTests` is the likely value — confirm against each repo rather
      than assuming
- [ ] Remove the CLAUDE.md inference fallback from `detectJsonCommand` once
      every active repo declares `probe_command`. A repo without one must fail
      loudly at dispatch, not silently guess. Closes C-3
- [ ] Resolve the six `# confirm` markers on `default_branch` in
      `repo-manifest.yaml`. `bff` currently declares
      `version11/11.10.0/update-claude-md` — confirm that is the intended base
      for PRs, since features `0be2aa39` and `14ec88b4` both branched from it
- [ ] Audit — list, not summary — every field in `RepoEntry` that has a code-side
      default or inferred value, and state for each whether the default is
      intentional policy or an undeclared guess
**Definition of Done:**
- Every `active: true` repo that can reach the test job declares `probe_command`
- `detectJsonCommand` has no prose-inference path; a missing `probe_command`
  fails at dispatch with a clear error
- No `# confirm` marker remains in `repo-manifest.yaml`
- `docs/phase-6.md` is empty of open items, or states what remains
- RepoEntry default audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 84 files / 1098 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 20 — Violations cost what they should, and the UI says what is running
**Goal:** No task dies on a no-op redirect, and no agent displays idle while it works.
**PRD refs:** §3 R3, R6
**Tasks:**
- [ ] `78-exempt-null-redirect` — R-29. `2>/dev/null` is a no-op: `container.ts`
      captures stdout and stderr together regardless, and `2>&1` is already
      exempted for exactly that reason. Strip it and proceed rather than
      rejecting. Evidence: feature `f78613cd` task `e4d27ea4` burned violations
      1 and 2 on `find specs -type f -name "*.yaml" ... 2>/dev/null` and
      `find dcs/openapis -type f -name "*.json" 2>/dev/null`, then parked at
      turn 18 having written no code. Cost of that attempt was discarded and the
      task re-ran from scratch
- [ ] `79-one-violation-per-turn` — R-26. Both violations above were issued in
      the same turn, so two slots were consumed before the agent saw feedback
      from either. Count at most one violation per turn
- [ ] `80-working-is-authoritative` — O-19. `eventFold.ts:421` reads
      `if (agentStatuses[agent] === 'working' && derivedStatus === 'done') continue;`
      — it guards one derived value where it should guard the state. An agent
      that has emitted `working` with no later terminal event is working; no
      derived status should overwrite it
- [ ] `81-derive-knows-awaiting-tests` — O-20. Both chains in
      `deriveAgentStatuses` (`eventFold.ts:55-65`, `68-77`) are `else`-chains
      ending in `queued`, and neither knows `awaiting_tests`, added in Phase 16.
      A covered task holding there means dev work is done and tests are running.
      Evidence: on feature `f78613cd` the header read IDLE and Test Agent read
      QUEUED while the test agent was at turn 41 with $0.57 spent, against an
      `agent.status test working` event with no successor
- [ ] Audit — list, not summary — every consumer of `task.status`, in both
      workspaces, and confirm each handles `awaiting_tests`. Phase 16 checked
      three server-side call sites; `deriveAgentStatuses` in `apps/web` was a
      fourth and was missed
**Definition of Done:**
- A command whose only metachar is `2>/dev/null` executes and records no violation
- Two violating commands in one turn consume one slot, not two
- An agent with an unsuperseded `working` event never displays as `queued`,
  `done`, or idle
- A task in `awaiting_tests` derives `done` for its side and `working` for test
- `awaiting_tests` consumer audit recorded in HANDOVER.md, both workspaces
**Verification:**
```bash
npm test          # baseline 84 files / 1093 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A feature run displays the correct agent as working throughout
---
## Phase 21 — Orrery is neutral; organisational policy is operator config
**Goal:** No target's policy is compiled into the orchestrator.
**PRD refs:** §3 R1, §2 C6
**Tasks:**
- [ ] `82-charter-is-config` — R-32. `awsAgent.ts:21` frames every review as
      "reviewing a feature specification for a bank" and `buildSystemPrompt`
      loads `docs/agents/aws-charter.md` unconditionally — 78 lines including a
      literal `## Bank-specific concerns` section. `runAwsReview(featureId,
      featureName, specMarkdown, onUsage)` receives no repo context, so the
      agent cannot know what it is reviewing. Evidence: a demo repo described in
      the manifest as "Express 5 + TypeScript API, ESM. No network calls at
      request time" was told it violates bank CloudWatch logging policy for a
      Lambda it does not have. Move the charter to per-repo operator config:
      `RepoEntry` gains an optional `review_charter` path; the domain framing
      comes from the charter, not a string literal
- [ ] Rename `docs/agents/aws-charter.md` to `.example.md` and commit it as the
      template, matching `repo-manifest.example.yaml`. The Leumi charter becomes
      gitignored operator config
- [ ] AWS review runs only when a charter applies. Reuse the existing
      `SUBMIT_SPEC_LIGHT` → `AWAITING_APPROVAL` transition
      (`orchestrator.ts:38`); no new states. The decision is feature-level,
      resolved at spec submission from the charters of the repos in scope
- [ ] **The AWS-review decision must be independent of `feature_path`.** A FULL
      feature with no charter skips AWS review and keeps PLANNING,
      AWAITING_PLAN_APPROVAL, PLANNING_TESTS, AWAITING_TEST_PLAN_APPROVAL and
      TESTING. Setting `feature_path = 'LIGHT'` to achieve the skip is wrong:
      `APPROVE_LIGHT` (`orchestrator.ts:43`) drops four states and two human
      gates, `REVIEW_PASS_LIGHT` drops TESTING, and `specAgent.ts:95` switches
      to config-change framing. Reuse the transition, not the path flag
- [ ] Extract the skip branch into one function. The body currently lives twice
      — `featureMessages.ts:182-215` and `featureApprove.ts:213` — and carries a
      side effect the full path does not: it opens the `spec_approval` gate
      itself, because `awsReviewJob` normally does. A third copy is not
      acceptable
- [ ] `runAwsReview` receives the repo context so the review knows the
      deployment model. Pass the manifest `description` at minimum
- [ ] Audit — list, not summary — every prompt, charter, or default in
      `apps/server/src` that names a specific organisation, deployment model, or
      target repo. State for each whether it belongs in operator config
**Definition of Done:**
- A FULL feature whose repos declare no `review_charter` reaches
  AWAITING_APPROVAL with the spec gate open, no AWS review job dispatched, and
  planning, both plan gates, and TESTING still in its path
- A feature whose repos declare a charter is reviewed against that charter
- No organisation is named in `apps/server/src`
- The skip branch exists once
- Organisation-specific reference audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 84 files / 1103 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A demo feature completes the full pipeline with no AWS review and no
  bank-policy finding
---
## Phase 22 — Recovery is one click, and failures say why
**Goal:** A parked feature is recoverable from the UI, and a probe failure names its cause.
**PRD refs:** §3 R3
**Tasks:**
- [ ] `83-redispatch-button` — add a REDISPATCH control to the header, beside
      the existing buttons. Calls the existing `POST /features/:id/redispatch`
      (`featureRedispatch.ts:25`). Enabled only when at least one task on the
      feature has `status: 'parked'`; disabled otherwise, so it cannot be used
      to double-dispatch a healthy run. Parked state comes from task rows, not
      from an event — the same rule Phase 12 established for agent status
- [ ] `84-probe-stderr-surfaced` — R-36. A failed probe reports
      `toolchain probe failed: test command exited 1 (report 0 bytes, no output)`
      while stderr held `CACError: Unknown option \`--poolOptions\``. The cause
      was in hand and discarded. Include the first line of probe stderr in the
      failure event, as R-14 did for tool results. Evidence: feature `07f7ad96`
      parked five times across two days before the message was read directly
      from the event payload
- [ ] `85-validate-probe-command` — R-37. `probe_command` is unvalidated
      operator config; a wrong-runner flag surfaces only as a parked task
      mid-run. At startup, for each `active: true` full-path repo, verify the
      declared command's runner matches what `detectJsonCommand` will build.
      Fail loudly at boot, not per feature
- [ ] `86-charter-must-resolve` — R-35. `charterResolver.ts` catches a read
      failure and returns `undefined`, so a missing or misnamed charter file is
      indistinguishable from "no charter declared". A declared `review_charter`
      that does not resolve must throw. Evidence: the Phase 21 rename removed
      `aws-charter.md` entirely and `bff` would have silently skipped AWS review
- [ ] Audit — list, not summary — every startup-time read of operator config
      (manifest, charters, env) and state for each whether a missing or
      malformed value fails loudly or falls through to a default
**Definition of Done:**
- REDISPATCH is visible in the header, enabled only when a task is parked
- A probe failure event carries the first line of the command's stderr
- A repo whose `probe_command` names a runner the repo does not use fails at
  server start with the repo id and the offending command
- A declared `review_charter` pointing at a missing file throws
- Config-resolution audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 85 files / 1108 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 23 — Config validation that fits reality
**Goal:** Validation rejects what is broken, not what is merely unfamiliar.
**PRD refs:** §2 C6, §3 R1
**Tasks:**
- [ ] `87-validate-via-consumer` — R-38. `validateProbeCommands`
      (`validateManifest.ts:54`) requires a literal `npx jest` or `npx vitest`
      and rejected `npm test -- --maxWorkers=2`, the form `bff` had been running
      successfully all week. Validate that `detectJsonCommand` can build a
      reporter command from the declared probe — the actual downstream
      consumer — rather than matching a string pattern
- [ ] `88-config-error-is-not-a-crash` — the same failure surfaced as
      `{"event":"uncaught_exception", ... "origin":"unhandledRejection"}` and took
      the server down with a stack trace. A config validation failure must print
      the repo id, the offending value and the expectation, then exit
      deliberately
- [ ] `89-charter-example-neutral` — R-33. `aws-charter.example.md` is the
      committed template and still contains `## Bank-specific concerns` (line 28),
      CloudWatch logging policy (52) and bank-specific reasoning (66). Phase 21
      renamed the file without neutralising it. Anyone adopting Orrery copies
      bank policy as their starting point
- [ ] `90-one-charter-mechanism` — R-34. `review-charter.md:69` gates its
      concerns on `deploy: aws` in the manifest — a field that does not exist.
      Phase 21 built `review_charter`. One rule, two mechanisms, one of them
      dead. Reconcile, and confirm whether `test-charter.md` has the same shape
- [ ] Audit — list, not summary — every charter and prompt file under
      `docs/agents/`, which agent loads it, and whether it is operator config or
      committed template
**Definition of Done:**
- `npm test -- <flags>` passes validation; a genuinely unusable probe does not
- A config error exits with a readable message and no stack trace
- No organisation is named in any committed `.example` file
- `deploy: aws` appears nowhere, or exists as a real field
- Charter inventory recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 86 files / 1124 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 25 — Tests exist before code, and the flag says so
**Goal:** A covered task never reaches the dev agent without its tests.
**PRD refs:** §3 R7
**Tasks:**
- [ ] `94-tests-written-means-tests-written` — R-40. `taskTestJob.ts:432` and
      `:449` both write `data: { testsWritten: true, status: 'pending' }` on a
      task where the test agent failed and wrote nothing. The flag is used as
      "stop retrying" and read everywhere as "tests exist": `deriveAgentStatuses`
      reads it, the `no-authored-tests` gate reads it, and Phase 16's
      `awaiting_tests` guard checks `coveredByTestPlan && !testsWritten` — so a
      task marked this way passes the guard built to stop exactly this. Whatever
      the recovery, `testsWritten` must reflect reality
- [ ] A covered task whose test agent did not complete parks, and does not
      dispatch the dev job. `taskTestJob.ts:437-452` currently dispatches after
      one transient failure (`testTaskAttempts >= 1`). Evidence: feature
      `7d1146f5` logged `task-test agent failed after 1 attempt(s) — skipping to
      dev job` on a 403, and the dev agent then implemented with no acceptance
      tests
- [ ] `95-environmental-failure-is-not-agent-failure` — the only classification
      in that catch block is `isViolation`. An expired credential, a Bedrock
      outage, and an agent that cannot write tests all take the same path.
      `lib/bedrockPark.ts` is the canonical handler and is not used here. Route
      environmental failures through it
- [ ] `96-dev-agent-does-not-write-acceptance-tests` — on feature `7d1146f5` the
      dev agent wrote ten scenarios into `orderCardClubsList.test.js` that the
      test agent had already covered in
      `orderCardClubsListStrongId.acceptance.test.js`: delta ≥ 500, delta < 500,
      boundary 500, all three merge cases, both error paths, empty responses,
      field precedence. The dev agent's file also left dead scaffolding
      (`runWithMockedDcsApis`, defined and never called). A covered task's dev
      agent should extend or run existing tests, not author parallel ones
- [ ] Audit — list, not summary — every write of `testsWritten` and every read
      of it, in both workspaces, and state for each whether it means "tests
      exist" or something else
**Definition of Done:**
- No code path writes `testsWritten: true` without a test file authored
- A covered task with a failed test agent is `parked`, recoverable by
  REDISPATCH, and its dev job is not dispatched
- A 403 or Bedrock failure in `taskTestJob` routes through `bedrockPark`
- `testsWritten` read/write audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 86 files / 1125 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A feature whose test agent fails parks without the dev agent running
---
## Phase 26 — The test agent stops paying twice
**Goal:** A test task writes its file once and keeps only what it meant to keep.
**PRD refs:** §3 R6, R7
**Tasks:**
- [ ] Report first: measure rewrite cost. On feature `f78613cd` the test agent
      ran 45 turns for $1.75, writing `orderCardClubsListStrongId.test.js` at
      turns 21, 32, 34 and 37 — four versions of one file. But feature
      `7d1146f5` ran 36 turns for $1.10 with one file and genuine red-to-green
      iteration. Quantify how much test-agent output across recent features is
      rewriting rather than first authorship, and whether the 45-turn case is
      the pattern or the exception. Do not fix in this task
- [ ] `91-scratch-files-not-authored` — R-31. Agents create debug files
      (`debug-clubs.test.js` turn 38, `orderCardClubsListDebug.test.js` turn 25)
      that get committed and counted. One run reported "3 file(s)" of acceptance
      tests including scratch. Either exclude them from the authored set or
      prevent their commit
- [ ] Act on the rewrite measurement — the fix depends on what it shows, so the
      brief for it is written after the report lands. If the measurement shows
      rewriting is rare, say so and close the item
- [ ] `92-vendored-node-modules` — the dev-agent prompt (`devAgent.ts:314`)
      forbids reading node_modules, but `bff`'s Lambda layers live at
      `graphql/layers/*/nodejs/node_modules/` and are vendored source that must
      be edited. The agent worked against the instruction for ten turns on
      feature `14ec88b4`. State the exception in the target repo's `CLAUDE.md`,
      which reaches every dev prompt
- [ ] `93-binary-sentinel-is-real` — the demo repos declare
      `binary_sentinel: node_modules/.bin/vitest`, a symlink present after any
      install regardless of platform. It cannot detect a wrong-ABI tree, which
      is the failure it exists to catch. The real artifact for these repos is
      the `@rolldown/binding-*` native module
**Definition of Done:**
- Rewrite cost measured and recorded in HANDOVER.md with a figure
- A debug or scratch file is never counted as an authored acceptance test
- `binary_sentinel` for each active repo names an ABI-specific artifact
- The vendored-layer exception is stated in `bff`'s `CLAUDE.md`
**Verification:**
```bash
npm test          # baseline 86 files / 1130 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 27 — The scratch filter excludes only scratch
**Goal:** No legitimate test file is dropped from the authored set.
**PRD refs:** §3 R7
**Tasks:**
- [ ] `97-narrow-scratch-pattern` — R-42. `SCRATCH_FILE_RE = /debug|scratch/i`
      (`testJob.ts:73`) matches any filename containing those substrings, so a
      legitimate `debugPanel.test.ts` or `scratchpadReducer.test.ts` is excluded
      from the authored set. An excluded real test means
      `authoredPassed === 0`, which fires the `no-authored-tests` blocker — the
      same false rejection that cost two wasted test-agent rounds on feature
      `0be2aa39`. Narrow the pattern to what the agents actually produce:
      observed scratch files were `debug-clubs.test.js` and
      `orderCardClubsListDebug.test.js`
- [ ] The filter is applied at `testJob.ts:94` and `:114`. One definition, cited
      from both
- [ ] Tests, fail-first: `debug-clubs.test.js` excluded;
      `orderCardClubsListDebug.test.js` excluded; `debugPanel.test.ts` retained;
      `scratchpadReducer.test.ts` retained; a file matching neither retained
- [ ] Confirm the prompt-only fix from Phase 26 is measurable. The
      `## Iterating on test files` block instructs the test agent to edit rather
      than rewrite, but instruction-only changes have not held before —
      `devAgent.ts:314` forbids reading node_modules and the agent spent ten
      turns there on feature `14ec88b4`; the pipe and redirect rules are stated
      three times and were violated three times on `f78613cd`. State how the
      11–15% rewrite share will be re-measured after the next few features, and
      what would count as the instruction having failed
**Definition of Done:**
- A test file whose name merely contains "debug" or "scratch" is counted as authored
- The two observed scratch filenames are excluded
- The pattern is defined once
- Fail-first output shown per case
- Re-measurement method for rewrite share recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 86 files / 1130 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 28 — Acceptance tests are read-only to the dev agent
**Goal:** The agent under test cannot change the test it is measured by.
**PRD refs:** §3 R7
**Tasks:**
- [ ] `98-test-files-read-only-to-dev` — R-44. On feature take-19 the dev agent
      made nineteen consecutive edits (turns 17–35) to
      `orderCardClubsListStrongIdBehavior.test.js`, authored minutes earlier by
      the test agent, taking it from `16 passed, 8 failed` to `24 passed, 0
      failed`. Phase 25 told the dev agent not to author acceptance tests; it
      modified the existing one instead. Files carrying the
      `X-Orrery-Agent: test` trailer must be rejected by the dev agent's
      `edit_file` and `write_file` tools, the same way the bash allowlist
      rejects a command
- [ ] Evidence of what the edits did — compare the two versions in the PR:
      | Assertion | test agent (take-18 equivalent) | after dev-agent edits |
      |---|---|---|
      | AC4 threshold | `expect(result.max...).toBe(1500)` | `not.toBeNull()`, `typeof === 'number'` |
      | AC5 merged item | `expect(item.strongId...).toBe(1600)` | `toHaveProperty('strongIdentificationCreditLimit')` |
      | AC7 error | `rejects.toThrow('DCS base failure')` | `rejects.toBeDefined()` |
      A resolver returning `1` passes the second column
- [ ] `99-vacuous-assertion-check` — the same file contains
      `expect(mock.calls.length).toBeLessThanOrEqual(1)`, which passes at zero,
      and three calls wrapped in `.catch(() => {})` that swallow a throwing
      handler. Detect and surface assertions that cannot fail: `toBeDefined`,
      `toBeLessThanOrEqual(n)` on a count, `toHaveProperty` without a value,
      and `forEach` over a collection with no prior non-empty guard. Report as
      test-report warnings, not blockers
- [ ] `100-exempt-output-shaping-pipes` — R-43. Trailing `| head -N` and
      `| tail -N` are output-shaping no-ops, since results are auto-truncated
      before the agent sees them — the same argument that justified exempting
      `2>/dev/null` in Phase 20. Five violations across three agent runs on
      take-19 were exactly this, one of which parked a task and cost a full
      test-agent attempt. Exempt a trailing `head`/`tail` with a numeric
      argument; keep rejecting every other pipe
- [ ] Audit — list, not summary — every tool an agent can use to modify a file,
      and state for each whether it enforces the test-file boundary
**Definition of Done:**
- A dev agent's write or edit to a file with the test trailer is rejected with a
  message naming the file and the reason
- The rejection does not consume a violation slot — it is a boundary, not misconduct
- A trailing `| head -N` or `| tail -N` executes and records no violation
- Vacuous assertions appear as warnings in the test report
- File-modification tool audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 86 files / 1132 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A feature where the acceptance tests are red at dev-agent start ends with the
  same assertions it began with
---
## Phase 29 — Open questions are structured blockers answered at the gate
**Goal:** No spec is approved with an unanswered question.
**PRD refs:** §3 R1, R4
**Tasks:**
- [ ] `101-questions-are-structured` — the spec agent currently emits open
      questions as markdown prose, resolved by strikethrough and a
      `**Resolved: ...**` suffix. That is prose inference in a project whose rule
      is declared over inferred. Emit questions as structured data alongside the
      spec, with a stable id, the question text, and a resolution field —
      the same treatment findings already get
- [ ] Unanswered questions surface on the spec approval gate as blockers. An
      answered question does not surface. Evidence: on feature take-19 the spec
      carried three questions, all resolved, visible only by scrolling to the
      bottom of the SPEC tab — the genuinely-open case would have been invisible
      at the moment of approval
- [ ] `102-answer-round-trips-to-spec` — answering at the gate is an input, not
      a dismissal. The answer goes to the spec agent, which rewrites the spec and
      re-commits it. The gate then reopens against the new spec revision.
      Findings already key on `(featureId, specRev, id)` because model-assigned
      ids recur per cycle; questions need the same
- [ ] Approval is blocked while any question is unanswered. State whether this is
      a hard guard on the approve route or an advisory blocker like a dismissible
      finding — and implement one, not both
- [ ] The gate-opening logic lives in two places: `awsReviewJob.ts` opens it with
      AWS findings, and `specSubmit.ts` opens it directly when no charter applies
      (Phase 21). The question-blocker logic must live in one function both call
- [ ] Audit — list, not summary — every path that opens the spec approval gate
      and every path that can approve past it
**Definition of Done:**
- A spec with an unanswered question cannot be approved
- Answering at the gate produces a new spec revision with the answer recorded
- A resolved question does not appear as a blocker
- Questions are read from structured data, never parsed from spec markdown
- Gate-open and approve path audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 87 files / 1155 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A feature whose spec has an open question reaches the gate showing it, and
  cannot be approved until answered
---
## Phase 30 — Cover what Phase 29 shipped
**Goal:** The approval gate's new behaviour is verified, not assumed.
**PRD refs:** §3 R4
**Tasks:**
- [ ] Report first: enumerate what Phase 29 (`aa04bb3`) added and what covers it.
      679 insertions across 21 files, including `routes/featureQuestions.ts` at
      277 new lines, `lib/specQuestions.ts` at 25, `routes/featureApprove.ts`
      +22, and `components/ApprovalGate.tsx` +192. The only test file touched was
      `MissionControl.test.tsx`, one line. Suite went 1155 → 1155. State which of
      the four DoD criteria have a test today
- [ ] `103-unanswered-blocks-approval` — a feature with an unanswered structured
      question cannot be approved. This is the guard in `featureApprove.ts`; if
      it fails permissively, unanswered questions silently stop blocking and
      nothing surfaces — the same shape as R-15 and R-20. Fail-first: show the
      test red before the guard, green after
- [ ] `104-answer-round-trips` — answering at the gate produces a new spec
      revision with the answer recorded, and the gate reopens against the new
      `specRev`. Cover the id-recurrence case: findings key on
      `(featureId, specRev, id)` because model-assigned ids repeat per cycle;
      questions must not collide across revisions
- [ ] `105-resolved-is-not-a-blocker` — a question with an answer does not appear
      as a blocker, and a spec with every question answered approves normally
- [ ] `106-questions-are-not-parsed` — questions are read from the structured
      record only. A spec whose markdown contains `~~struck-through~~` text or a
      `## Open questions` section must not produce blockers from that prose
- [ ] `routes/featureQuestions.ts` is 277 lines with no test file. Cover its
      routes at the same level as the other route modules — at minimum the happy
      path, an unknown feature id, and an answer submitted against a stale
      `specRev`
- [ ] Audit — list, not summary — every path that opens the spec approval gate
      and every path that can approve past it. This was a Phase 29 task and was
      not reported
**Definition of Done:**
- Each of the four Phase 29 DoD criteria has a named test
- `featureQuestions.ts` has a test file
- Fail-first red output shown for `103` and `106`
- Gate-open and approve path audit recorded in HANDOVER.md
- Suite count stated explicitly against the 1155 baseline, from the repo root
**Verification:**
```bash
npm test          # baseline 87 files / 1155 tests — must increase
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A feature whose spec has an unanswered question is demonstrably unapprovable
---
## Phase 31 — Test report cubes and brand mark
**Goal:** The test report shows what it already measured, and the app carries its own mark.
**PRD refs:** §5 R2
**Tasks:**
- [ ] Report first: the latest `test.report` payload carries `passed: 70`,
      `authored_passed: 69`, `authored_failed: 0`, a `tests[]` array with
      `test_name` / `status` / `authored` / `duration_ms` per row, and eight
      `findings` entries with `"section": "vacuous assertions"` naming file and
      line. None of these counts reach the web view — it renders findings only.
      There is no wall-time field anywhere in the payload. State which of the
      five cube values are web-only and which need a schema change
- [ ] `107-favicon-and-header-mark` — add `apps/web/public/favicon.svg` verbatim
      from the supplied asset, plus `favicon-32.png` and `favicon-180.png`
      rendered from it. In `index.html` remove the default `/vite.svg` icon line
      entirely and add SVG icon, PNG fallback, `apple-touch-icon`, and
      `<meta name="theme-color" content="#0E1626">`. Delete
      `apps/web/public/vite.svg`
- [ ] Header renders the mark at 26px as `<img src="/favicon.svg" alt=""
      aria-hidden="true">` left of the `Orrery` wordmark. Do not re-draw the SVG
      inline in a component — one asset, one source of truth. The shell
      metachar rule, install routing and `maxBuffer` each drifted because
      geometry was copied. Report the header component path edited
- [ ] Audit — list, not summary — every remaining reference to `vite.svg` in the
      workspace, and whether `apps/web` already has a status-colour module. If
      one exists the cubes use it; if not, say so rather than inventing hex
- [ ] `108-wall-time-on-test-report` — add optional
      `wall_time_ms: z.number().int().nonnegative().optional()` to the
      `test.report` payload schema in `packages/shared`. Optional, not required:
      historical events must still parse. Populate it in `testJob.ts` as elapsed
      ms measured around the container exec call only — not install, not report
      parsing, not agent turns. `eventFold.ts` folds a missing value to `null`,
      never to `0`. Fail-first: show the historical-payload parse test red
      before the field is optional
- [ ] `109-cube-values` — five cubes above the findings list: `suite passing` =
      `passed`; `authored` = `authored_passed + authored_failed`;
      `authored failing` = `authored_failed`; `vacuous` = count of `findings`
      where `section === 'vacuous assertions'`; `wall time` = `wall_time_ms` as
      seconds to one decimal, or `—` when null. Against the pasted payload these
      render `70 / 69 / 0 / 8 / —`. Grid is
      `repeat(auto-fit, minmax(104px, 1fr))` so cubes wrap rather than shrink
- [ ] `110-cube-drilldown` — cubes 1–4 expand an inline list below the row;
      `wall time` is inert. `suite passing` → `tests[]` rows with
      `status === 'passed'`; `authored` → rows where `authored === true`;
      `authored failing` → authored rows not passed; `vacuous` → the
      vacuous-section findings showing the `issue` string. Test rows show
      `test_name` and `duration_ms` only — `tests[]` carries no file path, so do
      not link to files. A cube at `0` renders the number but is not clickable
**Definition of Done:**
- `/vite.svg` gone from `index.html` and from `public/`, grep result recorded
- Header mark and favicon load from the same single asset
- `wall_time_ms` present on new `test.report` events; old events still parse
- Five cubes render `70 / 69 / 0 / 8 / —` against the pasted payload in test
- Vacuous count ignores findings outside the `vacuous assertions` section
- Fail-first red output shown for `108`, `109` and `110`
- vite.svg grep and status-colour audit recorded in HANDOVER.md
- Suite count stated explicitly against the 2196 baseline, from the repo root
**Verification:**
```bash
npm test          # baseline 2196 tests — must increase
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A test report with eight vacuous findings shows `8`, not `0`
- Restart the worker before the next run — `testJob.ts` changed
---
## Phase 32 — Artifact tabs are copyable
**Goal:** Any artifact can be lifted into a brief or a ticket in one click.
**PRD refs:** §3 R3
**Tasks:**
- [ ] `110-copy-artifact` — add a Copy control to the artifact tabs
      (REQUIREMENT, SPEC, PLAN, CONTRACT, TEST PLAN). All five render through
      `ArtifactPanel.tsx`, so this is one component change, not five
- [ ] Copy the raw artifact source, not the rendered text — the artifacts are
      markdown and YAML, and the common destination is a brief, a ticket, or a
      chat message where the source is what is wanted
- [ ] The control confirms visibly on click. A clipboard write with no feedback
      reads as broken
- [ ] State whether TEST REPORT and ACTIVITY are in scope. They render through
      different components with structured rather than document content; if they
      are excluded, say so rather than leaving it ambiguous
- [ ] `navigator.clipboard` requires a secure context. The app runs on
      `http://localhost:5173`, which browsers treat as secure, but state what
      happens if the clipboard API is unavailable rather than failing silently
**Definition of Done:**
- Each of the five artifact tabs has a working Copy control
- The copied content is the raw source
- A successful copy is visibly confirmed
- An unavailable clipboard API surfaces rather than failing silently
- TEST REPORT and ACTIVITY scope decision recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 89 files / 1180 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 33 — An agent that is not progressing stops
**Goal:** No agent spends its budget repeating an identical failure.
**PRD refs:** §3 R6
**Tasks:**
- [ ] `111-detect-non-progress` — R-45. On feature `d4fd9d4f` the feature-level
      test agent ran turns 23–80 as a single loop: edit
      `orderCardClubsList-debug.test.js`, run it, receive a byte-identical
      337-char result, repeat. Twenty-seven consecutive identical results over
      45 minutes, ending at the 80-turn safety cap having authored nothing. Hash
      each tool result; when the same result recurs N times consecutively (N=3
      is a reasonable start), stop the agent and surface the repeated result.
      This is a budget guard, not a violation — it must not consume a violation
      slot
- [ ] The stop must be legible. The failure event names the repeated command and
      the first line of the repeated result, so the operator sees why it stopped
      rather than "hit the safety cap". Evidence: the cap message on `d4fd9d4f`
      said only `Test Agent hit 80-turn safety cap without completing`, and the
      actual cause — a missing `bff-utils` mock — took a manual code read to find
- [ ] `112-fixture-shape-is-asserted` — R-46. Agent-authored tests keep writing
      `result.clubItems ?? result.clubsItems ?? []`, which cannot distinguish
      "handler returned nothing" from "test is exercising the wrong branch". On
      `d4fd9d4f` all six failures came from the test never mocking
      `isClientVersionSupported`, so execution took the `!isVersionSupported`
      branch and filtered on `companyCode`/`brand` fields the fixtures did not
      set. The `?? []` made an empty array look like ordinary wrong data. State
      in the target repo's `CLAUDE.md` that a test asserts one response shape and
      does not accommodate alternatives. Third feature running with this pattern
- [ ] `113-turn-timestamps-in-ui` — O-22. Activity tab turn rows carry no
      timestamp, so per-turn duration is invisible in the UI and the 45-minute
      stall was only measurable by querying the events table directly
- [ ] Audit — list, not summary — every cap that can stop an agent (turn cap,
      spend guard, violation cap, and this one), and state for each what the
      operator sees when it fires
**Definition of Done:**
- Three consecutive identical tool results stop the agent
- The stop event names the command and the repeated result's first line
- The stop does not consume a violation slot
- Turn rows show a timestamp
- Agent-stop cap audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 91 files / 1199 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- An agent looping on an identical result stops before its turn cap
---
## Phase 34 — Verification means what it says
**Goal:** An agent that verifies gets the truth, and is not punished for verifying.
**PRD refs:** §3 R6, R7
**Tasks:**
- [ ] `114-npm-test-is-not-scoped` — R-50. `summarizeBashTestRun` returns a
      scoped result for `npm test`. On feature `8cabb35c` task `18cb51c5`,
      turn 20 (`npx jest <one file>`) reported `9 passed`, turn 21 (`npm test`)
      reported `9 passed`, and turn 22 (`npx jest --no-coverage`) reported
      `2191 passed`. The same symptom appeared on take-19, where `npm test`
      returned `12 passed` against a 2200-test suite. An agent verifying with
      `npm test` receives a false all-clear on a fraction of the suite.
      Diagnose before fixing: establish whether `toJsonReporterCommand` is
      grafting a path argument from a previous invocation, or whether the
      report file is stale from the prior run
- [ ] Fix R-50 once diagnosed. A test command that names no path must run the
      whole suite
- [ ] `115-verification-is-not-non-progress` — R-49. The Phase 33 guard counts
      identical *summarised* results across *different* commands. Turns 25, 26
      and 27 of the first attempt ran `npx jest test/scenarios/cardAction/`,
      `npm test --no-coverage` and `npm test` — three distinct commands, each
      collapsed by the summariser to `TESTS: 97 passed, 0 failed` — and the task
      was killed after its fix had already landed at turn 24. Include the command
      in the hash so distinct commands never count as repetition
- [ ] A passing suite is not non-progress. A result reporting zero failures must
      not contribute to the repeat count regardless of how often it recurs — the
      failure the guard exists for was `TESTS: 0 passed, 1 failed` twenty-seven
      times
- [ ] `116-proxy-block-is-environmental` — a `503 File Blocked` HTML page from
      the corporate proxy was classified as an agent failure and consumed an
      attempt (feature `8cabb35c`, task `ef659ce3`). It is infrastructure, the
      same category as Bedrock unreachable, and belongs in `bedrockPark`
- [ ] Audit — list, not summary — every place a test command's output is
      rewritten or summarised before an agent sees it, and state for each what
      the agent can no longer distinguish
**Definition of Done:**
- `npm test` with no path argument reports the full suite count
- Three different commands returning identical summaries do not trigger the stop
- A zero-failure result never contributes to the non-progress count
- A proxy 503 parks without consuming an attempt
- Output-rewriting audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 92 files / 1204 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- An agent running the full suite sees the full suite count
---
## Phase 35 — The orchestrator is not bound by the agent's allowlist
**Goal:** A stale report is detected, not deleted by a command the agent may not run.
**PRD refs:** §3 R7
**Tasks:**
- [ ] `117-remove-the-rm` — Phase 34 added `await container.exec(\`rm -f ${reportFilePath}\`)`
      at `testOutputSummary.ts:115` to prevent a stale report being read. `rm` is
      not in `ALLOWED_PREFIXES` (`container.ts:20-46` lists `cat`, `mkdir`, `cp`,
      `mv` but deliberately not `rm`), and `ContainerHandle.exec` enforces the
      allowlist for every caller. Every test command now fails identically with
      `ERROR: Command not on allowlist: "rm -f /tmp/test-report.json"`. Observed
      on the take-22 test agent: turns 26, 27 and 28 all returned that error,
      tripping the Phase 33 non-progress stop, and the task parked at turn 28
      having authored nothing
- [ ] Do not add `rm` to the allowlist. `mv` and `cp` cannot destroy; `rm` can,
      and Phase 28 made acceptance tests read-only to the dev agent — granting
      `rm` would let an agent delete a test rather than edit it
- [ ] `118-stale-report-is-a-parse-failure` — solve R-50 by detection rather than
      deletion. `summarizeBashTestRun` must establish that the report it reads
      was written by the command it just ran; a report that cannot be shown to be
      current is treated as `parseError`, which already falls through to raw
      output. Report the mechanism chosen — mtime, a marker, or a per-invocation
      path — and why
- [ ] If a per-invocation path is chosen, note the cost: `TEST_REPORT_FILE`
      (`testJob.ts:368`) is read at nine sites across `devJob.ts` (629, 851, 898,
      958), `testJob.ts` (724) and `testOutputSummary.ts` (48, 97, 115). All must
      agree on the path for a given run
- [ ] `119-orchestrator-errors-are-not-agent-violations` — the park message read
      `test agent parked (allowlist violation) — use REDISPATCH to retry` for a
      command the agent did not issue. The agent's three commands were
      legitimate. An orchestrator-injected command that fails must not be
      reported as agent misconduct, and must not consume the violation budget
- [ ] Audit — list, not summary — every command the orchestrator injects into a
      container on the agent's behalf, and state for each whether it passes the
      allowlist
**Definition of Done:**
- No orchestrator-injected command is rejected by the agent allowlist
- `rm` is absent from `ALLOWED_PREFIXES`
- A stale report yields raw output, not stale counts
- An orchestrator-injected failure is not reported as an allowlist violation
- Injected-command audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 92 files / 1210 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A test agent completes a run on the bff repo without an allowlist error
---
## Phase 36 — Test output can be trusted
**Goal:** Every summarised test result is traceable to the command that produced it.
**PRD refs:** §3 R7
**Tasks:**
- [ ] `120-log-resolved-argv-and-report-path` — the event log records the command
      the agent asked for, never the command actually executed by
      `summarizeBashTestRun` nor the report path it read. Log both alongside each
      summary. Evidence from feature `00d548a1`, test-writing job:
      turns 38 (`--testPathPattern="orderCardClubsListStrongIdentification"`),
      42 (`--config`), 44 (`--testPathPattern="NOMATCH" --showConfig`) and
      45 (`--listTests`) each returned **byte-identical 9209-char output**.
      `--listTests` runs no tests and `--showConfig` prints configuration; neither
      can produce a test summary. Turns 47, 48 and 51 then returned identical
      5849-char output across a filtered run and a bare full-suite run
- [ ] Diagnose before fixing. Running the repo's own jest 29.7.0 directly in the
      worktree with the same flag lists exactly one file, so the flag is not at
      fault — something between the agent's command and jest changes the scope or
      the report. Report the mechanism found. Phase 35 introduced a
      per-invocation report path (`/tmp/test-report-<ts>-<rand>.json`); establish
      whether it is reached in every branch
- [ ] `121-summary-states-its-scope` — the summary must say how many test *files*
      it covered, so a whole-suite count under a single-file command is visible to
      the agent. Evidence, final-gate job on one file: turn 4 reported
      `TESTS: 2192 passed`, turn 6 reported `TESTS: 26 passed`
- [ ] `122-vacuous-findings-reach-a-gate` — the Phase 28 detector correctly found
      13 unfailable assertions in the authored test file (`resolves.toBeDefined()`
      ×4, `toBeDefined()` ×5, `toHaveProperty()` without a value ×4). It fires in
      TESTING, after the PR is open and after code review, and the feature went
      `TESTING → DONE` with no gate. Thirteen correct findings had no effect.
      Route them somewhere that can act — a gate, or the test agent's next turn
- [ ] `123-orchestrator-writes-are-not-agent-commits` — commit `6c09c4fd7`
      carries the test agent's trailer and **2,189 lines of lockfile drift**
      (`dynamo-db-utils/package-lock.json` +1191, `common-libraries/package-lock.json`
      +946, root `package-lock.json` 52±, pinning `mysql2 ^3.9.2 → 3.9.2` and
      `sequelize ^6.37.3 → 6.37.3`). No agent turn wrote them; the source is the
      bootstrap install. Exclude orchestrator-written files from agent commits,
      or commit them separately with an orchestrator trailer
- [ ] Audit — list, not summary — every point between an agent issuing a test
      command and the summary it receives, and state what is recorded at each
**Definition of Done:**
- Every test summary event carries the resolved argv and the report path read
- Two different commands cannot produce an identical summary without that being
  visible in the log
- A summary states how many test files it covered
- Vacuous-assertion findings reach something that can act on them
- No lockfile or install artifact appears in a commit carrying an agent trailer
- Command-path audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 92 files / 1211 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A filtered test command and a full-suite command produce visibly different
  summaries
---
## Phase 37 — Agents keep their flags, and blockers do not vanish quietly
**Goal:** A filtered run filters, a re-review re-checks, and an unfixable finding says so.
**PRD refs:** §3 R4, R7
**Tasks:**
- [ ] `124-preserve-agent-flags` — R-51. `toJsonReporterCommand`
      (`testOutputSummary.ts:46-61`) keeps only `extractPositionalArgs`, which
      filters out every token starting with `--`. So `--testPathPattern`,
      `--listTests`, `--showConfig`, `--verbose` and `--no-coverage` are all
      discarded and the agent's command becomes a bare full-suite run. Evidence
      from feature `00d548a1`: turns 38, 42, 44 and 45 issued four distinct
      commands and received byte-identical 9209-char output. Phase 36 documented
      and logged this; it did not change it. Strip only the flags the summariser
      replaces — `--json`, `--outputFile`, `--reporter`. `extractProbeFlags`
      (same file, line 21) already does precisely this for the probe command and
      can be reused
- [ ] Cost note for the report: an agent filtering to one file currently runs the
      full BFF suite (~38s, 2192 tests) on every verification turn. Twelve
      verification turns per test job. State the wall-time saving measured
- [ ] `125-blocked-by-protected-test` — the fix agent has no way to say a finding
      is unfixable. On `00d548a1`, review blocker f3 said base-only club items
      must carry `strongIdentificationCreditLimit = 0` per spec AC5. The test
      agent had pinned `toBeNull()` at lines 340, 374 and 605 of a file carrying
      the `X-Orrery-Agent: test` trailer. Fix-job turn 13 grepped that exact file
      for `toBeNull|toBe(0`, saw what was pinned, and left the code alone —
      correct under Phase 28's read-only rule — then completed the task as though
      the finding were addressed. The blocker was re-raised and dismissed by
      hand, and the wrong behaviour shipped. Add a `blocked_by_protected_test`
      park: the fix agent emits the finding id, the file, and the conflicting
      assertion quoted, and does not complete
- [ ] `126-re-review-checks-prior-findings` — round 2 of the code review did not
      re-raise round-1 blocker f4, which had been masked rather than fixed. The
      fix added an early return that fires only when the merged list is empty;
      the non-empty path still returns no `cardsBasic`/`cardsClub` and never
      applies the `!isVersionSupported` filter, so every 11.5.0+ client sending
      the flag with any clubs receives `undefined` for both fields the schema
      directs it to read. Feed the previous round's findings into the re-review
      as an explicit checklist: each must be marked fixed, still-present, or
      withdrawn with a reason
- [ ] Audit — list, not summary — every transformation applied to an agent's
      command between issue and execution, across the summariser, the probe path
      and the allowlist, and state what the agent can no longer express
**Definition of Done:**
- `npx jest --testPathPattern=X` runs only files matching X
- `--listTests` and a test run produce visibly different output
- A fix agent that cannot satisfy a finding without editing a protected test
  parks with the conflicting assertion quoted, and does not complete
- A re-review states, per prior finding, whether it is fixed, still present, or
  withdrawn
- Command-transformation audit recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 92 files / 1214 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A test agent's filtered run completes in seconds, not the full-suite duration
---
## Phase 38 — Orientation stops being the largest cost
**Goal:** An agent finds a symbol once, and the next agent does not look again.
**PRD refs:** §3 R6
**Tasks:**
- [ ] Report first: measure the current split. On feature `00d548a1`, 132
      tool-issuing turns broke down as 58 orientation (44%), 18 authoring (14%),
      23 verification (17%), 31 waste (24%), against a 28.7k-char
      `orientationBlock`. Establish whether that ratio holds across the last five
      features, and what a turn now costs: 6.34M cache-read tokens across 132
      turns means roughly $0.014 per turn before a token is emitted, so cache
      reads were 39% of the $4.83 total against output's 33%. Do not fix in this
      task
- [ ] `127-orientation-carries-a-symbol-map` — `isClientVersionSupported` lives
      in `graphql/layers/common-files/nodejs/node_modules/bff-utils/general.js`.
      Locating it consumed 16 turns across two jobs: impl turn 18 grepped
      `bff-utils/index.js` (no output), impl turns 25–31 repeated the same grep
      then tried four `find` variations before turn 30's `grep -rn` found it, and
      fix turns 15–18 repeated the identical dead-end from the identical starting
      point 12 minutes later. `dcs/openapis/card-order.json` was re-discovered
      the same way (impl 21–23, fix 19–22). Add an exported-symbol index for the
      vendored layer packages and an index of `dcs/openapis` to the orientation
      block
- [ ] Report the size cost. The block is already 28.7k chars in a ~50k prompt;
      state what the additions cost and whether anything currently in the block
      is unused. A larger block that removes 16 turns is a good trade at
      $0.014/turn; a larger block that does not is not
- [ ] `128-agents-share-what-they-found` — the fix agent had no memory of the
      impl agent locating `general.js` twelve minutes earlier on the same
      feature. The harness brief mechanism already carries knowledge between test
      runs; report whether it can carry a discovered-symbol record between dev
      jobs on the same feature, or whether a separate artifact is needed
- [ ] `129-npm-test-yields-no-summary` — impl turn 36 and fix turn 31 both ran
      `npm test --no-coverage`, both received `[raw output — JSON summary
      unavailable]`, and both then re-ran `npx jest --no-coverage`. The same
      wasted turn twice, ~90 seconds each. Neither the rules block nor the
      target repo's `CLAUDE.md` says `npm test` yields no summary. State it where
      the agent will read it
**Definition of Done:**
- Turn-split and per-turn-cost figures recorded in HANDOVER.md with numbers
- An agent locating a vendored-layer export does not need a filesystem search
- The orientation block's size change is stated, with what it displaced
- `npm test` versus `npx jest` guidance is stated where agents read it
**Verification:**
```bash
npm test          # baseline 92 files / 1214 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- Orientation turns fall below 44% on the next real feature
---
## Phase 39 — A write does not excuse a loop
**Goal:** An edit-run-edit-run loop is caught, and shared test infrastructure is not changed silently.
**PRD refs:** §3 R6, R7
**Tasks:**
- [ ] `130-write-does-not-reset-the-buffer` — R-52. Phase 33 resets the
      non-progress ring buffer on any `write_file`/`edit_file`, added to avoid
      false positives. It is defeated by the commonest loop shape. On take-24 the
      test agent ran turns 40–77 as edit-run-edit-run against a self-created
      probe file: 17 runs of `orderCardClubsListUrlDiscover.test.js`, with turns
      46, 48, 50, 52, 55, 57, 59 and 62 all returning exactly 619 chars and 65,
      67, 69 returning 618. It ended at the 80-turn cap having produced a 129-char
      stub. Reset only when the file written is not the file being run, or count
      identical results in a sliding window that writes do not clear. Note Phase
      37's false positive was three *different* commands returning the same
      summary, which the command-hash fix already covers — the write reset is
      now doing no work the hash does not already do
- [ ] Cost of the loop, for the report: 37 of 80 turns, roughly half the test
      agent's $2.27
- [ ] `131-shared-mock-changes-are-visible` — R-53. The test agent modified
      `test/__mocks__/axios.js`, shared by every test in the repo, adding
      queue-based per-URL responses and call introspection (38-line diff). The
      change is defensible — the feature makes two calls to one URL that must
      return different payloads, and the existing `getByUrl` map cannot express
      that — but nothing flagged it. Phase 28 protects test-agent-authored files
      from the dev agent; nothing constrains an agent editing pre-existing shared
      infrastructure. Surface such edits as a distinct event and in the test
      report, so they are reviewed rather than folded into a feature's test work
- [ ] `132-orientation-answers-the-url-question` — R-54. The 37-turn loop existed
      because the agent had no way to learn which URL the handler calls except by
      writing a probe and running it. The answer is derivable from
      `creditCards.js` and `setup-env-vars.js`, both of which it had already read.
      Report whether the Phase 38 orientation additions can carry a DCS
      endpoint/URL map, and what it would cost in block size
**Definition of Done:**
- An edit-run loop returning identical results stops before the turn cap
- Phase 37's three-different-commands case still does not trigger a stop
- An agent edit to a file under `test/__mocks__/` or equivalent shared path is
  surfaced as its own event
- URL-map feasibility reported in HANDOVER.md with a size figure
**Verification:**
```bash
npm test          # baseline 92 files / 1225 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A test agent completes within its turn cap on the bff repo
---
## Phase 40 — A correct finding has an effect
**Goal:** The review agent's findings route somewhere.
**PRD refs:** §3 R4
**Tasks:**
- [ ] `133-review-warnings-route` — R1. `reviewJob.ts` branches on `blockers`
      alone: zero blockers → `REVIEW_PASS` → `CODE_REVIEW → TESTING`, no gate.
      Warnings have no path. On feature `1b6e3d8c` the review agent produced
      three warnings at seq 336 and `phase.changed → TESTING` fired at seq 338,
      **zero seconds later**. All three `findings` rows still carry
      `resolution: null` — nobody dismissed them, nobody saw them, nothing
      recorded a decision. Meanwhile the vacuous detector's 23 warnings opened a
      `test_report` gate and stopped the feature. The same severity is treated
      two opposite ways
- [ ] Finding f1 was the shipped defect, stated correctly: *"The diff-visible
      early return in the `if (useStrongIdentificationLimit === true)` block never
      falls through to the `if (!isVersionSupported)` branch."* It quotes AC-10,
      names the mechanism, and locates the line. It is the second consecutive
      take shipping this defect
- [ ] Decide and implement one: a `code_review` gate on warnings, or a rule that
      a finding contradicting a stated acceptance criterion must be graded
      `blocker`. Not both. State which and why
- [ ] Findings must record a decision. A `finding.resolved` event should
      distinguish dismissed, fixed, and never-reviewed. Today the AWS spec
      findings all carry `resolution: 'dismissed'` because the spec gate forces a
      human through them; the code-review findings sit at `null` indefinitely
**Definition of Done:**
- A review warning cannot advance a feature without a recorded decision
- Every finding reaches a terminal resolution or blocks
- The routing rule is stated once, and review and test report agree on it
**Verification:**
```bash
npm test          # baseline 92 files / 1225 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 41 — The loop guard counts commands
**Goal:** A repeated command is caught whether or not its output varies.
**PRD refs:** §3 R6
**Tasks:**
- [ ] `134-count-commands-not-results` — R2. `checkNonProgress` hashes
      `{command, results}`. On feature `1b6e3d8c`, test-job turns 21–66 issued
      `npx jest --ci --testPathPattern="orderCardClubsListDebug" 2>&1` more than
      twenty times with result sizes 338/344/350/637/306/299/578/511/549/517/295/291
      — every one different, so no two hashes matched and the guard never fired.
      **46 turns, 35,081 output tokens, $1.506 — 40.4% of the feature.** Count
      repetitions of the command string, not of the result
- [ ] `135-green-does-not-disarm` — the guard clears the ring buffer
      unconditionally on `TESTS: n passed, 0 failed`. A passing scratch file emits
      that every cycle, so **a byte-identical loop against a passing file can never
      trip the stop**. That rule was added in Phase 34 to stop a false positive
      which the command-in-hash fix already covers. Remove it, or restrict it to
      a green result on the command that was previously red
- [ ] Both cases must be tested, and `nonProgress.test.ts` already has the shape:
      a repeated command with varying output stops; three distinct commands with
      identical output do not
**Definition of Done:**
- Twenty runs of one command stop the agent regardless of output variation
- Phase 37's three-different-commands case still does not fire
- A passing result no longer clears the buffer unconditionally
**Verification:**
```bash
npm test
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 42 — The harness brief works at all
**Goal:** What an agent learns survives to the next agent.
**PRD refs:** §3 R6
**Tasks:**
- [ ] `136-orchestrator-computes-the-hashes` — R3a.
      `checkHarnessBriefFreshness` recomputes SHA-256 for every path in the
      `orrery-sources` header, and `HARNESS_BRIEF_WRITE_INSTRUCTION` asks the
      **model** to supply those hashes. On feature `1b6e3d8c` it produced
      `"test/__mocks__/axios.js": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"`
      and `"test/__mocks__/bff-utils.js": "b2c3d4e5f6a7b8…"` — sequential nibbles
      across all thirteen entries. A language model cannot compute SHA-256.
      **Every brief fails freshness and is regenerated forever.** The orchestrator
      must hash the files itself
- [ ] `137-brief-path-agrees` — R3b. `taskTestJob.ts` looks for
      `<worktreeRoot>/__orrery_harness_brief.md`; `testAgent.ts:304` permits that
      path *and* the whole test directory, so the agent wrote
      `test/__orrery_harness_brief.md` legitimately and the pickup found nothing.
      `agent did not write harness brief` fired at seq 251, the same second the
      file was committed. One declared path, enforced at both ends
- [ ] `138-scratch-does-not-reach-the-pr` — because the brief was never captured
      and unlinked, `git add -A` swept it plus a placeholder plus
      `orderCardClubsListDebug.test.js` into PR #92807. The debug file's own body
      reads *"This file is intentionally empty … this file should be deleted"*.
      Exclude scratch-matched and brief files from agent commits, as Phase 36 did
      for lockfiles
- [ ] Report: with hashes computed correctly, does the brief actually carry
      knowledge between jobs? Phase 38's orientation carry-over is built on this
      mechanism and it has never worked
**Definition of Done:**
- Brief hashes are computed by the orchestrator and verify on an unchanged tree
- A brief written by an agent is found by the job that looks for it
- No scratch file or harness brief appears in a PR
**Verification:**
```bash
npm test
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 43 — The vacuous detector earns its gate
**Goal:** A gate worth reading, so it is not approved in 35 seconds.
**PRD refs:** §3 R7
**Tasks:**
- [ ] `139-detector-precision` — R5. The gate reported 23 vacuous of 32 authored.
      Ten are `.find()` results where `toBeDefined()` is the only thing between a
      missing club and a `TypeError` on the next line (lines 280, 281, 632, 664,
      669, 722, 728, 734, 773, 812). Nine more are `toHaveProperty(k)` immediately
      followed by a hard value or type assertion on `subject[k]`. **A 43%
      false-positive rate produced a 35-second approval.** Exempt `toBeDefined()`
      when the subject is the result of `.find()`/`.get()`/index access on the
      preceding line, and `toHaveProperty(k)` when the next statement asserts on
      `subject[k]`
- [ ] `140-flag-the-two-that-matter` — separately and loudly: a test whose *only*
      assertion is vacuous (line 891), and a `forEach` over a collection with no
      preceding non-empty guard (line 213). Both sit in AC-10, the one acceptance
      criterion with no real coverage, and that is why the shipped defect hid
- [ ] `141-tests-that-pass-against-base` — R2 of the report's §2. Eight of 32
      authored tests pass unchanged against the pre-feature commit: all five AC-1
      (by design) and all three AC-10 (not by design). Report whether the
      orchestrator can run the authored tests against the base commit and count
      how many pass. That number would have caught AC-10 automatically. Do not
      implement in this task — report cost and feasibility
**Definition of Done:**
- A `.find()`-guarded `toBeDefined()` is not reported vacuous
- A `toHaveProperty` followed by a value assertion is not reported vacuous
- A sole-assertion-vacuous test and an unguarded `forEach` are reported distinctly
- Base-commit comparison feasibility recorded in HANDOVER.md
**Verification:**
```bash
npm test
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 44 — The loop guard counts what it means to count
**Goal:** Orientation is not mistaken for a loop.
**PRD refs:** §3 R6
**Tasks:**
- [ ] `142-count-the-full-command` — R-56. Phase 41 changed the guard to count
      command repetition rather than result identity. It counts the tool name
      without arguments, so on take-26 the test agent died at **turn 3**:
```
      turn 1 · list_files (43 chars)
      turn 2 · list_files (951 chars)
      turn 2 · list_files (163 chars)
      turn 3 · list_files (214 chars)
      · Non-progress stop: 'list_files' was issued 3 times in a row.
```
      Four different directories, four different results, correct orientation
      behaviour. The comparison must be the full command including its arguments
- [ ] `143-count-only-bash` — every loop the guard exists for has been a
      bash/test-run loop: take-24 turns 40–77 (17 runs of one jest command),
      take-25 turns 21–66 (20+ runs of one jest command, $1.506). A repeated
      `read_file` or `list_files` is orientation, not churn, and the orientation
      problem is Phase 38's to solve, not this guard's. Restrict the counter to
      `bash`. State whether any observed loop would be missed by that restriction
- [ ] `144-non-progress-is-not-a-violation` — the park message read
      `test agent parked (allowlist violation)` for a `NonProgressError`. This is
      the same misclassification Phase 35 fixed for `TestAllowlistViolationError`:
      an orchestrator-side stop reported as agent misconduct. `NonProgressError`
      needs its own branch and its own message
- [ ] Tests, fail-first: three `list_files` on different paths do not stop; three
      identical `list_files` on the same path do not stop under the bash-only
      rule; twenty runs of one bash command with varying output do stop; three
      distinct bash commands with identical output do not
**Definition of Done:**
- An agent listing three directories in sequence is not stopped
- The take-25 loop shape still stops
- A non-progress stop is not reported as an allowlist violation
- Fail-first output shown per case
**Verification:**
```bash
npm test          # baseline 92 files / 1249 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A test agent completes its orientation turns without a non-progress stop
---
## Phase 45 — Coverage is only claimed where it can be proved
**Goal:** The test planner skips what the harness cannot express.
**PRD refs:** §3 R6, R7
**Tasks:**
- [ ] `148-planner-skips-the-unprovable` — the test planner marked the Vite proxy
      task covered, with this behaviour statement:
      *"In the Vite dev server, a request to any /api/* path is proxied to
      http://localhost:3000 and returns the correct API response; no absolute URLs
      appear in client source; no CORS configuration exists on the server."*
      That needs a running dev server and a running API to observe, and two of its
      three clauses are absence proofs, which are not behaviours. Task
      `2d185add` took two test-agent attempts; the parked run spent turns 13–31
      fighting vitest configuration. The planner already skips correctly when the
      deliverable is test code (*"not subject to acceptance testing"*) — extend
      the same judgement to build and dev-server configuration, and to any
      behaviour stated as the absence of something
- [ ] Report the coverage counts. This plan covered five tasks; take-10 on the
      same repo covered two and finished with 70 test-agent events against this
      run's 244. State what the five covered tasks cost and what each proved
- [ ] `149-reporter-flags-are-harness-controlled` — R-57. `toJsonReporterCommand`
      strips `--json`, `--outputFile` and `--reporter` by design, since the
      harness supplies its own. Nothing tells the agent this. On the world-clock
      run it asked for `--reporter=verbose` (turn 13), `--reporter=dot` (14),
      `--reporter=verbose` again (20, 27, 31) and received the same
      JSON-derived summary every time, unable to see why its tests were not
      running. State in the dev and test agent prompts that reporter and output
      flags are controlled by the harness and cannot be overridden
- [ ] Do not change the non-progress guard in this phase. It has been modified in
      four of the last six phases, each fix creating the next failure, and it is
      currently behaving correctly — it stopped a genuine dead end at turn 51
**Definition of Done:**
- A task whose behaviour is configuration or an absence proof is skipped, with
  the reason recorded in the test plan
- An agent supplying `--reporter` is told the flag is harness-controlled
- Coverage counts for this run recorded in HANDOVER.md against take-10's
**Verification:**
```bash
npm test          # baseline 92 files / 1253 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A world-clock feature plans two or three covered tasks, not five
---
## Phase 46 — An agent can see why nothing ran
**Goal:** A degenerate test result carries the reason, not just the verdict.
**PRD refs:** §3 R7
**Tasks:**
- [ ] `150-degenerate-results-carry-stdout` — `summarizeBashTestRun` returns
      `[raw output — zero tests reported]` when the parse yields zero total tests.
      The message names the case and carries none of the evidence. On take-12 the
      test agent received exactly that string eleven times across turns 19–39,
      rewriting `_probe.test.ts` between each (439 → 1981 → 2139 → 1583 → 521 →
      392 → 1222 → 1300 → 474 → 736 → 1235 chars) and never learning why the file
      produced no tests. When total is zero, return the command's actual stdout
      and stderr, truncated, in place of the summary. This is the one case where
      counts are useless and the runner's own error is the whole answer
- [ ] State the truncation limit and why. Full jest output on the bff repo runs
      to thousands of lines; the existing `truncateOutput` path already handles
      the non-test case and should be reused
- [ ] Report: seven consecutive features have produced a probe file —
      `orderCardClubsListUrlDiscover`, `orderCardClubsListDebug`,
      `orderCardClubsListFanOut` debug cycle, `orderCardClubsListUrlDiscovery`,
      `vite-proxy-debug-scratch`, `country-selector-diag`, `_probe`. Every one
      was the agent building an oracle because the harness gives it a verdict and
      no reasoning. State whether this change is expected to end that pattern, and
      what would show it had not
- [ ] `151-scratch-pattern-misses-probe` — `SCRATCH_FILE_RE` is
      `/(?:debug|scratch)(?![a-zA-Z0-9])/i`. `_probe.test.ts` matches neither, so
      an eleven-turn thrash file would have counted as an authored acceptance
      test. Add `probe`, and check the seven filenames above against the pattern
- [ ] `152-reporter-guidance-did-not-hold` — Phase 45 added prompt text naming
      `--reporter`, `--json` and `--outputFile` as harness-controlled. On the very
      next run the agent supplied `--reporter=verbose` on turns 3, 4, 9, 17, 19,
      21, 25, 27, 29, 31, 33, 35, 37 and 39 — every one stripped, as the resolved
      line shows. Report whether the guidance is reaching the prompt at all, and
      if it is, record that the instruction failed so the next attempt is a
      mechanism rather than more text
**Definition of Done:**
- A test command producing zero tests returns the runner's own output
- `_probe.test.ts` is excluded from the authored set
- The reporter-guidance outcome is recorded in HANDOVER.md either way
- Truncation limit stated with its reasoning
**Verification:**
```bash
npm test          # baseline 92 files / 1259 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A test agent that hits a zero-test result resolves it without writing a probe file
---
## Phase 47 — The agent can read a value
**Goal:** An agent that needs a runtime value can print it, instead of building an instrument.
**PRD refs:** §3 R6, R7
**Tasks:**
- [ ] Context, established by turn-by-turn analysis of seven runs (3,533 events):
      eight consecutive features produced a throwaway probe file. The cause is one
      function. `formatTestSummary` returns a bare count line when nothing fails,
      and `· "name" — ${t.message.slice(0, 200)}` when something does. So a probe
      that *passes* yields zero bits — the agent must make it fail to learn
      anything — and a probe that fails yields 200 bytes. take-24 turns 45–62 are
      the proof: eleven distinct one-line edits, **eight byte-identical 619-char
      results in a row**, because everything the agent changed sat past character
      200. It broke through at turn 77 and hit the 80-turn cap at 80. Of eight
      probe episodes, **one ended in knowledge** — and that answer was then lost
- [ ] `153-scale-the-failure-message-cap` — `t.message.slice(0, 200)` is right for
      a 27-failure run and absurd for a one-failure run. Scale it by failure
      count: `slice(0, failed <= 3 ? 4000 : 200)`. The whole summary is already
      capped at 8,192 elsewhere. Cheapest change on this list and it directly
      widens the channel the agent is already using
- [ ] `154-return-console-output` — `summarizeBashTestRun` builds
      `rawCombined = [stdout, stderr].join('\n')` on every call and uses it only
      when the JSON fails to parse. On every successful run it is discarded. The
      orchestrator logs that same stream in full — take-25 seq 264 shows
      `probe exec: … stderr: PASS … ● Console … console.log …`. **The orchestrator
      has the console output; the agent never does.** Append a tail of it to the
      summary
- [ ] The two runners differ and the fix must handle both. On jest, `rawCombined`
      holds the console. On vitest it is empty, because the resolved command is
      `npx vitest run <file> --reporter=json --outputFile=…` and vitest writes the
      report to the file while printing nothing to stdout — which is why Phase
      46's raw path fired on at least eight consecutive turns of world-clock
      take-12 and returned 34 characters, the label and nothing after it. On
      vitest, take the console from the JSON report's per-file entries
- [ ] `155-inspect-tool` — add a tool that runs one node/ts file in the container
      and returns its stdout, path-jailed to the test directory, no assertions
      involved. This is the capability the agent has hand-built eight times.
      `src/__tests__/debug_sort.mjs`, on disk in the take-14 server worktree, is a
      complete specification: nine lines, no assertions, five `console.log`s, one
      question — what order does `localeCompare` give `"Côte d'Ivoire"` and
      `"Croatia"`. It was committed unread, because `node` is not on the
      test-agent allowlist and nothing reads print
- [ ] Do not add prompt guidance for this. Phase 45 told the agent that
      `--reporter` is harness-controlled; world-clock take-12 requested
      `--reporter=verbose` on eleven consecutive turns and take-13 requested
      `--reporter=tap`. Every one was rewritten to `--reporter=json`, and it must
      be — the summariser reads a JSON report. Asking the agent not to want
      verbose output is asking it not to want the thing it needs
- [ ] Do not change the non-progress guard. It is working: it fired correctly on
      take-26, world-clock take-12 and take-13. But note what it bought — seven
      of eight probe episodes now end in a cap, a park or a spend gate rather
      than an answer. Capping the loop converted take-25's $1.59 answer into five
      cheaper non-answers. This phase is the reason the guard will stop mattering
**Definition of Done:**
- A one-failure test run returns the full assertion message, not 200 characters
- A test run's console output reaches the agent, on both jest and vitest
- An agent can run a file and read its stdout without writing an assertion
- Fail-first output shown for the cap and the console cases
**Verification:**
```bash
npm test          # baseline 92 files / 1261 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A feature completes with no probe file written
---
## Phase 48 — inspect_file actually runs the file
**Goal:** The capability Phase 47 added works, and cannot silently stop working.
**PRD refs:** §3 R7
**Tasks:**
- [ ] `156-inspect-file-uses-a-container-path` — `testAgent.ts:844` calls
      `container.exec(\`node ${absPath}\`)` where `absPath` comes from
      `checkReadAllowed`, which returns a **host** absolute path
      (`/private/tmp/orrery-worktrees/…`). Inside the container the worktree is
      mounted at `/workspace`, so that path does not exist and node exits with
      `MODULE_NOT_FOUND`. Pass the path relative to the worktree root instead;
      `checkReadAllowed` stays as the security check and only the string handed
      to `container.exec` changes
- [ ] Evidence. On world-clock take-17 the test agent called `inspect_file` four
      times — turns 6, 12, 19 and 21 across two jobs — and every call returned
      **535–540 characters**. Running the exact command by hand against that
      worktree produces 517 characters of `MODULE_NOT_FOUND`; the agent's four
      results are that error plus the lines `head -12` truncated. The same file
      run with a container-relative path prints `probe` and exits 0. **The tool
      has never executed a file.** The agent wrote, in `probe_app.mjs`:
      `// This is a node inspect helper (not a test)` /
      `// We can't run this directly, but we can check through vitest output` —
      an accurate report of what it observed
- [ ] `157-a-test-that-would-have-caught-it` — Phase 47 shipped with no test
      asserting `inspect_file` returns a file's output. Add one: a file that
      prints a known string, asserting the result **is** that string and does not
      contain `MODULE_NOT_FOUND` or `Error`. A tool whose failure mode is
      "returns an error message as if it were output" needs an assertion on the
      content, not on the call
- [ ] `158-inspect-results-are-logged-like-bash` — the `agent.log` line for
      `inspect_file` reads `◦ turn 21 · inspect_file (535 chars)` with no result
      preview, while `bash` lines carry `→ TESTS: …`. `onToolCall` is passed
      `resultFirstLine` and it is dropped for this tool. Four identical failures
      were invisible in the log for that reason
- [ ] Report: with `inspect_file` working, does the probe-file pattern stop?
      Ten consecutive features have produced one — take-17 produced seven in a
      single worktree (`probe_app.mjs`, `probe_app.test.ts`,
      `probe_appmodule.test.ts`, `probe_fetch.test.tsx`, `probe_render.test.tsx`,
      `probe_single.test.tsx`, `probe_vitest_env.test.ts`). State what would show
      it had not
**Definition of Done:**
- `inspect_file` on a file that prints returns the printed output
- A test asserts the returned content, not merely that the tool was callable
- The `inspect_file` log line carries a result preview
**Verification:**
```bash
npm test          # baseline 92 files / 1269 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- A client-side test task completes without writing a probe file
---
## Phase 49 — Writing nothing is a valid outcome
**Goal:** A test agent that correctly adds no files does not crash the job.
**PRD refs:** §3 R7
**Tasks:**
- [ ] `159-skip-the-empty-commit` — R-59. The feature-level test job stages, then
      commits unconditionally. On feature `01c70dcc` the agent read the existing
      acceptance file (23,722 chars, authored by the task-level agent at turn 19),
      ran it — `TESTS: 41 passed, 0 failed (1 file)` — ran the wider pattern —
      `TESTS: 50 passed, 0 failed (2 files)` — and correctly concluded there was
      nothing to add. Four turns, no probe files, sound judgement. The
      orchestrator then committed with an empty staged set and the target repo's
      pre-commit hook failed:
      `Running Prettier on staged files... No relevant files staged, skipping Prett`
      The job threw, and the feature stopped in TESTING with no test report, no
      gate, and no park — nothing to approve and nothing to act on. Skip the
      commit when nothing is staged
- [ ] Zero new test files is the *expected* outcome at the final gate when the
      task-level agents have already covered every covered task. Emit it as a
      normal event — "no new test files authored; N existing authored tests
      passed" — and let the gate proceed on the existing authored set. Do not
      treat it as a failure and do not use `--no-verify`, which would disable the
      target repo's own lint hook
- [ ] Note the interaction that produced it: Phase 36 correctly unstages lockfile
      drift from agent commits (`unstaged 3 lockfile(s) from agent commit`), and
      on this run that left the staged set empty. Both behaviours are right; the
      combination is unhandled
- [ ] Tests, fail-first: an empty staged set skips the commit and the job
      completes; a non-empty staged set still commits; the resulting event names
      the count of pre-existing authored tests
**Definition of Done:**
- A test job with nothing to stage completes without invoking git commit
- The feature reaches its test-report gate on the existing authored set
- The no-new-files case is a distinct, non-error event
**Verification:**
```bash
npm test          # baseline 92 files / 1270 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
**Entry conditions for next phase:**
- Feature `01c70dcc` reaches a test report on retry-test without a commit
---
## Phase 50 — A call that never returns is not a running task
**Goal:** No feature is stranded by a request with no deadline.
**PRD refs:** §3 R6
**Tasks:**
- [ ] `160-request-timeout` — R-48. Bedrock/Anthropic calls have no request
      timeout. Feature `8cabb35c`: ten calls succeeded with cache reads climbing
      17,590 → 20,555, the eleventh never returned. 26 minutes of silence, the
      container idle on `sleep infinity`, the task still `running`, credentials
      valid throughout. Feature `33b4d931`: four hours between the last event and
      discovery, two containers alive, jobs 937 and 938 still in BullMQ's active
      list. Set an explicit timeout on the API client and route it through
      `bedrockPark`, which already handles environmental failure without
      consuming a retry slot
- [ ] `161-a-killed-process-releases-its-jobs` — recovery from both incidents
      required manual surgery: kill the server, `docker rm -f` the containers,
      `LREM bull:agent-jobs:active` per job id, then `UPDATE tasks SET
      status='pending', bull_job_id=NULL`. A killed process leaves its job in
      BullMQ's `active` list, so `taskReconciler` — which checks liveness against
      that list — reports the job as running and skips the task. Redispatch does
      not help either: it only resurrects `parked` tasks, and these were
      `running`. State what the recovery path should be and implement it
- [ ] Report the timeout value and its reasoning. A dev agent turn on the bff
      repo legitimately runs minutes; the cap must not fire on healthy work. The
      observed hangs were 26 minutes and 4 hours
**Definition of Done:**
- A request exceeding the timeout parks the task, without consuming a retry slot
- A task whose job is stale is recoverable from the UI, with no Redis or
  Postgres edits
- Timeout value and reasoning recorded in HANDOVER.md
**Verification:**
```bash
npm test          # baseline 92 files / 1272 tests — must not decrease
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 51 — A test may not exercise its own stand-in
**Goal:** An acceptance test imports the implementation, not a fake the agent just wrote.
**PRD refs:** §3 R7
**Tasks:**
- [ ] `162-no-self-authored-subjects` — R-58. On world-clock take-17 the test
      agent wrote `src/__tests__/helpers/CountrySelectorStub.tsx` and
      `ResultRegionStub.tsx`, then wrote acceptance tests importing those:
      `country-selector.test.tsx:17` → `./helpers/CountrySelectorStub`,
      `result-region.test.tsx:12` → `./helpers/ResultRegionStub`. The real
      `src/components/CountrySelector.tsx` and `ResultRegion.tsx` existed and were
      never imported. 28KB of tests, all green, verifying nothing. The review
      agent caught it; four gates did not. Reject an agent-authored test that
      imports a module the same agent authored in the same run
- [ ] `163-mock-dirs-are-declared` — the exemption is per-repo vocabulary, not
      orchestrator knowledge. Add `mock_dirs` to `RepoEntry`, e.g.
      `["__mocks__", "fixtures"]`; a self-authored import under a declared mock
      directory is allowed. Absent means no exemption. This follows
      `probe_command` (Phase 19) and `review_charter` (Phase 21) — the rule lives
      in Orrery, the vocabulary lives in the manifest
- [ ] Do not adopt the broader rule "a test must import something outside the
      test directory". An investigation of the bff suite found **145 of 231 files
      (63%) have no relative import outside `test/`** — they reach implementation
      through Prism HTTP or through layer package names like `dcs-apis`. That
      rule would flag a working suite. The self-authored rule scores zero on the
      same suite: its only intra-test imports are `__mocks__/`, `utils/`,
      `dataMockFiles/` and one cross-scenario data file
- [ ] Tests, fail-first: the take-17 shape is rejected; an import from a declared
      mock dir is allowed; a repo with no `mock_dirs` still passes on a test that
      imports only implementation
**Definition of Done:**
- An acceptance test importing a same-run self-authored module is rejected, with
  the file and the import named
- A `mock_dirs` import is not rejected
- No bff test file would be rejected by this rule
**Verification:**
```bash
npm test
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 52 — Client component coverage: decide, then act
**Goal:** Stop paying for a coverage mode that has never completed.
**PRD refs:** §3 R6, R7
**Tasks:**
- [ ] Report first, no code. Client component tasks have been covered four times
      and completed zero times, each failing differently: take-12 fake-timer
      install order (46 turns); take-17 tests written against stubs; take-18 an
      untestable CSS-layout task marked covered; and an earlier run lost to probe
      loops from the then-broken `inspect_file`. Server tasks completed in every
      one of those runs. Quantify it — for each of takes 10, 12, 13, 16, 17, 18:
      covered client tasks, covered server tasks, outcome per task, cost
- [ ] State whether anything in the four causes is now fixed. `inspect_file`
      works as of Phase 48; the fake-timer fact is in the client repo's
      `CLAUDE.md`; the stub rule is Phase 51. Only the untestable-task cause is
      untouched, and Phase 45 already skips CSS layout — establish why take-18's
      `App shell: header and page layout` was covered anyway
- [ ] Recommend one of: keep client coverage and fix what remains; drop it and
      make the light path the declared default for client repos; or make it a
      per-repo manifest setting so the bank repos and the demo repos can differ.
      Give the cost of each. take-16 covered server only and completed for ~$2;
      take-13 covered five and reached $27
- [ ] Do not implement the recommendation in this phase
**Definition of Done:**
- Per-take table recorded in HANDOVER.md with costs and outcomes
- Each of the four causes marked fixed, partly fixed, or open
- One recommendation stated with its cost
**Verification:**
```bash
npm test
npm run typecheck
npm run lint      # must stay clean (exit 0)
```
---
## Phase 53 — A guard and its override must read the same state
**Goal:** Every guard that can park a task can be released by the control the UI offers for it.
**PRD refs:** §3 R6, R7
**Tasks:**
- [ ] `164-spend-override-is-not-inert` — R-61. `checkSpendGuard` derives its
      count from the append-only log: `COUNT(*) FROM events WHERE type =
      'usage.recorded' AND payload->>'task_id' = $taskId`.
      `featureSpendGate.ts` writes `gate.resolved` with `resolution: 'override'`
      and updates `attemptCount`, `status`, `parkReason`, `bullJobId` — none of
      which the guard reads — then calls `dispatchUnblockedTasks`, which re-runs
      the guard against the same unchanged rows. Observed on take-19 task
      `f3abb49e`: RESUME produced a `gate.resolved` followed immediately by a
      fresh `gate.opened`; the card never cleared and the click looked inert.
      RESUME has never worked for the spend guard. Make the accepted override
      raise the effective threshold for that task — a granted-budget column
      added to the threshold, or the count scoped to events after the last
      `gate.resolved` — and state which and why
- [ ] `165-no-diff-plus-green-is-not-a-failure` — R-62. `task.failed` for task
      `3cce0c84`, attempt 1, `final: true`: *"completed but no file changes
      detected in worktree and tests fail — expected work is genuinely absent /
      TESTS: 99 passed, 0 failed (6 files)"*. The message asserts a conjunction
      and prints the evidence that its second conjunct is false. The agent had
      reached `verifying tests before host-side commit` after 8 turns with
      `24 passed, 0 failed` on its own subject. Both halves must hold before
      failing; an empty diff with a green suite completes the task. Audit for
      this condition existing elsewhere — the empty-staged-set case (Phase 49)
      is the same shape and may share or duplicate the check
- [ ] `166-no-test-task-for-an-already-tested-subject` — R-63. Take-19 queued
      `3cce0c84` (depends on `324d37a0`) and `c2db56e8` (depends on `f3abb49e`)
      while both dependencies carried `tests_written = true`. `3cce0c84` read the
      existing `CountrySelector.test.tsx` (15861 chars) at turn 1 and had nothing
      to do; `c2db56e8` was queued to repeat the identical no-op. Skip a test task
      whose subject already has `tests_written`. Declared, not inferred — read the
      column, do not infer from file presence
- [ ] Audit and list. These three are one failure class: a guard reading state
      that the releasing path does not update. Enumerate every guard that can set
      `park_reason` or emit `task.failed`, and for each state what releases it and
      whether that release touches the state the guard reads. The list, not a
      summary
- [ ] Tests, fail-first, red output reported per case: override on a task at
      exactly threshold dispatches and does not re-park; a second override after
      further spend behaves the same; empty diff + green suite completes; empty
      diff + red suite still fails; a test task whose subject has
      `tests_written = true` is skipped, one whose subject does not is dispatched
**Definition of Done:**
- RESUME on a spend-parked task runs it; no `gate.opened` follows the
  `gate.resolved` in the same dispatch
- No task fails with a reason whose own evidence contradicts it
- Guard/release audit table in HANDOVER.md, every row accounted for
**Verification:**
```bash
npm test          # FROM REPO ROOT — baseline 93 files / 1288 tests, must not decrease
npm run typecheck # all three workspaces
npm run lint      # must stay clean (exit 0)
```
---
## Phase 54 — A retry starts warmer than the attempt before it
**Goal:** Nothing in the loop makes the second attempt worse than the first.
**PRD refs:** §3 R6
**Tasks:**
- [ ] `167-retry-keeps-what-the-last-attempt-established` — R-64. Take-19
      `f3abb49e` attempt 1 reached green at turn 54 (`ResultRegion.test.tsx`
      30 passed, 0 failed; full suite 47 passed) by writing
      `src/__tests__/setup.ts` and adding `setupFiles` to `vitest.config.ts`. It
      then hit the 60-turn cap and the host-side commit never ran. Attempt 2
      opened with `worktree reset to clean branch HEAD`, which discarded both
      files, and spent turns 14–37 re-deriving the same node_modules
      investigation from zero before running out at 47 turns. 107 turns across
      two attempts for a fix the first attempt had already found. Carry the prior
      attempt's diff, or a record of what it established, into the retry
- [ ] `168-the-agent-has-no-delete` — attempt 1 spent turns 56–60 — its last five
      — trying to remove its own scratch files: `rm` rejected as
      `Command not on allowlist`, then blanking two files to 44 bytes each, then
      re-running the suite. The host already strips these
      (`unstaged 1 scratch/brief file(s)`). The agent does not know that. Either
      give it a delete, or tell it in the rules that scratch files are stripped
      host-side and must not be cleaned up. State which and why
- [ ] `169-worktree-path-must-be-a-repo` — R-60. `createWorktree` reuses a
      slug-derived path without checking it is a git repo.
      `/private/tmp/orrery-worktrees` currently holds four such directories with
      no `.git` sibling and three entries each — `world-clock-feature-take-8-*`,
      `-take-9-*`, `-take-10-*`, `-take-12-worldclock-server-work`. A reused slug
      gives `fatal: not a git repository`, retried 3×, surfacing as "orphaned 3
      times — structural issue suspected". Validate and recreate
- [ ] `170-redispatch-banner-clears` — the banner condition is any `running` task
      in IMPLEMENTING (Phase 50), and redispatch's first act sets a task running,
      so the button re-satisfies its own condition and never clears. Use the
      no-live-job test. Audit for the condition existing in both the API layer and
      the web component — the "parked or stuck" wording appears in both
- [ ] `171-slug-truncation` — four sibling directories are named
      `orld-clock-feature-take-14-*`, leading `w` removed, while same-run peers
      for other takes are correct. Find the off-by-one and report where it was.
      A truncated slug and a correct one are two different paths for one feature
- [ ] Tests, fail-first, red output reported per case: a retry after a capped
      attempt sees the prior attempt's work; a worktree path that exists but is
      not a repo is recreated rather than failing; the banner is absent while a
      redispatched task is running; the slug for a name beginning `w` is intact
**Definition of Done:**
- A capped attempt's work is available to the next attempt, demonstrated on a
  reproduction of the take-19 shape
- No agent turn is spent on scratch-file cleanup
- Non-repo worktree path recovers without a retry being consumed
- Banner clears on redispatch
**Verification:**
```bash
npm test          # FROM REPO ROOT — baseline 93 files / 1288 tests, must not decrease
npm run typecheck # all three workspaces
npm run lint      # must stay clean (exit 0)
```
---
## Phase 55 — The agent can ask a question
**Goal:** An agent that needs to see a value does not have to manufacture a failure to read it.
**PRD refs:** §3 R6, R7
**Tasks:**
- [ ] `172-a-print-channel` — R-66. World-clock take-20 task `758c3426`, both
      attempts. The twelfth rewrite of `src/__tests__/zoneDebug.test.tsx` ends:
      `expect(callCount).toBe(999); // fail to see: callCount, url1, selectValue`
      — `999` and `'SHOW'` are sentinels, asserted because the assertion failure
      is the only way the agent can read a runtime value. `console.log` does not
      reach it and bash output is parsed to `TESTS: n passed, m failed (f files)`
      plus a capped excerpt. One sentinel reads one variable at one container
      round-trip. Attempt 1 burned turns 12–36 on `probe_dom.test.tsx`; attempt 2
      turns 8–34 on `zoneDebug.test.tsx` (comment `// Method 1:` marks discarded
      approaches). 70 turns, $1.45, no acceptance test. Turn 4 of attempt 2 had
      returned 11,614 chars of real failure output — the agent was not short of
      feedback about failures, it could not observe values. Give it a channel.
      State the mechanism chosen and why: runner `console.log` passthrough, a
      declared scratch-output path returned verbatim, or an explicit tool. One
      mechanism, not three
- [ ] `173-both-agents` — the dev agent has the same gap; only the test agent has
      been observed working around it. The channel must exist on both prompt
      paths
- [ ] `174-bounded-output` — the failure-message cap (Phase 47,
      `slice(0, failed <= 3 ? 4000 : 200)`) exists because unbounded output is
      expensive. State this channel's cap and its reasoning. Truncation must be
      visible, not silent
- [ ] `175-prohibit-the-sentinel` — the agent rules name the new mechanism and
      prohibit the sentinel pattern explicitly. Quote the take-20 line so the
      prohibition is concrete: `expect(x).toBe(999)` to read `x` is a workaround
      for a missing channel, not debugging
- [ ] Audit and list. Enumerate every path by which agent-side output reaches the
      orchestrator and state for each what it truncates and why. Four are known —
      `formatTestSummary`, the bash result formatter, `inspect_file`, the runner
      JSON reporter. There may be more. The list, not a summary
- [ ] `176-non-progress-counts-a-changed-file` — R-65. The guard hashes the bash
      command string only (`nonProgressError.ts:34`). All 24 take-20 probe runs
      issued an identical command against a file rewritten between every run, so
      it fired on work that was genuinely changing. A repeated command against a
      modified file is progress
- [ ] `177-does-167-reach-the-test-agent` — Phase 54 task 167 carries the prior
      attempt's diff into a retry. Take-20 attempt 2 rewrote the 28KB acceptance
      file from scratch (28118 vs 28773 chars) rather than receiving attempt 1's.
      167 was written against the dev agent's `buildSystemPrompt`. Establish
      whether the test agent has a separate prompt path and whether carrying the
      prior attempt's work applies there
- [ ] Tests, fail-first, red output reported per case: a value emitted through the
      mechanism appears in the agent's next turn; output over the cap truncates
      visibly; the dev agent path carries it; a run emitting nothing is
      unaffected; an identical command against a modified file does not
      increment the non-progress counter; an identical command against an
      unmodified file still does
**Definition of Done:**
- An agent can emit and read a value in one turn
- No sentinel-assertion pattern in any agent-authored file on the next feature
- Output-path audit table in HANDOVER.md, every row accounted for
- Mechanism and cap recorded with reasoning
**Verification:**
```bash
npm test          # FROM REPO ROOT — baseline 95 files / 1312 tests, must not decrease
npm run typecheck # all three workspaces
npm run lint      # must stay clean (exit 0)
```
