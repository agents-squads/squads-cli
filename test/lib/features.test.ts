/**
 * Feature lists as code (#1329) — validator, aggregation, `squads plan --features`,
 * and `squads contract validate --features`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { analyzeFeatures, gitShaExists, resolveOrgRoot, type ShaExists } from '../../src/lib/features.js';
import { featuresCommand } from '../../src/commands/plan.js';
import { stripAnsi } from '../../src/lib/terminal.js';

const GOOD_SHA = 'abc1234';
const shaExists: ShaExists = (_dir, sha) => sha === GOOD_SHA;

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  outcome: 'O1',
  title: `item ${id}`,
  status: 'failing',
  ...extra,
});
const verified = {
  status: 'passing',
  verifications: [{ model: 'opus', builder_model: 'sonnet', sha: GOOD_SHA, at: '2026-10-19T00:00:00Z' }],
};

let root: string;

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}
function repo(name: string, items: unknown[], ownerRepo = `acme/${name}`): void {
  writeJson(join(root, name, '.agents', 'features.json'), { schema: 1, repo: ownerRepo, items });
}

/** 3 valid repos, 1 duplicate id, 1 passing-without-verification, roadmap with a missing ref. */
function buildFixture(): void {
  repo('alpha', [item('A1'), item('A2', verified)]);
  repo('beta', [item('B1', { outcome: 'O2' })]);
  repo('gamma', [item('G1', verified), item('G2', { outcome: 'O2' }), item('G3')]);
  repo('dupe', [item('D1'), item('D1')]);
  repo('liar', [item('L1', { status: 'passing' })]);
  writeJson(join(root, 'hq', '.agents', 'roadmap.json'), {
    outcomes: [
      { id: 'O1', name: 'First', target: ['2026-10-01', '2026-12-31'], items: ['acme/alpha:A1', 'alpha:A2', 'gamma:G1', 'beta:NOPE'] },
      { id: 'O2', name: 'Second', items: ['beta:B1', 'gamma:G2'] },
    ],
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'features-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('validator', () => {
  it('reports exactly the 3 planted problems on the fixture org root', () => {
    buildFixture();
    const view = analyzeFeatures(root, { shaExists });
    expect(view.problems.map(p => p.code).sort()).toEqual([
      'duplicate-id',
      'missing-roadmap-item',
      'passing-without-verification',
    ]);
    expect(view.problems.find(p => p.code === 'duplicate-id')?.file).toBe(join('dupe', '.agents', 'features.json'));
    expect(view.problems.find(p => p.code === 'passing-without-verification')?.item).toBe('L1');
    expect(view.problems.find(p => p.code === 'missing-roadmap-item')?.item).toBe('beta:NOPE');
  });

  it('rejects a verification by the builder model itself, and one with an unknown sha', () => {
    repo('same', [
      item('S1', { status: 'passing', verifications: [{ model: 'opus', builder_model: 'opus', sha: GOOD_SHA, at: 'x' }] }),
      item('S2', { status: 'passing', verifications: [{ model: 'opus', builder_model: 'sonnet', sha: 'deadbee', at: 'x' }] }),
    ]);
    const view = analyzeFeatures(root, { shaExists });
    expect(view.problems.map(p => p.item)).toEqual(['S1', 'S2']);
  });

  it('flags a non-string outcome and malformed JSON as problems, not crashes', () => {
    repo('typed', [item('T1', { outcome: 7 })]);
    mkdirSync(join(root, 'broken', '.agents'), { recursive: true });
    writeFileSync(join(root, 'broken', '.agents', 'features.json'), '{nope');
    const view = analyzeFeatures(root, { shaExists });
    expect(view.problems.map(p => p.code).sort()).toEqual(['invalid-schema', 'unreadable']);
    expect(view.totals).toMatchObject({ files: 2, valid_files: 0, items: 0 });
  });

  it('checks sha existence against the real repo with git', () => {
    mkdirSync(join(root, 'real'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: join(root, 'real') });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], {
      cwd: join(root, 'real'),
    });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(root, 'real'), encoding: 'utf-8' }).trim();
    expect(gitShaExists(join(root, 'real'), sha)).toBe(true);
    expect(gitShaExists(join(root, 'real'), 'f'.repeat(40))).toBe(false);
    expect(gitShaExists(join(root, 'real'), '--output=x')).toBe(false);
  });
});

