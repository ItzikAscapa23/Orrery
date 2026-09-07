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
  - `repoOrientation.ts` — `generateRepoOrientation()`, includes vendored-package + API-spec sections
  - `nonProgressError.ts` — `NonProgressError` class + `checkNonProgress()` helper
  - `bedrockPark.ts` — `parkTaskOnBedrockFailure`, `isEnvironmentalBedrockError`
  - `testOutputSummary.ts` — `summarizeBashTestRun`, `toJsonReporterCommand`, `extractProbeFlags`
- `apps/server/src/jobs/` — devJob, testJob, taskTestJob, createAdoPrJob, agentWorker
- `apps/server/src/agents/` — devAgent, testAgent, plannerAgent, testPlannerAgent
- `apps/web/src/lib/eventFold.ts` — all UI state derived from folding the event log
- `packages/shared/` — event payload schemas; `docs/agents/repo-manifest.yaml` — operator config
- `scripts/orientation-probe.ts` — measure orientation block size for a given repo path

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

- **Current phase:** 41 — The loop guard counts commands
- **State:** `complete`
- **Last updated:** 2026-09-07

---

## Current phase progress

- [x] `134-count-commands-not-results` — `checkNonProgress` hashes only the command string; repeated invocations with varying output now accumulate
- [x] `135-green-does-not-disarm` — unconditional buffer-clear on passing results removed; green results no longer disarm the guard
- [x] Tests updated: new cases for varying-output fire and green-no-longer-clears; Phase 37 invariant retained

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1231 passed across 92 files**, 2026-09-07 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-07 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-07 |

---

## Decisions

- **Phase 41: command-only hashing (`134`, `135`)** —
  `checkNonProgress` now hashes only `command`, not `{command, results}`.
  A repeated command accumulates in the ring buffer regardless of output variation;
  20 identical command invocations fire the guard even if every result is different.
  The Phase 37 invariant (three distinct commands with identical output do not fire)
  is preserved because distinct command strings still produce distinct hashes.
  The Phase 34 green-clears rule is removed: it was added to prevent false positives
  from distinct commands with identical output — command-only hashing already prevents
  that, so the rule was both redundant and harmful (it permanently disarmed the guard
  against passing scratch-file loops).

- **Phase 40: warning findings open `code_review` gate (`133`)** —
  `reviewJob.ts` now branches on both `blockers` and `warnings`.
  A clean review (`blockers === 0 && warnings === 0`) passes immediately.
  A warnings-only review (`blockers === 0 && warnings > 0`) opens the
  `code_review` gate so every warning gets a recorded decision before advancing.
  `featureReviewGate.ts` `POST /approve-review` and `featureFindings.ts`
  auto-advance now check `severity: { in: ['blocker', 'warning'] }` for
  CODE_REVIEW; TESTING still checks `severity: 'blocker'` only.
  `persistFindings.ts` emits `finding.resolved(fixed)` for orphaned findings
  before deleting them, completing the dismissed/fixed/never-reviewed trail.
  Routing rule defined once in `reviewJob.ts`; both guard sites cite the same
  severity set.

- **Phase 39: edit-run loop fix (`130`)** —
  `checkNonProgress` skips write_file/edit_file turns entirely (no buffer entry,
  no clear). Only bash/read results are tracked. Write→bash→write→bash loops with
  an identical bash result fire after N bash hashes accumulate. The old
  `hadWriteOrEdit` reset was redundant: Phase 37's command-hash already prevented
  false positives from different commands returning identical summaries.

- **Phase 39: shared mock edits surfaced (`131`)** —
  New `test.shared_infra_changed` event (path, tool, repo?) emitted whenever the
  test agent writes/edits a file whose path contains `__mocks__` as a segment.

- **Phase 39: URL-map feasibility (`132`)** —
  Deferred; requires a real bff run to confirm the model uses the section.

- **Phase 38: `generateRepoOrientation` adds vendored-package and API-spec sections (`127`)** —
  Two new optional sections after tsconfig; zero cost on non-bff repos.

- **`spec_approval` gate-open (Phase 29)** — 4 open paths: `awsReviewJob.ts` after review,
  `specSubmit.ts` no-charter fast-path, `awsReviewJob.ts` error final-attempt, missing-charter
  guard. 1 approve path: `POST /features/:id/approve`.

- **Test-file boundary + finding identity (Phases 28, core)** — `write_file`/`edit_file` in
  dev agents call `getTestAuthoredSet` at startup and reject test-trailer files. Finding ids
  (`f1`, `f2`) recur per cycle — lookups must use composite `(featureId, specRev, id)`.

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
| 32 | Artifact tabs are copyable | `85592bf` | 2026-09-06 |
| 33 | An agent that is not progressing stops | `4273e44` | 2026-09-06 |
| 34 | Verification means what it says | `72bc51e` | 2026-09-06 |
| 35 | The orchestrator is not bound by the agent's allowlist | `c208689` | 2026-09-06 |
| 36 | Test output can be trusted | `260a95a` | 2026-09-06 |
| 37 | Agents keep their flags, and blockers do not vanish quietly | `ccbecaa` | 2026-09-06 |
| 38 | Orientation stops being the largest cost | `1948302` | 2026-09-06 |
| 39 | A write does not excuse a loop | `178d109` | 2026-09-06 |
| 40 | A correct finding has an effect | `937dba6` | 2026-09-07 |
| 41 | The loop guard counts commands | pending | 2026-09-07 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run when editing the orchestrator.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
- A test agent completes within its turn cap on the bff repo (plan.md phase 39 exit criterion).
