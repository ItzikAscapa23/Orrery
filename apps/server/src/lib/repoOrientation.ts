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

// ── Vendored packages ─────────────────────────────────────────────────────────

function scanForNestedNodeModules(
  dir: string,
  depth: number,
  maxDepth: number,
  results: string[],
): void {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === '.git') continue;
    // Only skip top-level EXCLUDED_DIRS; nested node_modules are what we're looking for
    if (depth === 0 && EXCLUDED_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    if (name === 'node_modules') {
      if (depth > 0) results.push(abs);
      // Never recurse into node_modules itself
    } else {
      scanForNestedNodeModules(abs, depth + 1, maxDepth, results);
    }
  }
}

function getPackageMainFile(pkgDir: string): string {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  try {
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>;
      const main = pkg['main'] ?? pkg['exports'];
      if (typeof main === 'string') return main.replace(/^\.\//, '');
    }
  } catch {
    return 'index.js';
  }
  return 'index.js';
}

function extractExportsFromFile(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, { encoding: 'utf-8' }).slice(0, 4096);
    const names = new Set<string>();
    // CommonJS: module.exports.name =
    for (const m of content.matchAll(/module\.exports\.(\w+)\s*=/g)) {
      names.add(m[1]!);
    }
    // ESM: export function/class/const/let/async function name
    for (const m of content.matchAll(
      /^export\s+(?:async\s+)?(?:function\*?\s+|class\s+|const\s+|let\s+)(\w+)/gm,
    )) {
      names.add(m[1]!);
    }
    // ESM named: export { foo, bar as baz }
    for (const m of content.matchAll(/^export\s+\{([^}]+)\}/gm)) {
      for (const part of m[1]!.split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .pop()!
          .trim();
        if (/^\w+$/.test(name)) names.add(name);
      }
    }
    return [...names].slice(0, 30);
  } catch {
    return [];
  }
}

function extractVendoredPackages(worktreePath: string): string {
  const nestedNodeModuleDirs: string[] = [];
  scanForNestedNodeModules(worktreePath, 0, 6, nestedNodeModuleDirs);
  if (nestedNodeModuleDirs.length === 0) return '';

  const lines: string[] = ['### Vendored packages (non-root node_modules)'];

  for (const nmDir of nestedNodeModuleDirs) {
    const relNm = path.relative(worktreePath, nmDir).split(path.sep).join('/');
    let pkgEntries: fs.Dirent[];
    try {
      pkgEntries = fs
        .readdirSync(nmDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    } catch {
      continue;
    }

    for (const pkg of pkgEntries.slice(0, 10)) {
      const pkgDir = path.join(nmDir, pkg.name);
      const mainFile = getPackageMainFile(pkgDir);
      const mainPath = path.join(pkgDir, mainFile);
      const exports = fs.existsSync(mainPath) ? extractExportsFromFile(mainPath) : [];
      const relPkg = `${relNm}/${pkg.name}`;
      if (exports.length > 0) {
        lines.push(`**${pkg.name}** (${relPkg}): ${exports.join(', ')}`);
      } else {
        lines.push(`**${pkg.name}** (${relPkg})`);
      }
    }
  }

  // If only the header was added (no packages scanned successfully), omit the section
  if (lines.length === 1) return '';
  return lines.join('\n');
}

// ── API spec directories ──────────────────────────────────────────────────────

const API_SPEC_DIR_NAMES = new Set(['openapis', 'openapi', 'api-specs', 'api-spec']);
const API_SPEC_EXTENSIONS = new Set(['.json', '.yaml', '.yml']);

function findApiSpecDirs(
  dir: string,
  depth: number,
  maxDepth: number,
  results: Array<{ relDir: string; files: string[] }>,
  worktreePath: string,
): void {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === '.git' || name === 'node_modules') continue;
    if (depth === 0 && EXCLUDED_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    if (API_SPEC_DIR_NAMES.has(name.toLowerCase())) {
      let files: string[] = [];
      try {
        files = fs
          .readdirSync(abs)
          .filter((f) => API_SPEC_EXTENSIONS.has(path.extname(f).toLowerCase()))
          .sort();
      } catch {
        // unreadable directory — files stays []
      }
      if (files.length > 0) {
        const relDir = path.relative(worktreePath, abs).split(path.sep).join('/');
        results.push({ relDir, files });
      }
    } else {
      findApiSpecDirs(abs, depth + 1, maxDepth, results, worktreePath);
    }
  }
}

function extractApiSpecFiles(worktreePath: string): string {
  const results: Array<{ relDir: string; files: string[] }> = [];
  findApiSpecDirs(worktreePath, 0, 5, results, worktreePath);
  if (results.length === 0) return '';

  const lines = ['### API spec files'];
  for (const { relDir, files } of results) {
    lines.push(`${relDir}/: ${files.join(', ')}`);
  }
  return lines.join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

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

  const vendoredSection = extractVendoredPackages(worktreePath);
  if (vendoredSection) {
    parts.push('', vendoredSection);
  }

  const apiSpecSection = extractApiSpecFiles(worktreePath);
  if (apiSpecSection) {
    parts.push('', apiSpecSection);
  }

  return parts.join('\n');
}
