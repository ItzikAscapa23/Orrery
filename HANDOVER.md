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
  - `vacuousAssertions.ts` — `detectVacuousAssertions` (warning + blocker findings)
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

- **Current phase:** 63 — A warning you approve in 35 seconds is not a gate
- **State:** `complete`
- **Last updated:** 2026-10-01

---

## Current phase progress

Phase 63 complete. The next phase is **plan.md Phase 63** (not yet written).

---

## Error-classification audit (complete after Phase 60)

| Code / condition | Environmental? | Consumes retry? | Can terminate final? |
|---|---|---|---|
| 403 expired STS | YES — `status === 403` | No | No |
| network / unreachable | YES — `'bedrock unreachable'` prefix | No | No |
| timeout | YES — `'request timed out'` prefix | No | No |
| 503 proxy block | YES — `status === 503 && 'file blocked'` | No | No |
| 429 rate limit | YES — `status === 429` (Phase 60) | No | No |
| 5xx Bedrock outage | YES — `status >= 500` (Phase 60) | No | No |
| 401 invalid key | No | Yes | Yes (if max attempts) |
| 400 bad request | No — agent-caused | Yes | Yes |
| 404 wrong model | No — operator config error | Yes | Yes |
| 422 bad body | No — agent-caused | Yes | Yes |

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1345 passed across 96 files**, 2026-10-01 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-10-01 |
| `npm run lint` | exit 0 — 0 problems, 2026-10-01 |

---

## Decisions

- **Phase 63: Vacuous detector precision — take-25 before/after** —
  Ran detector against `test/scenarios/cardAction/orderCardClubsListStrongIdentification.test.js`
  at commit `d2fcf581d` in `/Users/itzhak/aws-workspace/bff`.

  **Before (14 findings, all warnings):**
  - vacuous assertions (9): lines 148, 166, 177, 192, 213, 280, 281, 891, 1004
  - sole-assertion-vacuous (4): lines 171, 180, 195, 871
  - unguarded-forEach (1): line 212

  **After (6 findings — 2 blockers + 4 warnings):**
  - warnings (4): lines 148 `toHaveProperty('token')`, 166 `toHaveProperty('token')`,
    891 `toBeDefined()` (sole assertion, also drives finding below), 1004 `toHaveProperty('creditLimit')`
  - blockers (2): line 871 `sole-assertion-vacuous` ("client-version gate" test sole assertion),
    line 212 `unguarded-forEach` (`allClubs.forEach(...)`)
  - Lines 891 AND 871 are BOTH present: 891 as warning from PATTERNS, 871 as blocker
    from `detectSoleAssertionVacuous`. This pair is the one that caught the AC-10 defect.

  **False positives eliminated (8):**
  - Lines 177, 192, 213: `.not.toHaveProperty()` exemption (negative assertion is meaningful)
  - Lines 280, 281: subject-matching lookback — `falseUrl` and `trueUrl` assigned by `.find()`
    4 lines above; `expect(result).toBeDefined()` elsewhere is NOT exempt
  - Lines 171, 180, 195: sole-assertion-vacuous entries driven by `.not.toHaveProperty`
    false positives; once those assertions are exempt, the tests are no longer sole-vacuous

- **Phase 63: Gate consequence of sole-assertion-vacuous blocker** —
  After this phase, a finding with `severity: 'blocker'` and `resolution: null` from
  `detectSoleAssertionVacuous` or `detectUnguardedForEach`/`detectUnguardedForOf` blocks
  `POST /approve-test` until the operator dismisses it via `/findings/:id/dismiss`. This is
  the intended behaviour: vacuous blockers require explicit operator sign-off, not just a click
  through. Test case G (`testJob.test.ts`) documents this gate consequence explicitly with
  `section: 'sole-assertion-vacuous'`. Previously `testJob.ts:1226` hardcoded `blockers: 0`
  in the gate event — now computed from actual finding severities.

- **Phase 63: subject-matching for toBeDefined accessor exemption** —
  The original exemptCheck (one-line lookback) missed lines 280/281 in take-25 where `.find()`
  assigns `falseUrl`/`trueUrl` 4 lines above the `expect()`. A wide 5-line any-accessor window
  was rejected because it would accidentally exempt `expect(result).toBeDefined()` at line 891
  (the real finding). Subject-matching extracts the identifier from `expect(IDENTIFIER)` and
  looks back up to 5 lines for a line where BOTH that identifier is assigned AND an accessor
  appears — identifier-specific, not window-based.

- **Phase 63: scripts/demo-*/CLAUDE.md deleted** —
  Both `scripts/demo-client/CLAUDE.md` and `scripts/demo-server/CLAUDE.md` were dead templates
  never read by any orchestrator code path. `readClaudeMdFromDefaultBranch` reads
  `git show main:CLAUDE.md` from the bare clone of the TARGET repo, not from scripts/.
  The live files are at `/Users/itzhak/myProjects/Orrery-{client,server}-demo/CLAUDE.md`
  and are served to agents via the bare clone fetch. Both updated and pushed:
  - Orrery-client-demo: `5715d47`
  - Orrery-server-demo: `45155a3`

- **Phase 63: for...of detection added** —
  `detectUnguardedForEach` now also detects `for (const x of collection)` loops using
  `/for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+\w+/g`. Same 10-line guard lookback,
  same `FOREACH_GUARD_RE`, section `'unguarded-for-of'`, severity `'blocker'`.
  `testJob.ts` gate summary and counts updated.

