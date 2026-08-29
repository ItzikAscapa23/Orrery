import { exec as cpExec, execSync } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(cpExec);

export const EXEC_MAX_BUFFER = 50 * 1024 * 1024; // 50 MB — above any realistic test-suite output

const CONTAINER_PREFIX = process.env['CONTAINER_PREFIX'] ?? 'orrery-agent';

// Commands the dev agent is permitted to run inside the container.
// Checked as prefix matches so arguments are allowed.
// 'npm install' is intentionally absent — dependencies are pre-installed
// host-side before the container starts (serverDevJob.ts).
// git is intentionally absent: the orchestrator performs all git operations
// host-side after test verification. The agent writes files via write_file.
const ALLOWED_PREFIXES: readonly string[] = [
  'npm test',
  'npm run test',
  'npm run lint',
  'npm run typecheck',
  'cat ',
  'ls ',
  'ls\n',
  'ls',
  'find ',
  'grep ',
  'head ',
  'head\n',
  'head',
  'tail ',
  'tail\n',
  'tail',
  'wc ',
  'wc\n',
  'wc',
  'pwd\n',
  'pwd',
  'mkdir ',
  'cp ',
  'mv ',
  'echo ',
  'node ',
  'npx vitest',
  'npx jest',
  'npx tsc',
];

// Human-readable list of allowed commands for use in system prompts and error
// feedback. Derived from ALLOWED_PREFIXES so the two never silently diverge.
export const ALLOWED_COMMANDS_HINT: string = [
  ...new Set(ALLOWED_PREFIXES.map((p) => p.trim()).filter((p) => p.length > 0)),
]
  .map((p) => `  ${p}`)
  .join('\n');

