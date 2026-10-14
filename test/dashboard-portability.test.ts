/**
 * Dashboard portability (#961): the multi-repo base dir is recognised by the
 * squads' own repos, not by a sibling named `hq`; the bridge URL is read when
 * a request is made, not when the module loads.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

beforeAll(() => {
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_INDEX_FILE;
});

let ws: string;
const saved = { cwd: process.cwd(), home: process.env.HOME, bridge: process.env.SQUADS_BRIDGE_URL };

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'squads-dash-')));
  process.env.HOME = ws; // no ~/.squads/config.json
  delete process.env.SQUADS_BRIDGE_URL;
  vi.resetModules();
});

afterEach(() => {
  process.chdir(saved.cwd);
  process.env.HOME = saved.home;
  if (saved.bridge === undefined) delete process.env.SQUADS_BRIDGE_URL; else process.env.SQUADS_BRIDGE_URL = saved.bridge;
  vi.unstubAllGlobals();
  rmSync(ws, { recursive: true, force: true });
});

/** A project whose one squad declares `repo:`, with optional sibling clones. */
function workspace(siblings: string[]): string {
  const project = join(ws, 'project');
  mkdirSync(join(project, '.agents', 'squads', 'web'), { recursive: true });
  writeFileSync(join(project, '.agents', 'squads', 'web', 'SQUAD.md'), '---\nrepo: acme/acme-web\n---\n# Squad: web\n');
  for (const s of siblings) mkdirSync(join(ws, s, '.git'), { recursive: true });
  return project;
}

describe('dashboard base dir', () => {
  it("uses the parent when a squad's repo is cloned beside the project", async () => {
    process.chdir(workspace(['acme-web']));
    const { findAgentsSquadsDir } = await import('../src/commands/dashboard.js');
    expect(realpathSync(findAgentsSquadsDir()!)).toBe(ws);
  });

  it('ignores a sibling that merely matches one company\'s layout (hq)', async () => {
    process.chdir(workspace(['hq']));
    const { findAgentsSquadsDir } = await import('../src/commands/dashboard.js');
    expect(findAgentsSquadsDir()).toBeNull(); // project itself isn't a git repo here
  });
});

describe('bridge URL', () => {
  it('uses SQUADS_BRIDGE_URL set after the module was imported', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchBridgeStats } = await import('../src/lib/costs.js');
    process.env.SQUADS_BRIDGE_URL = 'http://bridge.test';
    await fetchBridgeStats();
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^http:\/\/bridge\.test\//);
  });
});
