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
  - `testOutputSummary.ts` — `summarizeBashTestRun`, `toJsonReporterCommand`, `extractProbeFlags`, `extractConsoleOutput`
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

- **Current phase:** 52 — Client component coverage: decide, then act
- **State:** `in-progress`
- **Last updated:** 2026-09-14

---

## Current phase progress

- [ ] Report first, no code: for takes 10, 12, 13, 16, 17, 18 — covered client tasks, covered server tasks, outcome per task, cost
- [ ] State whether each of the four failure causes is now fixed (inspect_file, fake-timer, stub rule, untestable-task)
- [ ] Recommend one option: keep client coverage, drop it, or make it a per-repo manifest setting — with cost

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1288 passed across 93 files**, 2026-09-14 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-14 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-14 |

---

## Decisions

- **Phase 51: `detectSelfAuthoredSubjects` uses `stagedSet.has()` not `fs.existsSync` (`162`)** —
  The check only needs to know whether an imported file was staged in the same run.
  Checking `stagedSet.has(candidate)` (with common extension variants) is O(1) per
  candidate, requires no disk access, and produces zero false positives. A file not
  in `stagedSet` is never flagged regardless of what's on disk.

- **Phase 51: `mock_dirs` matched by directory name, not path prefix (`163`)** —
  `resolved.split('/').includes(dir)` matches any directory segment named `helpers`
  (e.g. `src/__tests__/helpers/MyStub.tsx`) without requiring a full path in the
  manifest. Consistent with how `probe_command` and `review_charter` work: the rule
  lives in Orrery, the vocabulary in the manifest.

- **Phase 51: bounce-back from `_handleSelfAuthoredSubjects` mirrors `_handleNoAuthoredTests`** —
  Round 0 re-dispatches; round 1+ opens `test_report` gate for human review. This is
  the right recovery path because the violation is a test-quality defect, not an
  infrastructure failure — the operator should see it rather than retrying forever.

- **Phase 50: REQUEST_TIMEOUT_MS = 900 000 ms (15 min) on all Anthropic stream calls (`160`)** —
  Passes `{ timeout: REQUEST_TIMEOUT_MS }` as the second arg to `c.messages.stream(...)`.
  Exported constant so tests assert the value without magic numbers. Classified as
  environmental in `isEnvironmentalBedrockError()` (`msg.startsWith('request timed out')`)
  so a hung call parks the task without consuming a retry slot.
  Reasoning: longest healthy turn observed well under 10 min; 15 min fires at 58% of
  the 26-min observed hang.

- **Phase 50: Two-prong stale-job recovery (`161`)** —
  Prong A: `resetStaleRunningTasks()` in `startupResume.ts` runs after
  `sweepOrphanContainers()` at startup — every `running` task is provably stale once
  all containers are gone. Prong B: `featureRedispatch.ts` calls `job.remove()` on
  any BullMQ job still listed as active before `reconcileOrphanedTasks()`, then the
  existing reset loop transitions those tasks to `pending`. UI REDISPATCH button now
  enables when any task is `running` (not only `parked`) in an
  IMPLEMENTING/LIGHT_IMPLEMENTING feature.

- **Phase 49: empty staged set after lockfile unstaging skips git commit (`159`)** —
  `testJob.ts` previously called `gitCommit` unconditionally inside the
  `if (statusOut !== '')` block. When the agent correctly writes nothing new and
  Phase 36's lockfile unstaging drains the staged set to empty, `git commit` exited
  non-zero (target repo's pre-commit hook: "No relevant files staged"). Fix: wrap the
  staged-file log + `gitCommit` + `pushBranch` in `if (stagedLines.length > 0)`;
  the `else` branch emits an `agent.log` with `severity: ok`.

- **Phase 48: `inspect_file` now passes a container-relative path (`156`)** —
  `testAgent.ts:844` previously called `container.exec(`node ${absPath}`)` where
  `absPath` was the host-absolute path. Inside the Docker container (worktree mounted
  at `/workspace`) that path doesn't exist. Fix: compute
  `path.relative(realpathSync(worktreePath), absPath)` and pass the relative path.
  `realpathSync` is needed because macOS `/tmp` → `/private/tmp` symlink otherwise
  causes `path.relative` to return a traversal path.

- **Phase 47: failure message cap scaled by failure count (`153`)** —
  `formatTestSummary` changed `t.message.slice(0, 200)` to
  `slice(0, failed <= 3 ? 4000 : 200)`. A one-failure run now returns the full diff.

- **Phase 47: console output appended to test summaries (`154`)** —
  `summarizeBashTestRun` appends `\nCONSOLE:\n<tail>` (2048 chars). Jest: from
  `rawCombined`. Vitest: from per-file `message` fields.

- **Phase 46: reporter-flag stripping is mechanical, not prompt-based (`152`)** —
  `--reporter`, `--outputFile`, `--json` stripped at the harness layer.

- **Phase 42: brief hashes computed by orchestrator (`136`–`138`)** —
  Agent writes paths-only comment; orchestrator hashes the files and rewrites the
  header. One canonical path (`<worktreeRoot>/__orrery_harness_brief.md`) enforced
  at both ends.

- **Phase 40: warning findings open `code_review` gate (`133`)** —
  A warnings-only review opens the `code_review` gate; only a fully clean review
  passes immediately.

- **`spec_approval` gate-open (Phase 29)** — 4 open paths: `awsReviewJob.ts` after
  review, `specSubmit.ts` no-charter fast-path, `awsReviewJob.ts` error final-attempt,
  missing-charter guard. 1 approve path: `POST /features/:id/approve`.

- **Test-file boundary + finding identity (Phases 28, core)** — `write_file`/`edit_file`
  in dev agents call `getTestAuthoredSet` at startup and reject test-trailer files.
  Finding ids (`f1`, `f2`) recur per cycle — lookups must use composite
  `(featureId, specRev, id)`.

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
| 47 | The agent can read a value | `f0e408b` | 2026-09-08 |
| 48 | inspect_file actually runs the file | `4ba82b5` | 2026-09-09 |
| 49 | Writing nothing is a valid outcome | `8aa8dbb` | 2026-09-10 |
| 50 | A call that never returns is not a running task | `44cea4f` | 2026-09-14 |
| 51 | A test may not exercise its own stand-in | pending | 2026-09-14 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run when editing the orchestrator.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
