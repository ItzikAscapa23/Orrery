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

- **Current phase:** 38 — Orientation stops being the largest cost
- **State:** `complete`
- **Last updated:** 2026-09-06

---

## Current phase progress

*Next phase not yet defined in plan.md — no tasks to list.*

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1225 passed across 92 files**, 2026-09-06 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-06 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-06 |

---

## Decisions

- **Phase 38: turn-split measurement reference** —
  Feature `00d548a1`: 132 turns → 58 orientation (44%), 18 authoring (14%), 23
  verification (17%), 31 waste (24%). orientationBlock was 28.7k chars. Per-turn cost
  ≈ $0.037; cache reads were 39% of $4.83 total. Broader sample requires querying
  `agent_event` where tool calls are `read_file`/`find`/`grep` on repo-structure files.

- **Phase 38: `generateRepoOrientation` adds vendored-package and API-spec sections (`127`)** —
  Two new optional sections appended after tsconfig. (a) **Vendored packages** — scans
  `node_modules/` at depth > 0 (top-level excluded), lists packages with exported names
  via regex (CJS `module.exports.name =`, ESM `export function/const/class`, named
  `export { ... }`); capped at 30 symbols/package, 10 packages/vendor-dir, depth ≤ 6.
  (b) **API spec files** — scans dirs named `openapis`/`openapi`/`api-specs`/`api-spec`,
  lists `.json`/`.yaml`/`.yml`; depth ≤ 5. Both omitted when empty, so non-bff repos
  are unaffected. Generic detection chosen over BFF-specific to keep the function
  repo-agnostic.

- **Phase 38: size cost of new orientation sections** —
  On repos without vendored layers or openapis dirs: zero increase. For the bff repo:
  ~700 chars / ~175 tokens estimated. Cost increase ≈ $0.069/feature; saves ~16
  re-discovery turns × $0.037 ≈ $0.59/feature. Net ≈ +$0.52/feature.

- **Phase 38: dev-job harness brief is feasible, deferred (`128`)** —
  The `harnessbrief.ts` pattern can carry discovered symbols between dev jobs:
  `__orrery_dev_brief.md` written by first dev job, committed as `dev-symbol-brief.md`,
  loaded by subsequent jobs via a new `loadDevSymbolBrief` — same freshness-check
  mechanism. No separate artifact type needed. Implementation deferred to a later phase.

- **Phase 38: `npm test` guidance added to dev and test agents (`129`)** —
  `toJsonReporterCommand` rewrites `npm test` to `npx vitest run` (else-branch,
  `testOutputSummary.ts:55`); on a jest repo that fails → raw output. Agents wasted a
  turn per job discovering this empirically. Guidance added at three sites in
  `devAgent.ts` and once in `testAgent.ts`: "use `npx jest` / `npx vitest run` directly."

- **Phase 37: `toJsonReporterCommand` reuses `extractProbeFlags` for agent args (`124`)** —
  `extractPositionalArgs` dropped every `--flag` token; replaced with `extractProbeFlags`
  which strips only the three reporter flags the rewrite injects. Filtered runs now filter.

- **Phase 37: `blocked_by_protected_test` AgentOutcome (`125`)** — `REPORT_BLOCKED_TOOL`
  added to `devAgent.ts`. `runDevAgent` returns `{ kind: 'blocked_by_protected_test', ... }`.
  `devJob.ts` parks with `parkReason: 'blocked_by_protected_test'` and `final: false`.

- **Phase 37: `runReviewAgent` returns `{ findings, priorFindingStatuses }` (`126`)** —
  On `priorReviewRounds >= 1`, DB queried for prior findings before `persistFindings`
  overwrites them (specRev is stable between review rounds). Prior findings injected as
  checklist; statuses logged as muted `agent.log` after review.

- **Phase 36: `summarizeBashTestRun` returns `TestRunSummary`; vacuous findings gate (`120`, `122`)** —
  Returns `{ summary, resolvedCommand, reportPath }`; event log records resolved command + path.
  `_advanceTestPass` opens `test_report` gate when warnings > 0 instead of transitioning to TEST_PASS.

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
| 38 | Orientation stops being the largest cost | pending | 2026-09-06 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run when editing the orchestrator.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
- Orientation turns below 44% on the next real feature (plan.md phase 38 exit criterion).
