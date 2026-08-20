# Phase 5 — Review Agent + Test Agent

## Overview

Phase 5 replaces the `CODE_REVIEW` and `TESTING` auto-advance stubs with real
agents. The Review Agent inspects each repo's git diff against the approved spec
and `contract.yaml`, classifying findings into blocking conformance violations
and non-blocking quality observations. The Test Agent independently writes and
runs acceptance tests from the spec and contract only, never touching
implementation source. Both agents feed into a capped bounce-back loop (one
round) before escalating to a human gate.

Phase 5 is simulator-first: each slice builds the full state-machine path in the
simulator before Bedrock is wired. Slice 5a delivers the Review Agent
end-to-end, including bounce-back and human gate. Slice 5b delivers the Test
Agent. **5a acceptance criteria must be fully checked before 5b opens.**

**Prerequisite**: ticket T-4c-2 (findings panel regression) must be resolved
before 5a closes — the `CODE_REVIEW` gate depends on the same panel.

---

## Design decisions

### R1 — Review Agent charter: two finding classes

The Review Agent emits findings in exactly two classes:

- **CONFORMANCE** — the diff violates a spec acceptance criterion or a
  `contract.yaml` API shape (wrong method, missing required field, mismatched
  response schema, endpoint absent). These may carry `blocker` severity and gate
  state-machine advancement.
- **QUALITY** — naming, structure, style, coverage gaps, error-handling patterns.
  These are `warning` severity only. The agent must never emit a `blocker`-severity
  quality finding. This constraint is in the committed charter
  (`docs/agents/review-charter.md`), operator-injected into every review prompt
  exactly as `docs/agents/aws-charter.md` governs the AWS Expert Agent.

Rationale: conflating code style with spec conformance defeats the gate's
purpose. A missing endpoint must block; a poorly-named variable must not. The
charter is a committed document so the rule survives prompt rewrites.

### R2 — Review bounce-back: one capped revision round

Blocker findings trigger exactly one automatic revision round:

1. Review agent emits blockers → `REVIEW_FAIL` fires → feature returns to
   `IMPLEMENTING`.
2. Orchestrator creates a synthetic task per affected repo with a
   `## Required fixes (Review Agent findings)` block injecting the blockers
   verbatim. The dev agent has no special knowledge of the bounce-back — it sees
   a normal task with a mandatory fix list.
3. After the revision, `SUBMIT_REVIEW` fires automatically → `CODE_REVIEW` re-entered.
4. Review agent runs again. If blockers remain → `gate.opened { gate: 'code_review' }`
   — human gate, not another automatic round.

The cap is event-log-derived, not a stored counter: count `review.findings`
events with `agent: 'review'` that appear after the last `phase.changed { to:
'CODE_REVIEW' }` event. If count ≥ 1 and blockers remain → escalate.

Rationale: uncapped ping-pong burns tokens and stalls features. One round gives
the dev agent targeted feedback; escalating to human after that respects "humans
gate the expensive steps" (Core Principle 4).

### R3 — Test Agent independence: black-box acceptance tests

The Test Agent writes acceptance tests from `spec.md` and `contract.yaml` only.
It cannot read implementation source (`src/`, `app/`, `lib/`, or equivalent).
This constraint is **structurally enforced**: the agent's `read_file` tool is
jailed to a whitelist (artifact paths + test directory + `CLAUDE.md` +
`package.json` + `tsconfig.json`). Implementation paths are rejected at the
path-jail layer, not just by prompt instruction.

Tests run in the existing container machinery against the feature branch. The
Test Agent's value is independent behavioral verification — it can only pass a
test that the spec actually promises, not one derived from reading what the
implementation happens to do.

Unit tests covering implementation internals remain the dev agents' responsibility.

### R4 — Test bounce-back: same single capped round

Failures follow the same pattern as R2: one automatic revision round (inject
failures into dev agent context as synthetic task), then human gate on second
failure. Round tracking is event-log-derived: count `test.report` events after
the last `phase.changed { to: 'TESTING' }` event.

### R5 — Sequencing: 5a before 5b

