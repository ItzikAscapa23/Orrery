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
- `docs/specs/` — numbered phase specs (phases 0–5, amended through phase 10)
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

- **Current phase:** 13 — Recovery paths account for live work
- **State:** `complete`
- **Last updated:** 2026-08-29

---

## Current phase progress

*Phase 13 closed. No Phase 14 is defined in `plan.md` yet — next work requires a new phase entry.*

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — 1079 passed across 84 files, 2026-08-29 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-08-29 |
| `npm run lint` | **exit 0** — 0 problems, 2026-08-29 |

---

## Decisions

- **Brief = task, not phase** — briefs are already task-sized; the handover ceremony
  per three-file change costs more than the change.
- **Phase `Verification:` = the standing four** — repo-root suite count, typecheck,
  lint, commit SHA. Per-brief fail-first evidence stays in the brief.
- **`checkSpendGuard` returns a discriminated union** — callers need `remainingBudget`
  to compute `effectiveCap`. A boolean return forced callers to re-query or over-run.
- **Task-derived agent status applied after the event-sourced fold** — O-14 root
  cause: `agent.status` events can be stale on the gate-resolved path. Task rows
  are authoritative for dev/test agents; review/spec/planner remain event-sourced.
- **Spec 02 amended in place (not a new 06 file)** — keeps the canonical orchestrator
  reference in one file; an agent reading spec 02 gets the full current picture.
- **`bff` skill and architecture doc committed as `.example` files** — same pattern
  as `repo-manifest.example.yaml`; the operator copies and customises.
- **ESLint test-file scoped override, not per-line suppressions** — `no-unsafe-*`,
  `no-explicit-any`, `no-unnecessary-type-assertion`, `require-await` all turned off
  for `**/__tests__/**` in `eslint.config.mjs`.
- **`apps/server/prisma/` excluded from ESLint** — `seed.ts` sits outside any
  tsconfig `include`; excluding the directory is the minimal fix.
- **prettier needs two passes for stable output** — some method-chain patterns
  change indentation on pass 1, which changes line-length decisions on pass 2.
- **R8: `enqueueJob` returns job ID; persisted at dispatch time** — `queue.ts:enqueueJob`
  now returns the BullMQ job ID. `dispatchUnblockedTasks` writes `bullJobId` to the
  task row immediately after `queue.add()`, closing the window where a running task
  had a null ID. Reconciler treats null `bullJobId` as "not yet dispatched" (skip),
  not orphaned. Redundant second write in `devJob.ts:389` removed.
- **R8: attempt counter reset uses Prisma atomic decrement** — `{ decrement: 1 }`
  instead of JS read-modify-write `Math.max(0, n - 1)` prevents a race on concurrent
  reconciler runs.
- **`parkReason: 'orphan'` path is dead** — `startupResume.ts:31,40` filters on it,
  but no production code writes it (reconciler writes only `'orphan_cap'`). Left
  as-is; the filter is a no-op but harmless.
- **spendGuard dedup not implemented** — `checkSpendGuard` uses raw `COUNT(*)` which
  can overcount retried jobs. Spec said report only; implementation deferred.
- **R9: baseline-diff gate** — `devJob.ts` captures a `parseTestOutput` result
  immediately after the probe passes. The verification step only throws on failures
  absent from the baseline set, so pre-existing broken tests do not block the agent.
- **`parseTestOutput` skips non-terminal statuses** — `pending`, `skipped`, `todo`
  entries are excluded with an early `continue`; TypeScript narrows the remaining
  `status` to `'passed' | 'failed'` via control flow, making the `as` cast
  unnecessary.
- **Container name = `${CONTAINER_PREFIX}-${label}`** — `label` is the task ID for
  dev and task-test containers, `${featureId}-test` for the feature-level test job.
  `startContainer` calls `docker rm -f <name>` before `docker run -d`, so any
  re-dispatch (reconciler, BullMQ stall recovery, retry-bounce) automatically kills
  the incumbent. No timestamp suffix — deterministic naming is what makes targeted
  kill possible. `sweepOrphanContainers` stays as the crash-recovery blanket path.
- **Bedrock unreachable: `parkReason: 'bedrock_unreachable'`, `final: false`, no
  `agent.status:failed`** — VPN/credential failure is environmental; it must not
  consume a retry slot or permanently mark the agent as failed. The attempt counter
  was already rolled back; this phase adds `final: false` and a distinct park reason
  so operators can distinguish infra-down from agent quality failures.
