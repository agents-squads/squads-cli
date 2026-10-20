import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

import { auditOrg } from '../src/lib/org-audit.js';

// Fixed clock: 2026-10-19. "Recent" commits/metrics are mid-October,
// "old" ones are August/September (beyond the 30d idle / 14d stale defaults).
const NOW = new Date('2026-10-19T12:00:00Z');
const RECENT = '2026-10-15T12:00:00Z';
const OLD = '2026-08-01T00:00:00Z';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'squads-audit-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function initRepo(dir: string, opts: { remote?: string; commitDate?: string } = {}): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  writeFileSync(join(dir, 'file.txt'), 'work\n');
  git(dir, ['add', '.']);
  const dateEnv = opts.commitDate
    ? { GIT_AUTHOR_DATE: opts.commitDate, GIT_COMMITTER_DATE: opts.commitDate }
    : {};
  git(dir, ['-c', 'user.email=audit@example.com', '-c', 'user.name=audit', 'commit', '-qm', 'init'], dateEnv);
  if (opts.remote) git(dir, ['remote', 'add', 'origin', opts.remote]);
}

function agentsMd(dir: string, frontmatter: Record<string, string>, body = ''): void {
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
  writeFileSync(join(dir, 'AGENTS.md'), `---\n${fm}\n---\n\n${body}\n`);
}

function metricBody(command: string): string {
  return ['## Metric', '', '```sh', command, '```'].join('\n');
}

function unit(name: string) {
  const report = auditOrg(root, { now: NOW });
  const u = report.units.find((x) => x.name === name);
  if (!u) throw new Error(`unit ${name} not audited`);
  return u;
}

function codes(name: string): string[] {
  return unit(name).findings.map((f) => f.code).sort();
}

