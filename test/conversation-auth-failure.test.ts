/**
 * Tests for isAuthFailureMessage — unauthenticated-provider detection in
 * conversation turns (#956).
 *
 * A missing/expired Claude login fails every turn identically — unlike a
 * quota wall (test/conversation-quota.test.ts) it never clears mid-run, so
 * the whole conversation must abort loud instead of burning turns until
 * convergence detection prints a cryptic "no signals" stop at exit 0.
 */
import { describe, it, expect } from 'vitest';
import { isAuthFailureMessage } from '../src/lib/conversation.js';

describe('isAuthFailureMessage', () => {
  it('detects "Not logged in"', () => {
    expect(isAuthFailureMessage('Not logged in')).toBe(true);
  });

  it('detects the live clean-room transcript format (#956)', () => {
    expect(isAuthFailureMessage('Not logged in · Please run /login')).toBe(true);
  });

  it('detects "Please run /login" on its own', () => {
    expect(isAuthFailureMessage('Please run /login to continue')).toBe(true);
  });

  it('detects "Invalid API key"', () => {
    expect(isAuthFailureMessage('Invalid API key · please check ANTHROPIC_API_KEY')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAuthFailureMessage('NOT LOGGED IN')).toBe(true);
  });

  it('does not flag ordinary plans mentioning login or API keys', () => {
    expect(isAuthFailureMessage('Plan: wire the login page to the new API key rotation flow')).toBe(false);
  });
});