- **`pr.created` guard re-queried per repo inside the loop** — the pre-loop snapshot
  missed events written after the snapshot (ADO call succeeded, appendEvent crashed,
  job retried). Per-iteration `findFirst` closes the non-atomic window.

---

## Environmental failure audit (Phase 13)

Every failure classification in the codebase — confirmed they share one definition:
*an environmental failure is one caused by infrastructure, not agent behaviour*.

| Site | Failure | Slot consumed? | Mechanism |
|---|---|---|---|
| `taskReconciler.ts` | Orphan (server crash) | No | `{ decrement: 1 }` on `attemptCount` or `testTaskAttempts` |
| `devJob.ts` (Bedrock check) | Bedrock unreachable | No | `attemptCount: task.attemptCount` rollback; `final: false`; `parkReason: 'bedrock_unreachable'` |
| `devJob.ts` (catch block) | InstallError | Yes (3 attempts max) | Classified as infra but slot-consuming by design — cold-cache ratcheting needs multiple tries |
| `devJob.ts` (catch block) | PushError | Always final | Work is committed; retrying the full agent job cannot fix a push failure |
| `devJob.ts` (catch block) | AgentNoopError, policy violations | Always final | Agent behavioural fault — no retries appropriate |

`InstallError` is the only environmental failure that consumes slots, and that is
intentional: the npm cache ratchets forward on each attempt, so retrying helps.

---

## Enqueue path inventory (Phase 12 R8 audit)

All paths that can enqueue for a running task:

| Call site | Trigger |
|---|---|
| `taskReconciler.ts:185` | Orphan recovery — immediate call then 60 s interval |
| `featureRedispatch.ts:113` | `POST /features/:id/retry-bounce` manual redispatch |
| `startupResume.ts:14` | Server start — resumes any task that was running at shutdown |
| BullMQ `maxStalledCount: 1` (`agentWorker.ts:204`) | BullMQ-internal stall recovery; bypasses `queue.ts` |

`queue.ts:56` (`getQueue().add()`) is the only production call site. BullMQ's internal
stall-recovery path is external to application code and cannot be changed via R8.
All four paths now terminate the incumbent container via the deterministic naming
scheme before the new container starts.

---

## Assumptions

- `apps/web/.env.local` setting `VITE_PRODUCT_NAME=PepperOrchestrator` is a
  deliberate local brand override. The fallback `'Orrery'` stays.

---

## Open questions / blockers

- **C-6 macOS jail bug — not fixed.** `resolveReal` (`testAgent.ts:209`) falls back
  to the unresolved path when a nested parent dir doesn't exist. On macOS
  `/var → /private/var`, this makes the jail check fail for new nested test dirs
  (e.g. `__tests__/acceptance/`). Fix: use `path.resolve` instead of
  `fs.realpathSync.native` in the inner catch. Carry to Phase 14+.
- **O-15 AWS review 8 output tokens.** Low confidence; may be correct for trivial
  features. Carry forward.

---

## PRD conflicts

- none

---

## Phase log

| Phase | Title | Commit | Date |
|---|---|---|---|
| 0–5 | Spec agent through review/test agents | squashed into `54bdf20` | pre-2026-08 |
| 6 | Cost instrumentation and blocking backlog | squashed into `54bdf20` | 2026-08 |
| — | Brief 59 — product name single source | `4a1dc80` | 2026-08-21 |
| — | Tooling — phase and handover skills | `d13e9c2` | 2026-08-21 |
| 7 | Agent spend and test redundancy | `4a16025` | 2026-08-21 |
| 8 | Planner efficiency | `55a0c5b` | 2026-08-21 |
| 9 | Backlog sweep | `2723ba0` | 2026-08-21 |
| 10 | Spec reconciliation | `1097c3f` | 2026-08-21 |
| 11 | Lint debt | `f0769a5` | 2026-08-21 |
| 12 | Dispatch identity and gate baseline | `6d8ef86` | 2026-08-29 |
| 13 | Recovery paths account for live work | `ccbab22` | 2026-08-29 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run: `tsx watch` reloads on file save, which stalls in-flight
  BullMQ jobs and parks their tasks. Never edit the orchestrator while a feature
  is running.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
- A restart mid-dispatch produces exactly one container.
