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
- `docs/specs/` — numbered phase specs (phases 0–5)
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

- **Current phase:** 8 — Planner efficiency
- **State:** `complete`
- **Last updated:** 2026-08-21

---

## Current phase progress

*Phase 8 closed. Phase 9 has not started.*

- [x] Planner granularity — added per-covered-task cost hint to `plannerAgent.ts` prompt
- [x] Test planner coverage exclusion — added explicit SKIPPED rule for test-authoring tasks in `testPlannerAgent.ts`

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — 1063 passed (1063) across 84 files, 2026-08-21 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-08-21 |
| `npm run lint` | 362 problems (356 errors, 6 warnings) — unchanged from phase 7 baseline, 2026-08-21 |

---

## Decisions

- **Brief = task, not phase** — briefs are already task-sized and phases are
  already session-sized. Running the handover ceremony for a three-file change
  would cost more than the change.
- **Phase `Verification:` = the standing four** — repo-root suite count,
  typecheck, lint, commit SHA. Per-brief fail-first evidence stays in the brief.
- **`PRD.md` points into `docs/specs/` rather than duplicating it** — duplicating
  would be a further violation of C6.
- **`checkSpendGuard` returns a discriminated union** — callers need `remainingBudget`
  to compute `effectiveCap`. A boolean return forced callers to re-query or over-run.
- **Task-derived agent status applied after the event-sourced fold** — O-14 root
  cause: `agent.status` events can be stale on the gate-resolved path. Task rows
  are authoritative for dev/test agents; review/spec/planner remain event-sourced.
- **Phase 8 is prompt-only** — both tasks (planner granularity, test-authoring exclusion)
  are prompt changes. No code structure, schema, or API changes required.
- **`buildSystemPrompt` exported from testPlannerAgent.ts** — enables direct
  string-assertion test coverage without going through `runTestPlannerAgent`.

---

## Assumptions

- Phase 8 DoD item "task count varies by ≤ 1 across three runs" is a behavioral
  property of the model's response to the new prompt. The added cost hint steers
  toward fewer tasks; a real feature run is needed to validate empirically.
- `apps/web/.env.local` setting `VITE_PRODUCT_NAME=PepperOrchestrator` is a
  deliberate local brand override. The fallback `'Orrery'` stays.

---

## Open questions / blockers

- **`docs/phase-6.md` is inaccurate.** C-3, C-4 and C-5 are resolved in code but
  still listed STANDING. Scheduled as Phase 9.
- **Git history is a single squashed commit** before `4a1dc80`. SHAs cited in
  `docs/phase-6.md` are unreachable; descriptions remain trustworthy.
- **`bff` skill is machine-local.** `.claude/skills/orchestrator-server.md` is
  gitignored. PRD Q3. Scheduled as Phase 10.

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

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- No feature mid-run: `tsx watch` reloads on file save, which stalls in-flight
  BullMQ jobs and parks their tasks. Never edit the orchestrator while a feature
  is running.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
