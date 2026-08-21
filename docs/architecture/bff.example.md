# BFF Architecture — Orrery

*This is a committed example. The operator's actual `bff.md` is gitignored —
copy this file to `docs/architecture/bff.md` and update it for your deployment
(product name, port, route list). Same treatment as `docs/agents/repo-manifest.example.yaml`.*

---

## What Is the BFF Here?

`apps/server` is the Backend-for-Frontend. It is the sole API surface for `apps/web`; there is no public API, no gateway, no separate microservice layer. The server co-locates:

- **State machine** — feature lifecycle transitions (DRAFTING_SPEC → … → DONE)
- **Job dispatch** — BullMQ queues driving agent jobs (plan, dev, review, test, PR)
- **Artifact management** — git-backed storage for spec.md, plan.md, contract.yaml
- **Event fan-out** — append-only DB event log with in-process SSE pub/sub for live UI
- **LLM gateway** — all Anthropic/Bedrock calls routed through `lib/anthropic.ts`

The web client talks exclusively to `localhost:3001` (Vite dev proxy rewrites `/api/*`). There is no direct DB access, no direct LLM access, and no direct git access from the frontend.

---

## Component Map

```
┌─────────────────────────────────────────────────────────┐
│  apps/web (React SPA, port 5173)                        │
│                                                         │
│  useFeature.ts ──► GET /api/features                    │
│  useEventStream.ts ──► GET /api/features/:id/events     │  SSE
│                    └─► GET /api/features/:id/events/history
│  MissionControl ──► POST /api/features/:id/messages     │  SSE (streaming spec agent)
│  ApprovalGate   ──► POST /api/features/:id/approve      │
│  PlanGate       ──► POST /api/features/:id/approve-plan │
│  AmendmentGate  ──► POST /api/features/:id/approve-amendment
│  Inspector      ──► renders foldEvents(events) state    │
└─────────────────────────────────────────────────────────┘
             │ all calls via Vite proxy /api → :3001
             ▼
┌─────────────────────────────────────────────────────────┐
│  apps/server (Fastify, port 3001)                       │
│                                                         │
│  ┌─ Routes (17 plugins) ──────────────────────────────┐ │
│  │  features, featureMessages, featureApprove,        │ │
│  │  featureEvents, featureArtifacts, featureAttachments│ │
│  │  featureFindings, featurePlanGate, featureAmendment │ │
│  │  featureCost, featureRetryPr, featureRetryBounce   │ │
│  │  featureReviewGate, featureTestGate, featureRedispatch│ │
│  │  featureSimulate (dev/test only), health           │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌─ Core Lib ─────────────────────────────────────────┐ │
│  │  orchestrator.ts   state-machine (transitions)     │ │
│  │  dispatch.ts       dispatchForState / dispatchJob  │ │
│  │  events.ts         DB append + in-process pub/sub  │ │
│  │  artifacts.ts      git-backed spec/plan/contract   │ │
│  │  anthropic.ts      Bedrock/Anthropic SDK + logging │ │
│  │  worktree.ts       git worktree management         │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌─ Jobs (BullMQ) ────────────────────────────────────┐ │
│  │  agentWorker.ts    single worker, routes by type   │ │
│  │  plannerJob, devJob, serverDevJob, clientDevJob    │ │
│  │  reviewJob, testJob, awsReviewJob                  │ │
│  │  createAdoPrJob, simulatorJob, testingStubJob      │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
             │
             ▼
   ┌─────────────────┐   ┌───────────┐
   │  Postgres 16    │   │  Redis 7  │
   │  (Prisma ORM)   │   │  (BullMQ) │
   └─────────────────┘   └───────────┘
             │
             ▼
   packages/shared  (@orrery/shared)
   ─ Zod schemas: Feature, Event payloads (22 types), Agent ids
   ─ Imported by BOTH server and web — single source of type truth
```

---

## Transport Modes

The server uses two transport modes. Every endpoint uses one of them.

### 1. JSON REST

Standard request/response. Used for CRUD and all operator actions (approve, reject, retry).

```
POST /features               → create feature → 201 { id, status }
GET  /features               → list all       → 200 Feature[]
GET  /features/:id           → single         → 200 Feature
POST /features/:id/approve   → state transition (AWAITING_APPROVAL → PLANNING)
POST /features/:id/approve-plan
POST /features/:id/approve-amendment
POST /features/:id/reject-amendment
POST /features/:id/approve-review
POST /features/:id/retry-review
POST /features/:id/approve-test
POST /features/:id/retry-test
POST /features/:id/retry-pr
POST /features/:id/retry-bounce
POST /features/:id/redispatch
POST /features/:id/findings/:findingId/accept
POST /features/:id/findings/:findingId/dismiss
GET  /features/:id/artifacts/:kind   (kind: spec | plan | contract)
GET  /features/:id/attachments
GET  /features/:id/cost
GET  /cost
GET  /health
GET  /health/connectivity
```

