import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vitest globalSetup — runs once before all test files.
 *
 * 1. SAFETY GUARD: refuses to run if DATABASE_URL does not contain "_test".
 *    This prevents a misconfigured shell from truncating the dev database.
 *
 * 2. Migrates the test database schema so it is always current with the
 *    current codebase without requiring a manual migration step.
 */
export function setup(): void {
  const url = process.env['DATABASE_URL'] ?? '';
  if (!url.includes('_test')) {
    throw new Error(
      `SAFETY: DATABASE_URL does not contain "_test" — refusing to run tests ` +
        `against what may be the dev database.\n` +
        `Current DATABASE_URL: ${url}\n` +
        `Expected something like: postgresql://orrery:orrery@localhost:5432/orrery_test`,
    );
  }

  // __tests__/ → src/ → apps/server/ (3 levels up from __tests__)
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
  // Use pipe (not inherit) — Vitest globalSetup runs in a subprocess where
  // inherited stdio can confuse the test runner. Errors are re-thrown via the
  // execSync exception if the migration fails (non-zero exit).
  execSync('npx prisma migrate deploy', {
    cwd: serverDir,
    env: { ...process.env },
    stdio: 'pipe',
  });
}
