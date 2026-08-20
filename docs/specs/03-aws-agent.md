# Phase 3 — AWS Expert Agent

## Goal
AWS_REVIEW stops auto-skipping. When a spec is proposed, the AWS Expert Agent
reviews it against an operator-maintained charter, returns structured findings,
and the developer resolves them in the UI before the approval gate unlocks.
First real non-chat agent; establishes the reviewer-agent pattern for Phase 5.

## Charter document (operator-maintained)
- docs/agents/aws-charter.md, versioned in the repo, written/maintained by the
  tech lead (NOT by any agent). Contents: the agent's mandate, the list of
  approved AWS services with one-line usage notes, and bank-specific concerns
  (e.g. data residency, encryption expectations). Scaffold an initial file with
  placeholder sections and a TODO for the operator to fill the service list.
- The agent's system prompt is composed of: role definition + the charter file
  contents + output-format contract. Charter changes require no code changes.

## Agent runtime
- Raw Anthropic Messages API via src/lib/anthropic.ts (usage logged as always).
- Runs as a BullMQ job on queue "agent-jobs" ({ featureId, task: 'aws-review' }),
  enqueued by the orchestrator on entering AWS_REVIEW.
- Input: the proposed spec markdown + feature name/requirement.
- Output: JSON only — validated with Zod, retried once on parse failure with
  the validation error included; second failure = job failure.
- Follows the Agent activity contract (02-orchestrator.md): agent.status
  working -> done|failed, agent.log lines for meaningful steps, agent='aws'.
- Failure policy: BullMQ retries the job once. On persistent failure the
  machine still advances to AWAITING_APPROVAL, emitting agent.status(failed)
  and an agent.log warning "AWS review unavailable — proceeding without
  findings"; review failure must never brick a feature. Failed status is not
  sticky: the next dispatch of any agent resets its status via the normal
  working transition.
  **✅ Implemented 2026-07-17 (OQ1 resolved): enqueue uses attempts: 2 with
  exponential backoff; the job rethrows on non-final attempts and advances
  without findings only on the last one. Covered by reviewCycle.test.ts.**

## Findings
Zod schema (packages/shared):
  { id: string, severity: 'blocker'|'warning'|'suggestion', section: string,
    issue: string, suggested_text?: string }
- section references a heading of the spec template.
- suggested_text is concrete replacement/addition markdown; optional (a
  finding may be advisory). Accept is only offered when it exists.
- Findings referencing services not in the charter's approved list must be
  emitted (severity >= warning) when the spec implies such a service.

New event types (payload schemas in packages/shared):
- review.findings   { agent: 'aws', spec_rev: number, findings: Finding[] }
- finding.resolved  { finding_id, resolution: 'accepted'|'dismissed', reason? }
- spec.revised      { rev: number, cause: 'finding_accepted'|'changes_requested' }

## Machine & flow
- save_spec -> AWS_REVIEW: orchestrator enqueues the review job (remove the
  Phase 2 auto-skip and its log line).
- Findings persisted -> transition to AWAITING_APPROVAL (findings travel with
  the gate; gate.opened payload gains counts: { blockers, warnings, suggestions }).
- Resolution endpoints (valid only in AWAITING_APPROVAL):
  - POST /features/:id/findings/:findingId/accept — applies suggested_text to
    the proposed spec as a new revision (spec.revised event, proposed_spec
    cache updated in the same transaction), emits finding.resolved(accepted).
  - POST /features/:id/findings/:findingId/dismiss { reason } — reason is
    REQUIRED for blockers, optional otherwise.
- Gating: POST /approve returns 409 while any blocker is unresolved. Warnings
  and suggestions never block.
- request-changes still returns to DRAFTING_SPEC; when the Spec Agent proposes
  a new revision, AWS_REVIEW runs again against that revision (previous
  findings are superseded — old unresolved findings do not carry forward).

## Acceptance criteria
Verification 2026-07-17: scripted end-to-end runs against the live stack
(`scripts/bait-test.sh`, `scripts/gate-test.sh`, `scripts/failpath-test.sh`);
evidence in `scripts/run*-events.json` and `scripts/phase3-test-report.md`.

- ✅ Given a spec is proposed, when save_spec fires, then the AWS planet goes
  working and a review.findings event lands before AWAITING_APPROVAL.
  (agent.status working seq 9 → review.findings seq 13 → phase.changed seq 16.)
- ✅ Given the spec mentions an obviously non-charter service (seed the charter
  with a small approved list for the test), then at least one warning+ finding
  references it. (Bait spec with DynamoDB + SendGrid: both flagged warning+ in
  every run; run 3 additionally caught implied EventBridge as off-charter.)
- ✅ Given a blocker finding, when POST /approve is called, then 409; when the
  blocker is accepted (spec.revised appended, proposed_spec updated) or
  dismissed with a reason, then approve succeeds. (409 with 6 unresolved
  blockers; 2 accepted, 4 dismissed with reasons; approve then 200 → PLANNING.)
