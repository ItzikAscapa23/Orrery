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

- **Current phase:** 58 — The planner declares the subject
- **State:** `complete`
- **Last updated:** 2026-09-18

---

## Current phase progress

*Phase 58 complete. Phase 58 is the final phase in plan.md — no Phase 59 exists.*

---

## Output-path audit (Phase 55–56 deliverable)

| Path | Mechanism | Cap | Truncation visible? |
|---|---|---|---|
| Test run summary | `formatTestSummary` via `summarizeBashTestRun` | 4000 chars / 200 chars (4+ failures) | Yes — `FAILURES:` section |
| Console in test run | `extractConsoleOutput` → `CONSOLE:` section | 2048 chars | **Yes** — `(truncated — showing last N of M chars)` prefix (Phase 56 fix) |
| `inspect_file` result | `truncateOutput` | 8 KB / 200 lines | Yes — `(truncated…)` prefix |
| Bash non-test result | `truncateOutput` | 8 KB / 200 lines | Yes — `(truncated…)` prefix |
| `agent.log` event | `resultFirstLine` | 120 chars | No — **correct**: DB display column, not agent context |
| `test.report` findings | `parseTestOutput` → DB | 300 chars per message | No — **correct**: DB bounds; agent sees full content at reasoning time |
| Host-side exec diagnostic | partial stderr | 300 chars | No — borderline: human-debug path only; flag for future improvement |

---

## Guard/release audit (Phase 53 deliverable)

| Park reason | Guard reads | Release route | Clears guard state? |
|---|---|---|---|
| `spend_limit` | `usage.recorded` events since last `gate.resolved` anchor | `POST /features/:id/spend-gate` | YES — Phase 53 fix |
| `bedrock_unreachable` | connectivity at job run time | REDISPATCH | YES — re-evaluates on next job |
| `failure` | prior agent outcome | REDISPATCH (`attemptCount` reset) | YES — fresh attempt |
| `non_progress` | recent writes in current run | REDISPATCH | YES — next job starts fresh |
| `allowlist_violation` | allowlist at run time | REDISPATCH | YES — re-evaluates |
| `self_authored_subjects` | imported subjects vs staged set | REDISPATCH | YES — different staged set |
| `orphan` | heartbeat absence | auto-resumed at startup (`startupResume.ts`) | YES — auto-cleared |
| `orphan_cap` | orphan count ≥ 3 | REDISPATCH only | YES — resets `parkReason` |

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1330 passed across 96 files**, 2026-09-18 (−2 from Phase 57 baseline: removed tests for deleted `extractSubjectComponent` heuristic) |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-18 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-18 |

---

## Decisions

- **Phase 58: Subject is declared, not derived** —
  Phase 57 shipped `extractSubjectComponent(taskTitle)`, which PascalCased the words
  before "component" in a task title to derive the render-validation subject. This failed
  when the dev agent used a different name (e.g. "Zone result region component" →
  `ZoneResultRegion`, but agent named the file `ResultRegion.tsx`). Phase 58 adds
  `subject?: string` to `PlanTaskSchema` and the Prisma `Task` model; the planner now
  declares the component name explicitly. `extractSubjectComponent` was hard-deleted
  (no fallback, no flag). `validateTestFileContent` signature updated to accept
  `{ name: string } | undefined` — returns `null` immediately when `undefined`
  (opt-in: tasks without a subject skip render validation). Migration:
  `20260918165148_add_task_subject` — nullable column, zero data loss.

- **Phase 57: Stop condition for converging probe sequences — 184 report (unimplemented)** —
  Take-20 attempt 3 ran a probe loop that never tripped the Phase 33/41 non-progress
  guard. Recommended stop condition: if the same file is `write_file`'d and run 5+
  times without an authored test passing, fire `NonProgressError`. Was annotated
  "deferred to Phase 58" but Phase 58 covered the subject-field change. No later phase
  in `plan.md` covers this — it remains unimplemented.

- **Phase 57: Why probe instructions don't stick — 183 report** —
  Three root causes: (1) rule placement — probe rules appear after `## Relevant spec
  sections` in `testAgent.ts:buildSystemPrompt`, so the agent commits to an approach
  before reading them; (2) `CONSOLE:` absent when empty (`testOutputSummary.ts:196`);
  (3) React `__reactProps` probe returns undefined when the component is unimplemented.
  Root cause: the component did not exist. Writing tests for an absent subject requires
  spec-driven props, not probing. Rule relocation is a separate open decision.

- **Phase 56: CONSOLE: is the channel for in-test values (`178–180`)** —
  `inspect_file` runs `node <file>` in a fresh process and cannot observe vitest runtime
  state. `CONSOLE:` section (from `extractConsoleOutput`, 2048-char cap) is the correct
  channel. Both agents' rules document this; truncation now visible.

- **Phase 55: `checkNonProgress` includes `lastWrittenHash` in hash (`176`)** —
  Same command after file rewrite → different hash → counter doesn't fire.
  Phase 37 and 41 invariants preserved.

- **Phase 53: spend guard counts after `gate.resolved` anchor (`164`)** —
  `$queryRaw` scoped to `seq > COALESCE(MAX(gate.resolved.seq), 0)`. Zero-migration.

- **Phase 53: `depAlreadyHasTests` skips test-agent dispatch (`166`)** —
  Same-repo dependency with `testsWritten=true` → covered task routes directly to dev.

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
| 58 | The planner declares the subject | (pending) | 2026-09-18 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run when editing the orchestrator.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
