import fs from 'node:fs';
import path from 'node:path';

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const PARTIAL_THRESHOLD = 300;
// Only these top-level dirs are shown when the tree is partial
const PARTIAL_INCLUDE_DIRS = ['src', 'migrations', '__tests__', 'test', 'tests', 'e2e'];

// compilerOptions keys that affect how code must be written (not emit config)
const TSCONFIG_KEYS_TO_SHOW = new Set([
  'module',
  'target',
  'strict',
  'moduleResolution',
  'verbatimModuleSyntax',
  'exactOptionalPropertyTypes',
  'noUncheckedIndexedAccess',
  'noImplicitOverride',
  'useUnknownInCatchVariables',
  'esModuleInterop',
  'allowSyntheticDefaultImports',
  'jsx',
  'lib',
  'paths',
  'baseUrl',
]);

function walkTree(dir: string, excludedDirs: Set<string>): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
  const results: string[] = [];
  for (const entry of entries) {
    // parentPath is the dir containing the entry (Node 20+); name is the basename
    const parentPath =
      (entry as unknown as { parentPath?: string; path?: string }).parentPath ??
      (entry as unknown as { path?: string }).path ??
      dir;
    const rel = path.relative(dir, path.join(parentPath, entry.name));
    const topLevel = rel.split(path.sep)[0]!;
    if (excludedDirs.has(topLevel)) continue;
    if (entry.isFile()) {
      results.push(rel.split(path.sep).join('/'));
    }
  }
  return results.sort();
}

function extractPackageJson(worktreePath: string): string {
  const pkgPath = path.join(worktreePath, 'package.json');
  if (!fs.existsSync(pkgPath)) return '';
  try {
    const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (raw['name'] !== undefined) out['name'] = raw['name'];
    if (raw['scripts'] !== undefined) out['scripts'] = raw['scripts'];
    if (raw['dependencies'] !== undefined) out['dependencies'] = raw['dependencies'];
    if (raw['devDependencies'] !== undefined) out['devDependencies'] = raw['devDependencies'];
    return JSON.stringify(out, null, 2);
  } catch {
    return '';
  }
}

function extractTsConfig(worktreePath: string): string {
  const tscPath = path.join(worktreePath, 'tsconfig.json');
  if (!fs.existsSync(tscPath)) return '';
  try {
    const raw = JSON.parse(fs.readFileSync(tscPath, 'utf-8')) as Record<string, unknown>;
    const compilerOptions = (raw['compilerOptions'] as Record<string, unknown> | undefined) ?? {};
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(compilerOptions)) {
      if (TSCONFIG_KEYS_TO_SHOW.has(k)) filtered[k] = v;
    }
    return JSON.stringify({ compilerOptions: filtered }, null, 2);
  } catch {
    return '';
  }
}

/**
 * Generate a repo orientation block for injection into agent system prompts.
 * Host-side only — no LLM calls. Regenerated per task so it reflects the
 * current worktree state without going stale.
 */
export function generateRepoOrientation(worktreePath: string): string {
  const allFiles = walkTree(worktreePath, EXCLUDED_DIRS);

  let treeSection: string;
  if (allFiles.length > PARTIAL_THRESHOLD) {
    const partial = allFiles.filter((f) => {
      const top = f.split('/')[0]!;
      return PARTIAL_INCLUDE_DIRS.includes(top);
    });
    treeSection =
      `(partial listing — worktree has ${allFiles.length} files after exclusions; ` +
      `showing src/, migrations/, and test directories only)\n` +
      partial.join('\n');
  } else {
    treeSection = allFiles.join('\n');
  }

  const pkgSection = extractPackageJson(worktreePath);
  const tscSection = extractTsConfig(worktreePath);

  const parts = ['## Repository orientation', '', '### File tree', treeSection];

  if (pkgSection) {
    parts.push('', '### package.json (name, scripts, dependencies)', pkgSection);
  }

  if (tscSection) {
    parts.push('', '### tsconfig.json (compiler options that affect code authoring)', tscSection);
  }

  return parts.join('\n');
}
