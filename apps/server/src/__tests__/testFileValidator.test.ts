import { describe, it, expect } from 'vitest';
import { validateTestFileContent } from '../lib/testFileValidator.js';

// ── validateTestFileContent ───────────────────────────────────────────────────

const ZONE_RESULT = { name: 'ZoneResult' };
const COUNTER = { name: 'Counter' };

describe('validateTestFileContent — subject-declared validation', () => {
  // CASE 1: subject present — rejects test rendering a different component
  it('rejects a test that renders <App /> when subject is ZoneResult (default import style)', () => {
    const content = `
import App from '../../App';
import { render } from '@testing-library/react';

test('renders', () => {
  render(<App />);
});
`;
    const err = validateTestFileContent(content, ZONE_RESULT);
    expect(err).not.toBeNull();
    expect(err).toContain('App');
    expect(err).toContain('ZoneResult');
  });

  it('rejects a test that renders <App /> when subject is ZoneResult (named import style)', () => {
    const content = `
import { App } from '../App';
import { render } from '@testing-library/react';

test('renders zone result', async () => {
  const { findByRole } = render(<App />);
  const select = await findByRole('combobox');
});
`;
    const err = validateTestFileContent(content, ZONE_RESULT);
    expect(err).not.toBeNull();
    expect(err).toContain('App');
    expect(err).toContain('ZoneResult');
  });

  // CASE 2: subject present — accepts test rendering subject wrapped in a provider
  it('accepts a test that renders the correct subject directly', () => {
    const content = `
import { ZoneResult } from './ZoneResult';
import { render } from '@testing-library/react';

test('displays timezone', () => {
  render(<ZoneResult zone="US/Eastern" label="Eastern" />);
});
`;
    expect(validateTestFileContent(content, ZONE_RESULT)).toBeNull();
  });

  it('accepts a test that wraps the subject in a provider', () => {
    const content = `
import { ZoneResult } from './ZoneResult';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';

test('renders inside router', () => {
  render(<MemoryRouter><ZoneResult zone="US/Eastern" /></MemoryRouter>);
});
`;
    expect(validateTestFileContent(content, ZONE_RESULT)).toBeNull();
  });

  // CASE 3: task without subject — no check performed (opt-in behaviour)
  it('accepts anything when subject is undefined', () => {
    const content = `
import { OtherWidget } from './OtherWidget';
import { render } from '@testing-library/react';
test('renders', () => { render(<OtherWidget />); });
`;
    expect(validateTestFileContent(content, undefined)).toBeNull();
  });

  it('accepts a render-heavy file with no subject', () => {
    const content = `
render(<Foo />); render(<Bar />); render(<Baz />);
`;
    expect(validateTestFileContent(content, undefined)).toBeNull();
  });

  // CASE 4: subject names a component not yet in the repo — must not reject
  // The test agent runs before the dev agent; the component file is absent on first attempt.
  it('accepts when the subject component does not yet exist in the repo', () => {
    const content = `
import { Counter } from './Counter';
import { render } from '@testing-library/react';
test('renders counter', () => { render(<Counter count={0} />); });
`;
    expect(validateTestFileContent(content, COUNTER)).toBeNull();
  });

  it('rejects when a different component is rendered and subject not yet in repo', () => {
    const content = `
import { OtherWidget } from './OtherWidget';
import { render } from '@testing-library/react';
test('renders', () => { render(<OtherWidget />); });
`;
    const err = validateTestFileContent(content, COUNTER);
    expect(err).not.toBeNull();
    expect(err).toContain('OtherWidget');
    expect(err).toContain('Counter');
  });

  // Extra: no render calls in file — not rejected even with a subject
  it('does not reject a test file with no render calls', () => {
    const content = `
import { formatTimezone } from '../utils/time';
test('formats UTC offset', () => {
  expect(formatTimezone('America/New_York', 1700000000)).toBe('EST (UTC-5)');
});
`;
    expect(validateTestFileContent(content, ZONE_RESULT)).toBeNull();
  });
});
