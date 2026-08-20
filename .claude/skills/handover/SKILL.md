---
name: handover
description: Close out a development phase by rewriting HANDOVER.md into a fresh-context-readable state file and committing the phase. Use this whenever the user types /handover, says "wrap up this phase", "write the handover", "close out phase 2", or asks you to record where a project stands before stopping. The phase skill invokes this automatically at the end of every phase. Also use it when a session is about to end mid-phase and the user wants the current state captured so someone else — or a future Claude with no memory of this conversation — can pick it up.
---

# Handover

Rewrite `HANDOVER.md` so a Claude with zero memory of this conversation can resume the
project, then commit the phase.

Write for that reader, not for the user sitting here. The user already knows what
happened today; the file exists for whoever doesn't. If a line would only make sense
to someone who watched the work happen, rewrite it or cut it.

## HANDOVER.md is a rolling file, not a log

There is exactly one `HANDOVER.md`. Each handover **rewrites** it — it does not
append. An ever-growing file gets skimmed instead of read, and by phase six that means
the resume context is being ignored precisely when it matters most.

History is preserved compactly in `## Phase log`: one line per completed phase with its
commit hash. Anyone needing more detail reads the commit. That's what commits are for.

Target: **under 200 lines**. If it's growing past that, the fix is deleting resolved
items, not tightening the wording.

## Step 1 — Gather

Before writing, collect:

- Which phase completed, its title, and whether it's genuinely `complete` or
  `in-progress`
- Verification commands run and their **actual** exit results
- Files created or modified this phase (`git status --short` if you have a shell)
- Decisions made, and why — especially where you chose between defensible options
- Assumptions taken instead of asking
- Anything still open, blocking or not
- Any PRD conflicts surfaced

## Step 2 — Write HANDOVER.md

Use `assets/HANDOVER.template.md` as the exact structure. Section order is fixed so it
can be read by position across phases.

Two sections need care:

**Project header** — written in phase 0, carried forward largely unchanged. Update it
only when something structural actually changed (new command, new top-level directory,
changed convention). Don't rewrite it each phase for cosmetic reasons; its stability is
what makes it trustworthy.

**Current phase progress** — this is the live checklist. On completing a phase, replace
it with the next phase's tasks, all unticked. On an in-progress handover, leave the
ticks exactly as they are — that's the resume point.

### What goes in Decisions vs Assumptions

- **Decision** — you weighed options and picked one, or the user chose. Record the
  choice *and the reason*, because the reason is what stops a later phase from
  quietly reversing it.
- **Assumption** — you needed an answer, it wasn't worth blocking on, you picked
  something reasonable. Flag it so the user can cheaply correct it.

Assumptions that turn out fine can be deleted at the next handover. Decisions persist.

### Honesty rules

- Record verification results as they actually happened. `not run (no shell)` is a
  legitimate value; a fabricated pass is not, and every later phase inherits the lie.
- If the phase is unfinished, `State: in-progress` and say what's left. There's no
  penalty for an honest partial phase and real cost to a false complete one.
- Don't editorialise about quality. "Auth middleware added, 12 tests passing" beats
  "successfully implemented a robust auth layer".

## Step 3 — Commit

Only after `HANDOVER.md` is written, and only if verification passed.

**Never commit a phase whose verification failed or didn't run.** If it failed, write
the handover with `State: in-progress`, skip the commit, and tell the user why.

```bash
git status --short          # review what's actually there
git add <explicit paths>    # the files this phase touched, plus HANDOVER.md
git commit -m "<message>"
```

**Stage explicit paths. Never `git add -A` or `git add .`** — those sweep up
`.env` files, credentials, build output, and unrelated work-in-progress. If something
unexpected shows up in `git status`, ask rather than staging it.

**Do not push.** Pushing is the user's call; a bad local commit is trivially fixable
and a pushed one isn't.

### Commit message format

```
<type>(phase-<N>): <what changed>

<1-3 lines: why, and anything notable>

Phase <N>: <title>
Verification: <command> <result>
```

**Example 1:**
Input: Phase 0 recon — mapped stack, recorded commands, created HANDOVER.md
Output:
```
chore(phase-0): establish project map and handover baseline

Recorded stack, build/test commands, and directory conventions.
No production code changed.

Phase 0: Recon and groundwork
Verification: npm ci && npm run build — passed
```

**Example 2:**
Input: Phase 2 added JWT auth middleware and 12 tests
Output:
```
feat(phase-2): add JWT auth middleware

Middleware validates bearer tokens and returns 401 on missing or
expired tokens. Refresh-token rotation deferred to phase 3 per R9.

Phase 2: Authentication
Verification: npm test — 12 passed
```

Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`.

### No shell available

Write `HANDOVER.md`, then print the exact commands for the user to run:

```
Run this to commit:
git add src/auth/middleware.ts src/auth/verify.ts HANDOVER.md
git commit -m "feat(phase-2): add JWT auth middleware"
```

Record `Commit: pending (run locally)` in the phase log and set `State: in-progress`
until verification has actually run.

## Step 4 — Report back

Three or four lines, no more: phase completed, verification result, commit hash (or
why there isn't one), and what the next phase is. Then stop — don't start the next
phase.

## Reference files

- `assets/HANDOVER.template.md` — the exact file structure to write
- `assets/command.md` — thin `/handover` slash-command wrapper for Claude Code
