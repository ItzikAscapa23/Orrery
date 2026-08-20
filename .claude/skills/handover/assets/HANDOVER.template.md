# <Project> — Handover

Single source of truth for project state. Rewritten at the end of every phase.
Spec lives in `plan.md` and `PRD.md` — both read-only during execution.

---

## Project header

*Established in phase 0. Changes only when something structural changes.*

**Stack:** <languages, frameworks, package manager, versions that matter>

**Commands:**
| Purpose | Command |
|---|---|
| Install | `<cmd>` |
| Run | `<cmd>` |
| Test | `<cmd>` |
| Lint | `<cmd>` |
| Build | `<cmd>` |

**Key directories:**
- `<path>` — <what belongs here>

**Conventions:**
- <naming, file layout, test style, commit format>

---

## Status

- **Current phase:** <N> — <title>
- **State:** `complete` | `in-progress`
- **Last updated:** <YYYY-MM-DD>

---

## Current phase progress

*Live checklist — ticked as work completes, so an interrupted session can resume here.*

- [ ] <task>
- [ ] <task>

---

## Verification

| Command | Result |
|---|---|
| `<cmd>` | passed / failed: <reason> / not run (no shell) |

---

## Decisions

*Choices made and why. The reason matters — it's what stops a later phase from
silently reversing this.*

- **<decision>** — <reason>. <PRD ref if any>

---

## Assumptions

*Taken instead of blocking on a question. Correct any that are wrong.*

- <assumption>

---

## Open questions / blockers

- <item> — <who or what unblocks it>

---

## PRD conflicts

*Implementation contradicted the spec. Never resolved unilaterally.*

- <none> | <conflict: plan says X, PRD §N says Y — awaiting decision>

---

## Phase log

| Phase | Title | Commit | Date |
|---|---|---|---|
| 0 | <title> | `<sha>` | <date> |

---

## Next phase entry conditions

*Checked before the next phase starts. If unmet, that phase stops.*

- <condition>
