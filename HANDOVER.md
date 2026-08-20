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
- `apps/server/src/agents/` — devAgent, testAgent and their prompt construction
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

- **Current phase:** 7 — Agent spend and test redundancy
- **State:** `complete`
- **Last updated:** 2026-08-21

---

## Current phase progress

*Phase 7 closed. Phase 8 has not started.*

- [x] `58-test-file-reuse` — test agent injected with existing authored test files + describe titles
- [x] `60-spend-guard-budget` — spend guard now returns remainingBudget; agents capped at min(repoMaxTurns, remainingBudget)
- [x] `61-empty-fix-task-guard` — explicit early-return guard in createSyntheticFixTasks for zero blockers
- [x] `62-agent-status-from-tasks` — foldEvents derives dev/test agent status from task rows; fixes O-14

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — 1059 passed (1059) across 84 files, 2026-08-21 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-08-21 |
| `npm run lint` | 362 problems (356 errors, 6 warnings) — below 364 baseline, 2026-08-21 |

---

## Decisions

- **Brief = task, not phase** — briefs are already task-sized and phases are
  already session-sized. Running the handover ceremony for a three-file change
  would cost more than the change.
- **Phase `Verification:` = the standing four** — repo-root suite count,
  typecheck, lint, commit SHA. Per-brief fail-first evidence stays in the brief.
- **`PRD.md` points into `docs/specs/` rather than duplicating it** — duplicating
  would be a further violation of C6, the constraint this project has broken five
  times.
- **`.claude/skills/*` wildcard with negations for `phase` and `handover`** — the
  blanket `.claude/skills/` ignore was deliberate, to keep the tenant-specific
  `bff` skill out of the public repo.
- **Product name reads from a single accessor** (brief 59) — `VITE_PRODUCT_NAME ?? 'Orrery'`
  was duplicated in `TopBar` and `SolarMesh`; centralised at `4a1dc80`.
- **`checkSpendGuard` returns a discriminated union, not a boolean** — callers
  need `remainingBudget` to compute `effectiveCap = Math.max(1, Math.min(repoMaxTurns, remaining))`.
  A boolean return forced callers to re-query the DB or over-run the cap.
- **`buildSystemPrompt` exported from testAgent.ts** — exported for direct test
  coverage of the `existingTestFiles` injection, rather than testing it only
  indirectly through `runTestAgent`.
- **Task-derived agent status applied after the event-sourced fold** — O-14 root
  cause: `agent.status` events can be stale on the gate-resolved path. Task rows
  are the authoritative record; the event-sourced path remains for review/spec/planner
  agents which have no task rows.

---

## Assumptions

- Phases 0–6 are complete as recorded in `docs/specs/` and `docs/phase-6.md`,
  notwithstanding the backlog inaccuracies noted below.
- `apps/web/.env.local` setting `VITE_PRODUCT_NAME=PepperOrchestrator` is a
  deliberate local brand override, not a rename. The fallback `'Orrery'` stays.
- No feature was mid-run when phase 7 work landed. The worker re-registers on
  server restart; any in-flight task at that point would already have failed.

---

## Open questions / blockers

- **`docs/phase-6.md` is inaccurate.** C-3, C-4 and C-5 are resolved in code but
  still listed STANDING in the Phase 7 carry-forward. Scheduled as Phase 9.
- **Git history is a single squashed commit** before `4a1dc80`. SHAs cited in
  `docs/phase-6.md` are unreachable; descriptions remain trustworthy.
- **`bff` skill is machine-local.** `.claude/skills/orchestrator-server.md` is
  gitignored. PRD Q3. Scheduled as Phase 10.
- **Brief 59 acceptance block incomplete.** `4a1dc80` landed and suite is green,
  but the original acceptance block asked for greps not yet supplied. Low priority.

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
| 7 | Agent spend and test redundancy | `ae3d755` | 2026-08-21 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- No feature mid-run: `tsx watch` reloads on file save, which stalls in-flight
  BullMQ jobs and parks their tasks. Never edit the orchestrator while a feature
  is running.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
