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
  - `vacuousAssertions.ts` — `detectVacuousAssertions`; detects vacuous, sole-assertion-vacuous, unguarded-forEach
  - `harnessbrief.ts` — `loadHarnessBrief`, `injectHarnessBriefHashes`, `checkHarnessBriefFreshness`
  - `repoOrientation.ts` — `generateRepoOrientation()`, includes vendored-package + API-spec sections
  - `nonProgressError.ts` — `NonProgressError` class + `checkNonProgress()` helper
  - `bedrockPark.ts` — `parkTaskOnBedrockFailure`, `isEnvironmentalBedrockError`
  - `testOutputSummary.ts` — `summarizeBashTestRun`, `toJsonReporterCommand`, `extractProbeFlags`, `extractConsoleOutput`
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

- **Current phase:** 53 — A guard and its override must read the same state
- **State:** `complete`
- **Last updated:** 2026-09-17

---

## Current phase progress

*Phase 53 complete. Next: Phase 54 — A retry starts warmer than the attempt before it.*

Tasks 167–171 (see plan.md lines 2040–2071).

---

## Guard/release audit (Phase 53 deliverable)

All park reasons in the orchestrator, their guards, and whether the release path
clears the state the guard reads.

| Park reason | Guard reads | Release route | Clears guard state? |
|---|---|---|---|
| `spend_limit` | `usage.recorded` event count since last `gate.resolved` anchor | `POST /features/:id/spend-gate` (appends `gate.resolved`) | **YES** — after Phase 53 fix; anchor advances the count window |
| `bedrock_unreachable` | connectivity at job run time | REDISPATCH (reset status; job re-runs) | YES — guard re-evaluates on next job |
| `failure` | prior agent outcome (non-environmental) | REDISPATCH (`attemptCount` reset) | YES — fresh attempt |
| `non_progress` | recent writes to worktree in current run | REDISPATCH | YES — next job starts fresh |
| `allowlist_violation` | allowlist at job run time | REDISPATCH | YES — guard re-evaluates |
| `self_authored_subjects` | imported subjects vs staged set | REDISPATCH | YES — next run has a different staged set |
| `orphan` | heartbeat absence | auto-resumed at startup (`startupResume.ts`) | YES — auto-cleared to `pending` |
| `orphan_cap` | orphan count ≥ 3 | REDISPATCH only (no auto) | YES — REDISPATCH resets `parkReason` |

Before Phase 53: `spend_limit` was the only park reason whose release path never
updated the state the guard reads. RESUME appended `gate.resolved` but the SQL
counted all historical events, making every RESUME inert. Fixed by scoping the
`$queryRaw` to `seq > MAX(gate.resolved.seq)` for the task.

---

## Phase 52 analysis (deliverable — do not delete)

### Per-take table (world-clock-feature)

| Take | Final status | Client covered / total | Client outcomes | Server covered / total | Server outcomes | Total cost |
|------|-------------|----------------------|-----------------|----------------------|-----------------|-----------|
| 10 | DONE | 0 / 4 | all dev-completed, no coverage | 2 / 4 | both completed | $2.01 |
| 12 | IMPLEMENTING (stuck) | 2 / 6 | CountrySelector ✓ (2 attempts); ZoneResult ✗ parked | 2 / 4 | both completed | $12.23 |
| 13 | IMPLEMENTING (stuck) | 3 / 7 | Country selector ✓; Zone card ✓; Zone result ✗ parked; App shell pending | 2 / 4 | both completed | $27.03 |
| 16 | AWAITING_TEST_PLAN_APPROVAL (stuck) | 0 / 5 | all pending | 0 / 4 | all pending | $0.20 |
| 17 | DONE | 2 / 4 | Country selector ✓ (2 attempts); Result region ✓ (2 attempts) | 2 / 4 | both completed | $5.48 |
| 18 | IMPLEMENTING (stuck) | 1 / 5 started | App shell ✗ parked (60-turn cap); CountrySelector / ResultRegion pending | 2 / 3 | both completed | $1.89 |

### Four failure causes

| Cause | Status |
|-------|--------|
| **`inspect_file` host path** | **FIXED** — Phase 48 |
| **Fake-timer install order** | **FIXED** — documented in client repo's `CLAUDE.md` |
| **Tests written against stubs** | **FIXED** — Phase 51: `detectSelfAuthoredSubjects` |
| **Untestable task within budget** | **OPEN** — no fix shipped |

