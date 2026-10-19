/**
 * No probes for one company's layout or names (#961): MCP configs, templates
 * and the IDP dir come from config/env, and the dashboard asks npm about a
 * package only when told which one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let home: string;
const saved = { home: process.env.HOME, cwd: process.cwd(), npm: process.env.SQUADS_NPM_PACKAGE, tpl: process.env.SQUADS_TEMPLATES_PATH, idp: process.env.SQUADS_IDP_PATH };

function touch(path: string, content = '{}'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'squads-probes-'));
  process.env.HOME = home;
  delete process.env.SQUADS_NPM_PACKAGE;
  delete process.env.SQUADS_TEMPLATES_PATH;
  delete process.env.SQUADS_IDP_PATH;
  process.chdir(home); // no project: no .agents/ above
  vi.resetModules();
});

afterEach(() => {
  process.chdir(saved.cwd);
  process.env.HOME = saved.home;
  for (const [k, v] of [['SQUADS_NPM_PACKAGE', saved.npm], ['SQUADS_TEMPLATES_PATH', saved.tpl], ['SQUADS_IDP_PATH', saved.idp]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('selectMcpConfig', () => {
  it("uses ~/.claude/mcp-configs/<squad>.json for any squad name", async () => {
    touch(join(home, '.claude', 'mcp-configs', 'billing.json'));
    const { selectMcpConfig } = await import('../src/lib/run-utils.js');
    expect(selectMcpConfig('billing')).toBe(join(home, '.claude', 'mcp-configs', 'billing.json'));
  });

  it("does not route one company's squad names to shared files", async () => {
    // The old built-in map sent `intelligence` to research.json and `analytics` to data.json.
    touch(join(home, '.claude', 'mcp-configs', 'research.json'));
    touch(join(home, '.claude', 'mcp-configs', 'data.json'));
    const { selectMcpConfig } = await import('../src/lib/run-utils.js');
    expect(selectMcpConfig('intelligence')).toBe('');
    expect(selectMcpConfig('analytics')).toBe('');
  });
});

describe('templates source', () => {
  function templatesRepo(at: string): void {
    touch(join(at, '.agents', 'squads', '_template', 'SQUAD.md'), '# Squad: template\n');
  }

  it('ignores clones at guessed home-dir locations', async () => {
    templatesRepo(join(home, 'agents-squads', 'agents-squads'));
    templatesRepo(join(home, 'code', 'agents-squads'));
    const { getTemplateSource } = await import('../src/lib/templates.js');
    expect(getTemplateSource().type).not.toBe('repo');
  });

  it('uses the repo named by SQUADS_TEMPLATES_PATH', async () => {
    const repo = join(home, 'anywhere', 'my-templates');
    templatesRepo(repo);
    process.env.SQUADS_TEMPLATES_PATH = repo;
    const { getTemplateSource } = await import('../src/lib/templates.js');
    expect(getTemplateSource()).toMatchObject({ type: 'repo', path: repo });
  });
});

describe('findIdpDir', () => {
  it('does not fall back to ~/agents-squads/idp', async () => {
    touch(join(home, 'agents-squads', 'idp', 'catalog', 'x.yaml'), 'x: 1\n');
    const { findIdpDir } = await import('../src/lib/idp/resolver.js');
    expect(findIdpDir()).toBeNull();
  });
});

describe('fetchNpmStats', () => {
  it('makes no request unless SQUADS_NPM_PACKAGE names a package', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { fetchNpmStats } = await import('../src/lib/costs.js');
    expect(await fetchNpmStats()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