5a delivers Review Agent end-to-end. 5b delivers Test Agent. No overlap. This
respects the established "each slice closes before the next opens" pattern and
keeps the implementation surface manageable per task.

---

## State machine changes

### Transition table delta

No new `TransitionEvent` values are introduced. The existing
`REVIEW_PASS`, `REVIEW_FAIL`, `TEST_PASS`, `TEST_FAIL` events are reused. The
behavioral change is in _when_ they fire:

| Transition | Before Phase 5 | After Phase 5 |
|---|---|---|
| `CODE_REVIEW:REVIEW_PASS` → `TESTING` | Immediate auto-advance stub | Review agent finds no blockers; or human gate clears all blockers |
| `CODE_REVIEW:REVIEW_FAIL` → `IMPLEMENTING` | Immediate auto-advance stub | Review agent finds blockers on round 0; bounce-back synthetic task dispatched |
| `TESTING:TEST_PASS` → `DONE` | Immediate auto-advance stub | Test agent reports all passing; or human gate clears |
| `TESTING:TEST_FAIL` → `IMPLEMENTING` | Immediate auto-advance stub | Test agent reports failures on round 0; bounce-back task dispatched |

The `CODE_REVIEW` and `TESTING` states gain real gates (`gate.opened { gate:
'code_review' }` and `gate.opened { gate: 'test_report' }`) used only when the
round cap fires. The gate clears on `gate.resolved`, after which `REVIEW_PASS`
or `TEST_PASS` fires.

### Round tracking (event-log-derived)

Extend `lib/reviewCycle.ts` with two helpers (same scoping-by-cycle pattern
already used there):

- `getReviewRound(events: EventRow[]): number` — count `review.findings` events
  with `agent: 'review'` after the last `phase.changed { to: 'CODE_REVIEW' }`.
- `getTestRound(events: EventRow[]): number` — count `test.report` events after
  the last `phase.changed { to: 'TESTING' }`.

### Bounce-back dispatch

When `REVIEW_FAIL` fires (round 0), `dispatchForState(featureId, 'IMPLEMENTING')`
creates one synthetic task per repo that has blocker findings (identified by the
new `repo` field on Review Agent findings). The synthetic task's description
includes the standard structure plus a `## Required fixes (Review Agent findings)`
block with the blocker list verbatim. Synthetic task IDs are orchestrator-generated
UUIDs, not from the plan.

Same pattern for `TEST_FAIL`: one synthetic task per affected repo with
`## Required fixes (Test Agent failures)`.

**Scope fence (injected verbatim into every bounce-back synthetic task description)**:
"Address only the findings listed above. Do not refactor unrelated code, rename
identifiers, or expand scope beyond the listed items. The standard commit guardrail
applies: the orchestrator will only commit if tests pass in the worktree; no
changes → task parked."

**Re-entry mechanism**: after the bounce-back synthetic task(s) complete, the
state machine re-enters `CODE_REVIEW` via the standard `maybeAdvanceToReview`
path — the same `IMPLEMENTING → CODE_REVIEW` trigger already used for the first
review pass. There is no parallel or ad-hoc `SUBMIT_REVIEW` call; the existing
all-tasks-complete check in `maybeAdvanceToReview` fires naturally when the
synthetic tasks are done. This keeps a single `SUBMIT_REVIEW` trigger point in
the codebase.

### Auto-advance stub removal

The auto-advance stubs in `lib/maybeAdvance.ts` and `jobs/createAdoPrJob.ts`
are removed and replaced with real dispatches in slice 5a (review) and 5b
(test). The `dispatchForState` switch gains `CODE_REVIEW` and `TESTING` cases.

---

## Events

### New payload schemas

