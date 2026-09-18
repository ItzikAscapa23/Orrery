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

- **Current phase:** 57 — Test the component, not the app
- **State:** `complete`
- **Last updated:** 2026-09-18

---

## Current phase progress

*Phase 57 complete.*

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

## Phase 52 analysis (deliverable — do not delete)

Four root causes of client-coverage failures on world-clock-feature:
`inspect_file` host path (FIXED Phase 48), fake-timer install order (FIXED, documented in client repo CLAUDE.md),
tests written against stubs (FIXED Phase 51), untestable task within budget (OPEN).

**Recommendation:** Option C — per-repo manifest `test_coverage: "light" | "full"` (default `"full"`).
`light` marks all client tasks `covered: false`. One small phase (~2–3 tasks). Per-feature: light ≈ $2, full ≈ $5–8.

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1332 passed across 96 files**, 2026-09-18 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-18 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-18 |

---

## Decisions

- **Phase 57: Subject-derived render validation (`181`)** —
  `extractSubjectComponent(taskTitle)` derives the expected component name when the task title
  ends with "component" (e.g. "Zone result region component" → `ZoneResultRegion`). The derived
  name is passed as `subjectComponent` in `TestAgentContext`. `write_file` and `edit_file` handlers
  in `testAgent.ts` call `validateTestFileContent` and return `is_error: true` if the file renders
  a different PascalCase component without also rendering the subject. The check passes when the
  subject appears as any JSX element in the file (it may be wrapped in a provider/router).
  Implementation: `lib/testFileValidator.ts`; tests: `__tests__/testFileValidator.test.ts`.

- **Phase 57: Component-name-pattern audit (`181`)** —
  Searched `apps/server/src` and `apps/web/src` for heuristics that infer component or module
  names from string patterns. The only instance is `extractSubjectComponent` introduced in this
  phase. Existing code passes task titles as-is to agents and log messages; it does not infer
  component names. One related case: `testJob.ts:425` infers the test runner from CLAUDE.md
  keywords (`detectJsonCommand`), which is a runner inference, not a component inference.

- **Phase 57: Why probe instructions don't stick — 183 report** —
  Three independent causes documented before any prompt change:
  1. **Rule placement**: Console/sentinel/inspect_file rules appear in the `## Tools` tail section
     of `testAgent.ts:buildSystemPrompt` (after `## Relevant spec sections`). The agent reads the
     spec and commits to an approach before reaching these rules.
  2. **CONSOLE: absent when empty** (`testOutputSummary.ts:196`): `\nCONSOLE:\n` is only appended
     when `consoleOutput` is truthy. When `console.log` produces no output (component not
     implemented, no React fiber, vitest suppresses) the agent sees only `TESTS: N passed, N failed`
     and cannot distinguish "channel empty" from "channel unavailable."
  3. **React internals probe (`__reactProps`)**: Take-20 attempt 3 accessed `Object.keys(select)
     .find(k => k.startsWith('__reactProps'))` — React's internal fiber key. No fiber exists on
     an unimplemented component's DOM node. Every variation of this probe converges on `undefined`.
     `console.log` cannot help here either because the component produces no output.
  **Root cause**: The component did not exist. Writing tests for a subject that has no runtime
  presence cannot be done through probing — the correct approach is to write against the props
  interface declared in the spec (task 182). Rule relocation is a separate decision — recorded as
  an open question for the 183-followup task.

- **Phase 57: Stop condition for converging probe sequences — 184 report (implementation deferred)** —
  Take-20 attempt 3 bash result sizes: 327 / 363 / 365 / 363 / 363 / 328 chars — different every
  turn. Identical-output detection (Phase 33 guard) would not have fired. The Phase 55
  `lastWrittenHash` fix means any write-run cycle produces a distinct ring entry, so a probe loop
  that writes a file each cycle never trips the guard regardless of output.
  Three candidate stop conditions evaluated:
  (a) **Turn-without-authored-pass budget**: if N consecutive bash turns all show `authored: 0`
      (no authored test passing), stop. Catches take-20's shape; risks false positives on
      first-attempt authoring before any test passes. Threshold ~10–15 turns with a grace window.
  (b) **Same-file written-and-run N times without passing**: if path X is written and run N times
      with 0 passing, stop. Requires correlating write_file and bash events by path. Most precise
      for the probe-loop shape; avoids Phase 37 false positive (different commands don't collide).
      Recommended candidate.
  (c) **Probe-file detection at commit time**: if staged set contains only scratch-pattern files,
      the agent produced nothing real; fail and redispatch. Belt-and-suspenders, not a real-time
      stop.
  **Recommended**: (b). Threshold: if the same file has been write_file'd and run 5+ times in
  a session without at least one authored test passing, fire a NonProgressError. Does not interact
  with the command-hash ring buffer; passes Phase 37 invariant because it tracks
  per-file write+run cycles, not command repetition. Implementation deferred to Phase 58.

- **Phase 56: CONSOLE: is the channel for in-test values (`178–180`)** —
  `inspect_file` runs `node <file>` in a fresh process and cannot observe vitest runtime
  state (mocks, jsdom, post-render). The bash result already carries a `CONSOLE:` section
  assembled from `extractConsoleOutput` (`testOutputSummary.ts:191`). Both agents' rules
  now document this and the prohibition routes correctly: `console.log` + read `CONSOLE:`
  for in-test values; `inspect_file` for standalone file inspection. Cap kept at 2048 chars;
  truncation is now visible: `(truncated — showing last N of M chars)`.

- **Phase 55: `inspect_file` is the agent print channel (`172–174`)** —
  Already existed in `testAgent.ts` since Phase 48; added to `devAgent.ts`. Phase 56
  corrected the sentinel prohibition: prior wording named `inspect_file` as the in-test
  replacement, which was wrong. Sentinel assertions (`expect(x).toBe(999)`) are banned.

- **Phase 55: `checkNonProgress` includes `lastWrittenHash` in hash (`176`)** —
  Hash covers `fullCommand + (lastWrittenHash ?? '')`. Same command after file rewrite →
  different hash → counter doesn't fire. Phase 37 and 41 invariants preserved.

- **Phase 55: `priorAttemptDiff` extended to test agent (`177`)** —
  `testJob.ts` captures `git diff HEAD` before worktree reset. Injected as `## Prior attempt`
  section (6000 char cap). Empty on attempt 1; naturally non-empty on retry.

- **Phase 54: prior-attempt diff in memory only (`167`)** —
  `priorAttemptDiff` in `DevContext` — no DB column, no artifact file, ephemeral.

- **Phase 54: scratch-file stripping is host-side + agent rule (`168`)** —
  `devJob.ts` strips `SCRATCH_FILE_RE` after `git add -A`. Avoids widening the allowlist.

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

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run when editing the orchestrator.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