### Recommendation: Option C — per-repo manifest `test_coverage` flag

Add `test_coverage: "light" | "full"` (default `"full"`) to each repo entry in
`repo-manifest.yaml`. Test planner reads the flag; `light` marks all client tasks
as `covered: false`. One small phase (~2–3 tasks). Per-feature: `light` ≈ $2, `full` ≈ $5–8.

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1299 passed across 94 files**, 2026-09-17 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-17 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-17 |

---

## Decisions

- **Phase 53: spend guard counts after `gate.resolved` anchor (`164`)** —
  Scope `$queryRaw` to `seq > COALESCE(MAX(gate.resolved.seq), 0)` for the task.
  Each RESUME grants one fresh `SPEND_GUARD_MAX_TURNS` window. Zero-migration fix;
  naturally self-limiting and auditable from the event log. Chosen over adding a
  `grantedBudget` column (no schema change needed, simpler semantics).

- **Phase 53: noop result asserts zero failures before throwing (`165`)** —
  `assessNoopResult(ParsedTestOutput): 'pass'|'fail'` extracted from the noop branch.
  When `parseable && failed === 0`, the noop takes the same success path as the
  `exitCode === 0` branch. When `parseError` (unknown outcome), conservative `'fail'`.
  Consistent with `assessProbeResult` pattern in the same file.

- **Phase 53: `depAlreadyHasTests` skips test-agent dispatch (`166`)** —
  If any same-repo dependency already has `testsWritten=true`, the covered task
  routes directly to dev — the acceptance tests are already authored. Reads
  `testsWritten` column from the already-loaded `allFeatureTasks` array; no
  additional DB query. "Declared, not inferred."

- **Phase 52: recommendation = Option C (per-repo manifest `test_coverage` flag) (`164`)** —
  World-clock client coverage has failed 4× with different root causes; bank repo
  succeeds reliably. A per-repo flag isolates the two without losing coverage where
  it works.

- **Phase 51: `detectSelfAuthoredSubjects` uses `stagedSet.has()` not `fs.existsSync` (`162`)** —
  Checks whether an imported file was staged in the same run. O(1), no disk access,
  zero false positives.

- **Phase 50: REQUEST_TIMEOUT_MS = 900 000 ms (15 min) on all Anthropic stream calls (`160`)** —
  Classified as environmental in `isEnvironmentalBedrockError()` so a hung call parks
  without consuming a retry slot.

- **Phase 48: `inspect_file` passes container-relative path (`156`)** —
  `path.relative(realpathSync(worktreePath), absPath)` — `realpathSync` needed for
  macOS `/tmp` → `/private/tmp` symlink.

- **Phase 40: warning findings open `code_review` gate (`133`)** —
  Warnings-only review opens the gate; only a fully clean review passes immediately.

- **`spec_approval` gate-open (Phase 29)** — 4 open paths; 1 approve path:
  `POST /features/:id/approve`.

- **Test-file boundary + finding identity (Phases 28, core)** — `write_file`/`edit_file`
  in dev agents reject test-trailer files. Finding ids recur per cycle — lookups must
  use composite `(featureId, specRev, id)`.

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
| 41 | The loop guard counts commands | `7b8baa5` | 2026-09-07 |
| 42 | The harness brief works at all | `3b50e71` | 2026-09-07 |
| 43 | The vacuous detector earns its gate | `b9efa8f` | 2026-09-07 |
| 44 | The loop guard counts what it means to count | `f439b52` | 2026-09-07 |
| 45 | Coverage is only claimed where it can be proved | `7f2c688` | 2026-09-07 |
| 46 | An agent can see why nothing ran | `891cb40` | 2026-09-07 |
| 47 | The agent can read a value | `f0e408b` | 2026-09-08 |
| 48 | inspect_file actually runs the file | `4ba82b5` | 2026-09-09 |
| 49 | Writing nothing is a valid outcome | `8aa8dbb` | 2026-09-10 |
| 50 | A call that never returns is not a running task | `44cea4f` | 2026-09-14 |
| 51 | A test may not exercise its own stand-in | `575ef5c` | 2026-09-14 |
| 52 | Client component coverage: decide, then act | `49130d4` | 2026-09-14 |
| 53 | A guard and its override must read the same state | TBD | 2026-09-17 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run when editing the orchestrator.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
