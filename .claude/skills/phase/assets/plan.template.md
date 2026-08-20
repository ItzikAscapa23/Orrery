# <Project> — Plan

Spec file. Read-only during phase execution — all state lives in HANDOVER.md.
PRD: ./PRD.md

---

## Phase 0 — Recon and groundwork

**Goal:** Establish the project map so no later phase has to rediscover it.

**PRD refs:** §2 Constraints

**Tasks:**
- [ ] Map codebase: stack, package manager, key directories
- [ ] Confirm install / test / build / lint commands actually run
- [ ] Record conventions (naming, layout, test style, commit format)
- [ ] Create HANDOVER.md with a populated Project header

**Definition of Done:**
- HANDOVER.md exists with Stack, Commands, Key directories, Conventions filled in
- Every recorded command has been executed successfully at least once

**Verification:**
```bash
<install command>
<build command>
```

**Entry conditions for next phase:**
- Build passes from a clean checkout

---

## Phase 1 — <Title>

**Goal:** <one sentence>

**PRD refs:** <e.g. §3 R1–R4>

**Tasks:**
- [ ] <task>
- [ ] <task>

**Definition of Done:**
- <observable state, not an activity>

**Verification:**
```bash
<command>
```

**Entry conditions for next phase:**
- <condition>

---

<!-- Repeat per phase. If a phase needs >8 tasks or its DoD joins unrelated
     clauses with "and", split it. -->
