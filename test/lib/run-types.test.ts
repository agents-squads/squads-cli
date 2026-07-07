/**
 * Tests for src/lib/run-types.ts — defaultTimeoutForRole (#941).
 *
 * Covers:
 * - Per-role default resolution (worker/lead/scanner/verifier)
 * - Unknown/missing role falls back to the flat DEFAULT_TIMEOUT_MINUTES
 * - Callers still let explicit --timeout / SQUADS_AGENT_TIMEOUT_MINUTES win
 *   (asserted at the call-site source level, since the override chain lives
 *   inline at each call site rather than inside the helper itself)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TIMEOUT_MINUTES, defaultTimeoutForRole } from '../../src/lib/run-types.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readSrc = (relPath: string) => readFileSync(join(repoRoot, relPath), 'utf8');

describe('defaultTimeoutForRole (#941)', () => {
  it('resolves the per-role defaults', () => {
    expect(defaultTimeoutForRole('worker')).toBe(40);
    expect(defaultTimeoutForRole('lead')).toBe(20);
    expect(defaultTimeoutForRole('scanner')).toBe(15);
    expect(defaultTimeoutForRole('verifier')).toBe(20);
  });

  it('falls back to DEFAULT_TIMEOUT_MINUTES for unknown or missing roles', () => {
    expect(defaultTimeoutForRole(undefined)).toBe(DEFAULT_TIMEOUT_MINUTES);
    expect(defaultTimeoutForRole('coo')).toBe(DEFAULT_TIMEOUT_MINUTES);
    expect(defaultTimeoutForRole('bogus-role')).toBe(DEFAULT_TIMEOUT_MINUTES);
    expect(defaultTimeoutForRole()).toBe(DEFAULT_TIMEOUT_MINUTES);
  });
});

describe('per-role timeout call sites preserve explicit/env override order (#941)', () => {
  it('workflow.ts: config.timeout wins over the per-role default; env checked first', () => {
    const src = readSrc('src/lib/workflow.ts');
    const line = src.split('\n').find(l => l.includes('defaultTimeoutForRole(config.role)'));
    expect(line).toBeDefined();
    expect(line).toContain('envTimeout ? parseInt(envTimeout, 10)');
    expect(line).toContain('config.timeout ?? defaultTimeoutForRole(config.role)');
  });

  it('run-modes.ts (lead mode): options.timeout wins over the lead default', () => {
    const src = readSrc('src/lib/run-modes.ts');
    const line = src.split('\n').find(l => l.includes("defaultTimeoutForRole('lead')"));
    expect(line).toBeDefined();
    expect(line).toContain("options.timeout || defaultTimeoutForRole('lead')");
  });

  it('agent-runner.ts: options.timeout wins over the per-role default at both call sites', () => {
    const src = readSrc('src/lib/agent-runner.ts');
    const matches = src.split('\n').filter(l => l.includes('options.timeout || defaultTimeoutForRole(contextRole)'));
    expect(matches.length).toBe(2);
  });

  it('execution-engine.ts: executeWithClaude and executeWithProvider check the env var before the per-role default', () => {
    const src = readSrc('src/lib/execution-engine.ts');
    expect(src).toContain('const _timeoutMinutes = timeoutMinutes ?? defaultTimeoutForRole(options.contextStats?.role);');
    expect(src).toContain(
      'Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : (options.timeoutMinutes ?? defaultTimeoutForRole());'
    );
  });
});
