/**
 * #1084 — provider lanes must not inherit the operator's GitHub identity:
 * work lands via harvest + inbox (#966), never the lane's own pushes/PRs.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import { providerCredentialGuard } from '../src/lib/execution-engine.js';

describe('providerCredentialGuard (#1084)', () => {
  it('strips env tokens and points gh at an empty per-run config dir', () => {
    const guard = providerCredentialGuard(Date.now());
    // undefined values are DELETED from the child env by executeWithProvider.
    expect(guard).toHaveProperty('GH_TOKEN', undefined);
    expect(guard).toHaveProperty('GITHUB_TOKEN', undefined);
    expect(guard.GH_CONFIG_DIR).toBeTruthy();
    expect(existsSync(guard.GH_CONFIG_DIR!)).toBe(true);
    expect(readdirSync(guard.GH_CONFIG_DIR!)).toEqual([]); // no auth to be found
  });
});
