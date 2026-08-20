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

- **Current phase:** 6 — Cost instrumentation and blocking backlog
- **State:** `complete`
- **Last updated:** 2026-08-21

---

## Current phase progress

*Phase 6 closed before this plan was adopted. Phase 7 has not started.*

- [x] Usage instrumentation — `anthropic_usage` events on every API call
- [x] Rate table — `model_rates` seed, time-aware lookup
- [x] Cost endpoint + UI card — `GET /features/:id/cost`, `GET /cost`, CostCard
- [x] C-1 review findings deleted on re-review
- [x] C-2 operator resolutions no longer silently discarded
- [x] U-16 `activeCount` no longer conflates `working` with `waiting`
- [x] U-17 `WORKER_CODE_COMMIT` re-evaluated at dispatch

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **count to confirm**: baseline was 1024 passed / 1 failed (1025) before brief 59; 59 added N cases and turned the failure green. Record the real number at the next handover. |
| `npm run typecheck` | not run since brief 59 |
| `npm run lint` | not run since brief 59 |

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
  `bff` skill out of the public repo. Generic workflow tooling does not belong in
  that category. Git will not descend into an excluded directory, so the rule had
  to become a wildcard before negations could work.
- **Product name reads from a single accessor** (brief 59, `4a1dc80`) — the
  `VITE_PRODUCT_NAME ?? 'Orrery'` expression was duplicated in `TopBar` and
  `SolarMesh`, and `App.test.tsx` asserted the fallback literal, so the suite
  result depended on whether `.env.local` existed on the machine running it.

---

## Assumptions

- Phases 0–6 are complete as recorded in `docs/specs/` and `docs/phase-6.md`,
  notwithstanding the backlog inaccuracies noted below.
- `apps/web/.env.local` setting `VITE_PRODUCT_NAME=PepperOrchestrator` is a
  deliberate local brand override, not a rename. The fallback `'Orrery'` stays.

---

## Open questions / blockers

- **Brief 59 acceptance is incomplete.** `4a1dc80` landed and the suite is green,
  but the acceptance block asked for four things not yet supplied: the repo-root
  suite count, the `grep -rn "VITE_PRODUCT_NAME" apps/web/src` output, the full
  audit list of files inspected, and the list of other tests whose assertions
  depend on ambient env. Unblocked by: re-running the greps.
- **`docs/phase-6.md` is inaccurate.** C-3, C-4 and C-5 are resolved in code but
  still listed STANDING in the Phase 7 carry-forward. Real remaining count is
  nine, not twelve. Scheduled as Phase 9.
- **Git history is a single squashed commit** before `4a1dc80`. Every SHA cited
  in `docs/phase-6.md` is unreachable, so "resolved in commit X" cannot be
  verified against a diff. Descriptions remain trustworthy; provenance does not.
- **`bff` skill is machine-local.** `.claude/skills/orchestrator-server.md` is
  gitignored and points at `docs/architecture/bff.md`, also gitignored. No fresh
  checkout has either. PRD Q3.

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

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- No feature mid-run: `tsx watch` reloads on file save, which stalls in-flight
  BullMQ jobs and parks their tasks. Never edit the orchestrator while a feature
  is running.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
