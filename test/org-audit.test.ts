import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync, existsSync, chmodSync,
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
  cached = null;
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

// One audit per test: unit()/codes() are called many times per test, and each
// audit spawns git and metric commands for every unit.
let cached: { root: string; report: ReturnType<typeof auditOrg> } | null = null;
function unit(name: string) {
  if (!cached || cached.root !== root) cached = { root, report: auditOrg(root, { now: NOW, runMetrics: true }) };
  const report = cached.report;
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
    const report = auditOrg(root, { now: NOW, runMetrics: true });
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
    const report = auditOrg(root, { now: NOW, runMetrics: true });
    // lib no-remote (1) + scratch not-in-git & unclassified (2) + docs-repo stale-doc-fact (1)
    expect(report.summary.gaps).toBe(4);
    expect(report.summary.parkedOrArchived).toBe(1);
    expect(report.summary.units).toBe(5);
  });

  it('is read-only with the default (no --run-metrics) audit: no writes anywhere in the org root', () => {
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
    const report = auditOrg(root, { now: NOW, propose: true, runMetrics: true });
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
    const report = auditOrg(root, { now: NOW, runMetrics: true });
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
    const report = auditOrg(root, { now: NOW, runMetrics: true });
    expect(report.orgFindings).toHaveLength(1);
    expect(report.orgFindings[0].code).toBe('stale-doc-fact');
    expect(report.orgFindings[0].message).toContain('ghost');
  });
});