### 2. Server-Sent Events (SSE)

Used for live data: agent output streaming and run-state updates. The client never polls.

```
GET  /features/:id/events?since=<seq>
  → persistent SSE stream, replays from seq, delivers new EventRow on each agent event

GET  /features/:id/events/history?limit=500
  → one-shot JSON array of all past EventRow[]

POST /features/:id/messages            (multipart, spec-agent chat)
  → SSE stream: token-by-token chat.message events while spec agent is running

POST /features/:id/attachments         (multipart file upload)
  → 201 JSON on completion (not SSE)

POST /features/:id/approve             → SSE stream (spec agent re-runs on request-changes path)
POST /features/:id/request-changes     → SSE stream (same)
```

---

## Event System

All persistent state in the UI is derived from an ordered event log — not from REST responses.

### Server side (`lib/events.ts`)

- Every state-machine transition, agent action, gate change, and LLM usage emits an `EventRow` appended to the `events` Postgres table (seq, featureId, agent, createdAt, payload JSON).
- An in-process pub/sub (EventEmitter keyed by featureId) fans each row to open SSE connections for that feature.

### Client side (`lib/eventFold.ts`)

`foldEvents(events: EventRow[]): RunState` is a **pure reducer** — it replays the full event history from the beginning and derives all UI state:

| Derived state | Driven by events |
|---|---|
| `currentPhase` | `phase.changed` |
| `agentStatuses` | `agent.status` |
| `chatEntries` | `chat.message` |
| `gateOpen` | `gate.opened` / `gate.resolved` |
| `planGateOpen` | `plan.proposed` / `gate.resolved{plan_approval}` |
| `amendmentGateOpen` | `contract.amendment.proposed` / `gate.resolved{amendment}` |
| `findings` | `review.findings` / `test.report` / `finding.resolved` |
| `testReport` | `test.report` |
| `taskFailures` | `task.failed` |
| `prLinks` | `pr.created` |
| `usageTotal` | `usage.recorded` |
| `eventLogsByAgent` | `agent.log`, `agent.status`, `phase.changed`, `pr.created`, etc. |

Because `foldEvents` is pure and idempotent, reconnection is safe: the client fetches full history, folds it to reconstruct UI state, then opens a live SSE tail.

```
useEventStream(featureId)
  └─ 1. GET /events/history → EventRow[]
  └─ 2. new EventSource(/events?since=<lastSeq>)
  └─ 3. setEvents([...history, ...live])

foldEvents(events)  ← called on every render with the full accumulated array
```

---

## State Machine

`lib/orchestrator.ts` defines all legal transitions as a static lookup table `TRANSITIONS`.
See `docs/specs/02-orchestrator.md § Current system state` for the full current machine.
The short version:

```
DRAFTING_SPEC → AWS_REVIEW → AWAITING_APPROVAL → PLANNING
  → AWAITING_PLAN_APPROVAL → PLANNING_TESTS → AWAITING_TEST_PLAN_APPROVAL
  → IMPLEMENTING → CODE_REVIEW → TESTING → DONE

Light path: DRAFTING_SPEC → AWAITING_APPROVAL → LIGHT_IMPLEMENTING → CODE_REVIEW → DONE
```

`applyTransition(tx, featureId, currentStatus, event)` validates, updates `feature.status`,
and returns the next state — always inside a Prisma transaction that also appends `phase.changed`.

---

## Job Dispatch

`lib/dispatch.ts → dispatchForState(featureId, state, feature)` is the single source of truth
for "entering state X enqueues job Y". Never call `enqueueJob` directly from route handlers.

**One worker rule:** `jobs/agentWorker.ts` is the sole BullMQ Worker. It routes by `job.name`
to the correct handler. Never add a second Worker on the same queue.

---

## Shared Contract (`packages/shared`)

`@orrery/shared` is the single source of truth for all cross-boundary types. Both the server
(writes events, reads route bodies) and the web (reads events, renders state) import from it.

Key exports:
- `FeatureSchema` / `FeatureStatusSchema` — DB row shape + status enum
- `EventPayloadSchema` — Zod discriminated union of all event payload types
- `EventRowSchema` — wraps payload with seq, featureId, agent, createdAt
- `AgentIdSchema` / `AGENT_REGISTRY` — canonical agent ids and display metadata

Adding a new event type requires editing `packages/shared/src/types/events.ts` first.
Never add payload types unilaterally in server or web.

---

## Key Invariants

1. **One BullMQ Worker** per queue — a second Worker causes silent no-op races.
2. **`applyTransition` always runs inside a DB transaction** that also appends `phase.changed`.
3. **`foldEvents` is pure** — no side effects; reconnection relies on full idempotent replay.
4. **Finding lookups are composite** — `(featureId, specRev, id)` — never plain `id`.
5. **All LLM calls go through `lib/anthropic.ts`** — never call the SDK directly.
6. **`@orrery/shared` is the type contract** — both sides must agree; imported as TypeScript directly.
