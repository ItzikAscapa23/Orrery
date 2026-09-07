import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { detectVacuousAssertions } from '../lib/vacuousAssertions.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-vacuous-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTestFile(relPath: string, content: string): void {
  const absPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
}

describe('detectVacuousAssertions', () => {
  it('returns empty array for an empty authored-files list', () => {
    expect(detectVacuousAssertions(tmpDir, [])).toEqual([]);
  });

  it('returns empty array when authored file has no vacuous assertions', () => {
    writeTestFile(
      'src/__tests__/order.test.ts',
      `
      expect(result.max).toBe(1500);
      expect(item.strongId).toBe(1600);
      expect(fn).toThrow('Invalid input');
      expect(obj).toHaveProperty('id', expectedId);
    `,
    );
    expect(detectVacuousAssertions(tmpDir, ['src/__tests__/order.test.ts'])).toEqual([]);
  });

  it('detects .toBeDefined() as vacuous', () => {
    writeTestFile(
      'src/__tests__/weak.test.ts',
      `
      expect(result).toBeDefined();
    `,
    );
    const findings = detectVacuousAssertions(tmpDir, ['src/__tests__/weak.test.ts']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.section).toBe('vacuous assertions');
    expect(findings[0]?.issue).toContain('toBeDefined');
    expect(findings[0]?.issue).toContain('src/__tests__/weak.test.ts');
  });

  it('detects .toHaveProperty(key) without value check as vacuous', () => {
    writeTestFile(
      'src/__tests__/weak.test.ts',
      `
      expect(item).toHaveProperty('strongId');
    `,
    );
    const findings = detectVacuousAssertions(tmpDir, ['src/__tests__/weak.test.ts']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.issue).toContain('toHaveProperty');
  });

  it('does NOT flag .toHaveProperty(key, value) — has a value check', () => {
    writeTestFile(
      'src/__tests__/good.test.ts',
      `
      expect(item).toHaveProperty('strongId', 1600);
      expect(obj).toHaveProperty('name', 'Alice');
    `,
    );
    expect(detectVacuousAssertions(tmpDir, ['src/__tests__/good.test.ts'])).toEqual([]);
  });

  it('does NOT flag .toBe() or other specific assertions', () => {
    writeTestFile(
      'src/__tests__/good.test.ts',
      `
      expect(result).toBe(42);
      expect(list).toHaveLength(3);
      expect(err).toThrow('Bad input');
    `,
    );
    expect(detectVacuousAssertions(tmpDir, ['src/__tests__/good.test.ts'])).toEqual([]);
  });

  it('detects multiple vacuous patterns in the same file', () => {
    writeTestFile(
      'src/__tests__/multi.test.ts',
      `
      expect(a).toBeDefined();
      expect(b).toHaveProperty('id');
      expect(c).toBeDefined();
    `,
    );
    const findings = detectVacuousAssertions(tmpDir, ['src/__tests__/multi.test.ts']);
    expect(findings).toHaveLength(3);
  });

  it('returns findings with stable unique ids', () => {
    writeTestFile(
      'src/__tests__/dup.test.ts',
      `
      expect(a).toBeDefined();
      expect(b).toBeDefined();
    `,
    );
    const findings = detectVacuousAssertions(tmpDir, ['src/__tests__/dup.test.ts']);
    expect(findings).toHaveLength(2);
    // Different lines → different IDs
    expect(findings[0]?.id).not.toBe(findings[1]?.id);
  });

  it('skips missing files gracefully', () => {
    const findings = detectVacuousAssertions(tmpDir, ['does-not-exist.test.ts']);
    expect(findings).toEqual([]);
  });

  it('scans across multiple authored files', () => {
    writeTestFile('a.test.ts', `expect(x).toBeDefined();`);
    writeTestFile('b.test.ts', `expect(y).toHaveProperty('z');`);
    const findings = detectVacuousAssertions(tmpDir, ['a.test.ts', 'b.test.ts']);
    expect(findings).toHaveLength(2);
    const files = findings.map((f) => f.test_name.split(':')[0]);
    expect(files).toContain('a.test.ts');
    expect(files).toContain('b.test.ts');
  });
});

// ── Task 139: toBeDefined exemptions ─────────────────────────────────────────

describe('toBeDefined exemption — accessor on preceding line', () => {
  it('does NOT flag toBeDefined() when subject is from .find() on preceding line', () => {
    writeTestFile(
      'find-guard.test.ts',
      `
      const club = list.find((c) => c.id === 1);
      expect(club).toBeDefined();
    `,
    );
    expect(detectVacuousAssertions(tmpDir, ['find-guard.test.ts'])).toEqual([]);
  });

  it('does NOT flag toBeDefined() when subject is from .get() on preceding line', () => {
    writeTestFile(
      'get-guard.test.ts',
      `
      const entry = map.get(key);
      expect(entry).toBeDefined();
    `,
    );
    expect(detectVacuousAssertions(tmpDir, ['get-guard.test.ts'])).toEqual([]);
  });

  it('does NOT flag toBeDefined() when subject is from index access on preceding line', () => {
    writeTestFile(
      'index-guard.test.ts',
      `
      const first = arr[0];
      expect(first).toBeDefined();
    `,
    );
    expect(detectVacuousAssertions(tmpDir, ['index-guard.test.ts'])).toEqual([]);
  });

  it('DOES flag toBeDefined() when preceding line has no accessor', () => {
    writeTestFile(
      'no-guard.test.ts',
      `
      const result = computeSomething();
      expect(result).toBeDefined();
    `,
    );
    const findings = detectVacuousAssertions(tmpDir, ['no-guard.test.ts']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.section).toBe('vacuous assertions');
  });
});

