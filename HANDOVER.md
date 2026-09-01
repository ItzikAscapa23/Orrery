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
  log table below. Do not add `✅ DONE` or `Items closed in Phase N` lines —
  delete the entry outright once its fix is committed and the phase passes
  verification.

---

## Status

- **Current phase:** 23 — Config validation that fits reality
- **State:** `complete`
- **Last updated:** 2026-09-01

---

## Current phase progress

*Next phase (24) tasks — all unticked:*

- [ ] Report: measure test-agent rewrite cost on recent features (do not fix yet)
- [ ] `91-scratch-files-not-authored` — exclude debug/scratch test files from authored set
- [ ] Act on rewrite measurement — brief written after report lands
- [ ] `92-vendored-node-modules` — state the vendored-layer exception in `bff`'s CLAUDE.md
- [ ] `93-binary-sentinel-is-real` — `binary_sentinel` must name an ABI-specific artifact

---

## Verification

| Command | Result |
|---|---|
| `npm test` (repo root) | passed — **1125 passed across 86 files** (+1 new test), 2026-09-01 |
| `npm run typecheck` | passed — clean across all three workspaces, 2026-09-01 |
| `npm run lint` | exit 0 — 0 problems, 2026-09-01 |

---

## Decisions

- **`validateProbeCommands` validates via `detectJsonCommand` (Phase 23)** —
  `inferRunner` checked whether the probe string contained 'vitest' or 'jest',
  rejecting valid probes like `npm test -- --maxWorkers=2`. The new validator calls
  `detectJsonCommand('', probe)` — if that doesn't throw, the probe is usable. In
  practice `detectJsonCommand` only throws when `probe_command` is absent, so the
  effective rule is: probe must be declared. Runner detection happens from CLAUDE.md
  content at job time, not from the probe string.

- **Config validation failure → `process.exit(1)` with a readable message (Phase 23)** —
  previously the throw from `validateProbeCommands` propagated as an unhandledRejection
  and crashed the server with a stack trace. `agentWorker.ts` now catches it and exits
  deliberately: `Config error: <message>`.

- **Charter inventory (Phase 23):**

  | File | Kind | Loaded by |
  |---|---|---|
  | `docs/agents/aws-charter.example.md` | Committed template | Nobody — operator copies to `aws-charter.md` |
  | `docs/agents/aws-charter.md` | Operator config (gitignored) | `awsAgent.ts` via `charterPath` arg at job dispatch |
  | `docs/agents/repo-manifest.example.yaml` | Committed template | Nobody — operator copies to `repo-manifest.yaml` |
  | `docs/agents/repo-manifest.yaml` | Operator config (gitignored) | `devJob.ts` (`getRepoEntry`), `validateManifest.ts`, `charterResolver.ts` |
  | `docs/agents/review-charter.md` | Committed agent prompt | `reviewAgent.ts` (hardcoded path) — injected into every code-review system prompt |
  | `docs/agents/test-charter.md` | Committed documentation | Not loaded in production; used in tests as a dummy AWS-review charter path |

- **`deploy: aws` removed from `review-charter.md` (Phase 23)** — the field doesn't
  exist in `RepoEntry`. AWS review routing is already handled by the `review_charter`
  field on a repo entry: repos without it never enter `AWS_REVIEW`. The dead scope rule
  would have caused the review agent to silently skip AWS-charter checks for all repos.
  Removed; architecture review belongs to `aws-charter.md` + the AWS review agent, not
  the code review charter.

- **Startup config reads (Phase 22/23):**

  | Config source | Read location | Missing/malformed → |
  |---|---|---|
  | `repo-manifest.yaml` | `validateProbeCommands` (boot, worker) | absent: silent return; invalid YAML: `yaml.load` throws |
  | `repo-manifest.yaml` | `resolveCharterPath` (per-feature, aws-review) | absent: `undefined`; declared charter file missing: throws |
  | `repo-manifest.yaml` | `getRepoEntry` / `getAnyRepoEntry` (per-job) | absent or repo not found: throws |
  | `probe_command` field | `validateProbeCommands` (boot) | absent: exits with `Config error:` message; any non-empty value: passes |
  | `probe_command` field | `detectJsonCommand` (per-task, runtime) | absent: throws |
  | Env vars (`.env`) | `lib/env.ts` via `--env-file` at process start | absent required var: Zod parse throws at boot |
  | `BEDROCK_MODEL_ID` / `AWS_PROFILE` | Bedrock probe (boot) | absent/expired: probe fails with actionable message |

- **Charter skip uses `SUBMIT_SPEC_LIGHT` regardless of `feature_path` (Phase 21)** —
  `SUBMIT_SPEC_LIGHT` is the FSM edge from `DRAFTING_SPEC → AWAITING_APPROVAL`. For
  features with no `review_charter`, it is the correct skip mechanism even for FULL-path
  features. The `APPROVE` vs `APPROVE_LIGHT` split (which drops planning/testing states)
  still depends on `feature_path`, not the charter decision.

- **`dispatchForState('AWS_REVIEW')` removed (Phase 21)** — route handlers that go
  through the AWS review path call `dispatchJob(featureId, 'aws-review', { charterPath })`
  directly so the charterPath travels with the payload.

- **Finding identity is composite (featureId, specRev, id)** — model-assigned finding
  ids (`f1`, `f2`) recur in every review cycle. Lookups must use the composite key or
  scope by feature + current cycle; a plain `where: { id }` is always a bug.

- **Task-derived agent status applied after event-sourced fold; skip `working → done`
  override** — the feature-level test job emits `agent.status(working)` directly, after
  task rows already show `testsWritten: true`. Merging must not override an existing
  `'working'` with task-derived `'done'`.

- **`detectJsonCommand` throws when `probe_command` is absent (Phase 19)** — the
  CLAUDE.md prose-inference fallback is removed. Any active full-path repo without
  `probe_command` fails at the first `detectJsonCommand` call.

---

## Assumptions

- `apps/web/.env.local` setting `VITE_PRODUCT_NAME=PepperOrchestrator` is a
  deliberate local brand override. The fallback `'Orrery'` stays.
- When multiple repos in a feature declare different `review_charter` paths,
  first-charter-found semantics applies (first repo in `feature.repos` wins). Documented
  in `charterResolver.ts` JSDoc.

---

## Open questions / blockers

- **O-12 Duplicate `pr.created` events.** Root cause diagnosed (non-atomic ADO call
  + event append). Not implemented. Fix: re-query existing `pr.created` events inside
  the per-repo loop immediately before the ADO API call.

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
| 23 | Config validation that fits reality | pending | 2026-09-01 |

---

## Next phase entry conditions

- Full suite green from the repo root, with the count recorded.
- `npm run lint` exits 0.
- No feature mid-run: `tsx watch` reloads on file save, which stalls in-flight
  BullMQ jobs and parks their tasks. Never edit the orchestrator while a feature
  is running.
- Worker commit verified — `worker_registered` in the server log carries the SHA.
- A restart mid-dispatch produces exactly one container.
