# Orrery — Handover

Single source of truth for project state. Rewritten at the end of every phase.
Spec lives in `plan.md` and `PRD.md` — both read-only during execution.

---

## Project header

*Established retroactively at plan adoption. Changes only when something structural changes.*

**Stack:** TypeScript strict, Node 20+. Monorepo with npm workspaces.
`apps/server` — Fastify, Prisma/Postgres, BullMQ + Redis, Anthropic via Bedrock
or direct API. `apps/web` — React + Vite. `packages/shared` (`@orrery/shared`) —
event payload schemas, single source of truth for shapes crossing the boundary.
Tests are Vitest throughout. Agent shell work runs in Docker, `--network none`.

**Commands:**
| Purpose | Command |
|---|---|
| Install | `npm ci` |
| Infra | `docker compose up -d` (postgres 16 + redis 7) |
| Migrate | `npx prisma migrate deploy -w apps/server` |
| Run | `npm run dev` (server :3001, web :5173) |
| Test | `npm test` — **from the repo root**; running from `apps/server` under-reports by ~130 tests |
| Lint | `npm run lint` |
| Typecheck | `npm run typecheck` |

**Key directories:**
- `apps/server/src/lib/` — orchestrator, events, container, anthropic, spendGuard
  - `vacuousAssertions.ts` — `detectVacuousAssertions`; detects vacuous, sole-assertion-vacuous, unguarded-forEach
  - `harnessbrief.ts` — `loadHarnessBrief`, `injectHarnessBriefHashes`, `checkHarnessBriefFreshness`
  - `repoOrientation.ts` — `generateRepoOrientation()`, includes vendored-package + API-spec sections
  - `nonProgressError.ts` — `NonProgressError` class + `checkNonProgress()` helper
  - `bedrockPark.ts` — `parkTaskOnBedrockFailure`, `isEnvironmentalBedrockError`
  - `testOutputSummary.ts` — `summarizeBashTestRun`, `toJsonReporterCommand`, `extractProbeFlags`
- `apps/server/src/jobs/` — devJob, testJob, taskTestJob, createAdoPrJob, agentWorker
- `apps/server/src/agents/` — devAgent, testAgent, plannerAgent, testPlannerAgent
- `apps/web/src/lib/eventFold.ts` — all UI state derived from folding the event log
- `packages/shared/` — event payload schemas; `docs/agents/repo-manifest.yaml` — operator config
- `scripts/orientation-probe.ts` — measure orientation block size for a given repo path

**Conventions:**
- No default exports. Zod for all external input. No `any` without a comment.
- Commit format `feat|fix|chore(scope): description`.
- Every Anthropic call goes through `lib/anthropic.ts`.
- Transitions only through the orchestrator; each persists status and appends
  `phase.changed` in the same transaction.
- One task = one brief. Briefs carry evidence, numbered requirements, fail-first
  tests, and an acceptance block.
- **Backlog entries in `docs/phase-6.md` are deleted on close, not annotated.**
  The phase commit is the evidence for each closed item, reachable via the phase
  log table below.

---

## Status

- **Current phase:** 46 — An agent can see why nothing ran
- **State:** `complete`
- **Last updated:** 2026-09-07

---

## Current phase progress

- [x] `150` — Removed `[raw output — zero tests reported]` label prefix from `testOutputSummary.ts`; raw output returned directly
- [x] `151` — Added `probe` to `SCRATCH_FILE_RE`; deletion instruction in `testAgent.ts` updated; 2 new tests in `getAuthoredTestFiles.test.ts`
- [x] `152` — Documented: reporter guidance was present at `testAgent.ts:452` and model ignored it 14 times; mechanical fix required

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1261 passed across 92 files**, 2026-09-07 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-07 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-07 |

---

## Decisions

