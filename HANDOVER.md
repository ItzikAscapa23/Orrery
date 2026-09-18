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

- **Current phase:** 61 — A test agent that knows what it already wrote
- **State:** `complete`
- **Last updated:** 2026-09-18

---

## Current phase progress

Phase 61 complete. Phase 62 does not exist in `plan.md`.

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
| `npm test` (repo root) | passed — **1337 passed across 96 files**, 2026-09-18 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-18 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-18 |

---

## Decisions

- **Phase 61: test-agent suite accumulation — already wired, STOP** —
  `getExistingTestFilesWithDescribes` (which filters via `X-Orrery-Agent: test` commit trailer)
  is called in both `taskTestJob.ts:299` and `testJob.ts:715` and forwarded as `existingTestFiles`
  to `runTestAgent`. Dev-authored files are excluded because dev commits use `feat(taskId): title`
  with no `X-Orrery-Agent: test` trailer. Redundancy analysis on takes 21 and 22 found zero
  cross-file assertion overlap — each task covers a distinct API endpoint. The TESTING phase grows
  files with genuinely new cross-endpoint integration tests, not duplicates. No prompt change
  needed; task 200 deferred. Four tests added: `taskTestJob.test.ts` and `testJob.test.ts` each
  verify that (a) `existingTestFiles` is forwarded when prior tests have describe blocks, and
  (b) it is omitted when no prior tests exist. Existing `getAuthoredTestFiles.test.ts:19` covers
  the trailer-filter exclusion.

- **Phase 61 redundancy table (takes 21 and 22):**

  | Feature | Repo | File | Size (task-test) | it() | TESTING growth | Cross-file overlap |
  |---|---|---|---|---|---|---|
  | take-22 | server | `countries.acceptance.test.ts` | 3 821 chars | 9 | +2 589 chars / +3 | 0 |
  | take-22 | server | `time.acceptance.test.ts` | 10 692 chars | 26 | +4 681 chars / +8 | 0 |
  | take-22 | web | `CountrySelector.test.tsx` | 8 441 chars | — | none | — |
  | take-22 | web | `ResultRegion.test.tsx` | 14 321 chars | — | none | — |
  | take-21 | server | `countries.test.ts` | 4 722 chars | 11 | +2 090 chars / +3 | 0 |
  | take-21 | server | `time.test.ts` | 14 407 chars | 33 | +3 724 chars / +7 | 0 |

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

- **Phase 57: Probe-loop stop condition — unimplemented** —
  Recommended: fire `NonProgressError` if the same file is `write_file`'d and run 5+
  times without an authored test passing. No phase in `plan.md` covers this.

- **Phase 56: CONSOLE: is the sole channel for in-test values** —
  `extractConsoleOutput` delivers up to 2048 chars of console output in the CONSOLE:
  section of every bash result. A fresh process (node) cannot observe vitest runtime
  state. Truncation is visible in the output prefix.

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

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run when editing the orchestrator.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
