# Phase 4 — Developer Agents

## Goal
Approved specs become implemented code. A Planner produces a contract and task
lists (human-gated), then Server Dev and Client Dev agents implement in
parallel inside isolated git worktrees, ride the review/fix loop, and push
branches (later: Azure DevOps PRs). Delivered in five slices, each closed
(smoke-tested, criteria checked, pushed) before the next begins.

## Core model: agent type vs agent instance
- Types (registry): server-dev, client-dev. One system prompt + toolset per type.
- Instances: one per (type, repo) per feature. Own BullMQ job, own container,
  own worktree, own branch. Events carry instance identity: existing agent
  field keeps the type; ALL Phase 4 events add repo (string, nullable for
  non-repo events). UI renders unknown/instance ids gracefully (existing rule);
  planet badge may show active-instance count.
- Repo manifest: docs/agents/repo-manifest.yaml — operator-maintained list of
  repos: { id, side: server|client, url, description, default_branch }.
  The Planner maps spec requirements to repo ids from this manifest only.
- Slices 4a-4d run with exactly one server repo and one client repo (the demo
  repos). Multi-repo fan-out is slice 4e; the schema supports it from day one.

## Demo repos (created in 4b/4c, not part of this monorepo)
- demo-server: minimal Fastify + TypeScript API, Vitest, its own
  CLAUDE.md (conventions, npm test, folder layout).
- demo-client: minimal React Native (Expo) app, its own CLAUDE.md.
- Real bank repos are explicitly out of scope for Phase 4.

## Slice 4a — dispatchForState + Planner + plan gate
- Refactor (recorded debt): all state-entry side effects move to
  dispatchForState(featureId, newState), called from every transition point.
  Approve-route-specific enqueue logic is deleted. Simulator resume, AWS review
  enqueue, and all Phase 4 dispatches use it. Test: every transition path
  (approve, request-changes, auto-advance, resume) triggers the correct dispatch.
- Machine change: PLANNING -> AWAITING_PLAN_APPROVAL -> IMPLEMENTING.
  gate.opened gains gate: 'plan_approval'. Approve/request-changes endpoints
  gain plan-gate variants (request changes on the plan re-runs the Planner with
  the comment). Re-planning is revision, not regeneration: the prior plan.md
  and the developer's comment are mandatory prompt inputs; the Planner addresses
  the comment while keeping everything else stable.
- Planner agent (Messages API via anthropic.ts, agent='planner' — add to
  registry): input = approved spec + repo manifest; output (Zod, JSON only,
  retry-once pattern) = { contract_yaml: string (OpenAPI), tasks: [{ repo,
  side, title, description, spec_refs[], depends_on[] }] }.
  On success: contract.yaml + plan.md committed to artifacts repo
  (artifact.committed), plan.proposed event, machine -> AWAITING_PLAN_APPROVAL.
  Planner follows the agent activity contract (status, logs, usage, attribution).
- UI: plan gate card — contract summary, task lists per repo, APPROVE PLAN /
  REQUEST CHANGES.
- Simulator updated to walk the new state with the same vocabulary.

## Slice 4b — Server Dev agent, end to end (no parallelism)
- Runtime: custom tool-use loop over the Anthropic Messages API (createMessage
  in lib/anthropic.ts), routed via Bedrock. The model runs host-side; the
  container runs only bash tool invocations with no outbound network.
  (The original "Claude Agent SDK" line referred to the agentic pattern — the
  spike in scripts/spike-agent-sdk.ts confirmed the createMessage loop works
  through the corporate Bedrock setup before anything was built on it.)
- Isolation: each instance runs in a Docker container; the feature's worktree
  (branch feature/<slug> off default) is mounted; tools: write_file(path,
  content), read_file(path), bash (allowlist-enforced: npm test/lint/typecheck,
  cat/ls/find/grep/head/tail/wc/pwd/mkdir/cp/mv/echo, node, npx vitest/tsc).
  git is NOT available to the agent — the orchestrator performs all git
  operations host-side. write_file/read_file are path-jailed to the worktree
  (no .. or absolute paths). bash: one command per call, no shell operators;
  three violations permanently fail the task. Output capped at 200 lines / 8 KB
  with truncation marker. No network beyond what the SDK itself needs.
