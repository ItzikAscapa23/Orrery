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
## Phase 30 — Test report cubes and brand mark
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
