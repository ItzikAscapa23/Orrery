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

