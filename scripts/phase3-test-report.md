# Phase 3 — AWS Expert Agent: end-to-end test report

Date: 2026-07-17 · Operator: Itzhak · Driver: Claude (Cowork session)
Stack: local dev server (Fastify + tsx), Bedrock provider (corporate inference
profile, actual model `claude-sonnet-4-6`), Postgres + Redis via docker-compose.

## Scenario
Deliberate bait feature to test charter enforcement:

> **feedback-widget** — "Users can submit feedback text from the app. Store
> submissions in DynamoDB and email a weekly digest to the product team via
> SendGrid."

Bait: DynamoDB (explicitly not-yet-approved in the charter) + SendGrid
(non-AWS third-party service). Scripts: `bait-test.sh` (create → spec →
review), `gate-test.sh` (gate/accept/dismiss/approve), `failpath-test.sh`
(review-failure resilience).

## Runs

| Run | What | Outcome |
|---|---|---|
| 1 | bait-test, first attempt | Spec Agent `working → failed` ×4, zero `usage.recorded` — expired local AWS credentials, no model call ever succeeded. Not a Phase 3 defect. Feature never left DRAFTING_SPEC. |
| 2 | bait-test after credential fix | Spec proposed on first message (bait intact: DynamoDB ×6, SendGrid ×4 in spec). Review: 11 findings (4 blockers / 6 warnings / 1 suggestion). Both baits flagged. |
| 3 | bait-test (fresh feature, post-DB-reset) + gate-test | Review: 14 findings (6 / 6 / 2). Both baits flagged; implied EventBridge also correctly caught as off-charter. Gate flow: 11/11 checks passed. |
| 4 | failpath-test | Charter hidden → review job failed → machine still reached AWAITING_APPROVAL. 5/5 checks passed. Charter restored and verified. |

## Box results

- **Bait detection** — PASS every run. DynamoDB and SendGrid flagged at
  warning+ with board-sign-off language; the agent recommended SES while
  correctly noting SES is itself not on the approved list.
- **Box 4: approve refuses with unresolved blockers** — PASS.
  `409 {"error":"6 blocker finding(s) must be resolved before approval"}`.
- **Box 5: two consecutive suggested-text accepts** — PASS with note.
  Both accepts 200; `proposed_spec` mutated after each (hash-verified).
  `spec.revised` revs were `[1, 1]` — rev = review-cycle number by design of
  the pinning logic, so it does not increment per accept (spec 03 OQ2).
- **Box 6: dismiss remaining blockers → approve unlocks** — PASS.
  4 dismissals with reasons (severity-inflation rationale included), approve
  200, `gate.resolved(approved)`, `artifact.committed` (features/
  feedback-widget/spec.md @ c8d818f), `phase.changed → PLANNING`.
- **Box 7: review failure never bricks the feature** — PASS with note.
  Injection: charter file hidden (re-read per review; Spec Agent unaffected).
  Verified: `agent.status(failed)`, muted log "· AWS review unavailable —
  proceeding without findings", no `review.findings`, `gate.opened` without
  counts, machine at AWAITING_APPROVAL. Note: fails ONCE, not twice — the
  spec'd BullMQ retry is not implemented (spec 03 OQ1).

## Contract compliance (all runs)
JSON-only findings validated by Zod (unique ids, sections reference real spec
headings); `agent='aws'` attribution on all events; status lifecycle
working → done|failed; log lines per step; `review.findings` lands before the
AWAITING_APPROVAL transition; `gate.opened` counts match findings exactly;
`usage.recorded` per model call — including a visible parse-retry (first call
truncated at max_tokens=2048 → second call with the error fed back).

## Deviations & follow-ups
1. **BullMQ retry missing** (OQ1) — `enqueueJob` sets no `attempts`; job
   catches internally and never rethrows. Fix or amend spec.
2. **Rev semantics** (OQ2) — per-cycle, not per-accept. Amend criterion
   wording (recommended) or change code.
3. **Reviewer variance / severity inflation** (OQ3) — 11/4 vs 14/6 findings on
   the identical spec; duplicate blocker+warning pairs; absence-of-statement
   blockers. Charter "Finding calibration" section added 2026-07-17. Regression
   tests must assert properties, never counts.
4. **max_tokens=2048 in awsAgent.ts** — observed truncation forced the retry
   path, doubling review cost. Consider raising.
5. **Criterion 5 (request-changes → fresh review)** — not covered by the
   scripted suite; exercised interactively earlier. Re-verify before final
   check-off if in doubt.

## Evidence
`scripts/run2-events.json` (bait run), `scripts/bait-events.json` +
`scripts/bait-feature.json` (run 3 bait), `scripts/run3-events.json` +
`scripts/run3-feature.json` (gate flow), `scripts/run4-events.json` +
`scripts/run4-feature.json` (failure path).

## Addendum — criterion-5 live run (run 5, 2026-07-17)

`scripts/recheck-test.sh` on the fixed code (composite finding identity,
cycle-scoped approve gate, retry policy, single dispatcher worker):

- Review 1 (rev 0): 8 findings, 1 blocker — the calibrated charter visibly
  worked (one finding per issue, absence-of-statement issues at warning,
  ElastiCache/DAX caught inside an open question).
- request-changes (bait removed) → Spec Agent re-proposed → review 2 (rev 1):
  6 findings, 0 blockers.
- Supersession PROVEN: rev-0 blocker f1 left unresolved; approve returned 200
  gated only by rev-1 findings; feature reached PLANNING.
  Evidence: scripts/run5-events.json.
- Learning: finding labels restart at f1 each cycle; accept/dismiss resolve a
  label against the CURRENT cycle by design, so the 409-stale path applies
  only to labels absent from the current cycle. recheck-test.sh updated
  accordingly.
- Defect (c) discovered en route: two task-filtered BullMQ workers raced on
  the agent-jobs queue and no-op'd each other's jobs (features wedged in
  AWS_REVIEW). Fixed with the single dispatcher (jobs/agentWorker.ts).

With this run, all Phase 3 acceptance criteria are verified.

## Reproduce
```bash
./scripts/bait-test.sh      # park a bait feature at the gate
./scripts/gate-test.sh      # boxes 4-6 (auto-finds the parked feature)
./scripts/failpath-test.sh  # box 7 (self-contained; restores charter on exit)
```
