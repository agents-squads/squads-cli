/**
 * Tests for quota-probe reset-hint extraction (#856).
 * probeQuota/waitForQuota spawn the claude binary and are covered by the
 * org-runner integration path; the parsing is what must not regress.
 */
import { describe, it, expect } from 'vitest';
import { extractResetHint } from '../src/lib/quota-probe.js';

describe('extractResetHint', () => {
  it('extracts the live session-limit format', () => {
    expect(extractResetHint("You've hit your session limit · resets 3:10am (America/Santiago)"))
      .toBe('3:10am (America/Santiago)');
  });

  it('extracts a bare reset time', () => {
    expect(extractResetHint("You've hit your limit · resets 3am")).toBe('3am');
  });

  it('handles "resets at" phrasing', () => {
    expect(extractResetHint('limit reached, resets at 14:00 UTC')).toBe('14:00 UTC');
  });

  it('returns undefined when no reset time present', () => {
    expect(extractResetHint('rate limit exceeded')).toBeUndefined();
  });
});
