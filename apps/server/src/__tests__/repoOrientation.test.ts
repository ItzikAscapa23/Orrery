import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateRepoOrientation } from '../lib/repoOrientation.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-orientation-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function populate(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
}

// ── Exclusions ────────────────────────────────────────────────────────────────

describe('generateRepoOrientation — excluded directories', () => {
  it('tree excludes node_modules', () => {
    populate({
      'src/index.ts': '',
      'node_modules/foo/index.js': '',
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).toContain('src/index.ts');
    expect(result).not.toContain('node_modules');
  });

  it('tree excludes .git', () => {
    populate({
      'src/app.ts': '',
      '.git/HEAD': 'ref: refs/heads/main\n',
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).toContain('src/app.ts');
    expect(result).not.toContain('.git');
  });

  it('tree excludes dist', () => {
    populate({
      'src/util.ts': '',
      'dist/util.js': '',
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).toContain('src/util.ts');
    expect(result).not.toContain('dist/');
    expect(result).not.toContain('util.js');
  });

  it('tree excludes build', () => {
    populate({
      'src/server.ts': '',
      'build/server.js': '',
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).toContain('src/server.ts');
    expect(result).not.toContain('build/');
    expect(result).not.toContain('server.js');
  });
});

// ── package.json extraction ───────────────────────────────────────────────────

describe('generateRepoOrientation — package.json section', () => {
  it('includes name, scripts, and dependency names+versions', () => {
    populate({
      'package.json': JSON.stringify({
        name: 'my-app',
        scripts: { test: 'vitest', build: 'tsc' },
        dependencies: { express: '^4.18.0' },
        devDependencies: { vitest: '^1.0.0' },
      }),
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).toContain('my-app');
    expect(result).toContain('"test"');
    expect(result).toContain('"vitest"');
    expect(result).toContain('"build"');
    expect(result).toContain('"express"');
    expect(result).toContain('^4.18.0');
    expect(result).toContain('^1.0.0');
  });

  it('does not include raw file dump (large keys like browserslist are absent)', () => {
    populate({
      'package.json': JSON.stringify({
        name: 'my-app',
        scripts: {},
        dependencies: {},
        devDependencies: {},
        browserslist: ['> 1%', 'last 2 versions'],
        jest: { testMatch: ['**/*.test.ts'] },
      }),
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).not.toContain('browserslist');
    expect(result).not.toContain('"jest"');
  });

  it('handles missing package.json gracefully (no throw)', () => {
    expect(() => generateRepoOrientation(tmpDir)).not.toThrow();
  });
});

// ── tsconfig.json extraction ──────────────────────────────────────────────────

describe('generateRepoOrientation — tsconfig.json section', () => {
  it('includes relevant compilerOptions', () => {
    populate({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          target: 'ES2022',
          strict: true,
          moduleResolution: 'NodeNext',
          verbatimModuleSyntax: true,
          exactOptionalPropertyTypes: true,
          outDir: 'dist',
          rootDir: 'src',
        },
      }),
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).toContain('"module"');
    expect(result).toContain('NodeNext');
    expect(result).toContain('"strict"');
    expect(result).toContain('"verbatimModuleSyntax"');
    expect(result).toContain('"exactOptionalPropertyTypes"');
  });

  it('excludes non-code-authoring options like outDir and rootDir', () => {
    populate({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          outDir: 'dist',
          rootDir: 'src',
          declarationDir: 'types',
        },
      }),
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).not.toContain('"outDir"');
    expect(result).not.toContain('"rootDir"');
    expect(result).not.toContain('"declarationDir"');
  });

  it('handles missing tsconfig.json gracefully (no throw)', () => {
    expect(() => generateRepoOrientation(tmpDir)).not.toThrow();
  });
});

// ── Partial listing (>300 files) ──────────────────────────────────────────────

describe('generateRepoOrientation — partial listing cap', () => {
  it('with >300 files: result includes "partial" and only lists src/ and migrations/', () => {
    // Create 310 files in src/
    for (let i = 0; i < 310; i++) {
      populate({ [`src/file${i}.ts`]: '' });
    }
    // Also create a stray file at root level
    populate({ 'stray.ts': '' });

    const result = generateRepoOrientation(tmpDir);
    expect(result.toLowerCase()).toContain('partial');
    expect(result).toContain('src/');
    // stray root-level file should not appear (only src/, migrations/, test dirs shown)
    expect(result).not.toContain('stray.ts');
  });

  it('with ≤300 files: no "partial" indicator, all files shown', () => {
    for (let i = 0; i < 10; i++) {
      populate({ [`src/file${i}.ts`]: '' });
    }
    populate({ 'README.md': '' });

    const result = generateRepoOrientation(tmpDir);
    expect(result.toLowerCase()).not.toContain('partial');
    expect(result).toContain('README.md');
    expect(result).toContain('src/file0.ts');
  });
});

// ── Return value structure ────────────────────────────────────────────────────

describe('generateRepoOrientation — structure', () => {
  it('returns a non-empty string with a "## Repository orientation" header', () => {
    populate({ 'src/index.ts': 'export const x = 1;' });
    const result = generateRepoOrientation(tmpDir);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('## Repository orientation');
  });
});

// ── Vendored packages index ───────────────────────────────────────────────────

describe('generateRepoOrientation — vendored packages', () => {
  it('indexes exports from a nested node_modules package (ESM)', () => {
    populate({
      'graphql/layers/common/nodejs/node_modules/bff-utils/index.js':
        'export function isClientVersionSupported(v) { return v >= 11; }\nexport const VERSION = "1.0";\n',
      'src/app.ts': '',
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).toContain('### Vendored packages');
    expect(result).toContain('bff-utils');
    expect(result).toContain('isClientVersionSupported');
    expect(result).toContain('VERSION');
  });

  it('indexes exports from a nested node_modules package (CJS module.exports)', () => {
    populate({
      'layers/utils/node_modules/helpers/index.js':
        'module.exports.doThing = function() {};\nmodule.exports.CONST_VAL = 42;\n',
      'src/app.ts': '',
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).toContain('### Vendored packages');
    expect(result).toContain('helpers');
    expect(result).toContain('doThing');
    expect(result).toContain('CONST_VAL');
  });

  it('uses package.json main field when present', () => {
    populate({
      'vendor/node_modules/mylib/package.json': JSON.stringify({ main: 'lib/main.js' }),
      'vendor/node_modules/mylib/lib/main.js':
        'export function greet(name) { return "hi " + name; }\n',
      'src/app.ts': '',
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).toContain('mylib');
    expect(result).toContain('greet');
  });

  it('lists a package with no detected exports (no false omission)', () => {
    populate({
      'vendor/node_modules/empty-pkg/index.js': '// nothing exported\n',
      'src/app.ts': '',
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).toContain('### Vendored packages');
    expect(result).toContain('empty-pkg');
  });

  it('does not add the vendored section when there are no nested node_modules', () => {
    populate({ 'src/index.ts': '' });
    const result = generateRepoOrientation(tmpDir);
    expect(result).not.toContain('### Vendored packages');
  });

  it('does not index top-level node_modules (already excluded from the tree)', () => {
    populate({
      'node_modules/express/index.js': 'module.exports.express = function() {};\n',
      'src/app.ts': '',
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).not.toContain('### Vendored packages');
    expect(result).not.toContain('express');
  });
});

// ── API spec files ─────────────────────────────────────────────────────────────

describe('generateRepoOrientation — API spec files', () => {
  it('lists JSON and YAML files from a dcs/openapis directory', () => {
    populate({
      'dcs/openapis/card-order.json': '{}',
      'dcs/openapis/account.yaml': '',
      'src/app.ts': '',
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).toContain('### API spec files');
    expect(result).toContain('dcs/openapis');
    expect(result).toContain('card-order.json');
    expect(result).toContain('account.yaml');
  });

  it('lists files from a nested openapi directory at any depth', () => {
    populate({
      'specs/v2/openapi/users.yaml': '',
      'specs/v2/openapi/orders.json': '',
      'src/app.ts': '',
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).toContain('### API spec files');
    expect(result).toContain('specs/v2/openapi');
    expect(result).toContain('users.yaml');
    expect(result).toContain('orders.json');
  });

  it('does not add the API spec section when no spec directories exist', () => {
    populate({ 'src/index.ts': '' });
    const result = generateRepoOrientation(tmpDir);
    expect(result).not.toContain('### API spec files');
  });

  it('ignores an openapis directory with no JSON/YAML files', () => {
    populate({
      'dcs/openapis/README.md': '# APIs',
      'src/app.ts': '',
    });
    const result = generateRepoOrientation(tmpDir);
    expect(result).not.toContain('### API spec files');
  });
});
