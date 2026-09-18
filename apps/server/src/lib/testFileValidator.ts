/**
 * Phase 57 (task 181): subject-derived render validation for acceptance tests.
 *
 * Derives the expected component subject from a task title and rejects test files
 * that render a different component instead of their declared subject.
 */

/**
 * Derive the component subject from a task title.
 * Returns undefined when the title does not end with "component".
 *
 * Example: "Zone result region component" → { name: "ZoneResultRegion" }
 * Example: "Add login button component"   → { name: "AddLoginButton" }
 */
export function extractSubjectComponent(taskTitle: string): { name: string } | undefined {
  const COMPONENT_SUFFIX_RE = /\bcomponent\s*$/i;
  if (!COMPONENT_SUFFIX_RE.test(taskTitle)) return undefined;

  const withoutSuffix = taskTitle.replace(COMPONENT_SUFFIX_RE, '').trim();
  if (!withoutSuffix) return undefined;

  const words = withoutSuffix.split(/[\s\-_]+/).filter(Boolean);
  if (words.length === 0) return undefined;

  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return { name };
}

/**
 * Validate that a test file renders its declared subject component.
 *
 * Scans JSX render calls (`render(<X`, `mount(<X`, `shallow(<X`). Returns an
 * error string when the file renders a PascalCase component other than the subject
 * without also rendering the subject directly. Returns null when the content is
 * acceptable.
 *
 * Only triggers when `subject` is provided (component tasks only).
 */
export function validateTestFileContent(content: string, subject: { name: string }): string | null {
  // Match render/mount/shallow calls where the first argument is a JSX element
  // with a PascalCase component name (HTML elements are lowercase, fragments are <>).
  const RENDER_RE = /\b(?:render|mount|shallow)\s*\(\s*<([A-Z][a-zA-Z0-9]*)/g;

  const wrongTargets: string[] = [];
  for (const m of content.matchAll(RENDER_RE)) {
    const name = m[1];
    if (name && name !== subject.name) {
      wrongTargets.push(name);
    }
  }

  // If the subject appears anywhere as a JSX element in the file, the test is anchored
  // to the right component — wrapper providers like <MemoryRouter> or <ThemeProvider>
  // are fine as the outer render argument as long as the subject appears inside them.
  const SUBJECT_JSX_RE = new RegExp(`<${subject.name}[\\s/>]`);
  if (SUBJECT_JSX_RE.test(content)) return null;

  if (wrongTargets.length > 0) {
    const first = wrongTargets[0];
    return (
      `test renders <${first}> but this task's subject is <${subject.name}> — ` +
      `import and render the subject component directly`
    );
  }

  return null;
}