```typescript
// review.started — emitted when the review job begins diff acquisition
ReviewStartedPayloadSchema = z.object({
  type: z.literal('review.started'),
  agent: z.literal('review'),
  repos: z.array(z.string()), // repo ids being reviewed
});

// test.started
TestStartedPayloadSchema = z.object({
  type: z.literal('test.started'),
  agent: z.literal('test'),
  repos: z.array(z.string()),
});

// review.skipped — emitted when fail-open fires (two consecutive parse failures).
// A skipped gate must leave a record; the UI renders this as a muted log line
// and a distinct planet badge state so the operator knows the gate was bypassed.
ReviewSkippedPayloadSchema = z.object({
  type: z.literal('review.skipped'),
  agent: z.literal('review'),
  reason: z.string(), // e.g. "two consecutive parse failures"
});

// TestFindingSchema — extends FindingSchema with test-execution metadata
TestFindingSchema = FindingSchema.extend({
  test_name: z.string(),                              // exact test identifier as reported by the runner
  duration_ms: z.number().int().nonneg().optional(),  // test execution time (runner may not report)
});

// test.report — test agent output; uses TestFindingSchema for failures
// (severity is always 'blocker' for failures; section = spec section exercised)
TestReportPayloadSchema = z.object({
  type: z.literal('test.report'),
  agent: z.literal('test'),
  passed: z.number().int().nonneg(),
  failed: z.number().int().nonneg(),
  findings: z.array(TestFindingSchema), // failures only
});
```

### Schema changes

**`ReviewFindingsPayloadSchema.agent`** — widened from `z.literal('aws')` to
`z.enum(['aws', 'review'])`. Existing Phase 3 rows with `agent: 'aws'` still
validate. The `foldEvents` discriminated switch handles both values; the findings
panel renders identically for either.

**`FindingSchema`** gains an optional `repo` field (`z.string().optional()`).
Absent for AWS findings (Phase 3 rows unaffected). Required in Review Agent
output (enforced by the output contract in the charter, not the Zod schema —
the schema keeps it optional to maintain backwards compatibility).

**`spec_rev` on `review.findings`** — retained as-is; for the Review Agent it
records which spec revision the code was reviewed against, which is meaningful.

---

## Agent specs

### Review Agent

#### Charter (`docs/agents/review-charter.md`)

Committed alongside this spec. Operator-injected at the start of every review
prompt.

**Mandate**: Review git diffs from the feature's repos against the approved spec
and `contract.yaml`. Return structured findings in exactly two classes. Do not
evaluate subjective style.

**CONFORMANCE findings** (blocker or warning allowed):
- An API operation defined in `contract.yaml` is absent from the diff.
- A request/response shape in the diff contradicts `contract.yaml` (wrong field
  name, wrong type, missing required field, wrong status code).
- An acceptance criterion stated in the spec is not addressed by any changed file.
- A stated non-functional requirement (auth, error codes, pagination) is absent.

**QUALITY findings** (warning only — `blocker` is never valid here):
- Naming inconsistent with the repo's `CLAUDE.md` conventions.
- Missing error handling for paths the spec does not require specifically.
- Test coverage gaps beyond the acceptance criteria.
- Structural observations (extract function, simplify logic).

**Blocker calibration**: reserve blocker severity for concrete, diff-visible
violations of the spec or contract. When the diff is silent on a requirement
but the spec does not explicitly mandate it in that acceptance criterion, emit
a warning requesting the missing behaviour — not a blocker.

**Output contract**:
```json
{ "findings": [
  { "id": "f1",
    "severity": "blocker" | "warning",
    "section": "<spec heading or contract operationId>",
    "issue": "...",
    "repo": "<repo manifest id>" }
] }
```
`suggested_text` is omitted — the Review Agent does not propose code rewrites.
Return `{ "findings": [] }` if no concerns.

#### Input (assembled host-side before API call)

1. Approved `spec.md` (from artifacts repo).
2. Approved `contract.yaml` (from artifacts repo).
3. Review Agent charter (`docs/agents/review-charter.md`).
4. Per-repo git diff: `git diff <default_branch>...<feature_branch>` for each
   repo in `currentBranches`. Concatenated with `## Diff: <repo_id>` headers.
   **Total diff budget: 60 KB** (hard cap, truncated proportionally per repo
   with truncation markers). The agent must treat a truncated section as
   "not reviewed, no findings emitted" — the charter states this explicitly.

#### Toolset

None. All input is pre-assembled. This is a single Messages API call.

#### Invocation model

