# demo-server

Minimal Fastify + TypeScript API used as the target repository for Orrery
Phase 4 dev-agent smoke tests.

## Conventions
- TypeScript strict mode. No `any` without a comment.
- No default exports — all exports are named.
- Zod schemas for all external input (HTTP request bodies, query params).
- No `console.log` in production code — use Fastify's built-in logger.
- One route per file under `src/routes/`; register all routes in `src/index.ts`.

## Commands
```bash
npm test          # run Vitest unit tests
npm run lint      # ESLint check
npm run typecheck # tsc --noEmit
npm run dev       # start with tsx watch
npm run build     # tsc compile to dist/
```

## Folder layout
```
src/
  index.ts          # Fastify app entry point
  routes/           # one file per route group
  lib/              # shared helpers (db, validation, etc.)
  __tests__/        # unit tests co-located with source
dist/               # compiled output (gitignored)
```

## Definition of done (per task)
1. `npm test` passes in the worktree.
2. `npm run lint` passes with max-warnings 0.
3. One git commit per task: `feat(<task-id>): <task-title>`.