- **Phase 62: Plan Phases 8 and 9 — noop-success for already-implemented items** —
  See previous HANDOVER entry (commit `95fc54b`).

- **Phase 61: test-agent suite accumulation — already wired, STOP** —
  See previous HANDOVER entry (commit `19b9e2e`).

- **Phase 60: `inspect_file` removed, not fixed** —
  Take-21 and take-22 never reached for `inspect_file`; every probe used `bash node <file>`.
  Root cause: `bash` accepts flags (`--import tsx/esm`, `--input-type=module`) that `inspect_file`
  does not. Removal beats fighting the current. Phase 55 sentinel rule rewritten to name CONSOLE:
  instead. If an agent calls `inspect_file`, the response is `Unknown tool: inspect_file`.

- **Phase 60: 429 and 5xx classified environmental via status field** —
  Added `status === 429` and `status !== undefined && status >= 500` to
  `isEnvironmentalBedrockError` (`lib/bedrockPark.ts`). Both park without consuming a retry slot;
  `final: false`.

- **Phase 59: 403 detection uses `.status` property, not text** —
  Mid-stream 403s bypass `rethrowIfExpiredToken` and arrive as raw `APIError` objects
  with `.status === 403`. Text checks match prose; `.status` is the canonical signal.

- **Phase 58: Subject is declared, not derived** —
  `subject?: string` on `PlanTaskSchema` and the `Task` model. Planner declares the
  component name explicitly. `extractSubjectComponent` was hard-deleted. Tasks without
  a subject skip render validation.

---

## Assumptions

- `apps/web/.env.local` setting `VITE_PRODUCT_NAME=PepperOrchestrator` is a
  deliberate local brand override. The fallback `'Orrery'` stays.
- When multiple repos in a feature declare different `review_charter` paths,
  first-charter-found semantics applies (first repo in `feature.repos` wins).

---

## Open questions / blockers

- **R-7 test.report vocabulary (deferred).** `TestFinding` shares `severity: 'blocker'`
  with review findings and is stored in the same `finding` table. The dismiss route can
  act on either type. The specRev separation (CODE_REVIEW vs TESTING) prevents practical
  cross-gate dismissal, but the semantic confusion is real. Fix: add `source: 'review' | 'test'`
  column to `findings` table and guard the dismiss route. Requires a Prisma migration.

- **Task 196 — REDISPATCH banner clearing not observed.** Phase 54 task 170 and
  Phase 59 task 192 changed banner behaviour; neither was seen clearing on a real
  park (take-21 and take-22 completed with zero parks). The 429/5xx fix in Phase 60
  makes parks reproducible — verify on the next park and record here.

---

## PRD conflicts

- none

---

## Phase log

| Phase | Title | Commit | Date |
|---|---|---|---|
| 0–6 | Spec agent through cost instrumentation | squashed into `54bdf20` | pre-2026-08 |
| 7–11 | Spend, efficiency, backlog, spec, lint | `4a16025`–`f0769a5` | 2026-08-21 |
| 12–18 | Dispatch identity, recovery, gate, UI, backlog | `6d8ef86`–`78ff9ee` | 2026-08-29 |
| 19–21 | Config, violations, operator neutrality | `716a783`–pending | 2026-08-31 |
| 22–28 | Recovery, config, test-agent cost, acceptance read-only | `593dc75`–`c2e9fae` | 2026-09-01–03 |
| 29–35 | Structured blockers, UI, non-progress stop, allowlist | `aa04bb3`–`c208689` | 2026-09-05–06 |
| 36–46 | Test trust, loop guards, orientation, harness brief | `260a95a`–`891cb40` | 2026-09-06–07 |
| 47 | The agent can read a value | `f0e408b` | 2026-09-08 |
| 48 | inspect_file actually runs the file | `4ba82b5` | 2026-09-09 |
| 49 | Writing nothing is a valid outcome | `8aa8dbb` | 2026-09-10 |
| 50 | A call that never returns is not a running task | `44cea4f` | 2026-09-14 |
| 51 | A test may not exercise its own stand-in | `575ef5c` | 2026-09-14 |
| 52 | Client component coverage: decide, then act | `49130d4` | 2026-09-14 |
| 53 | A guard and its override must read the same state | `a70e02f` | 2026-09-17 |
| 54 | A retry starts warmer than the attempt before it | `d63e5b8` | 2026-09-17 |
| 55 | The agent can ask a question | `d67bd7b` | 2026-09-18 |
| 56 | Name the channel that works | `04f2d1b` | 2026-09-18 |
| 57 | Test the component, not the app | `562da3b` | 2026-09-18 |
| 58 | The planner declares the subject | `aa90c50` | 2026-09-18 |
| 59 | An expired credential is weather, not a verdict | `7d36ffb` | 2026-09-18 |
| 60 | A channel nothing uses is not a channel | `3857634` | 2026-09-18 |
| 61 | A test agent that knows what it already wrote | `19b9e2e` | 2026-09-18 |
| 62 | Plan Phases 8 + 9 sweep | `95fc54b` | 2026-10-01 |
| 63 | A warning you approve in 35 seconds is not a gate | pending | 2026-10-01 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run when editing the orchestrator.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
