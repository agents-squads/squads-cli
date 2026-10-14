/**
 * The CLI ships as ESM: a bare `require()` throws, and inside try/catch it
 * failed silently — memory recency always "999 days", process cwd always
 * empty, the background update check never spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const spawnMock = vi.fn(() => ({ stdout: { on: vi.fn() }, on: vi.fn(), unref: vi.fn() }));
const execMock = vi.fn((_cmd: string, _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(null, '/work/acme-web\n'));
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  spawn: (...a: unknown[]) => spawnMock(...(a as [])),
  exec: (...a: unknown[]) => execMock(...(a as [string, unknown, (e: Error | null, out: string) => void])),
}));

let dir: string;
const savedHome = process.env.HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'squads-esm-'));
  process.env.HOME = dir;
  vi.resetModules();
  spawnMock.mockClear();
  execMock.mockClear();
});

afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('memory search recency', () => {
  it('ranks a file updated today above an identical one untouched for 60 days', async () => {
    const memory = join(dir, 'memory');
    for (const agent of ['fresh', 'stale']) {
      mkdirSync(join(memory, 'sq', agent), { recursive: true });
      writeFileSync(join(memory, 'sq', agent, 'state.md'), 'pricing decision: tier two\n');
    }
    const old = new Date(Date.now() - 60 * 86_400_000);
    utimesSync(join(memory, 'sq', 'stale', 'state.md'), old, old);

    const { searchMemory } = await import('../src/lib/memory.js');
    const results = searchMemory('pricing decision', memory);
    const score = (agent: string) => results.find(r => r.entry.agent === agent)!.score;
    expect(score('fresh')).toBeGreaterThan(score('stale'));
  });
});

describe('process cwd enrichment', () => {
  it('reads the cwd lsof reports', async () => {
    const { enrichProcessesWithSquad } = await import('../src/lib/sessions.js');
    const [p] = await enrichProcessesWithSquad([{ pid: 42, tty: '', cwd: '', squad: null, tool: 'claude' }]);
    expect(execMock).toHaveBeenCalled();
    expect(p.cwd).toBe('/work/acme-web');
  });
});

describe('update check', () => {
  it('spawns a detached lookup that writes the cache itself, with no pipe back', async () => {
    const { checkForUpdate } = await import('../src/lib/update.js');
    checkForUpdate();
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['-e', expect.stringContaining('npm view squads-cli version'), join(dir, '.squads', 'update-check.json')],
      // A piped stdout would keep the CLI alive until npm answers.
      { detached: true, stdio: 'ignore' },
    );
  });
});

describe('no bare require in src', () => {
  // vitest provides `require`, so the runtime tests above can't catch the
  // bundled failure for every call site; this guard does. A file may use
  // require only after defining it with createRequire(import.meta.url).
  // Generated scripts written as .cjs (worktree-guard) are string content.
  function tsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
  }

  it('every require() call is backed by createRequire', () => {
    const offenders = tsFiles(join(__dirname, '..', 'src')).filter(f => {
      const code = readFileSync(f, 'utf-8')
        .replace(/`[^`]*`/gs, '``')          // template strings (generated scripts)
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
        .replace(/\/\/.*$/gm, '');          // line comments
      return /(?<![\w.$])require\(/.test(code) && !/createRequire\(import\.meta\.url\)/.test(code);
    });
    expect(offenders).toEqual([]);
  });
});
