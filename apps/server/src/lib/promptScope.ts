import yaml from 'js-yaml';

// Heading regex: matches lines starting with one or more # characters
const HEADING_RE = /^(#{1,6})\s+(.+)$/m;

/**
 * Filter a markdown spec to only include sections whose headings appear in
 * `refs`. Always includes the preamble (text before the first heading).
 *
 * Fallback rules:
 * - refs empty → return full spec (no task constraint to filter by)
 * - no refs match → return full spec (filtering would produce a near-empty prompt)
 * - matched sections > 75% of total → return full spec (filtering buys nothing)
 */
export function scopeSpecByRefs(specMarkdown: string, refs: string[]): string {
  if (refs.length === 0) return specMarkdown;

  const normalizedRefs = new Set(refs.map((r) => r.trim().toLowerCase()));

  // Split into sections: each element starts at a heading line.
  const sectionBoundaries: number[] = [];
  const lines = specMarkdown.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i]!)) {
      sectionBoundaries.push(i);
    }
  }

  if (sectionBoundaries.length === 0) return specMarkdown;

  const preambleLines = lines.slice(0, sectionBoundaries[0]);
  const preamble = preambleLines.join('\n');

  const sections: Array<{ heading: string; content: string }> = [];
  for (let i = 0; i < sectionBoundaries.length; i++) {
    const start = sectionBoundaries[i]!;
    const end = i + 1 < sectionBoundaries.length ? sectionBoundaries[i + 1]! : lines.length;
    const headingLine = lines[start]!;
    const match = HEADING_RE.exec(headingLine);
    const heading = match ? match[2]!.trim() : headingLine;
    const content = lines.slice(start, end).join('\n');
    sections.push({ heading, content });
  }

  const matched = sections.filter((s) => normalizedRefs.has(s.heading.toLowerCase()));

  // Fall back to the full spec when filtering achieves nothing useful
  if (matched.length === 0) return specMarkdown;
  if (matched.length / sections.length > 0.75) return specMarkdown;

  const parts = [preamble.trim(), ...matched.map((s) => s.content)].filter(Boolean);
  return parts.join('\n\n');
}

// ── Contract scoping ──────────────────────────────────────────────────────────

export interface ScopeContractOpts {
  side: 'server' | 'client';
  refs?: string[];
  taskDescription?: string;
  /** Called (synchronously) whenever the full contract is returned as a fallback,
   *  with a human-readable reason. Callers use this to emit an agent.log event. */
  onFallback?: (reason: string) => void;
}

type OpenApiDoc = {
  paths?: Record<string, unknown>;
  components?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Scope an OpenAPI contract YAML to operations referenced by the current task.
 *
 * Filter strategy (no x-side tags required):
 * - Build a token set from specRefs (path-segment split) + taskDescription (word split).
 * - Retain operations whose path key or operationId shares a token with the set.
 * - Guard: if fewer than 25% of operations would be removed, return full document.
 * - Validate: if any $ref in retained operations is dangling, return full document.
 * - If filtering cannot be done safely, return the full document and call onFallback.
 */
export function scopeContract(contractYaml: string, opts: ScopeContractOpts): string {
  // 1. Parse
  let doc: OpenApiDoc;
  try {
    doc = yaml.load(contractYaml) as OpenApiDoc; // js-yaml returns unknown; cast safe for valid OpenAPI
  } catch (e) {
    opts.onFallback?.(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`);
    return contractYaml;
  }

  const allPaths = Object.keys(doc.paths ?? {});
  if (allPaths.length === 0) return contractYaml;

  // 2. Build candidate token set from refs + task description
  const tokens = new Set<string>();
  for (const ref of opts.refs ?? []) {
    ref
      .toLowerCase()
      .split(/[\/_\-\s]+/)
      .filter(Boolean)
      .forEach((t) => tokens.add(t));
  }
  for (const word of (opts.taskDescription ?? '').toLowerCase().split(/\W+/).filter(Boolean)) {
    tokens.add(word);
  }
  if (tokens.size === 0) return contractYaml; // no constraint → return full

  // 3. Match paths by path-key tokens or operationId tokens
  const retainedPaths = new Set<string>();
  for (const [pathKey, pathItem] of Object.entries(doc.paths ?? {})) {
    const pathTokens = pathKey
      .toLowerCase()
      .split(/[\/_\-{}\s]+/)
      .filter(Boolean);
    if (pathTokens.some((t) => tokens.has(t))) {
      retainedPaths.add(pathKey);
      continue;
    }
    for (const opValue of Object.values(pathItem as Record<string, unknown>)) {
      const op = opValue as Record<string, unknown> | null;
      if (op && typeof op === 'object' && typeof op['operationId'] === 'string') {
        const opTokens = (op['operationId'] as string)
          .toLowerCase()
          .split(/[\/_\-]+/)
          .filter(Boolean);
        if (opTokens.some((t) => tokens.has(t))) {
          retainedPaths.add(pathKey);
          break;
        }
      }
    }
  }

  // 4. 25% guard: if fewer than 25% of operations would be removed, return full document
  const removedFraction = (allPaths.length - retainedPaths.size) / allPaths.length;
  if (removedFraction < 0.25) {
    opts.onFallback?.(
      `25% guard: ${allPaths.length - retainedPaths.size} of ${allPaths.length} operations filtered — too few to justify scoping`,
    );
    return contractYaml;
  }

  // 5. Collect all $refs from retained operations recursively
  const collectedRefs = new Set<string>();
  function collectRefs(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(collectRefs);
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (k === '$ref' && typeof v === 'string') collectedRefs.add(v);
      else collectRefs(v);
    }
  }
  for (const p of retainedPaths) collectRefs(doc.paths![p]);

  // 6. Validate all local $refs resolve in the document
  for (const ref of collectedRefs) {
    if (!ref.startsWith('#/')) continue; // skip external refs — can't validate here
    const parts = ref.slice(2).split('/'); // e.g. ['components', 'schemas', 'Foo']
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: any = doc; // dynamic traversal of unknown depth; any is correct here
    for (const part of parts) {
      if (!node || typeof node !== 'object') {
        node = undefined;
        break;
      }
      node = (node as Record<string, unknown>)[part];
    }
    if (node === undefined) {
      opts.onFallback?.(
        `dangling $ref: ${ref} — component not found; returning full document`,
      );
      return contractYaml;
    }
  }

  // 7. Build filtered document and re-serialize
  const filteredPaths: Record<string, unknown> = {};
  for (const p of retainedPaths) filteredPaths[p] = doc.paths![p];
  const filteredDoc = { ...doc, paths: filteredPaths };
  return yaml.dump(filteredDoc, { lineWidth: -1 });
}
