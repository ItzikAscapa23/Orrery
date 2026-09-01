import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateProbeCommands, inferRunner } from '../lib/validateManifest.js';

function writeTmpManifest(content: string): string {
  const p = path.join(os.tmpdir(), `test-manifest-vm-${Date.now()}.yaml`);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

const REPO_BASE = `
    side: server
    url: https://example.com/repo
    default_branch: main
    description: Test repo`;

describe('inferRunner', () => {
  it('returns vitest for a command containing vitest', () => {
    expect(inferRunner('npx vitest run')).toBe('vitest');
  });

  it('returns jest for a command containing jest', () => {
    expect(inferRunner('npx jest --maxWorkers=2')).toBe('jest');
  });

  it('returns null for an ambiguous command', () => {
    expect(inferRunner('npm test')).toBeNull();
  });

  it('returns null when both vitest and jest are present', () => {
    expect(inferRunner('npx vitest run --testNamePattern jest')).toBeNull();
  });
});

describe('validateProbeCommands', () => {
  it('returns without error when the manifest is absent', () => {
    expect(() => validateProbeCommands('/tmp/nonexistent-manifest-validate.yaml')).not.toThrow();
  });

  it('returns without error for inactive repos without probe_command', () => {
    const manifestPath = writeTmpManifest(`
repos:
  - id: repo-a
    active: false${REPO_BASE}
`);
    expect(() => validateProbeCommands(manifestPath)).not.toThrow();
  });

  it('returns without error for light-path repos without probe_command', () => {
    const manifestPath = writeTmpManifest(`
repos:
  - id: repo-a
    active: true
    path: light${REPO_BASE}
`);
    expect(() => validateProbeCommands(manifestPath)).not.toThrow();
  });

  it('returns without error for a valid vitest probe_command', () => {
    const manifestPath = writeTmpManifest(`
repos:
  - id: repo-a
    active: true
    probe_command: 'npx vitest run'${REPO_BASE}
`);
    expect(() => validateProbeCommands(manifestPath)).not.toThrow();
  });

  it('returns without error for a valid jest probe_command', () => {
    const manifestPath = writeTmpManifest(`
repos:
  - id: repo-a
    active: true
    probe_command: 'npx jest --maxWorkers=2'${REPO_BASE}
`);
    expect(() => validateProbeCommands(manifestPath)).not.toThrow();
  });

  it('throws for an active full-path repo with no probe_command', () => {
    const manifestPath = writeTmpManifest(`
repos:
  - id: repo-a
    active: true${REPO_BASE}
`);
    expect(() => validateProbeCommands(manifestPath)).toThrow(/probe_command/);
  });

  it('throws for an active full-path repo with an ambiguous probe_command', () => {
    const manifestPath = writeTmpManifest(`
repos:
  - id: repo-a
    active: true
    probe_command: 'npm test'${REPO_BASE}
`);
    expect(() => validateProbeCommands(manifestPath)).toThrow(/npm test/);
  });

  it('includes the repo id in the error message', () => {
    const manifestPath = writeTmpManifest(`
repos:
  - id: my-special-repo
    active: true
    probe_command: 'npm test'${REPO_BASE}
`);
    expect(() => validateProbeCommands(manifestPath)).toThrow(/my-special-repo/);
  });
});