- ✅⚠ Given accept on a finding with suggested_text, then the rendered spec
  preview reflects the change and spec_rev increments. (Preview updates
  verified per accept; rev does NOT increment per accept — consecutive accepts
  in one review cycle share rev = gate.opened count. See Open questions OQ2.)
- ✅ Given request-changes and a re-proposed spec, then a fresh review runs and
  old findings no longer gate approval. (Live E2E 2026-07-17 via
  scripts/recheck-test.sh, evidence scripts/run5-events.json: two review
  cycles, rev-0 blocker f1 left unresolved, approve returned 200 gated only by
  rev-1 findings, feature reached PLANNING. Also unit-tested in
  reviewCycle.test.ts. Note: finding labels restart at f1 each cycle; the
  accept/dismiss routes resolve labels against the current cycle by design,
  and the 409-stale path applies to labels absent from the current cycle.)
- ✅ Given the review job fails twice, then the feature still reaches
  AWAITING_APPROVAL with agent.status(failed) and the warning log line.
  (Live failure injection 2026-07-17: charter hidden → machine reached
  AWAITING_APPROVAL with agent.status(failed), the "· AWS review unavailable"
  log, no review.findings, gate.opened without counts. The retry-once policy
  was implemented the same day — unit tests assert two failed statuses and
  advance-only-on-final-attempt. Note the log severity is `muted`, as the
  event vocabulary has no `warning` severity.)
- ✅ All agent events carry agent='aws' with correct attribution; usage.recorded
  emitted per model call. (Verified in event dumps; includes the parse-retry
  path emitting a second usage.recorded.) npm test green: ✅ 183/183 (22 files) incl. new reviewCycle.test.ts, 2026-07-17.

## Open questions
- **OQ1 — Review-job retry policy — RESOLVED (implemented 2026-07-17).**
  Decision: implement the spec as written. `enqueueJob` adds
  `{ attempts: 2, backoff: exponential 3s }` for aws-review jobs;
  `runAwsReviewJob` receives the attempt context from the worker
  (attempt = job.attemptsMade + 1) and rethrows on non-final attempts,
  running the advance-without-findings branch only on the last attempt.
  Each failed attempt emits agent.status(failed) ("fails twice" is now
  literally observable). Tests: reviewCycle.test.ts.

- **Defects found & fixed during Phase 3 verification (2026-07-17).**
  (a) *Finding identity collision*: the findings PK was the model-assigned
  id alone ("f1"), so any second review in the same database — re-review of
  the same feature or the first review of a second feature — crashed on a
  unique-constraint violation and the machine advanced review-less
  (fail-open). Fixed: composite identity `@@id([featureId, specRev, id])`
  (migration 20260717080000), route lookups scoped to feature + latest cycle.
  (b) *Approve gate counted stale blockers*: the unresolved-blocker count had
  no specRev scope, so after request-changes → re-review, old unresolved
  blockers gated approval forever, violating "old unresolved findings do not
  carry forward". Fixed: gate counts only current-cycle blockers via the
  shared gateOpenedCount helper (lib/reviewCycle.ts). Both covered by
  reviewCycle.test.ts.
  (c) *Worker race lost aws-review jobs* (found in the criterion-5 live run):
  two BullMQ Workers on the "agent-jobs" queue (simulator + aws-review), each
  filtering by task type — whichever grabbed a job first won, and a job
  grabbed by the wrong worker completed as a silent no-op, leaving the
  feature wedged in AWS_REVIEW with no findings and no failure events.
  Nondeterministic: earlier runs won the race, later runs lost it. Fixed:
  single dispatcher worker (jobs/agentWorker.ts) routing by task type;
  startSimulatorWorker/startAwsReviewWorker removed.
- **OQ2 — spec_rev semantics per accept vs per review cycle (2026-07-17).**
  Implementation sets `spec.revised.rev = count(gate.opened)` so all accepts
  within one review cycle share a rev (observed: [1, 1] for two consecutive
  accepts). The finding-staleness pinning in featureFindings.ts depends on
  cycle-scoped revisions. Decision needed: amend the acceptance criterion to
  "rev equals the review-cycle revision" (code stays), or make rev monotonic
  per accept while keeping pinning on gate.opened count. Current lean: amend
  the wording — pinning semantics are the load-bearing part.
- **OQ3 — Reviewer variance and severity calibration (2026-07-17).**
  Identical bait spec produced 11 findings / 4 blockers in one run and
  14 / 6 in another; one run emitted duplicate blocker+warning pairs for the
  same issue; absence-of-statement issues were sometimes escalated to blocker
  beyond the charter's intent. Mitigation applied: "Finding calibration"
  section added to docs/agents/aws-charter.md (one finding per issue at the
  highest applicable severity; blockers for concrete violations and explicit
  BLOCKER-if-missing concerns only; off-charter services are warnings unless
  a bank-specific concern is concretely violated). Monitor the next few
  reviews; if variance persists, consider few-shot examples in the charter.
  Regression tests should assert properties (bait services flagged warning+),
  never finding counts.

## Out of scope
- Real AWS API calls, cost estimation, IaC generation. Dev/review/test agents
  (Phases 4-5). Charter authoring UI (it's a markdown file). Bedrock switch.
