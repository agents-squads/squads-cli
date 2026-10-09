/**
 * SQUAD.md schema (squads framework spec §5): four typed blocks — cost,
 * behavior, context, org — validated from schemas/squad.schema.json.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQUAD_SCHEMA, validateSquadFrontmatter } from '../src/lib/squad-schema.js';

const FULL = {
  name: 'web',
  mission: 'Ship the marketing site.',
  status: 'active',
  cost: { budget: { daily_usd: 5, per_run_usd: 1 }, models: { default: 'sonnet', cheap: 'haiku' }, lanes: ['deepseek', 'claude'] },
  behavior: { permissions: { push: false }, extra_tools: ['gws'], approval: ['merge', 'publish'], cooldown_s: 600 },
  context: { agents_md: 'AGENTS.md', mcp: ['chrome-devtools'], skills: ['seo'], memory: { load: ['web/*'] }, exclude: ['dist/**'] },
  org: {
    owner: 'maria',
    members: ['lead', 'writer'],
    domain: 'marketing',
    repos: ['acme/acme-web'],
    paths: ['src/pages/**'],
    depends_on: ['brand'],
    goals: [{ goal: 'Homepage LCP under 2s', check: 'npm run lighthouse -- --assert lcp<2000' }],
  },
};

describe('schema file', () => {
  it('defines the four blocks of the spec', () => {
    expect(Object.keys(SQUAD_SCHEMA.properties ?? {})).toEqual(
      expect.arrayContaining(['cost', 'behavior', 'context', 'org']),
    );
  });
});

describe('validateSquadFrontmatter', () => {
  it('accepts a complete four-block squad with no errors or hints', () => {
    expect(validateSquadFrontmatter(FULL)).toEqual({ errors: [], hints: [] });
  });

  it('requires a human owner when org is declared', () => {
    const { owner: _owner, ...orgWithoutOwner } = FULL.org;
    const { errors } = validateSquadFrontmatter({ ...FULL, org: orgWithoutOwner });
    expect(errors).toContainEqual({ path: 'org.owner', message: 'is required' });
  });

  it('requires every goal to carry its check', () => {
    const { errors } = validateSquadFrontmatter({ ...FULL, org: { ...FULL.org, goals: [{ goal: 'Grow' }] } });
    expect(errors).toContainEqual({ path: 'org.goals[0].check', message: 'is required' });
  });

  it('rejects wrong types, negative budgets, unknown keys inside a block and unknown status', () => {
    const { errors } = validateSquadFrontmatter({
      ...FULL,
      status: 'archived',
      cost: { budget: { daily_usd: -1, weekly_usd: '10' } },
      behavior: { approvals: ['merge'] },
    });
    const paths = errors.map(e => e.path);
    expect(paths).toEqual(expect.arrayContaining(['status', 'cost.budget.daily_usd', 'cost.budget.weekly_usd', 'behavior.approvals']));
  });

  it('keeps a legacy squad valid and says where each field belongs', () => {
    const legacy = {
      name: 'cli',
      repo: 'acme/acme-cli',
      depends_on: ['web'],
      status: 'frozen',
      stack: 'typescript',
      context: { mcp: ['x'], model: { default: 'sonnet' }, budget: { daily: 5 }, cooldown: 60 },
    };
    const { errors, hints } = validateSquadFrontmatter(legacy);
    expect(errors).toEqual([]);
    const byPath = Object.fromEntries(hints.map(h => [h.path, h.message]));
    expect(byPath.repo).toContain('org.repos');
    expect(byPath.depends_on).toContain('org.depends_on');
    expect(byPath['context.model']).toContain('cost.models');
    expect(byPath['context.budget']).toContain('cost.budget');
    expect(byPath['context.cooldown']).toContain('behavior.cooldown_s');
    expect(byPath.status).toContain('paused');
    expect(byPath.stack).toBe('not part of the schema');
  });

  it('requires a name', () => {
    expect(validateSquadFrontmatter({}).errors).toContainEqual({ path: 'name', message: 'is required' });
  });
});

describe('squads contract validate', () => {
  let dir: string;
  const cwd = process.cwd();
  let out: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'squads-schema-'));
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function squad(name: string, frontmatter: string): void {
    mkdirSync(join(dir, '.agents', 'squads', name), { recursive: true });
    writeFileSync(join(dir, '.agents', 'squads', name, 'SQUAD.md'), `---\n${frontmatter}---\n# Squad: ${name}\n`);
  }

  async function validate(...args: string[]): Promise<void> {
    process.chdir(dir);
    const { registerContractCommand } = await import('../src/commands/contract.js');
    const program = new Command();
    program.exitOverride();
    registerContractCommand(program);
    await program.parseAsync(['node', 'squads', 'contract', 'validate', ...args]);
  }

  it('fails on a schema error and names the field', async () => {
    squad('good', 'name: good\nrepo: acme/good\n');
    squad('bad', 'name: bad\norg:\n  members: [a]\n');
    await validate();
    expect(out.join('\n')).toContain('bad/SQUAD.md');
    expect(out.join('\n')).toContain('org.owner: is required');
    expect(out.join('\n')).toContain('1/2 SQUAD.md files match the schema');
    expect(process.exitCode).toBe(1);
  });

  it('passes legacy squads, reporting hints only in --json', async () => {
    squad('good', 'name: good\nrepo: acme/good\n');
    await validate('--json');
    const report = JSON.parse(out.join('\n'));
    expect(report.squads[0]).toMatchObject({ squad: 'good', errors: [] });
    expect(report.squads[0].hints[0].path).toBe('repo');
    expect(process.exitCode).toBe(0);
  });
});
