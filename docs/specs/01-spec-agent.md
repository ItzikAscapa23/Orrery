# Phase 1 — Spec Agent + Chat UI

## Goal
A developer can open a web UI, start a new feature, chat with the Spec Agent
(attaching screenshots and Figma links), and end up with a rendered spec.md
they can confirm. Confirmation saves the spec as a committed artifact.

## User stories
1. As a developer, I can create a new feature by entering a name and a short
   business requirement, so that a spec conversation starts.
2. As a developer, I can chat with the Spec Agent, which asks me clarifying
   questions one at a time, so that the spec converges on my intent.
3. As a developer, I can attach screenshots (PNG/JPG) to any message, and the
   agent uses them to understand the UI, so I don't have to describe designs in text.
4. As a developer, I can paste a Figma node link, and the system renders it to an
   image via the Figma API and feeds it to the agent.
5. As a developer, when the agent proposes a final spec, I see it rendered as
   markdown with a Confirm button; confirming commits spec.md to the artifacts repo
   and marks the feature as spec-approved.

## Spec Agent behavior
- System prompt defines its role: senior product engineer interviewing a developer.
- Asks at most one clarifying question per turn. Covers: user flows, edge cases,
  error states, data model implications, API needs, out-of-scope.
- Must produce the final spec via a `save_spec` tool call (never as plain chat text),
  using this template:
  Overview | User stories | Acceptance criteria (Given/When/Then) | Screens
  (referencing attached designs) | API endpoints (name, method, purpose only —
  detailed contract comes in a later phase) | Out of scope | Open questions.
- Streaming responses to the UI (SSE).

## Technical scope
- apps/server: Fastify + TypeScript. Endpoints:
  - POST /features (create), GET /features, GET /features/:id
  - POST /features/:id/messages (user message + attachments), SSE stream of the reply
  - POST /features/:id/approve-spec
- Anthropic Messages API with tool use (`save_spec`) and image inputs.
- Figma: given a URL like figma.com/file/KEY?node-id=ID, call the Figma REST
  images endpoint with FIGMA_TOKEN env var, download the PNG, attach as image.
- Persistence for this phase: SQLite (or JSON files) is acceptable; Postgres
  arrives in Phase 2. Conversations must survive a server restart.
- Artifacts repo: local git repo at path ARTIFACTS_REPO_PATH; on approval, write
  features/<feature-slug>/spec.md and commit with message "spec: <feature-slug> v1".
- apps/web: minimal React app — feature list, chat view with file attach,
  markdown rendering of the proposed spec, Confirm button. Plain and functional;
  no design polish in this phase.
- .env.example listing ANTHROPIC_API_KEY, FIGMA_TOKEN, ARTIFACTS_REPO_PATH.

## Acceptance criteria
- ✅ Given a new feature, when I describe a requirement and answer the agent's
  questions, then within the conversation the agent eventually calls save_spec
  and the UI displays the rendered spec.
- ✅ Given an attached screenshot, when I ask "what fields do you see", then the
  agent's answer reflects the image content.
- ✅ Given a valid Figma node link in a message, then the server fetches the render
  and the agent references it.
- ✅ Given a proposed spec, when I click Confirm, then spec.md exists in the
  artifacts repo with a git commit, and the feature status becomes SPEC_APPROVED.
- ✅ Given a server restart, when I reopen a feature, then the full conversation
  history is intact.
- ✅ Unit tests cover: the tool-use loop handler, spec template validation, and the
  Figma URL parser. `npm test` passes (59/59).

## Out of scope for Phase 1
- Orchestrator state machine beyond a simple status field.
- AWS review, dev agents, code review, test agents.
- Auth, multi-user, deployment.
