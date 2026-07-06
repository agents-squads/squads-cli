import { describe, it, expect } from 'vitest';
import { defaultTimeoutMinutes, DEFAULT_TIMEOUT_MINUTES, RESEARCH_TIMEOUT_MINUTES } from '../src/lib/run-types.js';

describe('defaultTimeoutMinutes (#941 — research agents need 40m, not 15m)', () => {
  it('gives research-class agents the long watchdog', () => {
    expect(defaultTimeoutMinutes({ name: 'company-profiler', role: 'worker' })).toBe(RESEARCH_TIMEOUT_MINUTES);
    expect(defaultTimeoutMinutes({ name: 'world-watch', role: 'worker' })).toBe(RESEARCH_TIMEOUT_MINUTES);
    expect(defaultTimeoutMinutes({ name: 'aws-monitor', role: 'scanner' })).toBe(RESEARCH_TIMEOUT_MINUTES);
    expect(defaultTimeoutMinutes({ name: 'x', role: 'market research' })).toBe(RESEARCH_TIMEOUT_MINUTES);
  });
  it('keeps mechanical/lead agents on the short default', () => {
    expect(defaultTimeoutMinutes({ name: 'docs-writer', role: 'worker' })).toBe(DEFAULT_TIMEOUT_MINUTES);
    expect(defaultTimeoutMinutes({ name: 'cli-lead', role: 'lead' })).toBe(DEFAULT_TIMEOUT_MINUTES);
    expect(defaultTimeoutMinutes(undefined)).toBe(DEFAULT_TIMEOUT_MINUTES);
  });
});
