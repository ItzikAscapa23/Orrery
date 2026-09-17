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
  - `nonProgressError.ts` — `NonProgressError` class + `checkNonProgress()` helper
  - `testOutputSummary.ts` — `summarizeBashTestRun`, `extractConsoleOutput`
  - `repoOrientation.ts` — `generateRepoOrientation()`
  - `bedrockPark.ts` — `parkTaskOnBedrockFailure`, `isEnvironmentalBedrockError`
- `apps/server/src/jobs/` — devJob, testJob, taskTestJob, createAdoPrJob, agentWorker
- `apps/server/src/agents/` — devAgent, testAgent, plannerAgent, testPlannerAgent
- `apps/web/src/lib/eventFold.ts` — all UI state derived from folding the event log
- `packages/shared/` — event payload schemas; `docs/agents/repo-manifest.yaml` — operator config

**Conventions:**
- No default exports. Zod for all external input. No `any` without a comment.
- Commit format `feat|fix|chore(scope): description`.
- Every Anthropic call goes through `lib/anthropic.ts`.
- One task = one brief. Briefs carry evidence, numbered requirements, fail-first tests, acceptance block.
- **Backlog entries in `docs/phase-6.md` are deleted on close, not annotated.**

---

## Status

- **Current phase:** 55 — The agent can ask a question
- **State:** `complete`
- **Last updated:** 2026-09-18

---

## Current phase progress

*Phase 55 complete. Awaiting Phase 56 spec.*

---

## Output-path audit (Phase 55 deliverable)

| Path | Mechanism | Cap | Truncation visible? |
|---|---|---|---|
| Test run summary | `formatTestSummary` via `summarizeBashTestRun` | 4000 chars / 200 chars (4+ failures); `parseTestOutput` pre-caps stored msgs at 300 chars | Yes — `FAILURES:` section |
| Console in test run | `extractConsoleOutput` → `CONSOLE:` section | 2048 chars | Silent tail, no notice |
| `inspect_file` result | `truncateOutput` | 8 KB / 200 lines | Yes — `(truncated…)` prefix |
| Bash non-test result | `truncateOutput` | 8 KB / 200 lines | Yes — `(truncated…)` prefix |
| `agent.log` event | `resultFirstLine` | 120 chars | No — first line only |
| `test.report` findings | `parseTestOutput` → DB | 300 chars per message | No — stored truncated |
| Host-side exec diagnostic | partial stderr | 300 chars | No |

Notable gap: full tool-result bodies never reach the DB — only `resultFirstLine` (120 chars) is persisted in `agent.log` events.

---

## Guard/release audit (Phase 53 deliverable)

| Park reason | Guard reads | Release route | Clears guard state? |
|---|---|---|---|
| `spend_limit` | `usage.recorded` events since last `gate.resolved` anchor | `POST /features/:id/spend-gate` | **YES** — Phase 53 fix |
| `bedrock_unreachable` | connectivity at job run time | REDISPATCH | YES — re-evaluates on next job |
| `failure` | prior agent outcome | REDISPATCH (`attemptCount` reset) | YES — fresh attempt |
| `non_progress` | recent writes in current run | REDISPATCH | YES — next job starts fresh |
| `allowlist_violation` | allowlist at run time | REDISPATCH | YES — re-evaluates |
| `self_authored_subjects` | imported subjects vs staged set | REDISPATCH | YES — different staged set |
| `orphan` | heartbeat absence | auto-resumed at startup (`startupResume.ts`) | YES — auto-cleared |
| `orphan_cap` | orphan count ≥ 3 | REDISPATCH only | YES — resets `parkReason` |

---

## Phase 52 analysis (deliverable — do not delete)

### Per-take table (world-clock-feature)

| Take | Final status | Client covered / total | Server covered / total | Total cost |
|------|-------------|----------------------|----------------------|-----------|
| 10 | DONE | 0 / 4 | 2 / 4 | $2.01 |
| 12 | IMPLEMENTING (stuck) | 2 / 6 | 2 / 4 | $12.23 |
| 13 | IMPLEMENTING (stuck) | 3 / 7 | 2 / 4 | $27.03 |
| 16 | AWAITING_TEST_PLAN_APPROVAL (stuck) | 0 / 5 | 0 / 4 | $0.20 |
| 17 | DONE | 2 / 4 | 2 / 4 | $5.48 |
| 18 | IMPLEMENTING (stuck) | 1 / 5 started | 2 / 3 | $1.89 |

