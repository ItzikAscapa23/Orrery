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
- `docs/specs/` — numbered phase specs (phases 0–5, amended through phase 17)
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

- **Current phase:** 18 — Close the backlog honestly
- **State:** `complete`
- **Last updated:** 2026-08-29

---

## Current phase progress

- [x] Diagnose O-15 (review agent 29k/14 tokens)
- [x] Close O-15 — no fix warranted (recorded in Decisions)
- [x] Trim `docs/phase-6.md` to open items only (C-3 and O-12 remain)
- [x] Record deletion convention in HANDOVER Conventions section

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1098 passed across 84 files** (no code changes), 2026-08-29 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-08-29 |
| `npm run lint` | exit 0 — 0 problems, 2026-08-29 |

---

## Decisions

- **O-15 closed — `reviewAgent` 29k input / 14 output tokens is correct
  behavior.** `createAdoPrJob.ts` has zero Anthropic calls; the PR body is pure
  string concatenation capped at 3,900 chars. The 29,870 in / 14 out event
  labeled `review` comes from `reviewAgent.ts` returning `{"findings":[]}` on a
  clean code review. `max_tokens` is 4096 — the 14 tokens is the minimal valid
  JSON response, not a budget truncation. The large input (charter.md + spec +
  contract + diff capped at 60 KB) is intentional. No fix warranted.
- **`severity === 'action' → 'violation'`, all other severities → `'turn'` in
  `activityFold.ts`** — violation text (`⚠ violation 1/3: allowlist — ...`) is logged
  with `severity: 'muted'`, so it loses the orange UI glyph but the in-text `⚠`
  remains visible. No double-glyph. Success lines (`ok`) and tool-call logs (`muted`)
  are neutral; agent-action lines (`action`) are highlighted.
- **Mesh status: skip `working → done` override from task-derived status** — the
  feature-level test job emits `agent.status(working)` directly; task rows have no
  record of it. `deriveAgentStatusesFromTasks` returns `'done'` when all covered tasks
  have `testsWritten: true`, but the feature-level job runs after that. Fix: when
  merging task-derived statuses, skip overriding an existing `'working'` with `'done'`.
- **C-6 settled as resolved (no code change)** — the `resolveReal` macOS inner-catch
  bug is unreachable: both `checkReadAllowed` and `checkWriteAllowed` pre-resolve the
  worktreeRoot via `realpathSync` before calling `resolveReal`. Since `abs` is
  constructed from the resolved root, the innermost catch returning `abs` already
  returns a real-path. Phase 15's candidate-depth fix eliminated the observable symptom;
  Phase 17 confirmed no distinct defect remains. C-6 closed.
- **`awaiting_tests` is a string status, not a Prisma enum** — `status` column is
  `String`; new values never require a migration. Only the schema comment and the
  `ActivityTask['status']` TypeScript union must be updated.
- **Bedrock park is always `parked` + `bullJobId: null`, never `pending`** —
  `pending` with a stale `bullJobId` is invisible to the reconciler (scans `running`)
  and gate logic (scans `parked`). `parked` + cleared ID is the only safe treatment.
- **Finding identity is composite (featureId, specRev, id)** — model-assigned finding
  ids (`f1`, `f2`) recur in every review cycle. Lookups must use the composite key or
  scope by feature + current cycle; a plain `where: { id }` is always a bug.
- **Task-derived agent status applied after the event-sourced fold** — except for the
  `working → done` guard above. Task rows are authoritative for dev/test agents; review,
  spec, and planner remain event-sourced.

---

## Assumptions

- `apps/web/.env.local` setting `VITE_PRODUCT_NAME=PepperOrchestrator` is a
  deliberate local brand override. The fallback `'Orrery'` stays.

---

## Conventions

- **Backlog entries in `docs/phase-6.md` are deleted on close, not annotated.**
  The phase commit is the evidence for each closed item, reachable via the phase
  log table below. Do not add `✅ DONE` or `Items closed in Phase N` lines —
  delete the entry outright once its fix is committed and the phase passes
  verification.

---

## Open questions / blockers

- **O-12 Duplicate `pr.created` events.** Root cause diagnosed (non-atomic ADO call
  + event append). Not implemented. Fix: re-query existing `pr.created` events inside
  the per-repo loop immediately before the ADO API call.
- **C-3 `detectJsonCommand` CLAUDE.md inference.** Mitigated — `probe_command` in
  `repo-manifest.yaml` is primary. Fallback inference only triggers when `probe_command`
  is unset. Ensure `probe_command` is set for every repo in the manifest.

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

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run: `tsx watch` reloads on file save, which stalls in-flight
  BullMQ jobs and parks their tasks. Never edit the orchestrator while a feature
  is running.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
- A restart mid-dispatch produces exactly one container.
