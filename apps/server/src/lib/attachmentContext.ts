import { listArtifacts, readArtifact } from './artifacts.js';

const PER_FILE_LIMIT = 15_000;
const TOTAL_BUDGET = 45_000;

function parseFrontMatter(raw: string): { kind: string; body: string } {
  if (!raw.startsWith('---\n')) return { kind: 'unknown', body: raw };
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return { kind: 'unknown', body: raw };
  const header = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const kindMatch = /^kind:\s*(.+)$/m.exec(header);
  return { kind: kindMatch?.[1]?.trim() ?? 'unknown', body };
}

function instruction(kind: string): string {
  if (kind === 'reference')
    return [
      'This file describes an EXTERNAL service the implementation CALLS.',
      'It does NOT describe our own API.',
      'Do NOT list these paths or operations in the spec endpoint table.',
      'Do NOT copy these schemas into our contract.yaml.',
      'Acceptance criteria concern OUR behaviour when calling this service — not our implementing its responses.',
      'Use field names, enum values, and required headers EXACTLY as given when constructing outbound calls.',
      'Refer to this file by its committed filename; do NOT restate its schema in spec prose — the file is the authority and a copy drifts from it.',
    ].join(' ');
  return 'Absorb this into the spec.';
}

export function buildAttachmentContext(slug: string): string {
  const names = listArtifacts(slug, 'attachment-');
  if (names.length === 0) return '';

  const sections: string[] = [];
  let totalChars = 0;
  const overflow: string[] = [];

  for (const name of names) {
    const raw = readArtifact(slug, name);
    if (raw === null) continue;

    const { kind, body } = parseFrontMatter(raw);

    if (totalChars >= TOTAL_BUDGET) {
      overflow.push(name);
      continue;
    }

    const remaining = TOTAL_BUDGET - totalChars;
    const allowed = Math.min(PER_FILE_LIMIT, remaining);
    let display = body;
    let truncated = false;

    if (body.length > PER_FILE_LIMIT) {
      display = body.slice(0, PER_FILE_LIMIT);
      truncated = true;
    }

    if (display.length > allowed) {
      display = display.slice(0, allowed);
      truncated = true;
    }

    totalChars += display.length;

    const marker = truncated
      ? `\n[truncated at ${Math.min(PER_FILE_LIMIT, allowed)} chars; true size: ${body.length} chars; treat content past this marker as not read]`
      : '';

    sections.push(`### ${name}\n_${instruction(kind)}_\n\n${display}${marker}`);
  }

  if (overflow.length > 0) {
    sections.push(`### Files not inlined (45 KB budget exhausted)\n${overflow.join('\n')}`);
  }

  return sections.join('\n\n');
}
