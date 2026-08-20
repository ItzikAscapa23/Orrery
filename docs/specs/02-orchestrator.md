# Phase 2 — Orchestrator, Event Log & Command Center

## Goal
Turn Orrery from a single Spec Agent into an orchestrated system:
a deterministic feature state machine, an append-only event log streamed to the
UI over SSE, and the "solar system" command center from docs/design/ui-design.md.
Split into 2a (backend, curl-verifiable) and 2b (UI). 2b must not start until
2a's acceptance criteria pass.

## Design references
- docs/design/ui-design.md (high-fidelity spec; tokens/metrics are final)
- docs/design/Orrery_Solar.dc.html (interactive reference ONLY —
  never import it or support.js into apps/web; recreate in our React/Vite setup)

## Phase 2a — Backend

### State machine (XState, apps/server)
States:
DRAFTING_SPEC -> AWS_REVIEW -> AWAITING_APPROVAL -> PLANNING ->
IMPLEMENTING -> CODE_REVIEW -> TESTING -> DONE
Loop-backs: AWS_REVIEW->DRAFTING_SPEC, CODE_REVIEW->IMPLEMENTING,
TESTING->IMPLEMENTING. FAILED is terminal and reachable from any non-DONE state
(used later when iteration caps are exceeded; cap default = 3, stored per feature).
- Transitions happen ONLY through the orchestrator module; no route handler
  sets feature status directly.
- Every transition persists the new state AND appends a phase.changed event
  in the same DB transaction.
- Guards: approve/request-changes are valid only in AWAITING_APPROVAL;
  invalid transition attempts return 409 and append no event.
- Phase 1 compatibility: DRAFTING_SPEC replaces the old drafting status;
  existing SPEC_APPROVED rows migrate to AWAITING_APPROVAL=resolved semantics —
  write a migration that maps old statuses onto the new machine.

### Agent registry (packages/shared)
- AgentId is a string. A registry object declares the known agents:
  spec, aws, client, server, review, test, orchestrator — each with
  { id, displayName, tier: 'spec'|'build'|'qa'|'core' }.
- The system must tolerate future agent ids: unknown ids in events must not
  crash server or UI (UI renders them with a neutral style).
- UI chip mapping (pure function in packages/shared):
  SPEC=DRAFTING_SPEC, AWS=AWS_REVIEW, APPROVE=AWAITING_APPROVAL,
  BUILD=PLANNING+IMPLEMENTING, QA=CODE_REVIEW+TESTING, SHIP=DONE.

### Postgres + Prisma
- docker-compose.yml at repo root: postgres:16 + redis:7 with volumes.
- Prisma schema: features, messages (migrated from SQLite shape), events.
- Migrate persistence from node:sqlite to Prisma/Postgres. Remove the sqlite
  shim and Vite workaround. A one-shot import script migrates existing dev data
  (best-effort; acceptable to document manual steps).

### Event log
Table events:
  id bigserial PK, feature_id uuid FK, seq int (per-feature, monotonic,
  unique(feature_id, seq)), type text, agent text null, payload jsonb,
  created_at timestamptz default now().
Event types (Zod-validated payloads in packages/shared, one schema per type):
- phase.changed   { from, to }
- agent.status    { agent, status: queued|working|waiting|done|failed }
- agent.log       { agent, severity: 'ok'|'action'|'info'|'muted', text }
  (maps to design prefixes: ok=✓ action=▸ info=◦ muted=·)
- chat.message    { who: 'dev'|agentId, text }
- gate.opened     { gate: 'spec_approval', summary, revision: number }
  (summary is ≤200 chars; never the full markdown; revision increments on re-propose)
- gate.resolved   { gate, resolution: 'approved'|'changes_requested', comment? }
- usage.recorded  { agent, model, input_tokens, output_tokens }
- artifact.committed { path, commit, message }
Rules: append-only (no UPDATE/DELETE); writes go through a single
appendEvent() helper that assigns seq and publishes to subscribers.

