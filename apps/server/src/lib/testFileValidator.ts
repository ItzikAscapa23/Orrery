/**
 * Phase 57/58: subject-declared render validation for acceptance tests.
 *
 * Rejects test files that render a different component than their declared subject.
 * Validation only runs when subject is explicitly provided by the planner — tasks
 * with no subject are accepted unconditionally.
 */

/**
 * Validate that a test file renders its declared subject component.
 *
 * Scans JSX render calls (`render(<X`, `mount(<X`, `shallow(<X`). Returns an
 * error string when the file renders a PascalCase component other than the subject
 * without also rendering the subject directly. Returns null when the content is
 * acceptable.
 *
 * Returns null immediately when subject is undefined (opt-in: no subject = no check).
 * A subject naming a component not yet in the repo is accepted — the test agent runs
 * before the dev agent, so the component file is absent on every first attempt.
 */
export function validateTestFileContent(
  content: string,
  subject: { name: string } | undefined,
): string | null {
  if (!subject) return null;

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