describe('auditOrg — Check bullet 1: fixture org root classifies exactly', () => {
  beforeEach(() => {
    // git repo with a remote — clean product unit
    const app = join(root, 'app');
    initRepo(app, { remote: 'git@example.com:org/app.git', commitDate: RECENT });
    agentsMd(app, { kind: 'product', lifecycle: 'active' }, metricBody("printf '2026-10-10 1\\n2026-10-18 2\\n'"));
    mkdirSync(join(app, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(app, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    mkdirSync(join(app, 'schemas'));
    writeFileSync(join(app, 'schemas', 'contract.json'), '{}\n');

    // git repo without a remote
    const lib = join(root, 'lib');
    initRepo(lib, { commitDate: RECENT });
    agentsMd(lib, { kind: 'domain', lifecycle: 'active' }, metricBody("printf '2026-10-18 7\\n'"));

    // plain folder holding work, no git, no self-description
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    writeFileSync(join(scratch, 'notes.txt'), 'unfinished work\n');

    // parked repo (properly declared, but no remote — listed, must not count as a gap)
    const old = join(root, 'old');
    initRepo(old, { commitDate: OLD });
    agentsMd(old, { kind: 'lab', lifecycle: 'parked', parked_reason: 'paused', revisit: '2027-01-15' });

    // repo with a stale doc fact (AGENTS.md version != package.json version)
    const docsRepo = join(root, 'docs-repo');
    initRepo(docsRepo, { remote: 'git@example.com:org/docs.git', commitDate: RECENT });
    agentsMd(docsRepo, { kind: 'domain', lifecycle: 'active', version: '1.0.0' }, metricBody("printf '2026-10-18 3\\n'"));
    writeFileSync(join(docsRepo, 'package.json'), JSON.stringify({ name: 'docs-repo', version: '2.0.0' }));
  });

  it('reports exactly the expected classes per unit', () => {
    const report = auditOrg(root, { now: NOW });
    expect(report.units.map((u) => u.name)).toEqual(['app', 'docs-repo', 'lib', 'old', 'scratch']);

    expect(codes('app')).toEqual([]);
    expect(unit('app').metric).toBe('ok');
    expect(unit('app').inGit).toBe(true);
    expect(unit('app').hasRemote).toBe(true);

    expect(codes('docs-repo')).toEqual(['stale-doc-fact']);

    expect(codes('lib')).toEqual(['no-remote']);

    expect(codes('scratch')).toEqual(['not-in-git', 'unclassified']);
    expect(unit('scratch').hints.length).toBeGreaterThan(0);

    // parked: listed with its no-remote finding, but does not count as a gap
    expect(codes('old')).toEqual(['no-remote']);
    expect(unit('old').countsAsGap).toBe(false);
  });

  it('counts gaps excluding parked/archived units', () => {
    const report = auditOrg(root, { now: NOW });
    // lib no-remote (1) + scratch not-in-git & unclassified (2) + docs-repo stale-doc-fact (1)
    expect(report.summary.gaps).toBe(4);
    expect(report.summary.parkedOrArchived).toBe(1);
    expect(report.summary.units).toBe(5);
  });

  it('is read-only: no writes anywhere in the org root', () => {
    const snapshot = (base: string): Map<string, number> => {
      const map = new Map<string, number>();
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const p = join(dir, entry);
          const st = statSync(p);
          map.set(relative(base, p), st.mtimeMs);
          if (st.isDirectory()) walk(p);
        }
      };
      walk(base);
      return map;
    };
    const before = snapshot(root);
    auditOrg(root, { now: NOW, propose: true });
    const after = snapshot(root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [p, mtime] of before) {
      expect(after.get(p)).toBe(mtime);
    }
  });

  it('--propose drafts one issue per gap, parked excluded, nothing filed', () => {
    const report = auditOrg(root, { now: NOW, propose: true });
    const proposals = report.proposals!;
    expect(proposals).toHaveLength(4);
    expect(proposals.every((p) => p.repo !== 'old')).toBe(true);
    expect(proposals.some((p) => p.title.startsWith('fix: add a git remote for lib'))).toBe(true);
    expect(proposals.every((p) => p.body.includes('Draft only'))).toBe(true);
  });
});

describe('auditOrg — metric classification', () => {
  function metricUnit(name: string, body: string): void {
    const dir = join(root, name);
    initRepo(dir, { remote: `git@example.com:org/${name}.git`, commitDate: RECENT });
    agentsMd(dir, { kind: 'domain', lifecycle: 'active' }, body);
  }

  it('undeclared: no ## Metric section', () => {
    metricUnit('m-undeclared', '# just docs\n');
    expect(unit('m-undeclared').metric).toBe('undeclared');
    expect(codes('m-undeclared')).toEqual(['metric-undeclared']);
  });

  it('no-data: command fails', () => {
    metricUnit('m-nodata', metricBody('exit 1'));
    expect(unit('m-nodata').metric).toBe('no-data');
    expect(codes('m-nodata')).toEqual(['metric-no-data']);
  });

  it('stale: newest data point older than staleDays', () => {
    metricUnit('m-stale', metricBody("printf '2026-09-01 1\\n2026-09-20 2\\n'"));
    expect(unit('m-stale').metric).toBe('stale');
    expect(codes('m-stale')).toEqual(['metric-stale']);
  });

  it('flat: every data point identical', () => {
    metricUnit('m-flat', metricBody("printf '2026-10-10 5\\n2026-10-18 5\\n'"));
    expect(unit('m-flat').metric).toBe('flat');
    expect(codes('m-flat')).toEqual(['metric-flat']);
  });

  it('ok: fresh, moving data', () => {
    metricUnit('m-ok', metricBody("printf '2026-10-10 1\\n2026-10-18 2\\n'"));
    expect(unit('m-ok').metric).toBe('ok');
    expect(codes('m-ok')).toEqual([]);
  });
});

describe('auditOrg — delivery basics for product kind', () => {
  it('flags missing CI and missing contract', () => {
    const dir = join(root, 'prod');
    initRepo(dir, { remote: 'git@example.com:org/prod.git', commitDate: RECENT });
    agentsMd(dir, { kind: 'product', lifecycle: 'active' }, metricBody("printf '2026-10-18 1\\n'"));
    expect(codes('prod')).toEqual(['no-ci', 'no-contract']);
  });

  it('accepts an AGENTS.md ## Contract section as the versioned contract', () => {
    const dir = join(root, 'prod2');
    initRepo(dir, { remote: 'git@example.com:org/prod2.git', commitDate: RECENT });
    agentsMd(dir, { kind: 'product', lifecycle: 'active' }, `${metricBody("printf '2026-10-18 1\\n'")}\n\n## Contract\n\nemits: x\n`);
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    expect(codes('prod2')).toEqual([]);
  });
});

describe('auditOrg — activity vs lifecycle', () => {
  it('active unit untouched for >idleDays is a gap', () => {
    const dir = join(root, 'idle');
    initRepo(dir, { remote: 'git@example.com:org/idle.git', commitDate: OLD });
    agentsMd(dir, { kind: 'domain', lifecycle: 'active' }, metricBody("printf '2026-10-18 1\\n'"));
    expect(codes('idle')).toEqual(['active-but-idle']);
  });

  it('archived unit still pushed is listed but not counted as a gap', () => {
    const dir = join(root, 'zombie');
    initRepo(dir, { remote: 'git@example.com:org/zombie.git', commitDate: RECENT });
    agentsMd(dir, { kind: 'domain', lifecycle: 'archived' }, metricBody("printf '2026-10-18 1\\n'"));
    const u = unit('zombie');
    expect(u.findings.map((f) => f.code)).toEqual(['archived-but-active']);
    expect(u.countsAsGap).toBe(false);
    const report = auditOrg(root, { now: NOW });
    expect(report.summary.gaps).toBe(0);
  });

  it('parked without reason + revisit date is flagged', () => {
    const dir = join(root, 'badpark');
    initRepo(dir, { remote: 'git@example.com:org/badpark.git', commitDate: OLD });
    agentsMd(dir, { kind: 'domain', lifecycle: 'parked' });
    expect(codes('badpark')).toEqual(['parked-incomplete']);
  });
});

describe('auditOrg — names table and org-level docs facts', () => {
  it('flags retired terms declared by the org', () => {
    const hq = join(root, 'hq');
    mkdirSync(hq);
    writeFileSync(join(hq, 'names.yml'), 'retired:\n  - oldbrand\n');
    const dir = join(root, 'site');
    initRepo(dir, { remote: 'git@example.com:org/site.git', commitDate: RECENT });
    agentsMd(dir, { kind: 'product', lifecycle: 'active' }, `${metricBody("printf '2026-10-18 1\\n'")}\n\n## Contract\n\nx\n`);
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    writeFileSync(join(dir, 'README.md'), '# site\n\npowered by oldbrand\n');
    expect(codes('site')).toEqual(['retired-name']);
  });

  it('flags repos listed in org docs that no longer exist', () => {
    writeFileSync(join(root, 'README.md'), '# Org\n\n## Repos\n\n- `ghost` — retired last quarter\n');
    const report = auditOrg(root, { now: NOW });
    expect(report.orgFindings).toHaveLength(1);
    expect(report.orgFindings[0].code).toBe('stale-doc-fact');
    expect(report.orgFindings[0].message).toContain('ghost');
  });
});