#### Event-sourcing note
`proposed_spec` and `status` on the Feature row are **read-model caches** —
convenient projections of the event stream, not the source of truth.
- They are written **only** inside the same DB transaction as their corresponding
  event: `proposed_spec` with `gate.opened`, `status` with `phase.changed`.
- On re-propose (after request-changes), `proposed_spec` is overwritten and
  `gate.opened.revision` increments.
- `appendEvent(tx, featureId, payload)` accepts the Prisma transaction client as
  its first argument. State-changing writes (createFeature, applyTransition, gate
  resolution) must compose the cache update and the event INSERT in one transaction.
  Pure log lines (agent.log, usage.recorded) may call appendEvent outside a
  transaction — that is the only acceptable exception.

#### Agent activity contract
Applies to all real agent flows in this phase and Phases 3-5. The simulator
is the reference implementation; real flows must match its vocabulary exactly.

1. **Status lifecycle.** When the orchestrator dispatches work or a message to
   an agent, emit `agent.status { status: 'working' }`. When the agent's reply
   completes, emit `agent.status { status: 'waiting' }` if the exchange
   continues (mid-conversation), or `agent.status { status: 'done' }` on
   terminal completion (e.g. immediately after `save_spec` resolves). On any
   uncaught error, emit `agent.status { status: 'failed' }`.

2. **Mandatory attribution.** Every event emitted by a real flow must carry a
   non-null top-level `agent` field. Spec-conversation events use `'spec'`;
   phase-transition events use `'orchestrator'`. `agent: null` is reserved for
   genuinely system-wide events that belong to no single agent.

3. **Vocabulary parity.** The simulator and real flows must emit an identical
   set of event types with identical payload shapes. If the simulator emits a
   type that a real flow does not, that is a bug in the real flow.

4. **Mandatory log lines.** Every real agent flow must emit at least one
   `agent.log` entry per meaningful step (e.g. `▸ processing developer message`,
   `✓ spec proposed rev 2`). An agent run that completes without emitting any
   `agent.log` entries violates this contract.

5. **Structural attribution in `appendEvent`.** The top-level `agent` field
   must be derived from the validated payload itself — `payload.agent` for most
   types, or `chat.message.who` mapped to an agent id (`null` when `who` is
   `'dev'`) — never from an optional caller-supplied `opts` argument that
   callers can forget. The TypeScript overloads must make misattribution
   unrepresentable: a call that omits `agent` on a payload type that requires it
   should be a compile-time error.

### API
- GET  /features/:id/events           — SSE stream. Sends id: <seq> per event;
  honors Last-Event-ID header AND ?since=<seq> to replay missed events, then
  continues live. Heartbeat comment every 25s.
- GET  /features/:id/events/history   — JSON array (paginated) for initial load.
- POST /features/:id/approve          — valid only in AWAITING_APPROVAL; emits
  gate.resolved(approved) + advances machine.
- POST /features/:id/request-changes  { comment } — emits
  gate.resolved(changes_requested), appends comment as chat.message from dev,
  transitions back to DRAFTING_SPEC, and the comment is delivered to the Spec
  Agent as the next user message in its conversation.
- POST /features/:id/messages  — Chat with the Spec Agent. **Valid only in
  DRAFTING_SPEC.** In any other state (AWS_REVIEW, AWAITING_APPROVAL, PLANNING,
  etc.) the endpoint returns 409 `{ error: "Chat input is not accepted in <status>
  state" }` without invoking the model or persisting any message. The UI must
  surface this as a muted system message.
- Existing Phase 1 endpoints now emit events: chat.message for each user/agent
  message, usage.recorded per model call, artifact.committed on approval,
  gate.opened when spec is proposed (save_spec now moves machine to AWS_REVIEW;
  until the AWS agent exists in Phase 3, AWS_REVIEW auto-advances to
  AWAITING_APPROVAL after emitting one agent.log info event noting the skip).
