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

- **Current phase:** 9 — Backlog sweep
- **State:** `complete`
- **Last updated:** 2026-08-21

---

## Current phase progress

*Phase 9 closed. Phase 10 has not started.*

- [x] Correct `docs/phase-6.md` — C-3 mitigated, C-4/C-5 resolved, O-14 done
- [x] R-8 gate card header copy for non-spec_approval gates (`ApprovalGate.tsx`)
- [x] R-9 `discoverTestDir` fallback reaches event log (returns `{dir, method}`)
- [x] R-10 stale docblock at `maybeAdvance.ts`
- [x] O-13 `POST /simulate` status guard — 409 unless DRAFTING_SPEC or AWAITING_APPROVAL
- [x] O-12 duplicate `pr.created` events — root cause diagnosed, not yet fixed
- [x] C-6 nested test directories in `resolveReal` — confirmed macOS jail bug by analysis
- [x] R-7 test.report blocker vocabulary — recorded as moot

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — 1064 passed (1064) across 84 files, 2026-08-21 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-08-21 |
| `npm run lint` | 362 problems (356 errors, 6 warnings) — unchanged from phase 7 baseline, 2026-08-21 |

---

## Decisions

- **Brief = task, not phase** — briefs are already task-sized; the handover ceremony
  per three-file change costs more than the change.
- **Phase `Verification:` = the standing four** — repo-root suite count, typecheck,
  lint, commit SHA. Per-brief fail-first evidence stays in the brief.
- **`PRD.md` points into `docs/specs/` rather than duplicating it** — duplicating
  would be a further violation of C6.
- **`checkSpendGuard` returns a discriminated union** — callers need `remainingBudget`
  to compute `effectiveCap`. A boolean return forced callers to re-query or over-run.
- **Task-derived agent status applied after the event-sourced fold** — O-14 root
  cause: `agent.status` events can be stale on the gate-resolved path. Task rows
  are authoritative for dev/test agents; review/spec/planner remain event-sourced.
- **`discoverTestDir` returns `{dir, method}`** — keeps the pure fs function decoupled
  from the database; callers that have `featureId` emit `agent.log` when
  `method === 'fallback'`. Three callers updated: testJob, taskTestJob, devJob.
- **R-7 recorded as moot, not fixed** — `MissionControl.tsx:341` already excludes
  `test_report` from `ApprovalGate`; `featureFindings` routes 409 when not in
  AWAITING_APPROVAL or CODE_REVIEW. Counts vocabulary in the event payload is
  cosmetic; it does not gate approval.

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
  `fs.realpathSync.native` in the inner catch. Carry to Phase 12+.
- **O-12 duplicate `pr.created` — not fixed.** `createAdoPrJob.ts:146` builds
  `alreadyCreated` once before the loop. If the job retries after the ADO API call
  but before the event append, a second PR is created. Fix: re-query inside the
  per-repo loop immediately before each ADO call. Carry to Phase 12+.
- **O-15 AWS review 8 output tokens.** Low confidence; may be correct for trivial
  features. Carry forward.
- **`bff` skill is machine-local.** `.claude/skills/orchestrator-server.md` is
  gitignored. PRD Q3. Scheduled as Phase 10.
- **Git history is a single squashed commit** before `4a1dc80`. SHAs cited in
  `docs/phase-6.md` are unreachable; descriptions remain trustworthy.

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
| 9 | Backlog sweep | `b41310d` | 2026-08-21 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- No feature mid-run: `tsx watch` reloads on file save, which stalls in-flight
  BullMQ jobs and parks their tasks. Never edit the orchestrator while a feature
  is running.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
