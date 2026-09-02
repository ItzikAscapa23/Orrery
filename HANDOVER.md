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

- **Current phase:** 27 — The scratch filter excludes only scratch
- **State:** `complete`
- **Last updated:** 2026-09-03

---

## Current phase progress

*plan.md has no phase 28 yet — next phases pending plan update.*

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1132 passed across 86 files**, 2026-09-03 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-03 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-03 |

---

## Decisions

- **Scratch filter narrowed to standalone-word match (Phase 27)** — `SCRATCH_FILE_RE`
  changed from `/debug|scratch/i` to `/(?:debug|scratch)(?![a-zA-Z0-9])/i`. The
  negative lookahead ensures "debug" or "scratch" matches only as a standalone word or
  terminal camelCase segment (e.g. `debug-clubs.test.js`, `orderCardClubsListDebug.test.js`)
  but not when embedded in a compound name (`debugPanel.test.ts`, `scratchpadReducer.test.ts`).
  Defined once at `testJob.ts:73`, applied at `:94` and `:114`.

- **Rewrite measurement follow-up (Phase 27)** — The `## Iterating on test files`
  prompt block (added Phase 26) instructs the test agent to edit rather than rewrite.
  Re-measure using `scripts/measure-rewrite-cost.ts` after 3–5 new feature runs complete.
  The instruction will be considered to have failed if any feature shows ≥10% rewrite
  share on non-scratch test files. Instruction-only changes have not held before
  (the node_modules prohibition, the pipe/redirect rules) — if the threshold is crossed,
  replace with a structural fix (e.g. read-file before write-file enforcement).

- **Scratch-file filter: basename-only check (Phase 24/26)** — Applied via
  `path.basename(f)` in both `getAuthoredTestFilesForTask` and `getAuthoredTestFiles`
  (`testJob.ts:94`, `:114`). Basename-only avoids false-positives from directory names.

- **Binary sentinel is ABI-specific (Phase 24/26)** — Both `worldclock-server` and
  `worldclock-web` use `node_modules/@rolldown/binding-linux-arm64-musl/rolldown-binding.linux-arm64-musl.node`.
  Present only after a correct linux-musl install. `repo-manifest.example.yaml` shows
  the Rollup variant (`@rollup/rollup-linux-arm64-musl`) for vitest 1.x–2.x repos.

- **Parking replaces the one-round cap (Phase 25)** — All failure paths in
  `taskTestJob.ts` park the task (`status: 'parked'`, no `testsWritten` change) and
  REDISPATCH retries the test-first path. The old `testTaskAttempts === 0` routing
  guard in `dispatch.ts:157` was removed.

- **`testsWritten` read/write audit (Phase 25)** — Only written in `taskTestJob.ts`
  success path when `authoredFiles.length > 0`. Any `testsWritten: true` without a
  committed test file is a bug.

- **Finding identity is composite (featureId, specRev, id)** — Model-assigned ids
  (`f1`, `f2`) recur across cycles. A plain `where: { id }` on findings is always a bug.

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
| 24 | The test agent stops paying twice (tasks 91–93) | `657c09e` | 2026-09-01 |
| 25 | Tests exist before code, and the flag says so | `f2a30d4` | 2026-09-02 |
| 26 | The test agent stops paying twice (measurement + prompt fix) | `d55a601` | 2026-09-03 |
| 27 | The scratch filter excludes only scratch | pending | 2026-09-03 |

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
