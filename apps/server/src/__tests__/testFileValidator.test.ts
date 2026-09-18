import { describe, it, expect } from 'vitest';
import { extractSubjectComponent, validateTestFileContent } from '../lib/testFileValidator.js';

// ── extractSubjectComponent ───────────────────────────────────────────────────

describe('extractSubjectComponent', () => {
  it('returns undefined when title does not end with "component"', () => {
    expect(extractSubjectComponent('Implement login endpoint')).toBeUndefined();
    expect(extractSubjectComponent('Add unit tests')).toBeUndefined();
    expect(extractSubjectComponent('')).toBeUndefined();
  });

  it('extracts a single-word component name', () => {
    expect(extractSubjectComponent('Button component')).toEqual({ name: 'Button' });
  });

  it('extracts a multi-word component name as PascalCase', () => {
    expect(extractSubjectComponent('Zone result region component')).toEqual({
      name: 'ZoneResultRegion',
    });
  });

  it('is case-insensitive for the "component" suffix', () => {
    expect(extractSubjectComponent('Login form Component')).toEqual({ name: 'LoginForm' });
  });

  it('handles hyphenated words', () => {
    expect(extractSubjectComponent('date-picker component')).toEqual({ name: 'DatePicker' });
  });
});

// ── validateTestFileContent ───────────────────────────────────────────────────

const ZONE_RESULT = { name: 'ZoneResult' };

describe('validateTestFileContent — task 181 fail-first', () => {
  // CASE 1: default-import App render → rejected
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

  // CASE 2: named-import App render → rejected (take-20 actual shape)
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

  // CASE 3: renders the correct subject → accepted
  it('accepts a test that renders <ZoneResult ...>', () => {
    const content = `
import { ZoneResult } from './ZoneResult';
import { render } from '@testing-library/react';

test('displays timezone', () => {
  render(<ZoneResult zone="US/Eastern" label="Eastern" />);
});
`;
    expect(validateTestFileContent(content, ZONE_RESULT)).toBeNull();
  });

  // CASE 4: subject is wrapped in a provider — still accepted
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

  // CASE 5: no subjectComponent context — no check performed
  // (tested via extractSubjectComponent returning undefined)
  it('extractSubjectComponent returns undefined for a non-component task title', () => {
    const subject = extractSubjectComponent('Implement REST endpoint for time lookup');
    expect(subject).toBeUndefined();
    // When subject is undefined the caller should skip validateTestFileContent entirely.
  });

  // CASE 6: no render calls in file (pure function test) — not rejected
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
