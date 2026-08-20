---
name: phase
description: Execute one phase of a phased development plan driven by a plan.md + PRD.md pair, ending in a handover and commit. Use this whenever the user types /phase, says "start the next phase", "run phase 3", "continue the plan", "let's do phase zero", or mentions working through a plan.md that is divided into phases. Also use it whenever a repo contains plan.md and HANDOVER.md and the user asks what to work on next, or asks you to implement something that a plan file already covers — even if they never say the word "phase". Prefer this skill over ad-hoc implementation whenever a plan.md exists.
---

# Phase

Execute exactly one phase of a phased plan: read it, resolve the unknowns with the
user, build it, prove the Definition of Done, then hand over.

The point of this workflow is that each phase leaves the project in a state a fresh
Claude with no memory of the conversation can pick up. That constraint drives every
rule below.

## The three artifacts

| File | Role | Mutable? |
|---|---|---|
| `PRD.md` | Why the project exists, what it must do, constraints | **Read-only** |
| `plan.md` | The phases, their tasks, their Definition of Done | **Read-only** |
| `HANDOVER.md` | All project state: where we are, what was decided, what's open | **The only file you write state into** |

Never write progress, status, checkmarks, or notes into `plan.md` or `PRD.md`. If you
do, the diff for "the plan changed" becomes indistinguishable from "we made progress",
and the spec stops being trustworthy. State lives in `HANDOVER.md`. Only the user
edits the spec.

If `plan.md` doesn't exist yet, don't improvise one silently — offer to scaffold it
from `assets/plan.template.md` and `assets/PRD.template.md` and get the user's sign-off
before treating it as spec. See `references/plan-format.md` for the structure this
skill expects.

## Step 1 — Establish where we are

1. Locate `plan.md`, `PRD.md`, `HANDOVER.md` (repo root first, then `docs/`).
2. **`HANDOVER.md` is the source of truth for current position.** Read
   `## Status` → `Current phase` and `State`.
   - No `HANDOVER.md` → this is **Phase 0**. See "Phase 0 is different" below.
   - `State: complete` → the next phase is the one after `Current phase`.
   - `State: in-progress` → **resume, don't restart**. Read
     `## Current phase progress`; the unticked boxes are the remaining work. Re-verify
     any ticked box that looks cheap to re-check rather than trusting it blindly.
3. Read that phase from `plan.md` and the PRD sections it references.
4. Check `## Next phase entry conditions` in `HANDOVER.md`. If they aren't met, say so
   and stop rather than building on a false foundation.

State the phase number, title, and its Definition of Done back to the user in two or
three lines before doing anything else. This catches "wrong phase" errors when they're
still free.

## Step 2 — Detect the environment

Capabilities differ between surfaces and the skill must degrade gracefully:

- **Shell available** (Claude Code, Cowork): full flow, including verification
  commands and the git commit at handover.
- **No shell** (Claude Desktop chat, file tools only): you can still read the plan,
  reason, write code files, and update `HANDOVER.md`. You **cannot** run verification
  commands or commit. Say this plainly, mark verification rows `not run (no shell)`,
  and have `/handover` emit the exact commit command for the user to run.

Never fake a verification result you couldn't actually run. A green checkmark that
nobody executed is worse than an honest gap, because the next phase builds on it.
See `references/environments.md` for details.

## Step 3 — Ask everything blocking, once, up front

Front-load questions. Interrupting every twenty minutes destroys the user's flow, and
asking nothing produces confidently wrong work.

- Ask only what **blocks** you: something with two or more defensible answers where
  guessing wrong means rework.
- Batch them into a single message. Cap at **five**. If you have more than five, the
  phase is too big — say so and propose splitting it.
- Anything non-blocking becomes an `Assumption:` line in `HANDOVER.md`. Don't ask; note
  it and move on. The user can correct assumptions at review time cheaply.
- If the phase is fully specified and nothing is genuinely ambiguous, ask nothing and
  say so. Asking questions to look thorough is noise.

Good blocking question: "The PRD says accounts are soft-deleted, the plan says
`DELETE /accounts/:id` — should the endpoint soft-delete or hard-delete?"

Bad blocking question: "Should I use `const` or `let`?" — that's an assumption.

## Step 4 — Build, ticking as you go

Work through the phase's tasks. **After each task completes, tick its box in
`HANDOVER.md` immediately.** Don't batch the ticks to the end.

This is the resume mechanism. If the session dies at task 4 of 7, the tick marks are
the only thing standing between the user and redoing four tasks. Set `State:
in-progress` in `HANDOVER.md` the moment you start work, not when you finish.

If you hit something the plan didn't anticipate:
- **Contradicts the PRD** → stop. Surface the conflict, quote both sides, wait for the
  user. Do not resolve it yourself. Silent deviation from the spec is how a plan
  becomes fiction.
- **Plan is merely incomplete** (an unlisted but obviously necessary step) → do it,
  record it under `## Decisions`.

## Step 5 — Prove the Definition of Done

Run every command in the phase's `Verification:` block and record the real exit
codes in `HANDOVER.md`.

A phase is done when its verification passes — not when you believe the work is
finished. You are a poor judge of your own output here; the commands are not.

If anything fails:
1. Try to fix it, within the scope of this phase.
2. Still failing → **do not proceed to handover**. Report what failed, what you tried,
   and leave `State: in-progress`. A half-finished phase honestly labelled is
   recoverable; a broken phase committed as complete is not.

If the phase has no `Verification:` block, say so and propose concrete commands to add
to `plan.md` for next time — prose-only DoD means you're grading your own homework.

## Step 6 — Hand over

When verification passes, invoke the **handover** skill. It rewrites `HANDOVER.md`,
stages the specific paths you touched, and commits. Don't write `HANDOVER.md`'s final
form yourself — the handover skill owns that format so it stays consistent across
phases.

Then stop. **One `/phase` invocation runs exactly one phase.** Do not roll on into the
next one, however small it looks. The user decides when to continue, and the pause is
their review checkpoint.

## Phase 0 is different

Phase 0 is reconnaissance and groundwork, not features. Its job is to produce the
stable header that every later handover reuses, so no future phase has to rediscover
the project.

Phase 0 should establish and record:
- **Stack** — languages, frameworks, package manager, versions that matter
- **Commands** — install, run, test, lint, build (verified to actually work)
- **Key directories** — where things live and what belongs where
- **Conventions** — naming, file layout, testing style, commit format
- **Entry conditions** for phase 1

This is also where `HANDOVER.md` is created for the first time. If phase 0 can't
establish a working test or build command, flag it — every later phase's DoD depends
on it.

## Reference files

- `references/plan-format.md` — expected structure of `plan.md` and `PRD.md`
- `references/environments.md` — behaviour differences across Claude Code, Cowork, Desktop
- `assets/plan.template.md`, `assets/PRD.template.md` — scaffolds for new projects
- `assets/command.md` — thin `/phase` slash-command wrapper for Claude Code
