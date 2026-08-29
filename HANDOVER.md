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
- `packages/shared/` — event payload schemas
- `docs/specs/` — numbered phase specs (phases 0–5, amended through phase 16)
- `docs/agents/repo-manifest.yaml` — operator config, gitignored, example committed

**Conventions:**
- No default exports. Zod for all external input. No `any` without a comment.
- Commit format `feat|fix|chore(scope): description`.
- Every Anthropic call goes through `lib/anthropic.ts`.
- Transitions only through the orchestrator; each persists status and appends
  `phase.changed` in the same transaction.
- One task = one brief. Briefs carry evidence, numbered requirements, fail-first
  tests, and an acceptance block.

---

## Status

- **Current phase:** 16 — Environmental failures leave a recoverable task
- **State:** `complete`
- **Last updated:** 2026-08-29

---

## Current phase progress

*Phase 16 closed. Pull Phase 17 tasks from `docs/specs/` before starting.*

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1097 passed across 84 files** (+12 new tests), 2026-08-29 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-08-29 |
| `npm run lint` | exit 0 — 0 problems, 2026-08-29 |

---

## Phase 16 audit — task state-write sites

Every site that writes a terminal or near-terminal state to a Task row:

| File:line | State written | `bullJobId` | `parkReason` | Notes |
|---|---|---|---|---|
| `lib/bedrockPark.ts:25` | `parked` | `null` (cleared) | `bedrock_unreachable` | Canonical Bedrock park — called by devJob + taskTestJob |
| `jobs/devJob.ts:780` | `parked` | not touched | `failure` | Agent failure after max attempts (final) |
| `jobs/devJob.ts:874` | `awaiting_tests` | not touched | — | Noop-success path: code unchanged, tests not yet written |
| `jobs/devJob.ts:983` | `parked` | not touched | `failure` | Per-attempt failure during acceptance check |
| `jobs/devJob.ts:1011` | `awaiting_tests` | not touched | — | Normal-success: commit done, test task not yet written |
| `jobs/devJob.ts:1076` | `parked` | not touched | `failure` | PushError / CommitStepError (always final) |
| `jobs/devJob.ts:1086` | `pending` | not touched | — | Retry after non-final failure (re-dispatch follows) |
| `jobs/taskTestJob.ts:394,434,450` | `pending` | `null` (cleared) | — | Tests written, task ready for re-dispatch |
| `jobs/devJob.ts:290` | `completed` | not touched | — | `completeTask` helper — normal completion |

---

## Decisions

- **`awaiting_tests` is a string status, not a Prisma enum** — `status` column is
  `String`; new values never require a migration. Only the schema comment and the
  `ActivityTask['status']` TypeScript union must be updated.
- **Bedrock park is always `parked` + `bullJobId: null`, never `pending`** —
  `pending` with a stale `bullJobId` is invisible to the reconciler (scans `running`)
  and gate logic (scans `parked`). `parked` + cleared ID is the only safe treatment.
- **`checkBedrockWithRetry` must reset cache between retries** — the 30 s cache TTL
  means all retry probes read the same stale `false` unless `resetConnectivityCache()`
  is called before each attempt.
- **`checkSpendGuard` returns a discriminated union** — callers need `remainingBudget`
  to compute `effectiveCap`. A boolean return forced callers to re-query or over-run.
- **Task-derived agent status applied after the event-sourced fold** — `agent.status`
  events can be stale on the gate-resolved path. Task rows are authoritative for
  dev/test agents; review/spec/planner remain event-sourced.
- **`discoverTestDir` candidate depth = 3** — `findTestFiles(abs, N)` consumes depth
  entering directories. BFF layout (`test/scenarios/<domain>/`) needs `maxDepth=3`;
  depth=1 triggered deep-scan with inconsistent results across rounds.
- **`getAuthoredTestFiles` lets git errors propagate** — silent `catch { return [] }`
  was indistinguishable from zero authored files. Error propagation routes to
  `_handleNoAuthoredTests` with a `parseError` marker, preventing a false gate pass.
- **`enqueueJob` returns job ID; persisted at dispatch time** — closes the window
  where a running task had a null `bullJobId`. Reconciler treats null as "not yet
  dispatched" (skip), not orphaned.
- **Baseline-diff gate** — `devJob.ts` captures probe test output immediately after
  the probe passes. Verification only throws on failures absent from baseline, so
  pre-existing broken tests do not block the agent.
- **Container name = `${CONTAINER_PREFIX}-${label}`** — deterministic naming makes
  targeted kill possible; re-dispatch automatically kills the incumbent.

---

## Assumptions

- `apps/web/.env.local` setting `VITE_PRODUCT_NAME=PepperOrchestrator` is a
  deliberate local brand override. The fallback `'Orrery'` stays.

---

## Open questions / blockers

- **C-6 macOS jail bug — carry forward.** `resolveReal` (`testAgent.ts:209`) falls
  back to the unresolved path when a nested parent dir doesn't exist. On macOS
  `/var → /private/var` makes the jail check fail for new nested test dirs. Fix:
  use `path.resolve` instead of `fs.realpathSync.native` in the inner catch.
- **O-15 AWS review 8 output tokens.** Low confidence; may be correct for trivial
  features. Carry forward.

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

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run: `tsx watch` reloads on file save, which stalls in-flight
  BullMQ jobs and parks their tasks. Never edit the orchestrator while a feature
  is running.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
- A restart mid-dispatch produces exactly one container.
