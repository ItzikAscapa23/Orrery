# plan.md and PRD.md format

Read this when a plan looks malformed, when scaffolding a new project, or when you
need to know which parts of a phase block are mandatory.

## Why the format matters

The `Verification:` block is the load-bearing part. Everything else is prose a human
reads; verification is what makes "done" mean something an agent can't fudge. A plan
without it degrades into self-assessment.

## plan.md

```markdown
# <Project> — Plan

Spec file. Read-only during execution. All state lives in HANDOVER.md.
PRD: ./PRD.md

---

## Phase 0 — Recon and groundwork

**Goal:** One sentence. What this phase makes true that wasn't before.

**PRD refs:** §2 Constraints, §4 Non-goals

**Tasks:**
- [ ] Map the existing codebase; record stack and layout
- [ ] Confirm install / test / build commands actually run
- [ ] Record conventions in HANDOVER.md

**Definition of Done:**
- HANDOVER.md exists with a populated Project header
- Test and build commands are recorded and verified working

**Verification:**
```bash
npm ci
npm run build
```

**Entry conditions for next phase:**
- Build passes from a clean checkout

---

## Phase 1 — <Title>

...same shape...
```

Task checkboxes in `plan.md` stay **unticked forever** — they're a template. The live
copy that gets ticked lives in `HANDOVER.md` under `## Current phase progress`.

## Field rules

| Field | Required | Notes |
|---|---|---|
| `Goal` | yes | One sentence. If it needs three, split the phase. |
| `PRD refs` | no | Sections to read; saves loading the whole PRD |
| `Tasks` | yes | Ordered, each independently completable |
| `Definition of Done` | yes | Observable outcomes, not activities |
| `Verification` | strongly | Runnable commands. Missing → flag it |
| `Entry conditions for next phase` | no | Gate checked at the start of the next phase |

**Definition of Done** describes a state, not an effort. "Auth endpoints return 401
for missing tokens" is a state. "Implement auth" is an effort — it's already in Tasks.

## PRD.md

Freeform, but these headings make `PRD refs` useful:

```markdown
# <Project> — PRD

## 1. Problem
## 2. Constraints          <- technical and business limits
## 3. Requirements         <- numbered, referenceable: R1, R2...
## 4. Non-goals            <- explicitly out of scope
## 5. Open questions       <- unresolved at plan time
```

Numbered requirements pay off later: `HANDOVER.md` decisions can cite `R7` instead of
paraphrasing, and PRD conflicts become precise.

## Sizing phases

A phase should fit in one working session with room for verification. Signals it's too
big: more than five blocking questions, more than roughly eight tasks, or a Definition
of Done with unrelated clauses joined by "and". Propose a split rather than pushing
through — an oversized phase produces an unreliable handover, which poisons every
phase after it.
