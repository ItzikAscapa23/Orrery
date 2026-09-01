import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCharterPath } from '../lib/charterResolver.js';

function writeTmpManifest(content: string): string {
  const p = path.join(os.tmpdir(), `test-manifest-${Date.now()}.yaml`);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

function writeTmpCharter(name: string): string {
  const p = path.join(os.tmpdir(), `test-charter-${name}-${Date.now()}.md`);
  fs.writeFileSync(p, `# Charter ${name}\n`, 'utf-8');
  return p;
}

describe('resolveCharterPath', () => {
  it('returns undefined when no repos declare a charter', () => {
    const manifestPath = writeTmpManifest(`
repos:
  - id: repo-a
    side: server
    active: true
    url: https://example.com/repo-a
    default_branch: main
    description: Repo A
  - id: repo-b
    side: client
    active: true
    url: https://example.com/repo-b
    default_branch: main
    description: Repo B
`);
    expect(resolveCharterPath(['repo-a', 'repo-b'], manifestPath)).toBeUndefined();
  });

  it('returns the charter path of the first repo that declares one', () => {
    const charterPath = writeTmpCharter('a');
    const manifestPath = writeTmpManifest(`
repos:
  - id: repo-a
    side: server
    active: true
    url: https://example.com/repo-a
    default_branch: main
    description: Repo A
    review_charter: ${charterPath}
  - id: repo-b
    side: client
    active: true
    url: https://example.com/repo-b
    default_branch: main
    description: Repo B
`);
    expect(resolveCharterPath(['repo-a', 'repo-b'], manifestPath)).toBe(charterPath);
  });

  it('returns the charter of the first matching repo in the list order', () => {
    const charterA = writeTmpCharter('charter-a');
    const charterB = writeTmpCharter('charter-b');
    const manifestPath = writeTmpManifest(`
repos:
  - id: repo-a
    side: server
    active: true
    url: https://example.com/repo-a
    default_branch: main
    description: Repo A
    review_charter: ${charterA}
  - id: repo-b
    side: client
    active: true
    url: https://example.com/repo-b
    default_branch: main
    description: Repo B
    review_charter: ${charterB}
`);
    expect(resolveCharterPath(['repo-a', 'repo-b'], manifestPath)).toBe(charterA);
    expect(resolveCharterPath(['repo-b', 'repo-a'], manifestPath)).toBe(charterB);
  });

  it('returns undefined for an empty repo list', () => {
    const manifestPath = writeTmpManifest(`
repos:
  - id: repo-a
    side: server
    active: true
    url: https://example.com/repo-a
    default_branch: main
    description: Repo A
    review_charter: docs/agents/aws-charter.md
`);
    expect(resolveCharterPath([], manifestPath)).toBeUndefined();
  });

  it('returns undefined when the manifest file does not exist', () => {
    expect(resolveCharterPath(['repo-a'], '/tmp/nonexistent-manifest.yaml')).toBeUndefined();
  });

  it('skips repos in the list that have no review_charter', () => {
    const charterPath = writeTmpCharter('b');
    const manifestPath = writeTmpManifest(`
repos:
  - id: repo-a
    side: server
    active: true
    url: https://example.com/repo-a
    default_branch: main
    description: Repo A
  - id: repo-b
    side: client
    active: true
    url: https://example.com/repo-b
    default_branch: main
    description: Repo B
    review_charter: ${charterPath}
`);
    expect(resolveCharterPath(['repo-a', 'repo-b'], manifestPath)).toBe(charterPath);
  });

  it('throws when review_charter is declared but the file does not exist', () => {
    const manifestPath = writeTmpManifest(`
repos:
  - id: repo-a
    side: server
    active: true
    url: https://example.com/repo-a
    default_branch: main
    description: Repo A
    review_charter: /nonexistent/path/charter.md
`);
    expect(() => resolveCharterPath(['repo-a'], manifestPath)).toThrow(
      /repo-a.*review_charter.*\/nonexistent\/path\/charter\.md/,
    );
  });
});