Single call via `lib/anthropic.ts` (agent='review'), max_tokens 4096.
Retry-once on JSON parse failure (same pattern as AWS agent). On second
failure: `review.skipped { reason: 'two consecutive parse failures' }` is
emitted, a `· review unavailable — gate skipped` log line is appended at
`muted` severity, and `REVIEW_PASS` fires (**fail-open** — do not block the
feature on a broken review agent, same policy as Phase 3). A skipped gate must
leave a scar: the `review.skipped` event is persisted in the event log and
rendered in the timeline so the operator knows the gate was bypassed, not passed.

#### Error taxonomy

- **Parse failure**: retry-once, then fail-open.
- **Bedrock 403 / STS expiry**: park with actionable message, do not consume
  attempt. `POST /features/:id/retry-review` is the dedicated retry door
  (same pattern as `retry-pr`).
- **Diff acquisition failure** (repo absent from `currentBranches`): log at
  `muted` severity, skip that repo, continue with available diffs. A partial
  review is better than no review.

---

### Test Agent

#### Charter

Committed as `docs/agents/test-charter.md` in slice 5b.

**Mandate**: Given a spec and contract, write tests that would fail if the
feature were not implemented. Run them. Report pass/fail. Tests are black-box:
they exercise behavior promised to users, not internal structure.

**Test scope**: one test file per repo API surface (HTTP endpoints for server
repos, component/screen integration for client repos). Cover every contract
operation and every acceptance criterion. Do not test implementation internals.
Do not duplicate the dev agent's unit tests.

#### Input (what the Test Agent sees)

Read-only via `read_file`, jailed to:
- `spec.md` and `contract.yaml` (artifact paths)
- The repo's `CLAUDE.md` (conventions, test framework, test command)
- The repo's `package.json` and `tsconfig.json` (test framework discovery —
  per Phase 4e ergonomics lesson: `node_modules` off-limits, use these instead)
- The repo's test directory listing

**What the Test Agent cannot see**: `src/`, `app/`, `lib/`, or any
implementation directory. `read_file` rejects paths that resolve inside those
directories at the path-jail layer (same `pathJail` helper as dev agents, with
an additional implementation-path blocklist).

#### Toolset

- `read_file(path)` — jailed to artifact paths + test directory + `CLAUDE.md`
  + `package.json` + `tsconfig.json`. Rejects implementation paths.
- `write_file(path, content)` — jailed to the test directory only.
- `bash(command)` — allowlist: `npm test`, `npx vitest run`, `npx jest --ci`,
  `npm run test`, `cat`, `ls`, `find`, `grep`. NO `npm install`, NO `git`,
  NO `node <arbitrary script>`. Same violation budget (3 violations → task
  permanently failed).

#### Invocation model

Tool-use loop via Messages API (same `createMessage` loop as dev agents),
agent='test', through `lib/anthropic.ts`. Container: same `node:20-alpine`
image with `--network none`, worktree mounted. **Max 30 turns** (narrower scope
than dev agents — read spec, write test file, run, report).

The Test Agent signals completion via `end_turn`. Orchestrator runs the test
suite host-side as verification (same commit-guard pattern as dev agents).
On pass: `test.report { passed, failed: 0, findings: [] }` + commit test files
to feature branch + `TEST_PASS`. On failure: test output parsed for failing test
names → `test.report { ... }`.

#### Error taxonomy

Same classification as dev agents:
- Turn budget exhausted → park (attempt 1 → retry, attempt 2 → parked).
- Violation budget → permanent fail.
- Container infra failure → `CommitStepError` equivalent (not agent fault, retry).
- Bedrock 403 → park + `POST /features/:id/retry-test`.

---

## Diff acquisition

`currentBranches` (written by dev jobs after successful pushes) is the single
authority for feature branch refs — the Phase 4e lesson applies here too. The
review job reads this map and runs `git diff <default_branch>...<feature_branch>`
for each repo, host-side, before the API call. A repo absent from the map means
its push failed; log and skip (partial review, not a crash).

The diff is size-budgeted at 60 KB total. Per-repo diffs are truncated
proportionally if the combined size exceeds this, with truncation markers.
The charter instructs the agent to emit no findings for truncated sections
rather than fabricating them from incomplete context.