- POST /features/:id/simulate — DEV ONLY (403 in production). Enqueues a BullMQ
  job that walks the machine from the feature's current state to DONE, emitting
  realistic events (agent.status transitions, 2-4 agent.log lines per agent,
  gate at AWAITING_APPROVAL that pauses until approve is called, usage.recorded
  samples) with 1-3s delays. Same event vocabulary as real agents will use.

### BullMQ
- One queue "agent-jobs". The simulator is its first consumer. Job payload
  { featureId, task } — keep the shape generic for Phases 3-5.

## Phase 2b — Command center UI (apps/web)
Implements docs/design/ui-design.md against the 2a API. Highlights (the design
doc is the full spec; follow its tokens, metrics, and animations):
- Three-region layout + top bar; solar mesh with orbits/planets/sun/beams;
  inspector with state-machine chips and per-agent event log; mission-control
  chat with approval gate card wired to approve/request-changes.
- All state derives from folding the event stream (history fetch + SSE tail).
  No timers driving phases. Reconnect resumes via Last-Event-ID.
- Planets render from the agent registry (data-driven: adding an agent to the
  registry must not require touching the mesh component beyond ring config).
- Ambient motion defaults OFF when prefers-reduced-motion; toggle in UI.
- Planets render at fixed angular positions derived deterministically from the
  agent registry (even distribution per ring, minimum angular separation, no
  position within ±25° of the sun's vertical axis at top/bottom). Orbital drift
  animation is not used. Ambient motion is limited to glow/pulse/shimmer effects.
  Every planet must remain fully inside the viewport at default layout dimensions,
  never be occluded by the sun, and connection beams must render as straight
  sun→planet lines beneath the planet disc.
- Phase 1 flows (create feature, chat, attach image, Figma link, spec preview,
  approve) remain available inside this UI — the old minimal UI is replaced.
- Agent and network errors that occur during a conversation must render
  visibly in chat as a muted system message; they must never fail silently.

## Acceptance criteria
2a (all verifiable via curl): ✅ verified 2026-07-17
- ✅ Given a new feature, when created, then its state is DRAFTING_SPEC and a
  phase.changed event with seq=1 exists.
- ✅ Given a spec conversation, when the agent calls save_spec, then events show
  gate.opened and the machine reaches AWAITING_APPROVAL (via Phase 3 AWS review;
  the Phase 2 auto-skip was replaced by the real AWS agent in Phase 3).
- ✅ Given AWAITING_APPROVAL, when POST /approve, then gate.resolved(approved),
  phase.changed to PLANNING, and artifact.committed events append; when
  POST /request-changes with a comment, then the machine returns to
  DRAFTING_SPEC and the Spec Agent's next reply addresses the comment.
- ✅ Given approve is called twice, the second returns 409 and appends nothing.
- ✅ Given curl -N on /events with Last-Event-ID=N, replay starts at N+1 then
  continues live; killing and restarting the server mid-stream loses no events.
- ✅ Given POST /simulate, when the run pauses at the gate and is approved, then
  the stream shows the full vocabulary through DONE, and folding all events
  reproduces the design's phase/status table exactly.
- ✅ Every model call emits usage.recorded. All Phase 1 acceptance criteria still
  pass. npm test green; no node:sqlite remains.
2b: ✅ verified 2026-07-17
- ✅ Given a simulated run in the browser, the sun/planets/chips/log/chat update
  live per the design; refresh mid-run restores identical state (event replay).
- ✅ Approval card appears at the gate; APPROVE and REQUEST CHANGES both work
  end-to-end. Given prefers-reduced-motion, ambient motion starts off.

## Out of scope
- Real AWS/dev/review/test agent logic (Phases 3-5). Bedrock provider switch
  (stub ANTHROPIC_PROVIDER env only). Auth. Multi-run history UI. Deployment.
