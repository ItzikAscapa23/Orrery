---
description: Close out the current phase — rewrite HANDOVER.md and commit
---

Use the **handover** skill to close out the current phase.

Rewrite `HANDOVER.md` to the skill's template so a fresh Claude with no memory of this
conversation could resume. Record real verification results — never a pass you didn't
actually run.

Then commit: stage explicit paths only (never `git add -A`), use the skill's commit
message format, and do not push. If verification failed or didn't run, skip the commit
and leave `State: in-progress`.

<!-- Install to .claude/commands/handover.md in the repo, or ~/.claude/commands/handover.md
     for all projects. -->
