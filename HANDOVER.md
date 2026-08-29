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

- **Current phase:** 15 — The gate counts what actually ran
- **State:** `complete`
- **Last updated:** 2026-08-29

---

## Current phase progress

*Phase 15 closed. Next work requires a new phase entry in `plan.md`.*

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — 1085 passed across 84 files, 2026-08-29 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-08-29 |
| `npm run lint` | **exit 0** — 0 problems, 2026-08-29 |

---

## Phase 15 audit — gate resolution sites

Every site that makes an acceptance-gate decision derived from a resolved path or file set:

| Site | Resolution step | Failure mode (before fix) | Failure mode (after fix) |
|---|---|---|---|
| `discoverTestDir` candidate loop | `findTestFiles(abs, N)` | depth-1 missed BFF `test/scenarios/<domain>/` layout → fell to deep-scan | depth-3 catches 2-subdir-deep layouts; candidate returns `dir: 'test'` |
| `discoverTestDir` deep-scan | `path.relative(worktree, path.dirname(found[0]))` | `''` when file sits at worktree root → `git log -- ''` throws | empty-string guard falls through to `fallback`; caller also guards `dir === ''` |
| `getAuthoredTestFiles` call site | `git log --diff-filter=A -- testDir` | git error swallowed → `[]` → false "no authored tests" gate | error propagates; call site logs and routes to `_handleNoAuthoredTests` with `parseError: 'git-resolution-error'` |
| Zero-tests guard (pre-`_advanceTestPass`) | `authoredParsed.passed` | zero total tests could reach `_advanceTestPass` → `✓ all acceptance tests pass (0 passed, 0 failed)` | guard on `(passed ?? 0) === 0 && !parseError` routes to `_handleNoAuthoredTests` |
| `testJob.ts:984` pass log | `counts.passed` | reachable with zero when guard above was absent | unreachable now; guard fires first |

**Task 72 (bounce-back inherits tests):** Fixed as a consequence of the testDir stability fix. With `discoverTestDir` consistently returning `'test'` across rounds, `getAuthoredTestFiles(worktree, 'test')` finds round-1 files in git history in round 2, and `authoredParsed.authoredPassed > 0` correctly passes the gate.

---

## Environmental failure audit (Phase 13)

Every failure classification — confirmed they share one definition:
*an environmental failure is one caused by infrastructure, not agent behaviour*.

| Site | Failure | Slot consumed? | Mechanism |
|---|---|---|---|
| `taskReconciler.ts` | Orphan (server crash) | No | `{ decrement: 1 }` on `attemptCount` or `testTaskAttempts` |
| `devJob.ts` (Bedrock check) | Bedrock unreachable | No | `attemptCount` rollback; `final: false`; `parkReason: 'bedrock_unreachable'` |
| `devJob.ts` (catch block) | InstallError | Yes (3 max) | Slot-consuming by design — cold-cache ratcheting needs multiple tries |
| `devJob.ts` (catch block) | PushError | Always final | Work is committed; retrying can't fix a push failure |
| `devJob.ts` (catch block) | AgentNoopError, policy violations | Always final | Agent behavioural fault |

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
- **`discoverTestDir` candidate depth = 3** — `findTestFiles(abs, N)` consumes depth
  entering each directory, not on reaching a file. Files 2 subdirs inside the
  candidate (BFF layout: `test/scenarios/<domain>/`) need `maxDepth=3`. Using 1
  missed them and triggered deep-scan producing inconsistent testDir across rounds.
- **`getAuthoredTestFiles` lets git errors propagate** — the silent `catch { return [] }`
  was indistinguishable from "truly zero authored files". Surfacing the error lets
  the call site route to `_handleNoAuthoredTests` with a `parseError` marker,
  preventing a false gate pass.
- **Spec 02 amended in place (not a new 06 file)** — keeps the canonical orchestrator
  reference in one file; an agent reading spec 02 gets the full current picture.
- **`bff` skill and architecture doc committed as `.example` files** — same pattern
  as `repo-manifest.example.yaml`; the operator copies and customises.
- **ESLint test-file scoped override, not per-line suppressions** — `no-unsafe-*`,
  `no-explicit-any`, `no-unnecessary-type-assertion`, `require-await` all turned off
  for `**/__tests__/**` in `eslint.config.mjs`.
- **R8: `enqueueJob` returns job ID; persisted at dispatch time** — closes the window
  where a running task had a null ID. Reconciler treats null `bullJobId` as "not yet
  dispatched" (skip), not orphaned.
- **R8: attempt counter reset uses Prisma atomic decrement** — `{ decrement: 1 }`
  instead of JS read-modify-write prevents a race on concurrent reconciler runs.
- **R9: baseline-diff gate** — `devJob.ts` captures a `parseTestOutput` result
  immediately after the probe passes. Verification only throws on failures absent
  from the baseline set, so pre-existing broken tests do not block the agent.
- **Container name = `${CONTAINER_PREFIX}-${label}`** — deterministic naming makes
  targeted kill possible. `startContainer` calls `docker rm -f <name>` before
  `docker run -d`; any re-dispatch automatically kills the incumbent.
- **Bedrock unreachable: `parkReason: 'bedrock_unreachable'`, `final: false`** —
  VPN/credential failure is environmental; must not consume a retry slot or
  permanently mark the agent as failed.
- **Phase 14: zero-total treated as failed intercept** — `summarizeBashTestRun`
  returns `[raw output — zero tests reported]` when `passed + failed === 0`.
- **Phase 14: `resultFirstLine` in `ToolCallInfo`** — first line of every tool result
  appended to the `agent.log` event. Consumers: `devJob.ts` and `testJob.ts`.

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
  `fs.realpathSync.native` in the inner catch. Carry to Phase 16+.
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
| 14 | Agents see what actually happened | `da52c8d` | 2026-08-29 |
| 15 | The gate counts what actually ran | `4c8f1c6` | 2026-08-29 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run: `tsx watch` reloads on file save, which stalls in-flight
  BullMQ jobs and parks their tasks. Never edit the orchestrator while a feature
  is running.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
- A restart mid-dispatch produces exactly one container.
