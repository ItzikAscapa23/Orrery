# Orrery — PRD

Thin index. The detailed specs are the real source of truth and live in
`docs/specs/`. This file exists so `plan.md` phases can cite stable requirement
numbers instead of paraphrasing.

**Do not duplicate spec content here.** Add a pointer.

---

## 1. Problem

Feature work against real repositories is slow and inconsistently specified.
Orrery takes a business requirement through spec → AWS review → plan → test plan
→ per-task test-first implementation → code review → testing → an open pull
request, with a human approval gate at every phase.

It works against real repositories: it clones them, runs their actual test
suites inside a container, writes commits, and opens PRs. It is not a demo
harness.

Full statement: `docs/specs/00-project-overview.md`.

---

## 2. Constraints

- **C1** TypeScript strict everywhere, Node 20+. No default exports. Zod for all
  external input (HTTP bodies, model JSON output, env vars).
- **C2** Every Anthropic call routes through `apps/server/src/lib/anthropic.ts`,
  which logs token usage. Never call the SDK directly from feature code.
- **C3** Agent shell execution happens inside Docker with `--network none`.
  The container is a load-bearing security boundary.
- **C4** Git remote is Azure DevOps. PRs go through the ADO REST API, not GitHub.
- **C5** Secrets via env only. `NODE_*` vars must be shell-level, never in `.env`.
- **C6** One source of truth. Duplicated logic has caused five defects in this
  project. A fix touching a rule that may exist elsewhere requires an audit and
  the full list of occurrences, not a summary.
- **C7** Declared over inferred. Manifest config beats prose inference. Two long
  defects came from inferring the test runner from CLAUDE.md and inferring job
  type from a counter.

---

## 3. Requirements

- **R1** The spec is the source of truth. Agents work from artifacts
  (`spec.md`, `plan.md`, `contract.yaml`), never loose chat history.
- **R2** The orchestrator is deterministic. Intelligence lives in agents,
  reliability in the orchestrator. Transitions happen only through the
  orchestrator module.
- **R3** Every agent action is an event, appended to the log and streamed to the
  UI. The UI derives all state by folding the event stream and never talks to
  agents directly.
- **R4** Humans gate the expensive steps. Agent-to-agent loops are capped before
  escalating to a human.
- **R5** Contract-first parallelism. Client and server agents share an OpenAPI
  contract generated from the approved spec. The contract is law; changes go
  through the amendment gate.
- **R6** Agent spend is bounded and observable. Output tokens are the cost;
  input is effectively free once caching works. A task past a cumulative turn
  threshold parks rather than re-running.
- **R7** Test coverage is authored, not assumed. `TEST_PASS` requires that the
  test agent actually wrote tests this run, discriminated by commit trailer.
- **R8** A task has exactly one live agent. Dispatch records the queue job
    identity before the task is observable as running; no recovery path may
    enqueue for a task that already has one.
- **R9** The test gate judges the delta, not the absolute. A failure that
  predates the agent's work is not the agent's failure.

Spec detail per subsystem:

| Area | Spec |
|---|---|
| Overview, principles | `docs/specs/00-project-overview.md` |
| Spec agent | `docs/specs/01-spec-agent.md` |
| Orchestrator, event log, UI | `docs/specs/02-orchestrator.md` |
| AWS expert agent | `docs/specs/03-aws-agent.md` |
| Dev agents | `docs/specs/04-dev-agents.md` |
| Review + test agents | `docs/specs/05-review-test-agents.md` |
| Phase 6 backlog | `docs/phase-6.md` |

---

## 4. Non-goals

- Orrery does not replace human review. Every phase gate is deliberate.
- No post-hoc redundancy detection or automatic deletion of agent output. Where
  agents produce redundant work, the fix is giving them context they lack.
- No GitHub PR integration.

---

## 5. Open questions

- **Q1** Specs 02 and 05 are behind the code by roughly two phases. States
  `AWAITING_PLAN_APPROVAL`, `PLANNING_TESTS`, `AWAITING_TEST_PLAN_APPROVAL`, the
  light path, the spend guard, the amendment gate, `task_acceptance_gate`, and
  the ADO PR job have no spec coverage. Spec 02 still documents the original
  seven-state machine and says AWS_REVIEW auto-advances.
- **Q2** `docs/specs/05` OQ1 (diff budget granularity), OQ4 (findings panel
  `repo` field scope) and OQ5 (cost attribution for synthetic bounce-back tasks)
  were deferred to Phase 6 and never closed.
- **Q3** The `bff` skill at `.claude/skills/orchestrator-server.md` is gitignored
  and points at `docs/architecture/bff.md`, also gitignored. No fresh checkout
  has either. Needs the same committed-example treatment as `repo-manifest.yaml`.
