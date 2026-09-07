import fs from 'node:fs';
import path from 'node:path';
import type { TestFinding } from '@orrery/shared';

// djb2 hash — identical to the stableId implementation in testJob.ts.
function stableId(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  return `tf-${h.toString(36)}`;
}

interface VacuousPattern {
  name: string;
  re: RegExp;
  reason: string;
  // Return true to skip this match (false positive suppression).
  exemptCheck?: (lineIdx: number, lines: string[], matchText: string) => boolean;
}

// Regex that matches the preceding or current line containing a .find()/.get()/index access —
// the subject of expect() was retrieved from a collection and toBeDefined() is a safety guard.
const ACCESSOR_RE = /\.find\s*\(|\.get\s*\(|\[\s*[\w'"]+\s*\]/;

const PATTERNS: VacuousPattern[] = [
  {
    name: 'toBeDefined',
    // Matches .toBeDefined() — passes for any non-undefined value.
    re: /\.toBeDefined\(\s*\)/g,
    reason: 'assertion always passes for any non-undefined value',
    // Exempt when the subject comes from .find()/.get()/index access on the
    // preceding line or the same line — toBeDefined() is a null-check there, not
    // a content check.
    exemptCheck: (lineIdx, lines) =>
      ACCESSOR_RE.test(lines[lineIdx - 2] ?? '') || ACCESSOR_RE.test(lines[lineIdx - 1] ?? ''),
  },
  {
    name: 'toHaveProperty-no-value',
    // Matches .toHaveProperty('key') with exactly one argument (no value check).
    // A two-argument form has a comma before the closing paren; this regex requires
    // the closing paren immediately after the key string.
    re: /\.toHaveProperty\(\s*['"][^'"]+['"]\s*\)/g,
    reason: 'toHaveProperty with no value check passes for any property value',
    // Exempt when the next non-blank line asserts on the same key with a value —
    // the toHaveProperty acts as an existence guard before the value check.
    exemptCheck: (lineIdx, lines, matchText) => {
      const keyMatch = /\.toHaveProperty\(\s*['"]([^'"]+)['"]\s*\)/.exec(matchText);
      if (!keyMatch) return false;
      const key = keyMatch[1]!;
      for (let i = lineIdx; i < Math.min(lineIdx + 3, lines.length); i++) {
        const next = lines[i] ?? '';
        if (next.trim() === '') continue;
        const hasKeyRef =
          next.includes(`.${key}`) || next.includes(`['${key}']`) || next.includes(`["${key}"]`);
        const hasValueAssertion =
          /\.toBe\(|\.toEqual\(|\.toStrictEqual\(|\.toMatch\(|\.toHaveLength\(|\.toBeTruthy\(/.test(
            next,
          );
        if (hasKeyRef && hasValueAssertion) return true;
        break;
      }
      return false;
    },
  },
];

// Line numbers (1-based) of vacuous pattern matches, used by detectSoleAssertionVacuous.
type VacuousLineSet = Set<number>;

/**
 * Within a single file's lines, detect test blocks (it/test) whose ONLY
 * assertions are vacuous. Returns findings with section 'sole-assertion-vacuous'.
 */
function detectSoleAssertionVacuous(
  lines: string[],
  relPath: string,
  vacuousLineNums: VacuousLineSet,
): TestFinding[] {
  const findings: TestFinding[] = [];
  const allAssertionRe = /\.to[A-Z][a-zA-Z]+\(/;
  const blockStartRe = /^\s*(it|test)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!blockStartRe.test(line)) continue;

    // Extract test name (best-effort).
    const nameMatch = /(?:it|test)\s*\(\s*(['"`])(.*?)\1/.exec(line);
    const testName = nameMatch ? nameMatch[2] : '(anonymous)';
    const blockStartLine = i + 1; // 1-based

    // Walk forward counting braces to find the block body.
    let depth = 0;
    let bodyStart = -1;
    let totalAssertions = 0;
    let vacuousAssertions = 0;

    for (let j = i; j < lines.length; j++) {
      const bodyLine = lines[j] ?? '';
      for (const ch of bodyLine) {
        if (ch === '{') {
          if (depth === 0) bodyStart = j;
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            // End of block — check assertion balance.
            if (bodyStart !== -1 && totalAssertions > 0 && vacuousAssertions === totalAssertions) {
              const locKey = `${relPath}:${blockStartLine}:sole-assertion-vacuous`;
              findings.push({
                id: stableId(locKey),
                severity: 'warning',
                section: 'sole-assertion-vacuous',
                issue: `${relPath}:${blockStartLine}: test "${testName}" — every assertion is vacuous`,
                test_name: `${relPath}:${blockStartLine}`,
              });
            }
            i = j; // outer loop advances past this block
            break;
          }
        }
      }
      if (depth === 0 && bodyStart !== -1) break;

      // Count assertions in this body line (skip the it/test line itself).
      if (j > i) {
        if (allAssertionRe.test(bodyLine)) totalAssertions++;
        if (vacuousLineNums.has(j + 1)) vacuousAssertions++;
      }
    }
  }

  return findings;
}

// Guards that precede a .forEach() and indicate the collection was checked for
// emptiness before iteration.
const FOREACH_GUARD_RE =
  /\.toHaveLength\s*\(|\.toBeGreaterThan\s*\(|if\s*\(.*\.length|\.length\s*[>!]=?\s*0/;

/**
 * Detect .forEach() calls with no length guard in the preceding 10 lines.
 * Returns findings with section 'unguarded-forEach'.
 */
function detectUnguardedForEach(content: string, lines: string[], relPath: string): TestFinding[] {
  const findings: TestFinding[] = [];
  const forEachRe = /\.forEach\s*\(/g;

  let m: RegExpExecArray | null;
  while ((m = forEachRe.exec(content)) !== null) {
    const lineIdx = content.slice(0, m.index).split('\n').length; // 1-based

    // Scan back up to 10 lines for a guard.
    const lookback = Math.max(0, lineIdx - 10);
    let guarded = false;
    for (let i = lookback; i < lineIdx - 1; i++) {
      if (FOREACH_GUARD_RE.test(lines[i] ?? '')) {
        guarded = true;
        break;
      }
    }
    if (!guarded) {
      const lineText = (lines[lineIdx - 1] ?? '').trim().slice(0, 100);
      const locKey = `${relPath}:${lineIdx}:unguarded-forEach`;
      findings.push({
        id: stableId(locKey),
        severity: 'warning',
        section: 'unguarded-forEach',
        issue: `${relPath}:${lineIdx}: \`${lineText}\` — forEach over collection with no non-empty guard`,
        test_name: `${relPath}:${lineIdx}`,
      });
    }
  }

  return findings;
}

/**
 * Scan test-agent-authored files for assertion patterns that cannot meaningfully
 * fail. Returns TestFinding[] with severity 'warning' — not blockers, but surfaced
 * in the test report so the operator can decide whether the coverage is real.
 */
export function detectVacuousAssertions(
  worktreePath: string,
  authoredFiles: string[],
): TestFinding[] {
  const findings: TestFinding[] = [];

  for (const relPath of authoredFiles) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(worktreePath, relPath), 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const vacuousLineNums: VacuousLineSet = new Set();

    for (const { name, re, reason, exemptCheck } of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        // Find which line this match is on (1-indexed).
        const lineIdx = content.slice(0, m.index).split('\n').length;

        if (exemptCheck?.(lineIdx, lines, m[0])) continue;

        const lineText = (lines[lineIdx - 1] ?? '').trim().slice(0, 100);
        const locKey = `${relPath}:${lineIdx}:${name}`;
        findings.push({
          id: stableId(locKey),
          severity: 'warning',
          section: 'vacuous assertions',
          issue: `${relPath}:${lineIdx}: \`${lineText}\` — ${reason}`,
          test_name: `${relPath}:${lineIdx}`,
        });
        vacuousLineNums.add(lineIdx);
      }
    }

    // Sole-assertion-vacuous: test blocks where every assertion is vacuous.
    const soleVacuous = detectSoleAssertionVacuous(lines, relPath, vacuousLineNums);
    findings.push(...soleVacuous);

    // Unguarded forEach: iteration over a collection with no non-empty guard.
    const unguarded = detectUnguardedForEach(content, lines, relPath);
    findings.push(...unguarded);
  }

  return findings;
}