---

## Slice plan

### Slice 5a — Review Agent end-to-end

Simulator-first: the full bounce-back + gate path must work in the simulator
before Bedrock wiring.

#### Tasks

**5a-T1: Simulator review path**
Extend `simulatorJob.ts` to walk the new `CODE_REVIEW` path. The simulator
must support two sub-paths (toggled by a parameter):
- **Forced-fix path**: `review.findings` (1 seeded blocker) → `REVIEW_FAIL` →
  bounce-back task → second `review.findings` (0 blockers) → `REVIEW_PASS`.
- **Gate path**: `review.findings` (blocker) → `REVIEW_FAIL` → bounce-back →
  second `review.findings` (blocker still present) → `gate.opened { gate:
  'code_review' }` → human dismiss → `gate.resolved` → `REVIEW_PASS`.
Both paths continue to `TESTING` → `DONE` (TESTING still auto-advances in 5a).

**5a-T2: Event schema additions**
Add `ReviewStartedPayloadSchema` and `TestStartedPayloadSchema` to
`packages/shared/src/types/events.ts`. Widen `ReviewFindingsPayloadSchema.agent`
to `z.enum(['aws', 'review'])`. Add optional `repo` field to `FindingSchema`.
Register `review` in `AGENT_REGISTRY` (tier: review, same ring as aws).

**5a-T3: Review job**
Create `apps/server/src/jobs/reviewJob.ts`:
- Diff acquisition from `currentBranches` (host-side `git diff`).
- Prompt assembly: charter + spec + contract + diffs (60 KB budget).
- Messages API call via `lib/anthropic.ts`.
- `review.started` event before call; `review.findings` event on success.
- `getReviewRound(events)` to decide: round 0 → `REVIEW_FAIL` + bounce-back
  dispatch; round 1 + blockers → `gate.opened { gate: 'code_review' }`.
- No blockers at any round → `REVIEW_PASS`.

**5a-T4: Review gate routes**
`POST /features/:id/findings/:findingId/accept|dismiss` already exist (Phase
3). Verify they scope correctly to the current CODE_REVIEW cycle (finding
identity is composite: featureId + specRev + id — `lib/reviewCycle.ts`
determines the active cycle). Add `POST /features/:id/retry-review` (same
shape as `retry-pr`). When all blockers are accepted or dismissed → `REVIEW_PASS`.

**5a-T5: dispatchForState wiring**
Add `CODE_REVIEW` case: dispatch `reviewJob`. Remove auto-advance stubs from
`lib/maybeAdvance.ts` (lines ~53-76) and `jobs/createAdoPrJob.ts` (lines
~244-260). The `TESTING` auto-advance remains until 5b.

**5a-T6: UI — CODE_REVIEW planet + findings panel**
- CODE_REVIEW planet wires `agent.status { agent: 'review' }` to
  working/waiting/done/failed badge states. `waiting` = gate open.
- `gate: 'code_review'` gate card: reuses Phase 3 findings panel component
  (T-4c-2 regression must be fixed before this closes). Minor extension: display
  `repo` field alongside section/issue.
- Same accept/dismiss actions as Phase 3 AWAITING_APPROVAL findings.

**5a-T7: Bedrock wiring + charter commit**
Commit `docs/agents/review-charter.md`. Connect real Review Agent.
Smoke-test: one feature branch with a known missing endpoint → blocker finding
referencing the contract operation → bounce-back → fix committed → re-review passes.

#### Task dependencies

5a-T2 before 5a-T3 (schema). 5a-T3 before 5a-T5 (job must exist before
dispatch). T-4c-2 resolved before 5a-T6 closes.

---

### Slice 5b — Test Agent

Begins only after all 5a acceptance criteria are verified and checked.

#### Tasks

**5b-T1: Simulator test path**
Extend `simulatorJob.ts` for `TESTING`:
- `test.started` → mock `test.report` (seeded failure) → `TEST_FAIL` → bounce-back.
- Second `test.report`: forced-pass path (0 failures → `TEST_PASS`) and gate path
  (failures persist → `gate.opened { gate: 'test_report' }` → human → `TEST_PASS`).

