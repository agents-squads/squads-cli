import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadContextPolicy, policyHash, resolveLayerPath, type ContextPolicy } from '../src/lib/context-policy.js';

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

  // The policy file is OPTIONAL and documented to fall back to defaults. An
  // empty or comment-only file (js-yaml → undefined|null) must NOT crash — this
  // path runs on every `squads run`, so a scaffolded-but-empty file would
  // otherwise hard-fail all squad execution.
  it.each([
    ['empty', ''],
    ['whitespace-only', '   \n\n'],
    ['comment-only', '# no overrides yet\n'],
  ])('falls back to compiled defaults for a %s policy file (no crash)', (_label, contents) => {
    writeFileSync(join(dir, '.agents', 'context-policy.yml'), contents);
    process.chdir(dir);

    const policy = loadContextPolicy();

    expect(policy.roles.worker.budgetChars).toBe(60000); // compiled default
    expect(policy.layers).toHaveLength(7);               // full L0–L6 defaults
  });
});

describe('resolveLayerPath — archive/tombstoned guard (#1194 coverage)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'squads-resolvepath-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('skips archived/tombstoned candidates even when they exist on disk', () => {
    mkdirSync(join(dir, 'archive'), { recursive: true });
    mkdirSync(join(dir, 'tombstoned'), { recursive: true });
    writeFileSync(join(dir, 'archive', 'old.md'), 'archived');
    writeFileSync(join(dir, 'tombstoned', 'dead.md'), 'removed');
    writeFileSync(join(dir, 'live.md'), 'current');

    // archive/** and tombstoned/** must be refused; the first live path wins.
    expect(resolveLayerPath(['archive/old.md', 'tombstoned/dead.md', 'live.md'], dir, 'sq', 'ag'))
      .toBe(join(dir, 'live.md'));
    // when only forbidden candidates exist (even on disk), nothing resolves.
    expect(resolveLayerPath(['archive/old.md', 'tombstoned/dead.md'], dir, 'sq', 'ag'))
      .toBeNull();
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
