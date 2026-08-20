/**
 * Client-dev job — thin wrapper around the generic runDevJob in devJob.ts.
 * Identical mechanism to serverDevJob.ts; the repo profile (probe_command,
 * exec_timeout_ms, etc.) is read from the manifest entry for the task's repo.
 */

export { runDevJob as runClientDevJob } from './devJob.js';
