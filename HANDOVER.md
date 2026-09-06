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
- `apps/web/public/` — static assets; favicon.svg is the canonical brand mark
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
  log table below.

---

## Status

- **Current phase:** 32 — Artifact tabs are copyable
- **State:** `complete`
- **Last updated:** 2026-09-06

---

## Current phase progress

*Phase 33 not yet written to plan.md — write the next spec before starting.*

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1199 passed across 91 files**, 2026-09-06 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-06 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-06 |

---

## Decisions

- **Phase 32: TEST REPORT and ACTIVITY excluded from copy scope** — both render
  structured/folded content, not raw source. Only the five source-document tabs
  (REQUIREMENT, SPEC, PLAN, CONTRACT, TEST PLAN) carry a Copy button.

- **Phase 32: clipboard unavailability surfaces as COPY ERROR** — handler throws
  if `navigator.clipboard` is falsy or `writeText` rejects; button shows `COPY ERROR`
  for 2.5 s then resets. No `execCommand` fallback — deprecated, unreliable return value.
  `localhost:5173` is a secure context in all modern browsers, so this is the rare path.

- **Phase 32: REQUIREMENT uses `RequirementTab.tsx`, not `ArtifactPanel.tsx`** —
  plan spec said all five tabs share one component; REQUIREMENT renders the raw
  `requirement` string prop via a separate component. Copy added to both; behavior
  identical.

- **`spec_approval` gate-open and approve paths (Phase 29)** —
  Gate-open paths (4):
  1. `awsReviewJob.ts` — after AWS review completes, `AWS_DONE` → AWAITING_APPROVAL
  2. `specSubmit.ts` — no charter, `SUBMIT_SPEC_LIGHT` → AWAITING_APPROVAL
  3. `awsReviewJob.ts` error-handler — final attempt exhausted, advances without findings
  4. `awsReviewJob.ts` missing-charter fallback — programming-error guard
  Approve path (1): `POST /features/:id/approve` only — `APPROVE` or `APPROVE_LIGHT`.

- **Test-file boundary: tool-handler enforcement, not prompt-only (Phase 28)** —
  `write_file` and `edit_file` in `runDevAgent` / `runLightDevAgent` call
  `getTestAuthoredSet(worktreePath)` at startup and reject any path in the returned
  set with `is_error: true`. Rejection does NOT consume a violation slot. Authoritative
  set: any file added in a commit carrying `X-Orrery-Agent: test`. `testAgent` is
  path-scoped to testDir. The full tool audit is in the Phase 28 commit.

- **`| head -N` / `| tail -N` exempted from metachar check (Phase 28)** —
  `checkMetachar()` strips `| head/tail [-n] N` before the regex; bare `| head` still
  throws. `2>/dev/null` also exempted (Phase 20 — no-op in the container).

- **Vacuous assertion detection (Phase 28)** — `detectVacuousAssertions()` emits
  `warning` findings for `.toBeDefined()` / `.toHaveProperty(key)` with no value.
  Wired into `_advanceTestPass`. Test report renders vacuous count in a cube.

- **Scratch filter (Phase 27)** — `SCRATCH_FILE_RE` is `/(?:debug|scratch)(?![a-zA-Z0-9])/i`.

- **Finding identity is composite (featureId, specRev, id)** — Model-assigned ids
  (`f1`, `f2`) recur across cycles. A plain `where: { id }` on findings is always a bug.

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
| 27 | The scratch filter excludes only scratch | `bbfef4b` | 2026-09-03 |
| 28 | Acceptance tests are read-only to the dev agent | `c2e9fae` | 2026-09-03 |
| 29 | Open questions are structured blockers answered at the gate | `aa04bb3` | 2026-09-05 |
| 30 | Cover what Phase 29 shipped | `848f40b` | 2026-09-05 |
| 31 | Test report cubes and brand mark | `41a8e1d` | 2026-09-06 |
| 32 | Artifact tabs are copyable | pending | 2026-09-06 |

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
- A feature where acceptance tests are red at dev-agent start ends with the same
  assertions it began with.
- A feature whose spec has an unanswered question is demonstrably unapprovable.
- A test report with eight vacuous findings shows `8` in the vacuous cube.