### Four failure causes

| Cause | Status |
|-------|--------|
| `inspect_file` host path | FIXED — Phase 48 |
| Fake-timer install order | FIXED — documented in client repo's `CLAUDE.md` |
| Tests written against stubs | FIXED — Phase 51 |
| Untestable task within budget | OPEN — no fix shipped |

### Recommendation: Option C — per-repo manifest `test_coverage` flag

Add `test_coverage: "light" | "full"` (default `"full"`) to each repo entry in
`repo-manifest.yaml`. Test planner reads the flag; `light` marks all client tasks
as `covered: false`. One small phase (~2–3 tasks). Per-feature: `light` ≈ $2, `full` ≈ $5–8.

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1314 passed across 95 files**, 2026-09-18 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-18 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-18 |

---

## Decisions

- **Phase 55: `inspect_file` is the agent print channel (`172–174`)** —
  Already existed in `testAgent.ts` since Phase 48; added identical implementation
  to `devAgent.ts`. Chose over console passthrough (test-run-only, 2048-char cap,
  unreachable from dev agent). Sentinel assertions (`expect(x).toBe(999)`) are now
  prohibited in rules blocks of both agents; `inspect_file` with `console.log` is
  the sanctioned channel.

- **Phase 55: `checkNonProgress` includes `lastWrittenHash` in hash (`176`)** —
  Hash now covers `fullCommand + (lastWrittenHash ?? '')`. Same command after
  file rewrite → different hash → counter doesn't fire. Same command, unchanged
  file → same hash → fires after N (Phase 41 invariant preserved). Phase 37 invariant
  (distinct commands same output) unaffected. `lastWrittenHash` is tracked in both
  dev and test agent loops after each `write_file`/`edit_file` success.

- **Phase 55: `priorAttemptDiff` extended to test agent (`177`)** —
  `testJob.ts` captures `git diff HEAD` before worktree reset on every attempt
  (empty string → `undefined` on a fresh worktree). Passed through `TestAgentContext`.
  Injected identically to `devAgent.ts` as a `## Prior attempt` section capped at
  6000 chars. No `attempt` counter needed — the diff is naturally empty on attempt 1.

- **Phase 54: prior-attempt diff in memory only (`167`)** —
  `priorAttemptDiff` in `DevContext` — no DB column, no artifact file, ephemeral.

- **Phase 54: scratch-file stripping is host-side + agent rule (`168`)** —
  `devJob.ts` strips `SCRATCH_FILE_RE` files after `git add -A`. Chosen over
  allowlist change to avoid widening the security boundary.

- **Phase 54: `git rev-parse` validity check in `createWorktree` (`169`)** —
  `--git-dir` for bare repo, `--is-inside-work-tree` for worktree; on failure `rmSync` + recreate.

- **Phase 54: `showRedispatch` checks `parked` only, not `running` (`170`)** —
  Orphaned running tasks are auto-recovered; banner clears on REDISPATCH.

- **Phase 53: spend guard counts after `gate.resolved` anchor (`164`)** —
  `$queryRaw` scoped to `seq > COALESCE(MAX(gate.resolved.seq), 0)`. Zero-migration.

- **Phase 53: `depAlreadyHasTests` skips test-agent dispatch (`166`)** —
  If any same-repo dependency has `testsWritten=true`, covered task routes directly to dev.

- **Phase 52: recommendation = Option C (per-repo manifest `test_coverage` flag)** —
  World-clock client coverage failed 4× with different root causes.

- **Phase 51: `detectSelfAuthoredSubjects` uses `stagedSet.has()` (`162`)** —
  O(1), no disk access, zero false positives on imported subject detection.

- **Test-file boundary + finding identity (Phases 28, core)** —
  `write_file`/`edit_file` in dev agents reject test-trailer files. Finding ids recur
  per cycle — lookups must use composite `(featureId, specRev, id)`.

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
| 53 | A guard and its override must read the same state | `a70e02f` | 2026-09-17 |
| 54 | A retry starts warmer than the attempt before it | `d63e5b8` | 2026-09-17 |
| 55 | The agent can ask a question | `d67bd7b` | 2026-09-18 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run when editing the orchestrator.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
