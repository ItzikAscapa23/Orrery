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