describe('auditOrg — safety', () => {
  it('does not execute declared metric commands unless runMetrics is set', () => {
    const marker = join(root, 'metric-ran.marker');
    const dir = join(root, 'm-optin');
    mkdirSync(dir, { recursive: true });
    agentsMd(dir, { kind: 'domain', lifecycle: 'active' }, metricBody(`touch '${marker}'; printf '2026-10-18 1\\n'`));
    const off = auditOrg(root, { now: NOW }).units.find((u) => u.name === 'm-optin')!;
    expect(off.metric).toBe('declared');
    expect(existsSync(marker)).toBe(false);
    const on = auditOrg(root, { now: NOW, runMetrics: true }).units.find((u) => u.name === 'm-optin')!;
    expect(on.metric).toBe('ok');
    expect(existsSync(marker)).toBe(true);
  });

  it('reports the retired kind "internal" with its replacement', () => {
    const dir = join(root, 'k-internal');
    mkdirSync(dir, { recursive: true });
    agentsMd(dir, { kind: 'internal', lifecycle: 'active' }, '# x\n');
    const u = auditOrg(root, { now: NOW }).units.find((x) => x.name === 'k-internal')!;
    expect(u.findings.map((f) => f.code)).toContain('retired-kind');
    expect(u.findings.find((f) => f.code === 'retired-kind')!.message).toContain('"lab"');
  });

  it('runs git hardened: a unit\'s own fsmonitor hook never executes', () => {
    const dir = join(root, 'g-fsmonitor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'x\n');
    initRepo(dir, { remote: 'https://example.invalid/x.git' });
    const marker = join(root, 'fsmonitor-ran.marker');
    const hook = join(root, 'fsmonitor-hook.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    git(dir, ['config', 'core.fsmonitor', hook]);
    auditOrg(root, { now: NOW });
    expect(existsSync(marker)).toBe(false);
  });
});

// --- Review of PR #1331 -------------------------------------------------------

function plainUnit(name: string, fm: Record<string, string>, body = '', opts: { remote?: string; commitDate?: string } = {}): string {
  const dir = join(root, name);
  initRepo(dir, { remote: opts.remote ?? `git@example.com:org/${name}.git`, commitDate: opts.commitDate ?? RECENT });
  agentsMd(dir, fm, body);
  return dir;
}

function auditUnitOnly(name: string, opts: Parameters<typeof auditOrg>[1] = {}) {
  const u = auditOrg(root, { now: NOW, ...opts }).units.find((x) => x.name === name);
  if (!u) throw new Error(`unit ${name} not audited`);
  return u;
}

describe('review #1331 — S1/L8: --run-metrics blast radius', () => {
  const SECRET = 'SQUADS_AUDIT_TEST_SECRET';
  afterEach(() => {
    delete process.env[SECRET];
  });

  it('S1: metric commands do not inherit the operator environment', () => {
    process.env[SECRET] = 'hunter2';
    plainUnit('envleak', { kind: 'domain', lifecycle: 'active' }, metricBody(`test -z "$${SECRET}" && printf '2026-10-18 1\\n'`));
    // Scrubbed env: the secret is empty -> the command prints data -> ok. Leaked env -> no-data.
    expect(auditUnitOnly('envleak', { runMetrics: true }).metric).toBe('ok');
  });

  it('L8: parked and archived units never execute their metric command', () => {
    const marker = join(root, 'dormant-ran.marker');
    for (const lifecycle of ['parked', 'archived']) {
      plainUnit(`dormant-${lifecycle}`, { kind: 'lab', lifecycle, parked_reason: 'x', revisit: '2027-01-01' }, metricBody(`touch '${marker}'; printf '2026-10-18 1\\n'`), { commitDate: OLD });
    }
    auditOrg(root, { now: NOW, runMetrics: true });
    expect(existsSync(marker)).toBe(false);
  });

  it('S1: the declared command is surfaced on the unit so callers can show it before running', () => {
    plainUnit('shown', { kind: 'domain', lifecycle: 'active' }, metricBody("printf '2026-10-18 1\\n'"));
    expect(auditUnitOnly('shown').metricCommand).toBe("printf '2026-10-18 1\\n'");
  });
});

describe('review #1331 — M2: unreadable unit does not abort the audit', () => {
  it.skipIf(process.getuid?.() === 0)('reports an audit-error for a directory without read permission and audits the rest', () => {
    const locked = join(root, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'x.txt'), 'x');
    plainUnit('fine', { kind: 'domain', lifecycle: 'active' }, metricBody("printf '2026-10-18 1\\n'"));
    chmodSync(locked, 0o311);
    try {
      const report = auditOrg(root, { now: NOW });
      expect(report.units.map((u) => u.name)).toEqual(['fine', 'locked']);
      expect(report.units.find((u) => u.name === 'locked')!.findings.map((f) => f.code)).toContain('audit-error');
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe('review #1331 — M3: malformed AGENTS.md is not reported as missing', () => {
  it('emits invalid-agents-md with the parse error and no "create AGENTS.md" hint', () => {
    const dir = plainUnit('badyaml', { kind: 'domain' });
    writeFileSync(join(dir, 'AGENTS.md'), '---\nkind: [unclosed\n---\n\n# x\n');
    const u = auditUnitOnly('badyaml');
    const codes = u.findings.map((f) => f.code);
    expect(codes).toContain('invalid-agents-md');
    expect(codes).not.toContain('unclassified');
    expect(u.hints).toEqual([]);
    expect(u.findings.find((f) => f.code === 'invalid-agents-md')!.message).toContain('AGENTS.md');
  });
});

describe('review #1331 — M4: only a declared version is a doc fact', () => {
  it('a historical vX.Y.Z mention in prose is not a stale-doc-fact', () => {
    const dir = plainUnit('changelogy', { kind: 'domain', lifecycle: 'active' }, `${metricBody("printf '2026-10-18 1\\n'")}\n\nAdded in v0.9.0. Requires version 0.8.1 of the tool.\n`);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'c', version: '0.10.0' }));
    expect(auditUnitOnly('changelogy', { runMetrics: true }).findings.map((f) => f.code)).toEqual([]);
  });
});

describe('review #1331 — M5: remote credentials are redacted', () => {
  it('strips userinfo from remote URLs in the report and in proposals', () => {
    plainUnit('leaky', { kind: 'domain' }, '# x\n', { remote: 'https://x-access-token:ghp_SUPERSECRET@github.com/org/leaky.git' });
    const report = auditOrg(root, { now: NOW, propose: true });
    const json = JSON.stringify(report);
    expect(json).not.toContain('ghp_SUPERSECRET');
    expect(report.units[0].remoteUrl).toBe('https://github.com/org/leaky.git');
  });
});

describe('review #1331 — M6: parked-incomplete is a counted, proposed gap', () => {
  it('counts and proposes a parked unit missing reason/revisit; a complete parked unit stays uncounted', () => {
    plainUnit('badpark2', { kind: 'lab', lifecycle: 'parked' }, '', { commitDate: OLD });
    plainUnit('goodpark', { kind: 'lab', lifecycle: 'parked', parked_reason: 'paused', revisit: '2027-01-15' }, '', { commitDate: OLD });
    const report = auditOrg(root, { now: NOW, propose: true });
    expect(report.units.find((u) => u.name === 'badpark2')!.countsAsGap).toBe(true);
    expect(report.units.find((u) => u.name === 'goodpark')!.countsAsGap).toBe(false);
    expect(report.summary.gaps).toBe(1);
    expect(report.proposals!.map((p) => p.repo)).toEqual(['badpark2']);
  });
});

describe('review #1331 — M7: multi-line metric commands run whole', () => {
  it('executes a backslash-continued command, not just its first line', () => {
    plainUnit('multiline', { kind: 'domain', lifecycle: 'active' }, metricBody("true && \\\n  printf '2026-10-18 1\\n'"));
    expect(auditUnitOnly('multiline', { runMetrics: true }).metric).toBe('ok');
  });
});

describe('review #1331 — L10: unparseable inputs are findings, not silence', () => {
  it('reports an invalid names table at org level', () => {
    mkdirSync(join(root, 'hq'));
    writeFileSync(join(root, 'hq', 'names.yml'), 'retired: [unclosed\n');
    const report = auditOrg(root, { now: NOW });
    expect(report.orgFindings.map((f) => f.code)).toContain('invalid-names-table');
  });

  it('reports an invalid package.json on the unit', () => {
    const dir = plainUnit('badpkg', { kind: 'domain', lifecycle: 'active' }, metricBody("printf '2026-10-18 1\\n'"));
    writeFileSync(join(dir, 'package.json'), '{ not json');
    expect(auditUnitOnly('badpkg', { runMetrics: true }).findings.map((f) => f.code)).toEqual(['invalid-package-json']);
  });
});

describe('review #1331 — L11: broken git is not "no remote"', () => {
  it('a corrupt .git reports git-error, never no-remote', () => {
    const dir = join(root, 'brokengit');
    mkdirSync(dir);
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/nowhere\n');
    writeFileSync(join(dir, 'f.txt'), 'x');
    const codes = auditUnitOnly('brokengit').findings.map((f) => f.code);
    expect(codes).toContain('git-error');
    expect(codes).not.toContain('no-remote');
  });

  it('a repo with no commits yet is not a git-error', () => {
    const dir = join(root, 'fresh');
    mkdirSync(dir);
    git(dir, ['init', '-q']);
    git(dir, ['remote', 'add', 'origin', 'git@example.com:org/fresh.git']);
    expect(auditUnitOnly('fresh').findings.map((f) => f.code)).not.toContain('git-error');
  });
});

describe('review #1331 — fresh squads init tree (Check bullet 2)', () => {
  it('the init AGENTS.md template yields an unclassified unit with a hint and no crash', () => {
    const dir = join(root, 'fresh-project');
    mkdirSync(dir);
    writeFileSync(join(dir, 'AGENTS.md'), readFileSync(join(__dirname, '..', 'templates', 'core', 'AGENTS.md.template'), 'utf8'));
    const u = auditUnitOnly('fresh-project');
    expect(u.unclassified).toBe(true);
    expect(u.findings.map((f) => f.code)).toContain('unclassified');
    expect(u.hints.length).toBeGreaterThan(0);
  });
});

describe('duplicate docs — one file per kind of text', () => {
  const BASE = [
    '# Release plan',
    '',
    'This document describes the release process for the platform.',
    'Cut a branch from develop, run the full test suite, and verify the',
    'changelog. Tag the release, publish the package, then announce it to',
    'the team so everyone knows what changed and when. After release, watch',
    'the dashboards for errors and roll back if the error rate rises above',
    'the agreed threshold.',
  ].join('\n');

  function docsUnit(name: string): string {
    return plainUnit(name, { kind: 'domain', lifecycle: 'active', version: '1.0.0' }, metricBody("printf '2026-10-18 1\\n'"));
  }

  function commitDocs(dir: string, paths: string[] = ['.']): void {
    git(dir, ['add', '--', ...paths]);
    git(dir, ['-c', 'user.email=audit@example.com', '-c', 'user.name=audit', 'commit', '-qm', 'docs']);
  }

  function duplicateFindings(name: string) {
    return auditUnitOnly(name, { runMetrics: true }).findings.filter((f) => f.code === 'duplicate-doc');
  }

  it('flags a tracked dated pair whose text overlaps at similarity >= 0.3 as one family', () => {
    const dir = docsUnit('dated');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'plan-2026-10-14.md'), BASE);
    writeFileSync(join(dir, 'docs', 'plan-2026-10-19.md'), BASE.replace('platform', 'product').replace('publish', 'ship'));
    commitDocs(dir);

    const found = duplicateFindings('dated');
    expect(found).toHaveLength(1);
    expect(found[0].check).toBe('docs-facts');
    expect(found[0].message).toContain('docs/plan-2026-10-14.md');
    expect(found[0].message).toContain('docs/plan-2026-10-19.md');
    expect(found[0].message).toContain('2 file(s)');
    expect(found[0].message).toContain('2 overlapping');
    expect(found[0].message).toMatch(/similarity \d+\.\d{2}/);
  });

  it('does not flag a dated series with disjoint content', () => {
    const dir = docsUnit('series');
    mkdirSync(join(dir, 'docs'));
    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(dir, 'docs', `2026-01-0${i}-report.md`),
        `# Report ${i}\n\nalpha${i} beta${i} gamma${i} delta${i} epsilon${i} zeta${i} eta${i} theta${i}\n`,
      );
    }
    commitDocs(dir);

    expect(duplicateFindings('series')).toEqual([]);
  });

  it('reports one finding per family, listing only the overlapping members', () => {
    const dir = docsUnit('family');
    mkdirSync(join(dir, 'docs'));
    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(dir, 'docs', `plan-2026-10-0${i}.md`), BASE.replace('platform', `product${i}`));
    }
    writeFileSync(join(dir, 'docs', 'plan-2026-10-04.md'), '# Unrelated\n\nA wholly different note about security disclosure windows.\n');
    commitDocs(dir);

    const found = duplicateFindings('family');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('4 file(s)');
    expect(found[0].message).toContain('3 overlapping');
    expect(found[0].message).toContain('docs/plan-2026-10-01.md');
    expect(found[0].message).toContain('docs/plan-2026-10-02.md');
    expect(found[0].message).toContain('docs/plan-2026-10-03.md');
    expect(found[0].message).not.toContain('docs/plan-2026-10-04.md');
  });

  it('does not flag two unrelated docs', () => {
    const dir = docsUnit('unrelated');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'release.md'), BASE);
    writeFileSync(join(dir, 'docs', 'security.md'), [
      '# Security policy',
      '',
      'Report vulnerabilities privately to the maintainers. Do not open a',
      'public issue. We acknowledge reports within two business days and',
      'coordinate disclosure after a fix is available to users.',
    ].join('\n'));
    commitDocs(dir);

    expect(duplicateFindings('unrelated')).toEqual([]);
  });

  it('flags a tracked near-copy with a few edits at similarity >= 0.6', () => {
    const dir = docsUnit('nearcopy');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'release.md'), BASE);
    writeFileSync(join(dir, 'docs', 'release-copy.md'), BASE.replace('platform', 'product').replace('publish', 'ship'));
    commitDocs(dir);

    const found = duplicateFindings('nearcopy');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('docs/release.md');
    expect(found[0].message).toContain('docs/release-copy.md');
    const similarity = Number(/similarity ([\d.]+)/.exec(found[0].message)![1]);
    expect(similarity).toBeGreaterThanOrEqual(0.6);
  });

  it('does not flag an untracked near-copy in a git repo', () => {
    const dir = docsUnit('untracked');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'release.md'), BASE);
    writeFileSync(join(dir, 'docs', 'release-copy.md'), BASE);
    commitDocs(dir, ['docs/release.md']);

    expect(duplicateFindings('untracked')).toEqual([]);
  });

  it('treats 3+ same-basename files in sibling directories as data, not docs', () => {
    const dir = docsUnit('templated');
    for (let i = 1; i <= 5; i++) {
      const taskDir = join(dir, 'tasks', 'tier1', String(i).padStart(2, '0'));
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, 'prompt.md'), `${BASE}\n\nvariant ${i}\n`);
    }
    commitDocs(dir);

    expect(duplicateFindings('templated')).toEqual([]);
  });

  it('skips licenses, changelogs, conduct files and vendored trees', () => {
    const dir = join(root, 'loose');
    mkdirSync(dir);
    agentsMd(dir, { kind: 'domain', lifecycle: 'active' }, metricBody("printf '2026-10-18 1\\n'"));
    for (const name of ['LICENSE-2026-10-14.md', 'LICENSE-2026-10-19.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md']) {
      writeFileSync(join(dir, name), BASE);
    }
    for (const tree of ['.venv/site-packages', 'node_modules/pkg', 'vendor', 'dist', 'build', 'venv']) {
      mkdirSync(join(dir, tree), { recursive: true });
      writeFileSync(join(dir, tree, 'a.md'), BASE);
      writeFileSync(join(dir, tree, 'b.md'), BASE);
    }

    expect(duplicateFindings('loose')).toEqual([]);
  });

  it('skips tracked vendored trees, not only the untracked walk path', () => {
    const dir = docsUnit('tracked-vendor');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'plan-a.md'), BASE);
    for (const tree of ['vendor/lib', 'node_modules/pkg', '.venv/site-packages', 'dist', 'build']) {
      mkdirSync(join(dir, tree), { recursive: true });
      writeFileSync(join(dir, tree, 'manual-a.md'), BASE);
    }
    commitDocs(dir);

    expect(duplicateFindings('tracked-vendor')).toEqual([]);
  });

  it('bounds pairwise work per unit and reports that later pairs were not compared', () => {
    const dir = docsUnit('quadratic');
    mkdirSync(join(dir, 'docs'));
    // 120 disjoint docs = 7140 pairs, above the per-unit comparison bound.
    for (let i = 0; i < 120; i++) {
      const words = Array.from({ length: 20 }, (_, k) => `term${i}x${k}`).join(' ');
      writeFileSync(join(dir, 'docs', `note-${i}.md`), `# Note ${i}\n\n${words}\n`);
    }
    commitDocs(dir);

    const found = duplicateFindings('quadratic');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('pairwise comparisons');
    expect(found[0].message).toContain('not compared');
  });

  it('caps at 10 pair findings and notes how many were suppressed', () => {
    const dir = docsUnit('capped');
    mkdirSync(join(dir, 'docs'));
    // 6 identical docs = C(6,2) = 15 near-duplicate pairs.
    for (let i = 1; i <= 6; i++) writeFileSync(join(dir, 'docs', `release-${i}.md`), BASE);
    commitDocs(dir);

    const found = duplicateFindings('capped');
    expect(found).toHaveLength(11);
    const notes = found.filter((f) => /suppressed/.test(f.message));
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toContain('5 duplicate-doc finding(s) suppressed');
    expect(found.filter((f) => /near-duplicate docs/.test(f.message))).toHaveLength(10);
  });
});
