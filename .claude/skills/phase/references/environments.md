# Running this workflow across Claude surfaces

Read this when you're unsure what you can actually do on the current surface, or when
a step fails because a tool isn't there.

## Detect, don't assume

Don't branch on "which product am I in" — branch on what tools exist:

1. **Can you run shell commands?** If yes, check `git rev-parse --is-inside-work-tree`.
2. **Can you write files?** If yes, `HANDOVER.md` updates work regardless of shell.
3. If neither, you can still read and reason — produce the handover content in the
   conversation and tell the user where to paste it.

## Capability matrix

| | Claude Code | Cowork / Desktop w/ files | Desktop chat only |
|---|---|---|---|
| Read plan/PRD | yes | yes | if uploaded/pasted |
| Write code files | yes | yes | output in chat |
| Update HANDOVER.md | yes | yes | output in chat |
| Run verification | yes | usually | no |
| Git commit | yes | if git present | no |

## When there's no shell

Do the work, update `HANDOVER.md`, and then:

- Mark every verification row `not run (no shell)` — never `passed`.
- Set `State: in-progress`, not `complete`. Verification is part of the Definition of
  Done, so an unverified phase genuinely isn't done.
- Have the handover skill print the exact `git add` / `git commit` command for the user
  to run themselves.

Tell the user in one line, without belabouring it: "No shell here, so I couldn't run
the tests — here's the command to verify and commit locally."

## When there's no git

The workflow still works; it just loses the commit. Write the handover, note
`Commit: n/a (no git)` in the phase log, and carry on. Don't `git init` a repo the
user didn't ask for.

## Slash commands vs skills

These are different mechanisms and both are worth having:

- **Skill** — `.claude/skills/<name>/SKILL.md`. Model-invoked from the description.
  Works in Claude Code, Cowork, and Desktop. This is where all the logic lives.
- **Slash command** — `.claude/commands/<name>.md` in Claude Code. User-invoked by
  typing `/phase`. Should be a thin wrapper that defers to the skill, so there's one
  source of truth.

Install both: the command gives deliberate invocation, the skill gives automatic
triggering and cross-surface portability. Verify current paths against Claude Code's
docs — they've moved before.
