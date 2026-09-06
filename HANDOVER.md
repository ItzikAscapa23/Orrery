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
- `apps/server/src/lib/nonProgressError.ts` — `NonProgressError` class + `checkNonProgress()` helper
- `apps/server/src/lib/bedrockPark.ts` — `parkTaskOnBedrockFailure`, `parkFeatureAgentOnBedrockFailure`, `isEnvironmentalBedrockError`
- `apps/server/src/lib/testOutputSummary.ts` — `summarizeBashTestRun`, `toJsonReporterCommand`, `extractProbeFlags`
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

- **Current phase:** 37 — Agents keep their flags, and blockers do not vanish quietly
- **State:** `complete`
- **Last updated:** 2026-09-06

---

## Current phase progress

- [x] 124-preserve-agent-flags
- [x] 125-blocked-by-protected-test
- [x] 126-re-review-checks-prior-findings

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1215 passed across 92 files**, 2026-09-06 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-06 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-06 |

---

## Decisions

- **Phase 37: `toJsonReporterCommand` reuses `extractProbeFlags` for agent args (`124`)** —
  `extractPositionalArgs` dropped every `--flag` token, so an agent running
  `npx jest --testPathPattern=auth` silently executed the full suite. Fix: replace
  `extractPositionalArgs(trimmed, 'npx jest')` with `extractProbeFlags(trimmed)`, which
  strips only the three reporter flags the rewrite injects (`--json`, `--outputFile=`,
  `--reporter=`) and preserves everything else. The unused `extractPositionalArgs` function
  was deleted. Wall-time benefit: a filtered run (e.g. `--testPathPattern`) now actually
  filters instead of running all 92 files.

- **Phase 37: `blocked_by_protected_test` AgentOutcome (`125`)** — `REPORT_BLOCKED_TOOL`
  added to `devAgent.ts` alongside `PROPOSE_AMENDMENT_TOOL`. Agent calls
  `report_blocked_by_protected_test(finding_id, test_file, conflicting_assertion)` when a
  review finding requires changing a read-only acceptance test. `runDevAgent` returns
  `{ kind: 'blocked_by_protected_test', ... }`. `devJob.ts` parks the task with
  `parkReason: 'blocked_by_protected_test'` and `final: false` — not final because the
  operator can investigate and unlock. Modelled on the `amendment_proposed` pattern.

- **Phase 37: `runReviewAgent` returns `{ findings, priorFindingStatuses }` (`126`)** —
  Return type changed from `FindingSchema[]` to
  `{ findings: FindingSchema[]; priorFindingStatuses: PriorFindingStatus[] }`.
  `ReviewFindingArraySchema` gains optional `prior_finding_statuses` array.
  In `reviewJob.ts`, when `priorReviewRounds >= 1`, the DB is queried for findings at the
  current `(featureId, specRev)` *before* `persistFindings` overwrites them — this is the
  guaranteed read window (specRev is stable between review rounds since only
  spec_approval/plan_approval gates increment it). Prior findings are injected into the
  review prompt as a checklist; statuses are logged as a muted `agent.log` event after
  the review completes.

- **Phase 36: `summarizeBashTestRun` returns `TestRunSummary` (`120`)** — Now returns
  `{ summary, resolvedCommand, reportPath }` instead of a raw string. Both `devAgent.ts`
  and `testAgent.ts` destructure `.summary` as the tool result, and pass `resolvedCommand`
  and `reportPath` through `ToolCallInfo` to the `onToolCall` log handlers in devJob,
  testJob, and taskTestJob. The event log now records `∟ resolved: <rewritten cmd> @ <path>`
  alongside each intercepted test command.

- **Phase 36: diagnosis — `toJsonReporterCommand` strips agent flags (`120`)** — Fixed in
  Phase 37 (task 124). Phase 36 documented it; Phase 37 fixed it.

- **Phase 36: file count in summary (`121`)** — `ParsedTestOutput` gains `fileCount?: number`
  (populated from `json.testResults.length`). `formatTestSummary` appends `(N files)` / `(1 file)`
  when `fileCount` is set.

- **Phase 36: vacuous findings reach a `test_report` gate (`122`)** — `_advanceTestPass` in
  `testJob.ts`: when `warnings.length > 0`, persists findings to the `finding` table, opens a
  `test_report` gate, and sets `agent.status: waiting` instead of transitioning to TEST_PASS.

- **Phase 36: lockfiles excluded from agent commits (`123`)** — After `git add -A` in devJob.ts,
  testJob.ts, and taskTestJob.ts, any staged `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml`
  is unstaged via `git reset HEAD -- <lockfiles>` before the agent commit.

- **Phase 35: per-invocation path replaces `rm -f` (`117-118`)** — `summarizeBashTestRun`
  now generates `/tmp/test-report-<timestamp>-<random>.json` per call. Staleness is
  structurally impossible without any `rm`.

- **`spec_approval` gate-open and approve paths (Phase 29)** —
  Gate-open paths (4): `awsReviewJob.ts` after review; `specSubmit.ts` no-charter
  fast-path; `awsReviewJob.ts` error final-attempt; missing-charter fallback guard.
  Approve path (1): `POST /features/:id/approve` only.

- **Test-file boundary: tool-handler enforcement, not prompt-only (Phase 28)** —
  `write_file` and `edit_file` in `runDevAgent` / `runLightDevAgent` call
  `getTestAuthoredSet(worktreePath)` at startup and reject any path in the returned
  set with `is_error: true`.

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
| 32 | Artifact tabs are copyable | `85592bf` | 2026-09-06 |
| 33 | An agent that is not progressing stops | `4273e44` | 2026-09-06 |
| 34 | Verification means what it says | `72bc51e` | 2026-09-06 |
| 35 | The orchestrator is not bound by the agent's allowlist | `c208689` | 2026-09-06 |
| 36 | Test output can be trusted | `260a95a` | 2026-09-06 |
| 37 | Agents keep their flags, and blockers do not vanish quietly | pending | 2026-09-06 |

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
- An agent running `npx jest --testPathPattern=auth` sees only the matching tests, not
  the full suite (scope is respected, not silently expanded).
- An agent running `npx jest --ci` produces a rewritten command that contains `--ci`
  before `--json` in the event log.
- A dev agent that calls `report_blocked_by_protected_test` causes the task to park
  with `parkReason: 'blocked_by_protected_test'` and a `task.failed` event with
  `final: false`.
- A round-2 review receives a prior-findings checklist in its prompt and the response
  includes `prior_finding_statuses`; statuses are logged as a muted `agent.log` event.