- Job flow: dispatchForState(IMPLEMENTING) enqueues one job per task (4b:
  server tasks only, sequential). Agent prompt = task + relevant spec slice +
  contract.yaml + repo CLAUDE.md. Definition of done per task: tests pass in
  the worktree (verified host-side by the orchestrator); one host-side commit
  per task (conventional message + task id) performed by the orchestrator after
  test verification. The agent writes files only and signals completion via
  end_turn — no git commands. A task with no file changes at end_turn fails.
- Events: task.started / task.completed / task.failed { repo, task_id },
  agent.log lines for meaningful steps, usage.recorded per SDK session.
- Failure: retry once; then agent.status(failed) + feature waits in a
  resumable IMPLEMENTING. Iteration cap 3 per task across automatic fix loops
  (cap counted per task, stored on the task record). POST /redispatch is the
  human-facing resume: it resets parked tasks to pending with attempt_count=0
  (a new grant, not attempt N+1) and re-enqueues — use after fixing an
  environmental failure (expired SSO, registry down, VPN off).
- After all server tasks: branch pushed to the demo repo remote.

## Slice 4c — Client Dev agent + parallelism + contract amendments
- Client Dev instance mirrors 4b against demo-client.
- Both sides dispatch in parallel on entering IMPLEMENTING; per-repo task
  order respects depends_on.
- Contract amendment flow (Decision 1 ruling): when an agent determines the
  contract is insufficient, it calls the propose_amendment tool with
  { contract_yaml (full replacement), rationale }. The orchestrator pauses
  all pending tasks (both sides), opens an amendment gate, and the UI shows
  an amendment card. APPROVE writes the new contract.yaml (commitArtifact),
  emits contract.revised, resets amendment_paused tasks to pending, and
  redispatches. REJECT resets tasks to pending and optionally appends a
  rejection note to the proposing task's description for the agent to see
  on retry. Amendments are events + gates — same machinery as findings.
- IMPLEMENTING -> CODE_REVIEW when all tasks on all repos are completed.
  (CODE_REVIEW/TESTING remain simulator-only until Phase 5; auto-advance with
  the Phase-2-style skip log.)

### Ratified decisions (Stage C)
- **Cross-side pause is between-tasks-only.** `runServerDevAgent` has no
  abort signal. When a task proposes an amendment, all pending tasks on both
  sides are set to `amendment_paused`. Tasks currently running on the other
  side run to completion; their downstream tasks are not dispatched because
  they are `amendment_paused`. This is a deliberate architectural constraint,
  not an oversight. A full abort signal is deferred to a future phase.
