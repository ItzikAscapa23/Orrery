# Phase 6 — Backlog

Items carried from Phase 5 closeout. All are pre-diagnosed; none blocked
5b shipping. Severity labels are informal: C = correctness, R = representation,
O = observability, U = UI/state.

Priority tiers (orthogonal to thematic sections): **BLOCKING** — can let bad code
through or make the boot ritual unsatisfiable; **WATCH LIST** — diagnosis incomplete,
confidence marker present; **STANDING** — known, non-urgent.

---

## Gate & pipeline integrity

**C-1. Review findings never deleted on re-review.** ✅ DONE (3734edf) `BLOCKING`
`reviewJob.ts` / `awsReviewJob.ts` upsert but have no `deleteMany`. Round 1
raises f1+f2; round 2 raises only f1 → f2 survives at the same `specRev` with
`resolution: null`, blocking `approve-review` on a finding the current round
doesn't report. Nothing in the event log explains it.

**C-2. Resolution reset silently discards operator decisions.** ✅ DONE (3734edf) `BLOCKING`
0a394cf sets `resolution: null, reason: null` on re-review at the same
`specRev`. A human dismissal (with its reason) is wiped with no event
recording that it happened.

**U-16. `activeCount` conflates `working` with `waiting`.** ✅ DONE (99b655c) `BLOCKING`
`apps/web/src/components/TopBar.tsx:45-47`. `working` means "don't interrupt";
`waiting` means "a human is the blocker". One number can't carry both, and the
boot ritual's "0 ACTIVE" precondition is unsatisfiable whenever any feature
parks at a gate.

**U-17. `WORKER_CODE_COMMIT` stamped at launch, never refreshed.** ✅ DONE (0da753b, c498c2f) `BLOCKING`
`agentWorker.ts:26`, `apps/server/package.json:7`. Under tsx watch it certifies
process start time, not loaded code — it drifted three commits this session
(worker on ae36a0f, HEAD at 9ea013e) while the check nominally passed.
Re-evaluate `git rev-parse` at dispatch and compare.

---

## Phase 6 shipped

- **Usage instrumentation** — `anthropic_usage` events recorded on every API call (8bc9980, 1e12ced)
- **Rate table** — model_rates seed, time-aware lookup (629f8b4, 2e32244)
- **Cost endpoint + UI card** — GET /features/:id/cost, GET /cost, CostCard with live refetch on usage events and staleness timestamp (82a058f, 439883e, 4a0b424)

---

## Correctness

**C-3. `detectJsonCommand` infers test runner from CLAUDE.md prose.** `STANDING`
`testJob.ts:195-201`. `repo-manifest.yaml` already carries `probe_command`;
`package.json` carries `scripts.test`. A jest repo whose CLAUDE.md mentions
vitest gets `npx vitest run`, and npx will try to fetch a missing runner from
inside a network-isolated container.

**C-4. Double suite execution on reporter miss.** `STANDING`
`testJob.ts:401` then `412`. On any repo without a JSON reporter the entire
suite runs twice. `--outputFile` plus a file read removes both this and the
stdout-interleaving fragility.

**C-5. Fallback path never re-parses.** `STANDING`
`testJob.ts:412` re-runs `npm test` but `parsed` still holds the first
attempt's `parseError`. Result: exit code correct, counts `null`, `tests[]`
empty — on what is probably the most common real-world path.

**C-6. Nested test directories — unverified.** `WATCH LIST`
`resolveReal` realpaths the parent and re-appends the basename. If the parent
itself doesn't exist (`__tests__/acceptance/api.test.ts` where `acceptance/`
hasn't been created), behaviour is unknown; `mkdirSync(recursive)` runs after
the jail check so it can't help. Hypothesis — never tested.

---

## Representation

**R-7. `test.report` shares the review-counts vocabulary.** `STANDING`
`testJob.ts:470` — `counts: { blockers: failed, warnings: 0, suggestions: 0 }`.
Test failures flow into Phase 3's blocker-gating machinery, which means they
may be dismissible as review findings.

**R-8. Gate card header uses spec-approval copy on other gate types.** `STANDING`
"Spec revision #2 is ready for review" renders on `code_review` and
`test_report` gates. Body text is correct; the header isn't.

**R-9. `discoverTestDir`'s fallback is `console.warn` only.** `STANDING`
Never reaches the event log or UI. A guessed jail is exactly the thing an
operator needs to see. Return `{ dir, method }` and emit the `agent.log` from
`runTestJob`, which has the `featureId`.

**R-10. Stale docblock at `maybeAdvance.ts:13`.** `STANDING`
Describes a `CODE_REVIEW → TESTING → DONE` auto-advance the code no longer
has (the accurate comment is at 42–45).

---

## Observability / API hygiene

**O-11. `/features/:id/events/history` caps at 100 events silently.** ~~WATCH LIST~~ RESOLVED
The route accepts a `limit` query param (default 100); the client (`useEventStream.ts`) passes
`limit=500`. The alarm was the default cap, not a missing param. Residual: 500 is still a
ceiling — an initial-history baseline for a long-running feature is silently truncated beyond
event 500. Not blocking.

**O-12. Duplicate PR opened event.** `STANDING`
Confirmed on the ping-feature run: PRs #89905 and #89906 each emitted two identical
`pr.opened` events. Root cause not yet diagnosed. (Earlier instance: PR #89853 in the
coin-flip run.)

**O-13. `POST /simulate` has no status guard.** `STANDING`
Returned 202 and enqueued a no-op job against a feature already at `DONE`.
`retry-test` correctly 409s in the analogous case; simulate should too.

**O-14. Agent status not terminal on the gate-resolved path.** `WATCH LIST`
Final screenshot: Review Agent and Test Agent both `WAITING`, Spec Agent
`QUEUED`, on a feature the orchestrator reports `DONE`. May share a root with
U-16 (activeCount conflation), or may be a missing `agent.status: done`
emission — not diagnosed.

**O-15. AWS review returned 8 output tokens.** `WATCH LIST`
1843 in / 8 out on the coin-flip run — that's an empty findings array, not a
review. Plausibly correct for a trivial feature, plausibly a degenerate
response nobody would notice. Low confidence; Phase 3 territory.

---

## Phase 7 backlog (carried from Phase 6)

All 12 remaining STANDING / WATCH LIST items above carry forward unchanged:
C-3, C-4, C-5, C-6, R-7, R-8, R-9, R-10, O-12, O-13, O-14, O-15.

**Intermittent test failure (6b/2a, resolved 2026-08-02)** — featureFindings timeout; root cause was git subprocess at dispatch.ts module load; fixed by stubbing `_headCommit` in featureFindings.test.ts (6-U17-flake).

---

## Follow-up: derive agent display status from task rows (structural fix)

**7-o14** emits a corrective `agent.status(failed)` from the reconciler — a symptom fix.
The structural root cause is the same class of defect as the `activeCount` conflating
`working` with `waiting`: agent display state trusts the last `agent.status` event rather
than being computed from the current state of task rows. A future task should replace the
event-driven agent status read path with a query that derives status directly from
`task.status` aggregates — then no corrective event is needed and stale agent state
becomes impossible regardless of which code path moves a task.
