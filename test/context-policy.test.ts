import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadContextPolicy, policyHash, type ContextPolicy } from '../src/lib/context-policy.js';

// #1049 CRITICAL-1 (policy not consumed) + CRITICAL-2 (inert hand-rolled YAML
// parser). js-yaml now parses the file; these tests prove a nested override in
// context-policy.yml actually reaches the resolved policy.
describe('loadContextPolicy — YAML override consumption (#1049 / #1194)', () => {
  let dir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'squads-ctxpolicy-'));
    // findSquadsDir() walks up for `.agents/squads`; the ancestor walk returns
    // before any git fallback, so a temp `.agents` fully isolates the test.
    mkdirSync(join(dir, '.agents', 'squads'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies a nested override (proves js-yaml parses nested maps + block sequences)', () => {
    const yml = [
      'version: "9.9"',
      'roles:',
      '  worker:',
      '    layers: [0, 1, 2]',
      '    budget_chars: 12345',
      'layers:',
      '  - id: 0',
      '    key: system',
      '    name: SYSTEM.md',
      '    description: overridden system layer',
      '    paths: [SYSTEM.md]',
      '    required: true',
      '    outside_budget: true',
      '    decay_days: 0',
      '',
    ].join('\n');
    writeFileSync(join(dir, '.agents', 'context-policy.yml'), yml);
    process.chdir(dir);

    const policy = loadContextPolicy();

    // Nested map value + nested inline list, parsed and consumed.
    expect(policy.roles.worker.budgetChars).toBe(12345);
    expect(policy.roles.worker.layers).toEqual([0, 1, 2]);
    // Deep-merge: a role the file did not override keeps its compiled default.
    expect(policy.roles.scanner.budgetChars).toBe(50000);
    // Block sequence of a mapping (with an inline-array child) parsed correctly.
    expect(policy.layers).toHaveLength(1);
    expect(policy.layers[0].description).toBe('overridden system layer');
    expect(policy.layers[0].paths).toEqual(['SYSTEM.md']);
  });
});

// #1049 CRITICAL-3 (replacer-array policyHash). The hash must be a stable
// function of the resolved policy content — same content in, same hash out;
// any change out, a different hash.
describe('policyHash — determinism + content sensitivity (#1194)', () => {
  const base: ContextPolicy = {
    version: '1.0',
    roles: { worker: { layers: [0, 1], budgetChars: 60000 } },
    layers: [{
      id: 0,
      key: 'system',
      name: 'SYSTEM.md',
      description: 'x',
      paths: ['SYSTEM.md'],
      required: true,
      outsideBudget: true,
      decayDays: 0,
    }],
  };

  it('is deterministic — identical policy content hashes identically', () => {
    const clone: ContextPolicy = JSON.parse(JSON.stringify(base));
    expect(policyHash(clone)).toBe(policyHash(base));
  });

  it('changes when any policy value changes', () => {
    const changed: ContextPolicy = JSON.parse(JSON.stringify(base));
    changed.roles.worker.budgetChars = 99999;
    expect(policyHash(changed)).not.toBe(policyHash(base));
  });
});