**5b-T2: Event schema additions**
Add `TestFindingSchema` and `TestReportPayloadSchema` to `events.ts`. Register
`test` in `AGENT_REGISTRY`.

**5b-T3: Test Agent (tool-use loop)**
Create `apps/server/src/jobs/testJob.ts` and `apps/server/src/jobs/testAgent.ts`.
The tool-use loop follows the dev agent pattern (`devJob.ts` / `devAgent.ts`)
with these differences:
- `read_file` path jail adds implementation-path blocklist.
- `write_file` jailed to test directory only.
- 30-turn budget.
- Orchestrator commits test files to feature branch host-side after a passing run
  (same commit-guard pattern as dev agents).

Note on commit timing (see OQ2): test files must be committed before the PR
is considered final. If the PR was created in 4d before Phase 5 runs, pushing
new test file commits to the branch after PR creation is acceptable in ADO
(the PR auto-includes new commits). Verify this in a real ADO environment before
closing 5b.

**5b-T4: Test gate routes**
Add `POST /features/:id/retry-test`. Wire `gate: 'test_report'` gate card:
same `gate.opened`/`gate.resolved` + accept/dismiss vocabulary (test failures
use `TestFindingSchema`, which extends `FindingSchema` — the same
accept/dismiss routes apply unchanged).

**5b-T5: dispatchForState wiring**
Add `TESTING` case: dispatch `testJob`. Remove `TESTING` auto-advance stub.

**5b-T6: UI — TESTING planet + test report card**
- TESTING planet wires `agent.status { agent: 'test' }`.
- `gate: 'test_report'` card: new component (test failures are structurally
  similar to review findings but presented differently — show passed/failed
  counts prominently, then per-failure rows with test name and message summary).
  Same accept/dismiss resolution rails.

**5b-T7: Bedrock wiring + charter commit**
Commit `docs/agents/test-charter.md`. Connect real Test Agent. Smoke-test:
spec with a POST endpoint → Test Agent writes an acceptance test → passes
against the feature branch.

---

## Acceptance criteria

### Slice 5a

_Forced-failure paths are required; demonstrate in simulator before Bedrock wiring._

- [x] Simulator forced-fix path: `IMPLEMENTING` → `CODE_REVIEW` → `review.started`
  → `review.findings` (seeded blocker) → `REVIEW_FAIL` → `IMPLEMENTING`
  (bounce-back task carries `## Required fixes` block) → `SUBMIT_REVIEW` →
  `CODE_REVIEW` → `review.findings` (0 blockers) → `REVIEW_PASS` → `TESTING` →
  `DONE`.
- [x] Simulator gate path: same as above but second `review.findings` retains a
  blocker → `gate.opened { gate: 'code_review' }` → human dismiss →
  `gate.resolved` → `REVIEW_PASS` → `TESTING` → `DONE`.
- [x] `review.findings` with `agent: 'review'` validates against widened schema.
  Existing Phase 3 `review.findings` with `agent: 'aws'` still validates (no
  regression in npm test).
- [x] Round detection: `getReviewRound(events)` unit-tested for 0 (no prior
  review.findings this cycle), 1 (one prior), and multi-cycle case (two separate
  CODE_REVIEW entries — second cycle resets to 0).
- [x] Findings panel renders in `CODE_REVIEW` gate with `repo` field displayed
  (T-4c-2 regression confirmed resolved).
- [x] `gate: 'code_review'` card opens, shows blocker findings, clears on
  `gate.resolved` (T-4c-3 gate-clearing pattern holds for this new gate type).
- [x] `POST /retry-review`: feature in `CODE_REVIEW` with `agent.status(failed)`
  → retry → review job re-dispatched.
- [x] Fail-open path: two parse failures → `agent.status(failed)` + `REVIEW_PASS`
  (feature not blocked by broken review agent).
- [x] Bedrock smoke test: real feature branch with a known missing endpoint →
  blocker finding citing the contract operationId → bounce-back → fix committed
  → re-review passes → `TESTING`. Verified live on review-live-3 (084fa60b):
  2 evidence-cited blockers (missing `hostname` field + non-conformant test),
  synthetic fix task created, fix round completed, round cap and human gate paths
  both exercised. Round 2 findings correctly identified spec/contract divergence
  (artifact incoherence escalated, not just code drift).
