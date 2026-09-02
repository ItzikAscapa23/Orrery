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
- `apps/server/src/jobs/` — devJob, testJob, taskTestJob, createAdoPrJob, agentWorker
- `apps/server/src/agents/` — devAgent, testAgent, plannerAgent, testPlannerAgent
- `apps/web/src/lib/eventFold.ts` — all UI state derives from folding the event log
- `apps/web/src/lib/activityFold.ts` — activity-tab rows folded from events + task rows
- `packages/shared/` — event payload schemas
- `docs/specs/` — numbered phase specs (phases 0–5, amended through phase 18)
- `docs/agents/repo-manifest.yaml` — operator config, gitignored, example committed

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
  log table below. Do not add `✅ DONE` or `Items closed in Phase N` lines —
  delete the entry outright once its fix is committed and the phase passes
  verification.

---

## Status

- **Current phase:** 25 — Tests exist before code, and the flag says so
- **State:** `complete`
- **Last updated:** 2026-09-02

---

## Current phase progress

*plan.md has no phase 26 yet — next phases pending plan update.*

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1130 passed across 86 files** (+5 new tests), 2026-09-02 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-02 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-02 |

---

## Decisions

- **Parking replaces the one-round cap (Phase 25)** — The old `taskTestJob.ts` catch
  block wrote `testsWritten: true` on violation or after `testTaskAttempts >= 1`
  (one-round cap), then dispatched the dev job. This meant `testsWritten` could be
  `true` with no test files on disk. Now: all failure paths park the task
  (`status: 'parked'`, no `testsWritten` change) and REDISPATCH retries the test-first
  path. The `testTaskAttempts === 0` routing guard in `dispatch.ts:157` was the
  mechanism for the old cap — removed so REDISPATCH re-enters the test job.

- **Zero-file success path parks (Phase 25)** — `taskTestJob.ts` previously wrote
  `testsWritten: true` even when the agent ran successfully but committed no files
  (`authoredFiles.length === 0`). Now parks with `parkReason: 'no_tests_authored'`.
  The DoD says "no code path writes `testsWritten: true` without a test file authored".

- **Mid-run Bedrock error classified in catch block (Phase 25)** — `anthropic.ts`
  re-throws credential expiry as `'Bedrock credentials expired. ...'`. The catch block
  now checks `err.message.startsWith('Bedrock credentials expired')` and routes to
  `parkTaskOnBedrockFailure` with attempt rollback — same treatment as the pre-agent
  probe path.

- **Dev agent told not to write acceptance tests for covered tasks (Phase 25)** —
  `coveredByTestPlan: boolean` added to `DevContext`. When true, `buildSystemPrompt`
  injects a `## Test-first task` block telling the agent the tests already exist and
  it must not author new ones. Threaded through both `measurePromptSections` and
  `runDevAgent` calls in `devJob.ts`.

- **Park reason values (Phase 25):** `'no_tests_authored'`, `'allowlist_violation'`,
  `'test_agent_failed'` — all `final: false` (recoverable by REDISPATCH). No schema
  change needed; `parkReason` is a free-text string column.

- **`testsWritten` read/write audit (Phase 25):**

  Writes (after fix):
  | Site | Condition |
  |---|---|
  | `taskTestJob.ts` success path | Only when `authoredFiles.length > 0` |

  Reads:
  | Site | Meaning |
  |---|---|
  | `taskTestJob.ts:88` | Idempotency gate — skip if already written |
  | `dispatch.ts` | Route to test-task if `!testsWritten` (no `testTaskAttempts` guard after fix) |
  | `taskReconciler.ts` | Orphan counter selection — `testTaskAttempts` vs `attemptCount` |
  | `devJob.ts:873` | Noop-success → `awaiting_tests` |
  | `devJob.ts:945` | Gate for per-task acceptance test run |
  | `devJob.ts:1010` | Post-commit guard → `awaiting_tests` |
  | `featureTasks.ts` | API serialization |
  | `eventFold.ts:76` | Test agent display → `'done'` |
  | `TaskTable.tsx` | "TDD ✓ tests" badge |

- **Test mock pollution fix (Phase 25)** — `taskTestJob.test.ts` `beforeEach` now
  restores `execFileSync` to the default git-dispatching implementation before each
  test. Two tests (`git helper maxBuffer` and `git ENOBUFS`) used `mockImplementation`
  without cleanup, polluting the R-25 `bullJobId` test. Also clears
  `dispatchUnblockedTasks` call history so `not.toHaveBeenCalled()` assertions are
  isolated.

- **Finding identity is composite (featureId, specRev, id)** — model-assigned finding
  ids (`f1`, `f2`) recur in every review cycle. Lookups must use the composite key; a
  plain `where: { id }` is always a bug.

- **Task-derived agent status applied after event-sourced fold; skip `working → done`
  override** — the feature-level test job emits `agent.status(working)` after task rows
  show `testsWritten: true`. Merging must not override an existing `'working'` with
  task-derived `'done'`.

- **`detectJsonCommand` throws when `probe_command` is absent (Phase 19)** — CLAUDE.md
  prose-inference fallback removed. Any active full-path repo without `probe_command`
  fails at the first `detectJsonCommand` call.

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
| 24 | The test agent stops paying twice | `657c09e` | 2026-09-01 |
| 25 | Tests exist before code, and the flag says so | pending | 2026-09-02 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run: `tsx watch` reloads on file save, which stalls in-flight
  BullMQ jobs and parks their tasks. Never edit the orchestrator while a feature
  is running.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
- A restart mid-dispatch produces exactly one container.
- A feature whose test agent fails parks without the dev agent running.
