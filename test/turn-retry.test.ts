import { describe, it, expect } from 'vitest';
import { isTransientTurnError } from '../src/lib/workflow.js';

describe('isTransientTurnError (#944 — retry transient, stay loud on the rest)', () => {
  it('flags real transient signatures', () => {
    expect(isTransientTurnError('API Error: Connection closed mid-response')).toBe(true);
    expect(isTransientTurnError('[ERROR] intel-verifier exited with code 1: ECONNRESET')).toBe(true);
    expect(isTransientTurnError('Request failed with status 529 overloaded')).toBe(true);
    expect(isTransientTurnError('socket hang up')).toBe(true);
  });
  it('NEVER retries quota, timeout, auth, or model errors', () => {
    expect(isTransientTurnError('[QUOTA] intel-lead: API limit reached')).toBe(false);
    expect(isTransientTurnError('[ERROR] worker timed out after 40 minutes')).toBe(false);
    expect(isTransientTurnError('authentication_error: invalid api key')).toBe(false);
    expect(isTransientTurnError('The supported API model names are deepseek-v4-pro (invalid request model)')).toBe(false);
    expect(isTransientTurnError('insufficient balance, please recharge — connection error')).toBe(false);
    expect(isTransientTurnError('normal successful output')).toBe(false);
  });
});
