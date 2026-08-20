# Orrery

Multi-agent system implementing Spec-Driven Development. Read
docs/specs/00-project-overview.md before any task. Work only on the current
phase's spec; never implement ahead.

## Workflow rules
- **Cowork = verification and diagnostics only; it never modifies or commits
  code. Implementation goes through Claude Code.** Start every Cowork task
  with the preamble "Read-only: do not modify or commit anything."
- Always start in plan mode for a new spec or task; wait for approval before coding.
- Work in small tasks: one endpoint / module / migration per task.
- After every task: run lint + tests, then create a git commit
  (format: feat|fix|chore(scope): description). Never batch huge diffs.
- If a spec is ambiguous, stop and ask; do not invent requirements. Record the
  answer in the relevant spec file under "Open questions".
- When a phase completes, update this file with new commands/conventions and
  check off the phase in docs/specs/00-project-overview.md.

## Repo layout
- apps/server — Fastify + TypeScript API, orchestrator, agents
- apps/web — React UI
- docs/specs — numbered phase specs (source of truth)
- packages/shared — types shared between server and web

## Commands
- npm run dev        # run server + web
- npm test           # all unit tests (Vitest)
- npm run lint       # eslint + prettier check
- npm run typecheck  # tsc --noEmit
- scripts/*.sh       # phase-3 E2E harness (bait/gate/failpath/recheck) against a running dev server

## Conventions
- TypeScript strict mode. No `any` without a comment explaining why.
- No default exports.
- Zod schemas for all external input (HTTP bodies, model JSON outputs, env vars).
- Every Anthropic API call goes through src/lib/anthropic.ts, which logs token
  usage. Never call the SDK directly from feature code.
- Secrets only via env vars; .env is gitignored; keep env.template current.
- Errors: never swallow; log with feature_id context.
- Git remote is Azure DevOps. PRs (later phases) go through the Azure DevOps REST API, not GitHub.

## Provider modes

| Mode | When | Key vars |
|---|---|---|
| **Real-work** | VPN on, corporate channel | `ANTHROPIC_PROVIDER=bedrock`, `AWS_PROFILE=ai-devtools-dev`, `BEDROCK_MODEL_ID=<profile ARN>` |
| **Experiments** | VPN off, personal key | `ANTHROPIC_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=<key>` |

**Corporate network setup (real-work mode):**
- TLS-inspecting proxy requires a custom root CA. Export the cert path in your
  shell before running the dev server:
  `export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem`
- **`NODE_*` vars must be shell-level, not in `.env`.** Node reads them at bootstrap
  before any JS runs; `--env-file`/dotenv deliver them too late.
  Export `NODE_EXTRA_CA_CERTS` in your shell profile (`.zshrc`/`.bashrc`).
- **Bedrock model IDs differ from direct-API IDs.** The org IAM policy allows only
  the application inference profile, not foundation-model ARNs. Mirror the exact
  ARN from `~/.claude/settings.json → ANTHROPIC_DEFAULT_SONNET_MODEL` into
  `BEDROCK_MODEL_ID` in `.env`. Never use bare model names like `claude-sonnet-5`
  in Bedrock mode — they will 403 with an explicit deny.
- Verify the CA cert with:
  `curl --cacert "$NODE_EXTRA_CA_CERTS" -s -o /dev/null -w "%{http_code}\n" https://bedrock-runtime.eu-west-1.amazonaws.com`
  Expected: `404` (TLS succeeded, AWS rejected unsigned request). `SSL error` = cert wrong.
- **Tests and dev server must use separate databases.** Tests issue
  `TRUNCATE CASCADE` — running `npm test` against the dev DB erases live features.
  The test DB is `orrery_test`; `vitest.config.ts` sets `DATABASE_URL` automatically.
  The `globalSetup` guard refuses to run if `DATABASE_URL` does not contain `_test`.
  One-time setup: `docker compose exec postgres psql -U orrery -c "CREATE DATABASE orrery_test OWNER orrery"`
  then `npx prisma migrate deploy` (with `DATABASE_URL` pointing at `orrery_test`).
- **npm does not honor `NODE_EXTRA_CA_CERTS`.** npm has its own CA config; pass
  it explicitly in the process env for any child-process npm call:
  `env: { ...process.env, npm_config_cafile: process.env['NODE_EXTRA_CA_CERTS'] ?? '' }`
  An empty string is harmless when `NODE_EXTRA_CA_CERTS` is unset.
  Applies to all `exec`/`execSync` npm invocations in server worker jobs.
- **Never use** `NODE_TLS_REJECT_UNAUTHORIZED=0` — disables cert verification globally.

## Security boundaries (non-negotiable)

The server-dev agent runs inside a Docker container (`--network none`, worktree
mount only). This is a **load-bearing security boundary**, not a convenience:

- The **allowlist** is the tripwire — it blocks obvious violations.
- The **container** is the wall — it enforces network isolation and filesystem
  confinement even when the allowlist fails or is bypassed by a clever prompt.

**Never remove or work around either layer to make a task pass.** If the
container image is unavailable (Docker Hub blocked by corporate proxy), surface
the blocker to the user — do not activate host-exec, disable `--network none`,
or widen the allowlist as a fix. The right answer is an internal registry mirror.

`AGENT_CONTAINER_IMAGE=none` + `AGENT_UNSAFE_HOST_EXEC=true` exists as a
last-resort local-dev escape hatch. It requires an explicit double opt-in
precisely so that it cannot be activated by a well-intentioned "just make it
work" fix. On a bank laptop an LLM executing shell commands with full user
permissions and network access is the configuration every prior decision was
designed to prevent.

## Lessons from 4b

- Exit code 0 is a claim; the artifact on disk is the evidence.
- A marker must never outlive a reset that reverts what it vouches for.
- The allowlist governs the agent; orchestrator operations run host-side.
- Platform-native packages are never direct deps — lock-only as optional entries.
- The worker announces its code commit at registration so stale hot-reload is visible.
- Environment proves itself healthy (Bedrock probe, vitest-check) before any agent clock starts.
- No-diff plus passing tests is success (noop-success), not failure.
- Repo readiness (lockfile, .gitignore, CLAUDE.md) is a precondition for manifest entry.
- The scaffold's own npm test must pass against the committed lockfile before first push — a failing probe parks every task before the agent gets one turn.

## Process lessons

- Closeout "all green" claims must quote a verbatim suite run (test file count + pass count + zero failures). Memory of a prior green run is not evidence.

## Lessons from 4c

- An operator ruling binds the feature, not the proposing task — store it as a feature-level event so every resumed agent sees it.
- contract.yaml is the sole authority on API shapes — task text is intent, contract is truth. Agents that invent fields violate the contract; agents that silently drop requirements also violate it. The propose_amendment path is the correct escape hatch.
- Gate cards route by gate type (amendment vs spec_approval vs plan_approval) and clear on gate.resolved. Adding a new gate type requires: event schema entry, foldEvents case, UI card component, and a route to resolve it — all four or the gate leaks.
- A two-layer amendment guard is necessary: prompt injection (proactive, prevents well-behaved agents from re-proposing) + dedup handler park (reactive, catches forgetful or context-lost agents). One layer alone is insufficient.
- Credential expiry (Bedrock STS 403) wastes a full install cycle if the probe fires after container setup. Probe first, install second.

## Lessons from 4e

- Operator guidance rides the prompt channel — main's CLAUDE.md is law even for
  old branches. Inject it via `git fetch origin main; git show origin/main:CLAUDE.md`
  at job setup; never merge or rebase mid-flight to deliver it.
- Prohibitions without alternatives don't stick — name the sanctioned move for
  the intent and close the whole category. One bullet: "output is ALWAYS
  auto-truncated — never | head / | tail / | grep; node_modules is off-limits —
  read package.json and tsconfig.json instead."
- Self-auditing records (currentBranches) are the single authority — never
  reconstruct what the system already recorded. A missing entry means the push
  failed; surface an actionable error, not a best-guess ref.

## Lessons from 4d

- External APIs have hard limits — budget-aware builders (not truncation-only) are the right pattern. Build to the limit, then apply a safety-net truncation as a last resort. Never send unbounded content to an external API.
- Every job that calls an external service needs a dedicated retry door from its failure state. A generic redispatch that requires IMPLEMENTING is not sufficient when the job runs post-IMPLEMENTING. Add POST /features/:id/retry-<job> alongside each new external-call job.
- PR author = PAT owner. Use a service-account PAT in production so pipeline-created PRs appear under the pipeline identity, not a personal account.

## Lessons from 5a

- **A scheduler is not a factory.** `dispatchUnblockedTasks` schedules existing
  pending rows — it never creates them. Bounce-back (and any re-entry into
  `IMPLEMENTING`) requires a prior step that *inserts* new pending Task rows.
  The `allCompleted` guard in `dispatchUnblockedTasks` suppresses the no-tasks
  warning when all existing tasks are `completed` — which is exactly the
  post-bounce-back state — so the gap is silent. Fix: call
  `createSyntheticFixTasks` (`lib/syntheticTasks.ts`) *before* `dispatchForState`
  at every REVIEW_FAIL / TEST_FAIL bounce-back. The recovery door is
  `POST /features/:id/retry-bounce`.
- **The reviewer checks code against ALL authorities and escalates when they
  disagree.** The Review Agent holds the spec, the contract, and any injected
  charter as co-equal authorities. When those authorities contradict each other
  (a contract field the spec doesn't mention; a charter clause that doesn't
  apply to the repo type), the reviewer correctly emits a blocker demanding
  reconciliation. Artifact incoherence is now machine-enforced, not silently
  passed. When a reviewer escalates on incoherence, the correct response is to
  fix the artifact (spec, contract, or charter scope rule), not dismiss the
  finding.
- **A finding without citable evidence must not be emitted.** The blocker
  calibration rule in `docs/agents/review-charter.md` — "reserve blocker
  severity for concrete, diff-visible violations" — prevents fabrication. If the
  diff is silent on a requirement and the acceptance criterion doesn't explicitly
  mandate it, the correct call is a `warning`, not a `blocker`. This is the
  CONFORMANCE / QUALITY split enforced by the charter doc, not just the prompt.
  Enforce the rule in the committed charter so it survives prompt rewrites.

## Known gotchas
- **Install strategy: host platform-override is the proven path (primary).**
  `runHostInstall()` runs `npm install --os=linux --cpu=arm64 --libc=musl` on the
  host, downloading linux-musl binaries that the alpine exec container then runs.
  Container-offline-install (bind-mount `~/.npm`, `--offline`, `--ignore-scripts`)
  is the documented fallback if the host path ever breaks — do not build it until
  the primary path fails in production.
- **Prisma repos need offline engine binaries (pre-empt before adding to manifest).**
  Any repo with a `prisma` dependency will fail inside `--network none` because
  Prisma's postinstall script downloads engine binaries from the internet.
  Pre-empt: add `binaryTargets: ["linux-musl-arm64"]` to `prisma.schema` generator
  block AND provide engines via `PRISMA_ENGINES_MIRROR=file:///path/to/engines` on a
  bind-mounted path. Add this to the repo-readiness checklist for manifest entry.
  The worktree setup check (see serverDevJob.ts rollupBin assertion pattern) should
  detect a prisma dep and fail fast with an actionable message if binaryTargets is
  missing — wire this before activating any Prisma repo in the manifest.
- **npm install strategy: host-side platform-override (primary).** Container
  egress for npm tarballs is blocked by the TLS-inspecting proxy under VPN
  (ECONNRESET). `runHostInstall()` runs `npm install --os=linux --cpu=arm64
  --libc=musl` on the host (proven network, cafile covers TLS inspection),
  downloading linux-musl binaries that execute only inside the alpine exec
  container. Set `INSTALL_STRATEGY=container` to use the container path once
  an internal registry mirror (Artifactory/Nexus proxying docker.io) is
  available — that is the eventual clean fix. Until then, host install.
- **Host `npm install` produces darwin-arm64 binaries; exec container is linux-musl.**
  The server-dev job uses a two-phase container setup: `runInstallContainer` (same
  `node:20-alpine` image, network on) installs deps first, then `startContainer`
  (network off) mounts the same worktree. Never run `npm install` on the host for
  the agent worktree — it produces the wrong native ABI.
  **Fallback** if the install container's egress is also blocked by the proxy:
  run `npm install --os=linux --cpu=arm64 --libc=musl --prefer-offline` once on
  the host to populate `~/.npm` with musl variants; they'll be served from the
  npm cache Docker volume on subsequent container installs.
- **Env vars require server restart.** The server loads .env once at startup via
  `--env-file`. Adding or changing a var (e.g. FIGMA_TOKEN) has no effect until
  the process is restarted.
- **Figma node-ids: normalise `-` → `:` before the API call.** Figma URLs encode
  node IDs with a dash (e.g. `node-id=1-2`) but the Figma REST API requires a
  colon (`ids=1:2`). `parseFigmaUrl` in `lib/figma.ts` handles this; pass its
  output directly to `fetchFigmaImage`.
- **Multipart file streams must be consumed during iteration.** `@fastify/multipart`
  pipes file bytes through busboy synchronously with the HTTP request stream.
  Calling `part.toBuffer()` after the `for await` loop ends causes a backpressure
  deadlock — the pipe stalls and the request never completes. Always call
  `toBuffer()` inside the loop, on the current part, before moving to the next.
- **Strip thinking blocks before persisting assistant messages.** `claude-sonnet-5`
  emits `type: "thinking"` blocks by default. The Anthropic API rejects them when
  replayed as history without the `interleaved-thinking` beta header. Filter them
  out before `saveMessage()`. Never strip mid-turn (within a single API call's
  tool-use loop) — only at the cross-turn persist boundary.
- **A 202 from POST /simulate is not proof of execution.** The job enters Redis
  and the worker consumes it asynchronously. `job_start` and `job_complete`
  structured logs (`event: 'job_start'|'job_complete'`) confirm the worker ran.
  If neither appears, check: (a) `queue.getWorkers()` — was a worker registered?
  (b) `finishedOn - processedOn` in the job hash — 5ms means the handler body
  was skipped (tsx hot-reload served old code). Redis key
  `bull:agent-jobs:failed` holds job hashes for failures.
- **Exactly ONE BullMQ Worker per queue** (`jobs/agentWorker.ts` dispatches by
  task type). Two task-filtered workers on one queue raced for every job; the
  "wrong" worker completed foreign jobs as silent ~5ms no-ops and features
  wedged mid-state. Add new task types to the agentWorker switch, never as a
  second Worker.
- **Bedrock STS tokens expire (typically every 8h).** Symptom: 403 "security
  token included in the request is expired" in the server log or as a chat
  system bubble. The server surfaces this with an actionable message including
  the refresh command. Fix: `aws sso login --profile ai-devtools-dev` then
  restart the server (env vars are read at startup, not live-reloaded).
- **UI selection state belongs in the URL.** Feature selection is now `/features/:id`
  via History API pushState in `useFeature.ts`. Any new view state that must
  survive refresh (selected agent, active tab) should go in the URL, not React
  state.
- **Finding identity is composite (featureId, specRev, id).** Model-assigned
  finding ids ("f1", "f2") recur in every review cycle and across features.
  Lookups must use the composite key or scope by feature + current cycle
  (gateOpenedCount - 1, lib/reviewCycle.ts); the approve gate counts only
  current-cycle unresolved blockers. A plain `where: { id }` on findings is
  always a bug.
- **Phase 4 relocation: job dispatch on PLANNING entry.** Currently
  `simulate-resume` is enqueued inside the POST /approve route handler
  (`featureApprove.ts`) after the transition to PLANNING. Phase 4 must move
  this to a `dispatchForState(featureId, newState)` helper called from all
  transition points, so real planning/dev-agent jobs are dispatched regardless
  of which route triggered the transition. The helper maps state → job type
  (PLANNING → 'plan' or 'simulate-resume' based on `feature.simulatedRun`).

## Brand config (spec 56 — all optional, defaults shown)

Env var | Default | Effect
---|---|---
`BOT_GIT_NAME` | `Orrery` | Author name on all agent commits
`BOT_GIT_EMAIL` | `orrery-bot@example.com` | Author email on all agent commits
`CONTAINER_PREFIX` | `orrery-agent` | Docker container name prefix and npm-cache volume name
`WORKTREES_ROOT` | `/tmp/orrery-worktrees` | Root dir for git worktrees (already existed; default changed)
`VITE_PRODUCT_NAME` | `Orrery` | Product name shown in the UI header and solar watermark
`VITE_TENANT_LINE` | `AGENT SOLAR SYSTEM` | Subtitle line in the UI header (set empty to hide)

`VITE_*` vars are read by the Vite dev-server and baked in at `npm run build` time.
Server vars (`BOT_GIT_*`, `CONTAINER_PREFIX`, `WORKTREES_ROOT`) go in `.env`.

**First-run test DB setup:**
```bash
docker compose exec postgres psql -U orrery -c "CREATE DATABASE orrery_test OWNER orrery"
DATABASE_URL="postgresql://orrery:orrery@localhost:5432/orrery_test" npx prisma migrate deploy -w apps/server
```
