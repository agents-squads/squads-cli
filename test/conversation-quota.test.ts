/**
 * Tests for isQuotaMessage — quota/limit detection in conversation turns.
 *
 * Regression for hq#452: the live Max-plan cap message reads
 * "You've hit your session limit · resets 3:10am" — the `session` variant
 * slipped past a bare 'hit your limit' substring check, so a capped lead turn
 * was fed into task parsing and the squad burned its whole conversation.
 */
import { describe, it, expect } from 'vitest';
import { isQuotaMessage } from '../src/lib/conversation.js';

describe('isQuotaMessage', () => {
  it('detects the bare limit message', () => {
    expect(isQuotaMessage("You've hit your limit · resets 3am")).toBe(true);
  });

  it('detects the session-limit variant (hq#452 live format)', () => {
    expect(isQuotaMessage("You've hit your session limit · resets 3:10am (America/Santiago)")).toBe(true);
  });

  it('detects the usage-limit variant', () => {
    expect(isQuotaMessage("You've hit your usage limit")).toBe(true);
  });

  it('detects the [QUOTA] sentinel', () => {
    expect(isQuotaMessage('[QUOTA] intel-lead: API limit reached')).toBe(true);
  });

  it('detects the org-runner abort marker', () => {
    expect(isQuotaMessage('Quota limit reached')).toBe(true);
  });

  it('detects rate limit messages', () => {
    expect(isQuotaMessage('rate limit exceeded, retry later')).toBe(true);
    expect(isQuotaMessage('429 rate-limited')).toBe(true);
  });

  it('does not flag ordinary plans mentioning limits', () => {
    expect(isQuotaMessage('Plan: ship the weekly brief without limits')).toBe(false);
    expect(isQuotaMessage('- worker: solver | task: raise the budget limit in config')).toBe(false);
  });
});