- [x] `usage.recorded { agent: 'review' }` on every API call including retry path.
- [x] `dispatchForState` has `CODE_REVIEW` case. Auto-advance stubs removed from
  `maybeAdvance.ts` and `createAdoPrJob.ts`.
- [x] `npm test` green; Phase 3 / 4 criteria unaffected.

### Open tickets (not blocking 5a closure; must resolve before noted milestone)

- **findings-panel regression #2** ✅: id-construction mismatch in
  `simulatorJob.ts` spec-approval upsert — persisted finding id carried a
  `-<featureId>` suffix that the event payload did not, causing a 404 on the
  first gate resolve with no staleness involved. **Fixed in 0b5e93d.**
- **AWS-charter scope on demo-tier repos** ✅: OQ6 promoted to a standing rule
  in `docs/agents/review-charter.md`. **Resolved in 5b-T7.**

### Slice 5b

- [x] Simulator forced-pass path: `TESTING` → `test.started` → `test.report`
  (seeded failure) → `TEST_FAIL` → `IMPLEMENTING` → `TESTING` → `test.report`
  (0 failures) → `TEST_PASS` → `DONE`.
- [x] Simulator gate path: second `test.report` retains failures → `gate.opened {
  gate: 'test_report' }` → human dismiss → `TEST_PASS` → `DONE`.
- [x] Test Agent path jail enforced structurally: `read_file('src/index.ts')`
  returns an error; `read_file('spec.md')` succeeds.
- [x] Test Agent writes a test file to the test directory; orchestrator commits it
  to the feature branch host-side after passing run.
- [x] `test.report` validates against `TestReportPayloadSchema`; `findings` array
  uses `TestFindingSchema` with `severity: 'blocker'`, `test_name` populated,
  and optional `duration_ms` present when the runner reports it.
- [x] `gate: 'test_report'` card opens, clears on `gate.resolved`.
- [x] `POST /retry-test` recovery verified.
- [x] Bedrock smoke test: spec with a POST endpoint → Test Agent writes an
  acceptance test calling the endpoint → passes against the feature branch.
- [x] `usage.recorded { agent: 'test' }` on every turn of the tool-use loop.
- [x] `dispatchForState` has `TESTING` case. TESTING auto-advance stub removed.
- [x] `npm test` green; no regressions.

### Shipped beyond spec (Slice 5b)

Items shipped during 5b that were not in the original acceptance criteria:

1. **Authored-test gating with commit-trailer discriminant** (commits: afacc25,
   ec6dea3). `TEST_PASS` requires `authored_passed > 0`. Authored files are
   derived from `git log --grep='^X-Orrery-Agent: test' --diff-filter=A`
   scoped to the test directory. Necessary because dev-agent and test-agent
   commits share the Orrery identity, so `--author` cannot
   separate them. Without this, a run where the test agent wrote nothing passes
   on pre-existing tests.

2. **`discoverTestDir` — runtime test-directory resolution** (commit: afd46bf).
   Seven candidates, nested paths first (`src/__tests__` before `__tests__`),
   each requiring at least one `*.test.*`/`*.spec.*` file rather than mere
   directory existence; 3-level deep-scan fallback; logged fallback of last
   resort. The spec assumed a fixed test directory; the demo repos put tests at
   `src/__tests__`.

3. **Structured JSON test parsing** (commit: 9200bfc). Counts come from
   `vitest --reporter=json` / `jest --json` (`numPassedTests` /
   `numFailedTests` / per-test rows), not from a regex over human output. On
   parse failure the parser returns `passed: null` with a `parse_error` rather
   than fabricating a number. Exit code owns the gate; counts are observed or
   absent, never invented.

4. **Skipped-gate semantics** (commit: 9200bfc). The no-repo path now emits
   `test.report { skipped: true, passed: null, failed: null, skip_reason }` and
   parks the feature in `TESTING` pending `POST /approve-test`. A gate that
   observed nothing must not be representable as a pass.

