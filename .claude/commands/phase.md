---
description: Run the next phase of plan.md through to handover and commit
---

Use the **phase** skill to execute one phase of the phased plan in this repo.

Argument (optional): `$ARGUMENTS` — a specific phase number to run. If empty,
determine the current phase from `HANDOVER.md` as the skill describes.

Follow the skill exactly: read `HANDOVER.md` for position, confirm the phase and its
Definition of Done with me before starting, batch blocking questions up front, tick
progress in `HANDOVER.md` as you go, run the verification commands, and finish by
invoking the handover skill.

Run one phase only. Stop after handover.

<!-- Install to .claude/commands/phase.md in the repo, or ~/.claude/commands/phase.md
     for all projects. -->
