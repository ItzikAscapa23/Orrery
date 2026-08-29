# Phase 6 — Backlog

Items carried forward from Phase 5 closeout. Closed items are deleted on close;
evidence lives in the phase commit recorded in HANDOVER.md's phase log.
Severity labels: C = correctness, O = observability.

---

## Correctness

**C-3. `detectJsonCommand` infers test runner from CLAUDE.md prose.** `MITIGATED`
`testJob.ts:360-379`. `probe_command` from `repo-manifest.yaml` is now the
primary source and is passed as the first argument to `detectJsonCommand`.
CLAUDE.md inference (`lower.includes('jest')`) is a fallback-only path used
only when no `probe_command` is set. The original bug (jest repo mentioning
vitest → wrong runner) only triggers on repos without `probe_command`. Fix:
ensure `probe_command` is set in `repo-manifest.yaml` for every repo; the
inference fallback should be removed in a future phase.

---

## Observability / API hygiene

**O-12. Duplicate `pr.created` event / duplicate ADO PRs.** `WATCH LIST`
Phase 9 diagnosis: `createAdoPrJob.ts:146-154` builds `alreadyCreated` once at
job start from existing `pr.created` events, then loops per repo. The ADO API
call and `appendEvent(pr.created)` are NOT in the same DB transaction. If the
job fails after the ADO API call succeeds but before the event is appended
(network timeout, Bedrock error, process crash), BullMQ retries the job. On
retry, `alreadyCreated` is empty → second PR created → second event appended.
The confirmed duplicates (ping-feature PRs #89905/#89906, coin-flip PR #89853)
fit this pattern. Fix: re-query existing `pr.created` events inside the
per-repo loop (after the set is built), immediately before the ADO API call.
Not fixed.