5. **Test report card with six variants** (commits: 0e30228, 14eac07). `pass` /
   `fail` / `skipped` / `parse-error` / `details-unavailable` / `legacy`. The
   legacy variant exists because `authored_passed === undefined` (event predates
   the field) and `=== 0` (agent authored nothing) mean different things and
   must not render identically.

6. **Finding upsert updates severity on re-review at the same `specRev`**
   (commit: 0a394cf). Previously `createMany({ skipDuplicates })` left a stale
   severity in the table while the event log showed the current one — the gate
   enforces the table, so it could block or pass on a value the audit trail
   contradicted. Also fixes a latent unique-constraint crash on second review at
   the same revision.

7. **Stable finding IDs via djb2 hash** (commit: 9200bfc). Test finding ids are
   derived from a djb2 hash of `test_name` (`stableId`) rather than array
   position, so bounce-back rounds do not collide on `tf-1`.

---

## UI changes

### CODE_REVIEW planet

`agent.status { agent: 'review' }` drives the badge:
`queued` → `working` → `waiting` (gate open, human action required) → `done` /
`failed`. When reviewing multiple repos, show repo count badge (same pattern as
server/client instance badge from Phase 4).

When `review.skipped` is in the event log for the current cycle, the planet
badge shows `skipped` (a distinct state, styled like `muted`, between `done`
and `failed`). The tooltip reads "Review unavailable — gate bypassed".

### TESTING planet

Same badge structure with `agent: 'test'`.

### Findings panel (CODE_REVIEW gate)

Reuses the Phase 3 findings component. Minor extension: display the optional
`repo` field alongside section/issue in each finding row. Accept/dismiss routes
are unchanged (they are generic by design).

### Test report card (`gate: 'test_report'`)

New component. Layout:
- Pass/fail count row (prominent).
- Per-failure row: test name, failure message summary, spec section it exercises.
- Actions: DISMISS ALL (waive → `gate.resolved { resolution: 'approved' }` →
  `TEST_PASS`) or individual dismiss/accept using the same finding routes.

---

## Simulator additions summary

### 5a additions to `simulatorJob.ts`

Add `'review'` to `PHASE_AGENTS` (maps to `CODE_REVIEW`). Extend the phase-activity
pattern to emit `review.started`, mock `review.findings`, and walk both sub-paths
(forced-fix and gate). The simulator `simulated_run` flag is already how the
machine distinguishes auto-advance — in 5a the simulator drives the new path
rather than auto-advancing.

### 5b additions

Add `'test'` to `PHASE_AGENTS` (maps to `TESTING`). Same forced-pass and gate
sub-paths.

---

## Open questions

**OQ1 — Diff budget granularity.** 60 KB total is an estimate. A real multi-repo
feature could exceed this. Consider per-repo budget (e.g. 20 KB × N repos) vs a
shared pool. Track empirically after first real runs; document the outcome here.

**OQ2 — Resolved.** Confirmed via live run (feature/review-live-3, commit
24d1d6c): pushing new commits to an ADO PR branch post-creation works as
expected — the PR auto-includes them. Post-PR test file commits are valid.

**OQ3 — Resolved.** `TestFindingSchema` extends `FindingSchema` with `test_name`
(required — exact test identifier as reported by the runner) and `duration_ms`
(optional — useful for slow-test diagnosis in Phase 6). The `test.report.findings[]`
array uses this specialized schema. Option (b) chosen for clean UI rendering.

**OQ4 — Findings panel `repo` field extension scope.** The Phase 3 findings
panel was built for AWS findings with no `repo`. Confirm the extent of the
component change needed to display `repo` before 5a-T6 starts — it may be
trivial (one additional `<span>`) or require a prop-interface change that
touches test snapshots.

**OQ5 — Cost attribution for bounce-back synthetic tasks.** Bounce-back tasks
are orchestrator-generated (not from `plan.proposed`). They will not have a
`plan.md` entry. Phase 6's cost dashboard must account for orchestrator-
synthesized tasks when summing per-feature agent spend. Flag for Phase 6 design.