- **Phase 46: zero-test summary delivers raw output directly (`150`)** —
  `summarizeBashTestRun` in `apps/server/src/lib/testOutputSummary.ts` (lines 137–144)
  previously returned `[raw output — zero tests reported]\n${raw.slice(-8192)}` — the
  label named the case but added no diagnostic value, and agents received a verdict
  without any evidence. The prefix was removed; the summary is now `raw.slice(-8192)`
  with a comment citing the 8192-char limit and its alignment with the parse-error
  fallback above it. This change is expected to reduce the seven-consecutive-probe-file
  pattern (episodes: `orderCardClubsListUrlDiscover`, `orderCardClubsListDebug`,
  `orderCardClubsListDebug-fanout`, `orderCardClubsListUrlDiscovery`,
  `vite-proxy-debug-scratch`, `country-selector-diag`, `_probe`) because the agent now
  receives the runner's own stdout/stderr rather than a classification label. Evidence
  that it has NOT worked: subsequent runs still show agents creating probe/debug files
  after a zero-test result where the raw output itself is non-diagnostic (empty, or "no
  test files found" with no path context — not a runner configuration error).

- **Phase 46: `SCRATCH_FILE_RE` extended to match `probe` (`151`)** —
  `SCRATCH_FILE_RE` in `apps/server/src/jobs/testJob.ts` (line 72) widened from
  `/(?:debug|scratch)(?![a-zA-Z0-9])/i` to `/(?:debug|scratch|probe)(?![a-zA-Z0-9])/i`.
  Seven episode filenames checked against the new pattern:
  `orderCardClubsListUrlDiscover` — no match (legitimate);
  `orderCardClubsListDebug` — matched by `debug`, excluded;
  `orderCardClubsListDebug-fanout` — matched by `debug`, excluded;
  `orderCardClubsListUrlDiscovery` — no match (legitimate);
  `vite-proxy-debug-scratch` — matched by `debug` + `scratch`, excluded;
  `country-selector-diag` — no match (legitimate);
  `_probe` — `probe` followed by `.` (not alphanumeric), matched, excluded.
  `_probe` was the only filename the previous regex missed. The deletion instruction in
  `testAgent.ts buildSystemPrompt()` (line 458) updated to name "probe" alongside
  "debug" and "scratch".

- **Phase 46: reporter-flag guidance present but model ignored it — mechanical fix required (`152`)** —
  The rule "The --reporter, --json, and --outputFile flags are controlled by the harness
  and cannot be overridden — pass only test-selection flags." is at
  `apps/server/src/agents/testAgent.ts` line 452 in `buildSystemPrompt()` under
  `## Rules`, sent with `cache_control: { type: 'ephemeral' }`. Despite this, the test
  agent supplied `--reporter=verbose` on turns 3, 4, 9, 17, 19, 21, 25, 27, 29, 31, 33,
  35, 37, and 39 of one observed run (every flagged turn stripped by the harness). Adding
  more prompt text will not fix this — the guidance was explicit, cached, and present.
  The next fix must be mechanical: strip `--reporter`, `--outputFile`, and `--json` flags
  from bash tool calls at the harness layer before command execution, so compliance is
  enforced regardless of model behaviour.

- **Phase 45: coverage inflation from one unprovable task (`148`)** —
  World-clock run covered 5 tasks / 244 test-agent events vs take-10's 2 tasks / 70 events.
  The Vite proxy task was marked covered despite requiring a running dev server and
  containing three absence proofs. Two new hard-skip rules added to
  `testPlannerAgent.ts` `buildSystemPrompt()`:
  (1) build/dev-server/proxy/asset-pipeline config → "Deliverable is configuration —
  the harness cannot execute a dev server or observe a build.";
  (2) behaviour stated as the absence of something → "Behaviour is an absence proof —
  vitest cannot assert what is not there."
  Both mirror the test-code skip rule structure with verbatim `skipReason` strings.

- **Phase 45: reporter flags stated where agents read them (`149`)** —
  `toJsonReporterCommand` strips `--reporter`, `--json`, `--outputFile` silently.
  On the world-clock run the test agent asked for `--reporter=verbose` five times and
  received the same JSON-derived summary each time. One bullet added to both
  `devAgent.ts` and `testAgent.ts` `## Rules` blocks naming the three harness-controlled
  flags.

- **Phase 44: bash-only guard + full-command hash (`142`, `143`)** —
  `checkNonProgress` accepts `toolName` + `fullCommand` as separate params. Only
  `toolName === 'bash'` adds to the ring buffer; reads, listings and writes are
  transparent. The hash covers `fullCommand` so `npx jest --a` and `npx jest --b`
  are distinct. Every observed loop was a bash/jest loop — no coverage gap.

- **Phase 44: non-progress is not an allowlist violation (`144`)** —
  `taskTestJob.ts` has a separate `isNonProgress` branch with `parkReason: 'non_progress'`
  and message "test agent parked (non-progress: repeated command)".

- **Phase 43: detector exemptions (`139`)** —
  `toBeDefined()` not flagged when preceding line contains `.find(`/`.get(`/index access.
  `toHaveProperty('k')` not flagged when next statement asserts on `subject.k` with a value.

- **Phase 43: two high-priority finding categories (`140`)** —
  `detectSoleAssertionVacuous` emits `section: 'sole-assertion-vacuous'`;
  `detectUnguardedForEach` emits `section: 'unguarded-forEach'`.

- **Phase 42: brief hashes computed by orchestrator (`136`–`138`)** —
  Agent writes paths-only comment; orchestrator hashes the files and rewrites the header.
  One canonical path (`<worktreeRoot>/__orrery_harness_brief.md`) enforced at both ends.

- **Phase 40: warning findings open `code_review` gate (`133`)** —
  A warnings-only review opens the `code_review` gate; only a fully clean review passes immediately.

- **`spec_approval` gate-open (Phase 29)** — 4 open paths: `awsReviewJob.ts` after review,
  `specSubmit.ts` no-charter fast-path, `awsReviewJob.ts` error final-attempt, missing-charter
  guard. 1 approve path: `POST /features/:id/approve`.

- **Test-file boundary + finding identity (Phases 28, core)** — `write_file`/`edit_file` in
  dev agents call `getTestAuthoredSet` at startup and reject test-trailer files. Finding ids
  (`f1`, `f2`) recur per cycle — lookups must use composite `(featureId, specRev, id)`.

---

## Assumptions

- `apps/web/.env.local` setting `VITE_PRODUCT_NAME=PepperOrchestrator` is a
  deliberate local brand override. The fallback `'Orrery'` stays.
- When multiple repos in a feature declare different `review_charter` paths,
  first-charter-found semantics applies (first repo in `feature.repos` wins).

---

## Open questions / blockers

- **O-12 Duplicate `pr.created` events.** Root cause: non-atomic ADO call + event
  append. Fix: re-query existing `pr.created` events inside the per-repo loop
  immediately before the ADO API call.

---

## PRD conflicts

- none

---

## Phase log

| Phase | Title | Commit | Date |
|---|---|---|---|
| 0–6 | Spec agent through cost instrumentation | squashed into `54bdf20` | pre-2026-08 |
| 7 | Agent spend and test redundancy | `4a16025` | 2026-08-21 |
| 8 | Planner efficiency | `55a0c5b` | 2026-08-21 |
| 9 | Backlog sweep | `2723ba0` | 2026-08-21 |
| 10 | Spec reconciliation | `1097c3f` | 2026-08-21 |
| 11 | Lint debt | `f0769a5` | 2026-08-21 |
| 12 | Dispatch identity and gate baseline | `6d8ef86` | 2026-08-29 |
| 13 | Recovery paths account for live work | `ccbab22` | 2026-08-29 |
| 14 | Agents see what actually happened | `da52c8d` | 2026-08-29 |
| 15 | The gate counts what actually ran | `4c8f1c6` | 2026-08-29 |
| 16 | Environmental failures leave a recoverable task | `58bb2f7` | 2026-08-29 |
| 17 | The UI states what the data says | `d00751f` | 2026-08-29 |
| 18 | Close the backlog honestly | `78ff9ee` | 2026-08-29 |
| 19 | Declared config replaces the last inference | `716a783` | 2026-08-29 |
| 20 | Violations cost what they should, and the UI says what is running | `8120094` | 2026-08-29 |
| 21 | Orrery is neutral; organisational policy is operator config | pending | 2026-08-31 |
| 22 | Recovery is one click, and failures say why | `593dc75` | 2026-09-01 |
| 23 | Config validation that fits reality | `48f540f` | 2026-09-01 |
| 24 | The test agent stops paying twice (tasks 91–93) | `657c09e` | 2026-09-01 |
| 25 | Tests exist before code, and the flag says so | `f2a30d4` | 2026-09-02 |
| 26 | The test agent stops paying twice (measurement + prompt fix) | `d55a601` | 2026-09-03 |
| 27 | The scratch filter excludes only scratch | `bbfef4b` | 2026-09-03 |
| 28 | Acceptance tests are read-only to the dev agent | `c2e9fae` | 2026-09-03 |
| 29 | Open questions are structured blockers answered at the gate | `aa04bb3` | 2026-09-05 |
| 30 | Cover what Phase 29 shipped | `848f40b` | 2026-09-05 |
| 31 | Test report cubes and brand mark | `41a8e1d` | 2026-09-06 |
| 32 | Artifact tabs are copyable | `85592bf` | 2026-09-06 |
| 33 | An agent that is not progressing stops | `4273e44` | 2026-09-06 |
| 34 | Verification means what it says | `72bc51e` | 2026-09-06 |
| 35 | The orchestrator is not bound by the agent's allowlist | `c208689` | 2026-09-06 |
| 36 | Test output can be trusted | `260a95a` | 2026-09-06 |
| 37 | Agents keep their flags, and blockers do not vanish quietly | `ccbecaa` | 2026-09-06 |
| 38 | Orientation stops being the largest cost | `1948302` | 2026-09-06 |
| 39 | A write does not excuse a loop | `178d109` | 2026-09-06 |
| 40 | A correct finding has an effect | `937dba6` | 2026-09-07 |
| 41 | The loop guard counts commands | `7b8baa5` | 2026-09-07 |
| 42 | The harness brief works at all | `3b50e71` | 2026-09-07 |
| 43 | The vacuous detector earns its gate | `b9efa8f` | 2026-09-07 |
| 44 | The loop guard counts what it means to count | `f439b52` | 2026-09-07 |
| 45 | Coverage is only claimed where it can be proved | `7f2c688` | 2026-09-07 |
| 46 | An agent can see why nothing ran | `891cb40` | 2026-09-07 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run when editing the orchestrator.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
- A world-clock feature plans two or three covered tasks, not five.