- **Full YAML replacement, not a diff.** The `propose_amendment` tool takes
  `contract_yaml` (complete replacement) + `rationale`. The artifacts
  machinery writes whole files; a general patch applier adds complexity
  without benefit for the 4c use case. The semantic intent ("propose a
  contract change") is preserved — the diff is implicit between the committed
  version and the proposed replacement.
- **An operator ruling binds the feature, not the proposing task.** Rejection
  is persisted as an `amendment.rejected` event (feature-level, not
  task-level). Every subsequent dev-agent prompt for that feature includes a
  `## Rejected amendments` section so sibling tasks that resume independently
  cannot re-propose the same change. A dedup guard in `devJob.ts` parks any
  task that bypasses the prompt and proposes the same rationale again.
- **Gate cards route by gate type and clear on resolution.** The UI renders
  `gate.opened { gate: 'amendment' }` as an amendment card (not a spec/plan
  card); it clears on `gate.resolved` regardless of resolution. Gate-type
  routing prevents bleed-through between co-existing gate types.

### Follow-up tickets (before 4d)

**T-4c-2 — Findings panel restoration.**
After the amendment card workflow was added, the findings panel (AWS review
results) regressed in some states. Verify the findings panel renders correctly
when a feature is in IMPLEMENTING with a closed spec gate, and that the
amendment card does not occlude it.

**T-4c-3 — Stale-gate clearing verification.**
Confirm that `gate.resolved` events always clear the corresponding gate card
in the UI for both `amendment` and `spec_approval` gate types, including the
case where a second `gate.opened` fires before the first is resolved
(regression guard for the phase-gated suppression fix in foldEvents).

**T-4c-4 — Planner failed-badge stickiness.**
When the Planner job fails (e.g. Bedrock 403, plan parse error), the planet
badge should show `failed` and remain sticky until the operator redispatches.
Currently the badge may revert to `idle` on the next SSE poll. Fix: ensure
`agent.status { status: 'failed' }` is the terminal event for a failed plan
job and that foldEvents treats it as sticky (not overwritten by a subsequent
`queued` on retry).

**T-4c-5 — Credential-freshness probe on job start.**
Bedrock STS tokens expire every ~8h. A job that starts after expiry wastes a
full container setup cycle before hitting the 403. Move the
`checkBedrockConnectivity()` call to the very first step of `runDevJob`
(before `createWorktree` / `runInstallContainer`) so the job parks immediately
with an actionable message rather than after a 30–60s install.

## Slice 4d — Azure DevOps PRs
- On leaving IMPLEMENTING: create one PR per repo via Azure DevOps REST API
  (PAT via env var, never committed), title/body generated from spec + task
  list, pr.created { repo, url } event, PR links in the UI run view.

## Slice 4e — multi-repo fan-out
- Add a second entry per side to the repo manifest; Planner may emit tasks for
  multiple repos per side; one instance per (type, repo); events/UI already
  carry repo. No new mechanisms — this slice is configuration + verification.

## Acceptance criteria (per slice; each slice closes before the next starts)
4a: ✅ verified 2026-07-19
- ✅ dispatchForState is the single dispatch point (grep: no enqueueJob outside
  lib/ and jobs/ in production code; route handlers use dispatchForState /
  dispatchJob only).
- ✅ Plan gate round-trips both ways: approve → IMPLEMENTING placeholder;
  request-changes re-plans addressing the comment (revision mode verified
  behaviorally — server tasks decomposed per comment, client stable).
- ✅ Planner output validates (Zod), commits contract.yaml + plan.md to
  artifacts repo, follows activity contract (status/log/usage, agent='planner').
- ✅ Active-only repo filtering: inactive real-bank repos never appear in
  Planner prompt (grep + behavioral).
- ✅ Revision detection uses plan.proposed event + plan-gate comment filter
  (spec-gate comments do not bleed into plan revisions).
- ✅ Simulator walks DRAFTING_SPEC → AWAITING_APPROVAL → PLANNING →
  AWAITING_PLAN_APPROVAL → IMPLEMENTING → DONE through both gates; mock
  Planner runs at zero tokens.
- ✅ Phase 2/3 criteria still pass (npm test green).

### Follow-up tickets (before 4b)

**T-4a-1 — Simulator client-dev vocabulary.**
The simulator's mock plan emits both server and client tasks, but
`PHASE_AGENTS` / `PHASE_LOGS` do not yet have client-dev entries.
Symptom: client tasks in a simulated run show no `agent.status`
working→done cycle and no `agent.log` lines, breaking the agent activity
contract for the client side. Fix: add `client` phase activity to the
simulator using the same `emitPhaseActivity` pattern as server tasks.

**T-4a-2 — DB seed script.**
No script exists to seed a feature in a specific state (AWAITING_APPROVAL,
AWAITING_PLAN_APPROVAL, etc.) for manual smoke-testing without running a
full conversation. A `scripts/seed-feature.ts` that accepts a target state
and inserts the minimal event log would cut the manual smoke-test setup
time significantly, especially for gating criteria in later slices.

**T-4a-3 — Planner planet missing from solar mesh.**
`planner` is in `AGENT_REGISTRY` (tier: build) but does not appear as a
planet in the solar mesh. Root cause likely in `ringConfig.ts`: the
middle ring's `agents` array hardcodes `['client', 'server']` and does
not include `'planner'`. Fix: add `'planner'` to the middle ring agents
array (or make ring assignment data-driven from tier). The Planner planet
should appear and cycle working→done during a real plan run.
4b: ✅ verified 2026-07-21
- ✅ SDK-equivalent spike (scripts/spike-agent-sdk.ts) passes via corporate Bedrock.
- ✅ Three features shipped end-to-end in demo-server (branches
  server-uptime6, server-version2, server-echo); server-echo with zero manual
  interventions from approval to push.
- ✅ One commit per task, committed host-side after container test verification;
  events attributed with repo on every task.started / task.completed / task.failed.
- ✅ Failure paths verified in production conditions: retry (attempt 1 re-queues),
  park (attempt 2 → parked, resumable), resurrect via POST /redispatch (attempts
  cleared, new grant), zombie reconciliation (bullJobId claim + periodic reconciler).
- ✅ Noop-success: agent end_turn with no file changes + tests pass → completed
  (not AgentNoopError). Parked only when work is genuinely absent.
- ✅ Commit guardrails: git add -A trusts .gitignore; CommitStepError (infra, not
  agent-fault) never classified as final at attempt 2.
- ✅ Dependency-gated sequential dispatch verified (depends_on satisfied before
  enqueue); noop-success triggers downstream dispatch correctly.
- ✅ Cross-side exclusion: client tasks (side='client') never dispatched by
  dispatchUnblockedTasks (WHERE side='server'); no interference with server chain.
4c: ✅ Stage B verified 2026-07-22 (Stage A verified same date)
- ✅ Stage A foundations (findings 1-2, 4-6, 9-10): worktree keyed by (slug,
  repoId); repo-profile-driven pre-flights (binary_sentinel, probe_command,
  exec/install timeouts); idempotent maybeAdvanceToReview IMPLEMENTING→DONE;
  one-task-per-repo-per-wave dispatch; repo field on agent.status/agent.log;
  planner max_tokens 8192, retry no longer echoes truncated response; host
  installs serialized.
- ✅ Stage B client agent: demo-client scaffold (Expo 51, jest --ci
  --watchAll=false, linux-musl lockfile, CLAUDE.md with project structure);
  runDevJob extraction — no copy-paste job file, 7 parameterization points
  resolved; client-dev queue type + worker case; CLAUDE.md from worktree root
  kills the server-specific scaffold constant.
- ✅ First two-sided feature (greeting-screen) shipped end-to-end: parallel
  dispatch server + client, both branches pushed, maybeAdvanceToReview walked
  the machine to DONE. Client agent: 32 turns (GreetingScreen), noop-success
  (tests task already written), 0 manual interventions after approval.
- ✅ Walls 24-26 documented and resolved: proxy cold-cache install ETIMEDOUT
  (--fetch-timeout, InstallError 3-attempt budget, stderr tail captured);
  scaffold smoke test must pass before first push (test imports matched devDeps,
  react-test-renderer pinned); agent structure-map (CLAUDE.md ## Project
  structure cuts exploration turns).
- ✅ Stage C amendment flow: propose_amendment tool + gate machinery; parallel
  resume on approve (contract.yaml updated, all amendment_paused → pending,
  both sides redispatched); reject path with durable feature-scoped ruling —
  amendment.rejected event + ## Rejected amendments prompt section + dedup
  guard in devJob (park on duplicate proposal, no gate re-open). Amendment
  fired 3× across uv-index/wind-speed/tide-level2; approve proven twice incl.
  parallel resume; reject proven with two-layer defense holding under a
  mid-flight second proposal. Final audit: contract-faithful code, ruling
  documented in comments.
4d: ✅ verified 2026-07-26
- ✅ PR !89312 created in demo-server (feature/server-health-detail →
  main) via Azure DevOps REST API; pr.created event emitted; PR link rendered
  in MissionControl.
- ✅ Budget-aware body (buildPrBody, 3900-char cap + truncation safety net);
  failure path proven live: HTTP 400 on 4000-char body → loud structured log →
  POST /retry-pr → success.
- ✅ POST /features/:id/retry-pr: dedicated retry door from FAILED state;
  restores to CODE_REVIEW and re-enqueues create-ado-pr without re-running dev
  tasks.
- Note: PR author is the PAT owner. For production, use a service-account PAT
  so PRs appear under the pipeline identity rather than a personal account.
  AZURE_DEVOPS_PAT should reference the service account credential in production.
4e: ✅ verified 2026-07-26
- ✅ service-status feature spanned three repos (demo-server,
  demo-server-2, demo-client) from a single chat session through
  spec/AWS/plan gates, parallel multi-repo dispatch, and per-repo PR creation.
- ✅ Three PRs opened (#89353 client, #89354 server, #89355 server-2) via ADO
  REST API; all three pr.created events emitted with correct repo field; feature
  advanced to DONE.
- ✅ currentBranches map is the single authority for source refs — PR job iterates
  the map, never reconstructs refs from slug. Missing-map entry parks with an
  actionable error (empty-map guard + test).
- ✅ CLAUDE.md injected from origin/main on each job setup — operator guidance
  rides the prompt channel regardless of branch age.
- ✅ Generalized ergonomics bullet: auto-truncation declared always-on, full pipe
  ban named, node_modules named as the exploration anti-pattern with package.json
  + tsconfig.json as the correct lookup sources.
- Root cause documented: TF401398 was caused by demo-server's branch never
  being pushed to ADO (push failed silently; currentBranches map correctly omitted
  it) combined with the PR job ignoring the map and reconstructing the ref anyway.
  Fix: map is authoritative; branch manually pushed; retry-pr succeeded.

## Maintenance — chore/deps-2026-07 (2026-07-26)

### Step 9 — dependency upgrade + ESLint flat-config migration

| Area | Before | After | Notes |
|---|---|---|---|
| eslint | 8.57 | 10.8 | Flat config (`eslint.config.mjs`); `.eslintrc.cjs` deleted |
| @typescript-eslint | 7.9 | 8.65 | `recommended-type-checked` rules tightened |
| typescript | 5.4 | 5.9 | No breaking changes in codebase |
| concurrently | 8.2 | 10.0 | dev-only, no API changes used |
| prettier | 3.2 | 3.9 | Format-only, no rule changes |
| tsx | 4.11 | 4.23 | dev-only transpiler |
| bullmq | 5.80 | 5.81 | Patch bump |
| @testing-library/react | 16.0 | 16.3 | Patch bump |
| js-yaml | devDep (`@types` only) | runtime dep | Already imported in plannerJob/devJob/createAdoPrJob |
| Lint result | legacy `--ext` flag | flat-config globs | `--ext .ts,.tsx` removed from script |
| Test suite | 398 / 398 pass | 398 / 398 pass | No regressions |
| Typecheck | pre-existing `dispatch.test.ts` error | unchanged | Not introduced by this branch |

Gates run on this branch: `npm install` clean, `npm run lint` 0 warnings, `npm test` 40 files 398 tests 0 failures.

### Deferred tickets

**T-maint-2 — `npm audit` remediation pass.**
`npm audit` reports 14 vulnerabilities (3 moderate, 9 high, 2 critical) after
the deps bump. Run `npm audit` and resolve without breaking changes; escalate
any that require a major-version jump to a tracked decision. Target: 0 high/critical.

**T-maint-3 — Pin `@typescript-eslint` ESLint plugin to exact version.**
`@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` are pinned
at `^8.65.0` (semver caret). A minor bump here can tighten lint rules and break
CI unexpectedly. Consider pinning to an exact version and bumping deliberately.

**T-maint-4 — React `act(...)` warnings in `App.test.tsx`.**
`npm test` emits `Warning: An update to App inside a test was not wrapped in
act(...)` for every App test. These are warnings not failures, but they indicate
async state-update paths that escape the test harness. Fix: wrap the fetch mock
resolution in `act()` or upgrade to `@testing-library/react`'s `waitFor` pattern.

**T-maint-5 — `no-constant-condition` suppression sites audit.**
The migration to ESLint flat config removed `no-constant-condition` from the
rule set (it fires on `while (true)` patterns used for SSE drain loops).
Confirm intentional: either add `no-constant-condition: off` explicitly to
`eslint.config.mjs` with a comment, or convert the loops to `for await` to
restore the rule's coverage elsewhere.

## Lessons from Phase 4

- **Operator guidance rides the prompt channel.** CLAUDE.md on a feature branch
  drifts as main accumulates lessons. The correct fix is to inject main's
  CLAUDE.md into the agent prompt at job setup time (git fetch origin main; git
  show origin/main:CLAUDE.md), leaving the branch copy untouched. Branch content
  stays deterministic per attempt; operator rules stay current always.

- **Prohibitions without alternatives don't stick.** Each violation pattern added
  its own narrow bullet, which the agent worked around in new ways. The effective
  fix names the sanctioned move for the intent and closes the whole category:
  "output is ALWAYS auto-truncated — you never need | head / | tail / | grep;
  node_modules is off-limits — read package.json and tsconfig.json instead."
  One bullet per anti-pattern category, with the alternative named inline.

- **Self-auditing records are the single authority — never reconstruct what the
  system already recorded.** currentBranches is written by the dev agent after a
  successful push. The PR job must read it, not rederive refs from feature.slug.
  A missing entry means the push failed — the correct response is an actionable
  error, not a best-guess ref that silently targets a non-existent branch.

## Out of scope
- Real bank repositories. Review/Test agents doing real work (Phase 5).
  Deployment of generated code. Auto-merge of PRs. Cross-repo integrator role
  (noted future). Cost dashboard (Phase 6).