// Shell metacharacters that could chain commands or escape the allowlist.
// Checked before prefix matching — presence of any of these is an immediate
// violation regardless of the command prefix.
//
// | is blocked except when preceded by \ (grep alternation: grep "a\|b").
// Bare | (pipe) can chain to another command; \| cannot — it is only valid
// inside a grep pattern string. This lookahead allows \| while blocking |.
//
// 2>&1 and 2>/dev/null are stripped before this check — both are no-ops:
// container.exec captures stdout and stderr together regardless, so neither
// can redirect output anywhere. Both are removed before metachar testing.
//
// \ alone is not in the dangerous set; backslash cannot chain or redirect.
export const SHELL_METACHAR_RE = /[;&$`\n><]|(?<!\\)\|/;

export class AllowlistViolationError extends Error {
  constructor(command: string) {
    super(`Command not on allowlist: "${command.slice(0, 120)}"`);
    this.name = 'AllowlistViolationError';
  }
}

export class MetacharViolationError extends Error {
  /** The specific metacharacter that triggered rejection. */
  readonly char: string;
  constructor(command: string, char: string) {
    super(`Shell metacharacter '${char}' not permitted in: "${command.slice(0, 120)}"`);
    this.name = 'MetacharViolationError';
    this.char = char;
  }
}

export interface ContainerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ContainerHandle {
  /** Stable name for this container ('host' for the host executor). */
  name: string;
  /** Execute a shell command inside the container (allowlist enforced). */
  exec(command: string): Promise<ContainerExecResult>;
  /** Stop and remove the container. */
  stop(): Promise<void>;
}

/** Strips no-op fd redirects, then throws MetacharViolationError on any shell metachar. */
export function checkMetachar(command: string): void {
  const sanitized = command
    .trim()
    .replace(/2>&1/g, '')
    .replace(/2>\/dev\/null/g, '');
  const metaMatch = SHELL_METACHAR_RE.exec(sanitized);
  if (metaMatch) {
    throw new MetacharViolationError(command, metaMatch[0]);
  }
}

/**
 * Returns human-readable guidance naming both the prohibition AND a concrete
 * alternative for the metacharacter that triggered the violation. Shared by
 * devAgent and testAgent so both give consistent, actionable feedback.
 */
export function metaCharGuidance(char: string): string {
  if (char === '>') {
    return (
      `Shell metacharacter '>' not permitted. ` +
      `File redirection is not permitted (>, 2> file, < file). ` +
      `Permitted: 2>&1 and 2>/dev/null — both are no-ops since both streams are ` +
      `captured automatically. ` +
      `Omit > outfile and similar file redirects. ` +
      `For inline scripts use write_file then run node <file>, not node -e. ` +
      `One command per call.`
    );
  }
  if (char === '|') {
    return (
      `Shell metacharacter '|' not permitted. ` +
      `Output is captured automatically — never pipe commands.\n` +
      `Alternatives:\n` +
      `  jest path alternation: instead of --testPathPattern="a|b|c", ` +
      `run jest once per pattern (npx jest --ci a) or pass multiple ` +
      `positional patterns (npx jest --ci a b c — jest accepts multiple ` +
      `without a regex).\n` +
      `  grep/regex alternation: use \\| instead — it is already permitted. ` +
      `Example: grep "pat1\\|pat2" file\n` +
      `  stderr merge: 2>&1 and 2>/dev/null are permitted (both are no-ops).\n` +
      `One command per call.`
    );
  }
  if (char === '&') {
    return (
      `Shell metacharacter '&' not permitted. ` +
      `The container working directory is already /workspace — there is no need to cd anywhere. ` +
      `Run commands directly: npx jest src/foo.test.ts, not cd /workspace && npx jest src/foo.test.ts. ` +
      `Also: && and || chain multiple commands, which is never permitted. One command per call.`
    );
  }
  return (
    `Shell metacharacter '${char}' not permitted. ` +
    `Output is captured automatically — never use pipes (|), chaining ` +
    `(;, &&, ||), or command substitution ($, backtick). ` +
    `For inline scripts use write_file then run node <file>, not node -e. ` +
    `One command per call.`
  );
}

/**
 * Throws AllowlistViolationError or MetacharViolationError if the command is
 * not permitted. Returns void on success.
 *
 * Two distinct rejection reasons — the agent must know which rule it broke:
 *   MetacharViolationError  — command contains a shell metacharacter
 *   AllowlistViolationError — metachar-clean but not on the allowlist
 */
function checkAllowed(command: string): void {
  checkMetachar(command);
  const trimmed = command.trim();
  const onAllowlist = ALLOWED_PREFIXES.some(
    (prefix) => trimmed === prefix.trimEnd() || trimmed.startsWith(prefix.trimEnd() + ' '),
  );
  if (!onAllowlist) {
    throw new AllowlistViolationError(command);
  }
}

/**
 * Host-only executor: runs allowlisted commands directly in the worktree
 * directory without a Docker container.
 *
 * SECURITY: The container provides two protections the allowlist alone does not:
 *   1. --network none  — the model cannot exfiltrate data or call external services
 *   2. Filesystem jail — the model cannot read/write outside the worktree mount
 * Both are absent here. The allowlist is the tripwire in front of the wall, not
 * the wall itself. Commands run with full host user permissions and network access.
 *
 * Activation requires BOTH:
 *   AGENT_UNSAFE_HOST_EXEC=true   (explicit opt-in)
 *   NODE_ENV !== 'production'      (never in prod)
 *
 * onActivated fires once at startup so the caller can emit a warning event into
 * the feature event stream — keeping this module decoupled from the event system.
 *
 * Intended use: local dev when Docker Hub/internal registry is unreachable.
 * Permanent fix: point AGENT_CONTAINER_IMAGE at an internal registry mirror.
 */
function startHostExecutor(worktreePath: string, onActivated?: () => void): ContainerHandle {
  onActivated?.();

  return {
    name: 'host',
    exec: async (command: string): Promise<ContainerExecResult> => {
      checkAllowed(command);
      try {
        const { stdout, stderr } = await execAsync(`sh -c ${JSON.stringify(command)}`, {
          cwd: worktreePath,
          timeout: 120_000,
          env: { ...process.env },
          maxBuffer: EXEC_MAX_BUFFER,
        });
        return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number | string };
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return {
            stdout: e.stdout ?? '',
            stderr: 'output exceeded 50 MB buffer limit',
            exitCode: 1,
          };
        }
        return {
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? '',
          exitCode: typeof e.code === 'number' ? e.code : 1,
        };
      }
    },
    stop: async (): Promise<void> => {
      // No container to clean up
    },
  };
}

/**
 * Start a Docker container with the worktree mounted at /workspace.
 * Returns a ContainerHandle with exec() (allowlist enforced, truly async)
 * and stop().
 *
 * exec() uses util.promisify(child_process.exec) so long-running container
 * commands (npm test = 30-90s) do not block the Fastify event loop.
 *
 * Dependencies are pre-installed by runInstallContainer (same image, network on)
 * before calling startContainer. npm install is not in the allowlist and is
 * not attempted inside the no-network exec container.
 *
 * Set AGENT_CONTAINER_IMAGE to override the default image — e.g. point at an
 * internal registry mirror when Docker Hub is unreachable on a corporate network.
 * Setting it to 'none' activates the host executor (see startHostExecutor) and
 * requires AGENT_UNSAFE_HOST_EXEC=true + NODE_ENV !== 'production'.
 *
 * onUnsandboxedWarning: called once when the host executor activates so the
 * caller can emit a warning into the feature event stream.
 */
/**
 * One-shot container that installs npm dependencies inside the correct
 * linux-musl environment, then exits.
 *
 * Uses the same image as the exec container so native deps (rollup used by
 * vitest, etc.) are built for the right ABI. Network is ON for this container
 * only — the agent-facing exec container keeps --network none.
 *
 * A named volume `${CONTAINER_PREFIX}-npm-cache` is mounted at /root/.npm so repeat installs
 * are served from the cached tarballs without a registry round-trip.
 *
 * The demo repo ships a committed linux-native package-lock.json so npm ci
 * always installs the correct musl binaries. No first-run purge or marker needed.
 *
 * Proxy resilience: fetch_retries=5, reduced maxsockets=3 to avoid connection
 * fan-out that causes TLS-inspecting proxies to drop connections (ECONNRESET).
 *
 * cafile: absolute path to a CA cert file for TLS-inspecting proxies. Mounted
 * read-only into the container and passed as npm_config_cafile. Pass empty
 * string when no corporate CA is needed.
 */
/**
 * Primary install strategy: run `npm ci` on the HOST with platform-override
 * flags so native deps are installed for linux-arm64-musl (the exec container
 * ABI) via the host's proven network path (TLS cafile covers the proxy).
 *
 * The demo-server repo now carries a committed linux-native package-lock.json,
 * so npm ci always installs the correct musl binaries. No first-run purge,
 * no marker file — the lockfile is the source of truth.
 *
 * cafile: absolute path for corporate CA cert; empty string = no custom CA.
 */
export async function runHostInstall(
  worktreePath: string,
  cafile: string,
  installTimeoutMs = 300_000,
): Promise<void> {
  // Platform-override flags ensure native deps resolve for the exec container ABI.
  // Resilience flags survive proxy flakiness (fewer parallel connections = fewer drops).
  const platformFlags = '--os=linux --cpu=arm64 --libc=musl';
  const resilienceFlags =
    '--prefer-offline --fetch-retries=5 --fetch-retry-mintimeout=2000 ' +
    '--fetch-retry-maxtimeout=60000 --maxsockets=3 --fetch-timeout=300000';
  // --fetch-timeout: per-socket read patience (ms). Without this npm uses node's
  // ~2min default which a TLS-inspecting proxy can exhaust when fetching hundreds
  // of cold-cache tarballs. 300s matches the outer install timeout for server repos
  // and the proxy can afford to hold a single connection that long on a big tree.

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(cafile ? { npm_config_cafile: cafile } : {}),
  };

  const { stdout, stderr } = await execAsync(`npm ci ${platformFlags} ${resilienceFlags}`, {
    cwd: worktreePath,
    env,
    timeout: installTimeoutMs,
    maxBuffer: EXEC_MAX_BUFFER,
  });
  if (stdout) process.stderr.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

/**
 * Runs a repo-declared bootstrap command in place of the built-in npm ci path.
 * Used for monorepos whose install is too complex for a single npm ci invocation.
 * shell: true is required because the command is typically a shell pipeline.
 *
 * SECURITY: bootstrap is operator config only — it must never be settable from
 * a feature requirement, task payload, or any API surface.
 */
export async function runBootstrapInstall(
  worktreePath: string,
  command: string,
  cafile: string,
  installTimeoutMs = 300_000,
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(cafile ? { npm_config_cafile: cafile } : {}),
  };
  const { stdout, stderr } = await execAsync(command, {
    cwd: worktreePath,
    env,
    timeout: installTimeoutMs,
    maxBuffer: EXEC_MAX_BUFFER,
  });
  if (stdout) process.stderr.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

export async function runInstallContainer(
  worktreePath: string,
  imageTag: string,
  cafile: string,
  installTimeoutMs = 300_000,
): Promise<void> {
  const cafileMount = cafile ? `--volume "${cafile}:/etc/ssl/orrery-ca.pem:ro" ` : '';
  const cafileEnv = cafile ? '--env npm_config_cafile=/etc/ssl/orrery-ca.pem ' : '';

  // npm resilience flags — fewer parallel connections prevent proxy ECONNRESET
  // under high fan-out, and retries recover from transient flakes.
  const npmFlags =
    '--prefer-offline ' +
    '--fetch-retries=5 ' +
    '--fetch-retry-mintimeout=2000 ' +
    '--fetch-retry-maxtimeout=60000 ' +
    '--maxsockets=3';

  // The demo repo ships a committed linux-native lockfile, so npm ci always
  // installs the correct musl binaries. No first-run purge or marker needed.
  const installCmd = `npm ci ${npmFlags}`;

  // Use a named container (no --rm) so we can force-remove it on timeout or
  // failure. docker run --rm blocks after the container exits because Docker
  // keeps the stdio streams open; explicit docker rm -f in the finally block
  // guarantees the process terminates even if the container hangs on cleanup.
  const installContainerName = `${CONTAINER_PREFIX}-install-${Date.now()}`;

  try {
    await execAsync(
      `docker run --name ${installContainerName} ` +
        `--volume "${worktreePath}:/workspace:rw" ` +
        `--volume ${CONTAINER_PREFIX}-npm-cache:/root/.npm ` +
        `--workdir /workspace ` +
        cafileMount +
        cafileEnv +
        `${imageTag} ` +
        `sh -c ${JSON.stringify(installCmd)}`,
      { timeout: installTimeoutMs, maxBuffer: EXEC_MAX_BUFFER },
    );
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`npm install container failed:\n${e.stderr ?? ''}\n${e.stdout ?? ''}`.trim(), {
      cause: err,
    });
  } finally {
    // Always remove the container — keeps docker ps clean and unblocks the
    // stdio streams so execAsync can resolve even on timeout.
    await execAsync(`docker rm -f ${installContainerName}`).catch(() => {
      // Non-fatal: container may already be gone
    });
  }
}

/**
 * Kill the container associated with a specific task label (if running).
 * Safe to call even when no container exists — errors are swallowed.
 * Used by callers that need targeted termination before re-dispatching.
 */
export async function killContainerForTask(taskLabel: string): Promise<void> {
  const containerName = `${CONTAINER_PREFIX}-${taskLabel}`;
  try {
    await execAsync(`docker rm -f ${containerName}`);
  } catch {
    // Non-fatal: container may already be gone
  }
}

export function startContainer(
  worktreePath: string,
  label: string,
  imageTag = 'node:20-alpine',
  onUnsandboxedWarning?: () => void,
  execTimeoutMs = 120_000,
): ContainerHandle {
  // Host executor: only when explicitly opted in AND outside production.
  // The container is a load-bearing security boundary (network isolation +
  // filesystem jail); bypassing it requires a deliberate double opt-in.
  if (imageTag === 'none') {
    const unsafeEnabled = process.env['AGENT_UNSAFE_HOST_EXEC'] === 'true';
    const notProd = process.env['NODE_ENV'] !== 'production';
    if (!unsafeEnabled || !notProd) {
      throw new Error(
        'AGENT_CONTAINER_IMAGE=none requires AGENT_UNSAFE_HOST_EXEC=true and NODE_ENV!=production. ' +
          'The container is a load-bearing security boundary. ' +
          'Permanent fix: set AGENT_CONTAINER_IMAGE to an internal registry mirror (e.g. Artifactory/Nexus).',
      );
    }
    return startHostExecutor(worktreePath, onUnsandboxedWarning);
  }

  const containerName = `${CONTAINER_PREFIX}-${label}`;

  // Kill any incumbent container with the same name before starting. This
  // ensures a re-dispatch (reconciler, BullMQ stall recovery, retry-bounce)
  // never leaves two containers running for the same task.
  try {
    execSync(`docker rm -f ${containerName}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Non-fatal: container does not exist yet
  }

  // docker run -d is fast and one-time — execSync is acceptable here.
  execSync(
    `docker run -d --name ${containerName} ` +
      `--volume "${worktreePath}:/workspace:rw" ` +
      `--workdir /workspace ` +
      `--network none ` +
      `${imageTag} sleep infinity`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  return {
    name: containerName,
    exec: async (command: string): Promise<ContainerExecResult> => {
      checkAllowed(command);
      try {
        const { stdout, stderr } = await execAsync(
          `docker exec ${containerName} sh -c ${JSON.stringify(command)}`,
          { timeout: execTimeoutMs, maxBuffer: EXEC_MAX_BUFFER },
        );
        return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number | string };
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return {
            stdout: e.stdout ?? '',
            stderr: 'output exceeded 50 MB buffer limit',
            exitCode: 1,
          };
        }
        return {
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? '',
          exitCode: typeof e.code === 'number' ? e.code : 1,
        };
      }
    },

    stop: async (): Promise<void> => {
      try {
        await execAsync(`docker rm -f ${containerName}`);
      } catch {
        // Non-fatal: container may already be gone
      }
    },
  };
}

/**
 * Remove any leftover containers from a previous worker crash (prefix: CONTAINER_PREFIX).
 * Best-effort: all errors are swallowed so a Docker outage cannot prevent the
 * worker from starting.
 */
export async function sweepOrphanContainers(): Promise<void> {
  try {
    const { stdout } = await execAsync(
      `docker ps -a --filter "name=${CONTAINER_PREFIX}-" --format "{{.Names}}"`,
    );
    const names = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    await Promise.all(names.map((n) => execAsync(`docker rm -f ${n}`).catch(() => {})));
  } catch {
    // best-effort — Docker may be unavailable in this environment
  }
}
