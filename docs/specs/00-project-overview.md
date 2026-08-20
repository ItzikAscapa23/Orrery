# Orrery — Project Overview

## What this is
Orrery is a multi-agent system that implements Spec-Driven Development (SDD)
for building mobile features. A developer describes a business requirement (with Figma
links or screenshots) in a web UI, collaborates with a Spec Agent to produce a feature
specification, approves it, and then a pipeline of AI agents implements the feature
across two real codebases: a React Native client and a NodeJS server (deployed on AWS).

## Core principles (apply to every phase)
1. The spec is the source of truth. Agents work from artifacts (spec.md, plan.md,
   contract.yaml), never from loose chat history.
2. The orchestrator is deterministic. It is a state machine; intelligence lives in
   the agents, reliability lives in the orchestrator.
3. Every agent action is an event. Events are appended to an event log and streamed
   to the UI. The UI never talks to agents directly.
4. Humans gate the expensive steps. Spec approval is a hard gate. Loops between
   agents are capped (max 3 iterations) before escalating to the human.
5. Contract-first parallelism. Client and server agents share an OpenAPI contract
   generated from the approved spec. The contract is law.

## System components
- Web UI (React): chat with Spec Agent, attach Figma links/screenshots, approve
  specs, watch a live progress timeline per feature.
- API server (NodeJS + Fastify, TypeScript): REST + SSE, orchestrator, agent runners.
- Orchestrator: feature state machine
  DRAFTING_SPEC -> AWS_REVIEW -> AWAITING_APPROVAL -> PLANNING -> IMPLEMENTING
  -> CODE_REVIEW -> TESTING -> DONE (with loop-back transitions on failure).
- Agents:
  - Spec Agent (Messages API, vision): interviews the developer, produces spec.md.
  - AWS Expert Agent (Messages API, JSON output): reviews spec, proposes edits.
  - Client Dev Agent (Claude Agent SDK): implements in the React Native repo.
  - Server Dev Agent (Claude Agent SDK): implements in the NodeJS repo.
  - Review Agent (Messages API): reviews git diffs against the spec.
  - Test Agent (Claude Agent SDK): writes/runs unit tests from acceptance criteria.
- Storage:
  - Postgres: features, phases, events, token usage.
  - Artifacts git repo: one folder per feature containing spec.md, plan.md,
    contract.yaml; every revision is a commit.
- Codebase access: per-feature git branch + worktree in the client and server
  repos; agents work only inside their worktree; output is a pushed branch + PR.

## Tech constraints
- TypeScript everywhere (strict mode). Node 20+.
- Fastify for HTTP, SSE for streaming progress to the UI.
- BullMQ + Redis for agent job queue.
- Postgres via Prisma (or Drizzle — decide in Phase 2 plan and record the decision here).
- Anthropic Messages API for chat/review agents; Claude Agent SDK for coding agents.
- Agent jobs that execute shell commands run inside Docker containers.
- Log token usage from every API response from day one.

## Build phases
- Phase 1 (docs/specs/01-spec-agent.md): Spec Agent chat + minimal UI + spec artifact.
- Phase 2: Orchestrator state machine, Postgres, event log, SSE progress timeline.
  ✅ verified 2026-07-17 (see docs/specs/02-orchestrator.md acceptance criteria).
- Phase 3: AWS Expert Agent with structured JSON findings + accept/reject UI.
  ✅ verified 2026-07-17 with recorded deviations — see docs/specs/03-aws-agent.md
  acceptance notes + Open questions (OQ1 retry policy, OQ2 rev semantics) and
  scripts/phase3-test-report.md.
- Phase 4: Dev agents on real codebases (contract generation, worktrees, PRs).
  ✅ verified 2026-07-26 — five slices closed; service-status shipped across
  three repos with three PRs from a single conversation through all gates.
- Phase 5: Review Agent + Test Agent replacing the CODE_REVIEW/TESTING
  auto-advance stubs. Real git-diff review against spec; capped fix loops;
  findings feed back into the IMPLEMENTING loop before the branch is promoted.
  ✅ Fully verified 2026-08-01 — Slice 5a: real bounce-back, round cap, human
  gate, simulator sub-paths, evidence-cited blockers, artifact-incoherence
  escalation confirmed live. Slice 5b: structured JSON test parsing,
  authored-test gating (commit-trailer discriminant), six test-card variants,
  skipped-gate semantics, stable finding IDs. All 11 5b acceptance criteria
  checked; 7 items shipped beyond spec. Carried defects (17 items) logged in
  docs/phase-6.md.
- Phase 6: Cost dashboard — token usage aggregated over anthropic_usage events,
  per-feature and per-agent breakdown rendered in the UI.
  ✅ Verified 2026-08-02 — usage instrumentation, time-aware rate table, cost
  endpoint (per-feature + global), CostCard UI with live refetch on usage events
  and staleness timestamp. Four BLOCKING items resolved (C-1, C-2, U-16, U-17).
  12 STANDING/WATCH items + 1 intermittent failure carried to Phase 7 backlog
  (docs/phase-6.md).

Each phase has its own spec file. Do not implement ahead of the current phase.

## Non-goals (for the whole project, v1)
- No multi-user auth or team features; single developer, local usage.
- No deployment pipeline for the generated features; output is a PR.
- No support for codebases other than the configured RN client and Node server.
