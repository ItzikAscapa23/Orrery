import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/server/vitest.config.ts',
  'apps/web/vitest.config.ts',
  'packages/shared/vitest.config.ts',
]);
