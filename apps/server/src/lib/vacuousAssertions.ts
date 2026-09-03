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
}

const PATTERNS: VacuousPattern[] = [
  {
    name: 'toBeDefined',
    // Matches .toBeDefined() — passes for any non-undefined value.
    re: /\.toBeDefined\(\s*\)/g,
    reason: 'assertion always passes for any non-undefined value',
  },
  {
    name: 'toHaveProperty-no-value',
    // Matches .toHaveProperty('key') with exactly one argument (no value check).
    // A two-argument form has a comma before the closing paren; this regex requires
    // the closing paren immediately after the key string.
    re: /\.toHaveProperty\(\s*['"][^'"]+['"]\s*\)/g,
    reason: 'toHaveProperty with no value check passes for any property value',
  },
];

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

    for (const { name, re, reason } of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        // Find which line this match is on (1-indexed).
        const lineIdx = content.slice(0, m.index).split('\n').length;
        const lineText = (lines[lineIdx - 1] ?? '').trim().slice(0, 100);
        const locKey = `${relPath}:${lineIdx}:${name}`;
        findings.push({
          id: stableId(locKey),
          severity: 'warning',
          section: 'vacuous assertions',
          issue: `${relPath}:${lineIdx}: \`${lineText}\` — ${reason}`,
          test_name: `${relPath}:${lineIdx}`,
        });
      }
    }
  }

  return findings;
}