describe('aggregation', () => {
  it('totals equal the sum of the valid files', () => {
    buildFixture();
    const view = analyzeFeatures(root, { shaExists });
    // valid: alpha(2) + beta(1) + gamma(3); dupe + liar excluded
    expect(view.totals).toEqual({ files: 5, valid_files: 3, items: 6, passing: 2, failing: 4 });
    const inOutcomes = view.outcomes.reduce((n, o) => n + o.items.length, 0);
    expect(inOutcomes + view.unreferenced.length).toBe(view.totals.items);
  });

  it('joins items to roadmap outcomes and lists missing references', () => {
    buildFixture();
    const view = analyzeFeatures(root, { shaExists });
    const o1 = view.outcomes.find(o => o.id === 'O1');
    expect(o1?.items.map(i => i.ref)).toEqual(['acme/alpha:A1', 'acme/alpha:A2', 'acme/gamma:G1']);
    expect(o1?.counts).toEqual({ total: 3, passing: 2, failing: 1 });
    expect(o1?.missing).toEqual(['beta:NOPE']);
    expect(view.unreferenced.map(i => i.ref)).toEqual(['acme/gamma:G3']);
  });

  it('groups by outcome string when there is no roadmap', () => {
    repo('alpha', [item('A1'), item('A2', { outcome: 'O2' })]);
    repo('beta', [item('B1')]);
    const view = analyzeFeatures(root, { shaExists });
    expect(view.roadmap).toBeNull();
    expect(view.outcomes.map(o => [o.id, o.items.length])).toEqual([['O1', 2], ['O2', 1]]);
    expect(view.problems).toEqual([]);
  });

  it('is read-only', () => {
    buildFixture();
    const snapshot = () => readdirSync(root, { recursive: true }).sort().join('\n');
    const before = snapshot();
    analyzeFeatures(root, { shaExists });
    expect(snapshot()).toBe(before);
  });

  it('picks the org root: explicit, HQ with a roadmap, else the project parent', () => {
    expect(resolveOrgRoot('x', '/a/b', '/cwd')).toBe(resolve('/cwd', 'x'));
    expect(resolveOrgRoot(undefined, '/a/b', '/cwd')).toBe('/a');
    expect(resolveOrgRoot(undefined, null, '/cwd')).toBe('/cwd');
    buildFixture();
    expect(resolveOrgRoot(undefined, join(root, 'hq'), '/cwd')).toBe(join(root, 'hq'));
  });
});

describe('squads plan --features', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    }) as typeof process.stdout.write);
  });
  afterEach(() => vi.restoreAllMocks());

  it('--json emits totals and exits 0', () => {
    repo('alpha', [item('A1'), item('A2', { status: 'passing', verifications: [] })]);
    repo('beta', [item('B1')]);
    const code = featuresCommand({ json: true, root });
    const parsed = JSON.parse(out.join(''));
    expect(code).toBe(0);
    // alpha is invalid (passing, no verification) so only beta's item is counted
    expect(parsed.totals).toMatchObject({ files: 2, valid_files: 1, items: 1 });
    expect(parsed.problems).toHaveLength(1);
  });

  it('prints a clear message when there are no feature lists', () => {
    const code = featuresCommand({ root });
    expect(code).toBe(0);
    expect(stripAnsi(out.join(''))).toContain('No feature lists yet');
  });
});

// Built-CLI checks: need `npm run build` first (same as the other e2e files).
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');
describe.skipIf(!existsSync(CLI))('CLI (dist)', () => {
  const run = (args: string[], cwd: string) => {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    return spawnSync('node', [CLI, ...args], { cwd, env, encoding: 'utf-8', timeout: 60000 });
  };

  it('fresh `squads init` project: plan --features says no feature lists, exit 0', () => {
    const project = join(root, 'fresh');
    mkdirSync(project);
    execFileSync('git', ['init', '-q'], { cwd: project });
    expect(run(['init', '--yes', '--force'], project).status).toBe(0);
    const r = run(['plan', '--features', '--root', project], project);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No feature lists yet');
    const v = run(['contract', 'validate', '--features', project], project);
    expect(v.status).toBe(0);
  });

  it('contract validate --features exits 1 with the planted problems', () => {
    buildFixture();
    const r = run(['contract', 'validate', '--features', root, '--json'], root);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).problems.length).toBeGreaterThanOrEqual(3);
  });
});
