import { defineConfig } from 'vitest/config';

// Override DATABASE_URL to the test database BEFORE any test file loads.
// This prevents tests from connecting to the dev database and truncating live data.
// Set TEST_DATABASE_URL in your environment to override the default test DB URL.
process.env['DATABASE_URL'] =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://orrery:orrery@localhost:5432/orrery_test';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // globalSetup runs once before all test files: asserts _test DB + migrates schema.
    globalSetup: ['src/__tests__/globalSetup.ts'],
    // Run test files sequentially — they share a single Postgres instance and
    // parallel workers would race on TRUNCATE/insert against each other.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