// ── Task 139: toHaveProperty exemptions ──────────────────────────────────────

describe('toHaveProperty exemption — follow-up value assertion', () => {
  it('does NOT flag toHaveProperty(key) when next line asserts on subject.key with .toBe()', () => {
    writeTestFile(
      'prop-followup.test.ts',
      `
      expect(item).toHaveProperty('strongId');
      expect(item.strongId).toBe(1600);
    `,
    );
    expect(detectVacuousAssertions(tmpDir, ['prop-followup.test.ts'])).toEqual([]);
  });

  it('does NOT flag toHaveProperty(key) when next line uses bracket notation', () => {
    writeTestFile(
      'prop-bracket.test.ts',
      `
      expect(obj).toHaveProperty('name');
      expect(obj['name']).toEqual('Alice');
    `,
    );
    expect(detectVacuousAssertions(tmpDir, ['prop-bracket.test.ts'])).toEqual([]);
  });

  it('DOES flag toHaveProperty(key) when no follow-up value assertion', () => {
    writeTestFile(
      'prop-no-followup.test.ts',
      `
      expect(item).toHaveProperty('strongId');
      expect(item.otherId).toBe(99);
    `,
    );
    const findings = detectVacuousAssertions(tmpDir, ['prop-no-followup.test.ts']);
    expect(findings.filter((f) => f.section === 'vacuous assertions')).toHaveLength(1);
  });
});

// ── Task 140: sole-assertion-vacuous detection ────────────────────────────────

describe('sole-assertion-vacuous detection', () => {
  it('flags a test whose only assertion is toBeDefined()', () => {
    writeTestFile(
      'sole-vacuous.test.ts',
      `
      it('does something', () => {
        expect(result).toBeDefined();
      });
    `,
    );
    const findings = detectVacuousAssertions(tmpDir, ['sole-vacuous.test.ts']);
    const soleFindings = findings.filter((f) => f.section === 'sole-assertion-vacuous');
    expect(soleFindings).toHaveLength(1);
    expect(soleFindings[0]?.issue).toContain('every assertion is vacuous');
  });

  it('does NOT flag a test that mixes vacuous and real assertions', () => {
    writeTestFile(
      'mixed-assertions.test.ts',
      `
      it('checks both', () => {
        expect(result).toBeDefined();
        expect(result.value).toBe(42);
      });
    `,
    );
    const findings = detectVacuousAssertions(tmpDir, ['mixed-assertions.test.ts']);
    expect(findings.filter((f) => f.section === 'sole-assertion-vacuous')).toHaveLength(0);
  });

  it('does NOT flag a test with only real assertions', () => {
    writeTestFile(
      'real-assertions.test.ts',
      `
      it('verifies correctly', () => {
        expect(value).toBe(42);
        expect(name).toEqual('Alice');
      });
    `,
    );
    const findings = detectVacuousAssertions(tmpDir, ['real-assertions.test.ts']);
    expect(findings.filter((f) => f.section === 'sole-assertion-vacuous')).toHaveLength(0);
  });
});

// ── Task 140: unguarded-forEach detection ─────────────────────────────────────

describe('unguarded-forEach detection', () => {
  it('flags forEach with no preceding length guard', () => {
    writeTestFile(
      'unguarded-foreach.test.ts',
      `
      it('iterates', () => {
        results.forEach((r) => {
          expect(r.id).toBeDefined();
        });
      });
    `,
    );
    const findings = detectVacuousAssertions(tmpDir, ['unguarded-foreach.test.ts']);
    const forEachFindings = findings.filter((f) => f.section === 'unguarded-forEach');
    expect(forEachFindings).toHaveLength(1);
  });

  it('does NOT flag forEach preceded by if (arr.length > 0)', () => {
    writeTestFile(
      'guarded-if.test.ts',
      `
      it('guarded', () => {
        if (results.length > 0) {
          results.forEach((r) => {
            expect(r.id).toBe(1);
          });
        }
      });
    `,
    );
    const findings = detectVacuousAssertions(tmpDir, ['guarded-if.test.ts']);
    expect(findings.filter((f) => f.section === 'unguarded-forEach')).toHaveLength(0);
  });

  it('does NOT flag forEach preceded by expect(...).toHaveLength()', () => {
    writeTestFile(
      'guarded-expect.test.ts',
      `
      it('expects length', () => {
        expect(results).toHaveLength(3);
        results.forEach((r) => {
          expect(r.value).toBe(1);
        });
      });
    `,
    );
    const findings = detectVacuousAssertions(tmpDir, ['guarded-expect.test.ts']);
    expect(findings.filter((f) => f.section === 'unguarded-forEach')).toHaveLength(0);
  });
});
