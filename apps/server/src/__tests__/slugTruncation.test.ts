/**
 * Regression tests for toSlug (task 171).
 *
 * Historical artifact: four directories on disk were named `orld-clock-feature-take-14-*`
 * (leading `w` dropped), while same-session peers were correct. The root cause is
 * unrecoverable from the squashed repo history, but the most likely explanation is
 * a prior version that used `.slice(1, 61)` (off-by-one start index) or applied
 * `slice` before `replace(/^-+|-+$/g, '')`, causing a leading hyphen from a
 * non-alphanumeric prefix to be stripped together with the first real character.
 *
 * The current `toSlug` applies `replace` before `slice` and starts the slice at
 * index 0 — both correct. These tests are the permanent guard against regression.
 */
import { describe, expect, it } from 'vitest';
import { toSlug } from '../lib/features.js';

describe('toSlug — leading-character preservation (task 171)', () => {
  it('preserves the leading w in world-clock-feature-take-14', () => {
    expect(toSlug('world clock feature take 14')).toBe('world-clock-feature-take-14');
  });

  it('lowercases and handles mixed case', () => {
    expect(toSlug('World Clock Feature')).toBe('world-clock-feature');
  });

  it('strips leading and trailing spaces (converted to hyphens, then trimmed)', () => {
    expect(toSlug('  hello  ')).toBe('hello');
  });

  it('caps slug at 60 characters', () => {
    const long = 'a very long feature name that goes well past the sixty char limit for slugs here';
    const result = toSlug(long);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it('a 70-char slug retains its first character — no off-by-one at the slice boundary', () => {
    // Construct a name whose slugified form is longer than 60 chars.
    // After slicing at 60, the first char must survive.
    const name = 'wonderful-feature-name-that-is-definitely-longer-than-sixty-chars-when-slugified';
    const result = toSlug(name);
    expect(result[0]).toBe('w');
    expect(result.length).toBeLessThanOrEqual(60);
  });
});
