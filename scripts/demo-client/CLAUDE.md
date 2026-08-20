# demo-client

Minimal React Native (Expo) app used as the client-side target for Orrery
dev-agent runs. All client-side feature work lands here.

## Commands
- npm test          # jest --ci --watchAll=false (never use --watchAll; it hangs in CI)
- npm run lint      # eslint with zero-warning policy
- npm run typecheck # tsc --noEmit

## Folder layout
```
App.tsx                       # root component (default export — Expo requires it)
app.json                      # Expo config
src/
  screens/                    # one file per screen, named export
  api/                        # API client functions, one file per resource
  __tests__/                  # jest tests, mirrors src/ structure
```

## Project structure
- **Entry point**: `App.tsx` — the root component registered with Expo.
  Import screens into App.tsx or a navigator defined in App.tsx.
- **Screens**: `src/screens/<FeatureName>.tsx`, e.g. `src/screens/GreetingScreen.tsx`.
  Each screen is a **named export**: `export function GreetingScreen() { ... }`
- **API calls**: `src/api/<resource>.ts`, e.g. `src/api/version.ts`.
  Functions call the Orrery server at the base URL from an env/config constant.
  Never inline `fetch` in a component.
- **Tests**: `src/__tests__/<FeatureName>.test.tsx`, using `react-test-renderer`
  (already in the lockfile) or `@testing-library/react-native` (also in lockfile).
  Import the component under test by its named export.
- **Existing files to read first**: `App.tsx`, any existing screen in `src/screens/`,
  `src/__tests__/App.test.tsx` — understand the pattern before writing new files.

## Conventions
- TypeScript strict mode. No `any` without a comment.
- No default exports except App.tsx (Expo requires it).
- React Native components use StyleSheet.create for styles.
- Tests use jest-expo preset; mock native modules with jest.mock().
- npm test script is `jest --ci --watchAll=false` — never `--watchAll` alone
  (watch mode never exits in CI/container, causing 120s timeout failures).
- Each screen component lives in src/screens/<FeatureName>.tsx.
- API calls go through src/api/<resource>.ts — never inline fetch in components.

## Agent rules
- Implement only what the task requires; do not modify unrelated screens.
- Run `npm test` after implementation; fix all failures before calling end_turn.
- The orchestrator commits host-side after verifying tests — do not git commit.
- Write file paths relative to the repo root (e.g. src/screens/Version.tsx).
