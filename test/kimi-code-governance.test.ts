import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { spawnSync } from 'child_process';
import {
  KimiGovernanceError, assessKimiGrants, compileKimiWriteDenies, kimiSpawnEnv,
  buildKimiSeatbeltProfile, buildKimiBwrapArgs, resolveKimiSandbox, KIMI_DENY_READ,
} from '../src/lib/kimi-code-governance.js';
import { DEFAULT_AGENT_TOOLS } from '../src/lib/execution-engine.js';

const FULL = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

describe('assessKimiGrants — fail closed on grants kimi -p cannot honour', () => {
  it('accepts an explicit contract that grants the whole fixed surface', () => {
    expect(assessKimiGrants(FULL, 'contract').warnings).toEqual([]);
  });

  it('refuses an explicit contract with scoped Bash (kimi would widen it to every command)', () => {
    expect(() => assessKimiGrants(['Read', 'Write', 'Edit', 'Bash(git:*)'], 'contract')).toThrow(KimiGovernanceError);
  });

  it('refuses a read-only contract (kimi cannot withhold Write/Edit/Bash)', () => {
    expect(() => assessKimiGrants(['Read', 'Grep', 'Glob'], 'contract')).toThrow(/does not grant Bash, Write, Edit/);
  });

  it('refuses MCP grants and tool names it has never heard of — in default and contract mode', () => {
    expect(() => assessKimiGrants([...FULL, 'mcp__slack__post'], 'contract')).toThrow(/MCP grant/);
    expect(() => assessKimiGrants([...FULL, 'mcp__slack__post'], 'default')).toThrow(/MCP grant/);
    expect(() => assessKimiGrants([...FULL, 'Teleport'], 'contract')).toThrow(/no kimi equivalent/);
  });

  it('accepts the default surface, warning that shell scope is the sandbox', () => {
    const { warnings } = assessKimiGrants(DEFAULT_AGENT_TOOLS, 'default');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/OS sandbox/);
  });

  it('error text says why: -p auto-approves, nothing narrower than the sandbox is enforceable', () => {
    try {
      assessKimiGrants(['Read'], 'contract');
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/kimi -p auto-approves every tool/);
    }
  });
});

describe('compileKimiWriteDenies — guardrail → sandbox write denies', () => {
  it('maps Edit/Write(**/name) rules to deduplicated basenames', () => {
    expect(compileKimiWriteDenies({ deny: ['Edit(**/goals.md)', 'Write(**/goals.md)', 'Edit(**/SQUAD.md)'] }))
      .toEqual(['goals.md', 'SQUAD.md']);
  });

  it('is empty without a guardrail', () => {
    expect(compileKimiWriteDenies(undefined)).toEqual([]);
    expect(compileKimiWriteDenies({})).toEqual([]);
  });

  it('refuses any rule shape it cannot express', () => {
    expect(() => compileKimiWriteDenies({ deny: ['Edit(src/**)'] })).toThrow(KimiGovernanceError);
    expect(() => compileKimiWriteDenies({ deny: ['Bash(rm:*)'] })).toThrow(/cannot be expressed/);
    expect(() => compileKimiWriteDenies({ deny: 'Edit(**/goals.md)' })).toThrow(/not a list of strings/);
  });
});

describe('kimiSpawnEnv', () => {
  it('removes the metered keys and every ANTHROPIC_* var, and nothing else', () => {
    const env = kimiSpawnEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', KIMI_API_KEY: 'k', HOME: '/h' });
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'KIMI_API_KEY', 'MOONSHOT_API_KEY']);
    expect(Object.values(env).every((v) => v === undefined)).toBe(true);
  });
});

describe('sandbox profile', () => {
  let work: string;
  let khome: string;
  beforeEach(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-work-')));
    khome = join(realpathSync(mkdtempSync(join(tmpdir(), 'kimi-home-'))), '.kimi-code');
  });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('lets kimi write its measured state (sessions, logs, OAuth refresh, index) but NOT bin, config.toml or updates', () => {
    const p = buildKimiSeatbeltProfile({ workDir: work, writeDirs: [], kimiHome: khome });
    for (const d of ['sessions', 'logs', 'cache', 'telemetry', 'file-history', 'credentials', 'oauth']) {
      expect(p).toContain(`(subpath "${join(khome, d)}")`);
    }
    expect(p).toContain('session_index[.]jsonl[^/]*$');
    expect(p).toContain('workspaces[.]json[^/]*$');
    expect(p).not.toContain(join(khome, 'updates'));
    expect(p).not.toContain(join(khome, 'bin'));
    expect(p).not.toContain('config.toml');
    expect(p).not.toContain(`(subpath "${khome}")`); // the whole state root is never writable
    expect(p).toContain('(deny file-write*)'); // default-deny writes
  });

  it('denies reads of credential dirs and writes of guardrail-named files, case-insensitively', () => {
    const p = buildKimiSeatbeltProfile({ workDir: work, writeDirs: [], kimiHome: khome, denyWriteNames: ['goals.md'] });
    for (const d of KIMI_DENY_READ) expect(p).toContain(`(deny file-read* (subpath "${d.replace('~', homedir())}"))`);
    expect(p).toContain('(deny file-write* (regex #"/[gG][oO][aA][lL][sS][.][mM][dD]$"))');
  });

  it('keeps git hooks/config read-only inside a writable git dir', () => {
    const git = join(work, '.git');
    mkdirSync(join(git, 'objects'), { recursive: true });
    writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
    const p = buildKimiSeatbeltProfile({ workDir: work, writeDirs: [git], kimiHome: khome });
    expect(p).toContain(`(subpath "${join(git, 'hooks')}")`);
    expect(p).toContain(`(literal "${join(git, 'config')}")`);
  });

  it('selects sandbox-exec on darwin and bwrap on linux; null when neither exists', () => {
    const base = { workDir: work, writeDirs: [] as string[], kimiHome: khome };
    const darwin = resolveKimiSandbox({ ...base, platform: 'darwin', hasCommand: () => true }, '/tmp/p.sb');
    expect(darwin?.command).toBe('sandbox-exec');
    expect(darwin?.args).toEqual(['-f', '/tmp/p.sb']);
    expect(darwin?.profile).toContain('(version 1)');
    const linux = resolveKimiSandbox({ ...base, platform: 'linux', hasCommand: () => true }, '/tmp/p.sb');
    expect(linux?.command).toBe('bwrap');
    expect(linux?.args).toContain('--chdir');
    expect(resolveKimiSandbox({ ...base, platform: 'linux', hasCommand: () => false }, '/tmp/p.sb')).toBeNull();
    expect(resolveKimiSandbox({ ...base, platform: 'win32' as NodeJS.Platform, hasCommand: () => true }, '/tmp/p.sb')).toBeNull();
  });

  it('bwrap refuses write-name denies it cannot express (fail closed, no silent gap)', () => {
    expect(() => resolveKimiSandbox(
      { workDir: work, writeDirs: [], kimiHome: khome, denyWriteNames: ['goals.md'], platform: 'linux', hasCommand: () => true },
      '/tmp/p.sb',
    )).toThrow(/bwrap cannot express/);
    expect(buildKimiBwrapArgs({ workDir: work, writeDirs: [], kimiHome: khome })).toContain(work);
  });
});

// Real Seatbelt: skipped where sandbox-exec is absent or cannot nest (CI containers, another sandbox).
const canSeatbelt = process.platform === 'darwin' && spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

describe.skipIf(!canSeatbelt)('real Seatbelt enforcement', () => {
  let work: string;
  let outside: string;
  let khome: string;
  beforeEach(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-seat-work-')));
    // $TMPDIR is a writable root, so "outside" must live elsewhere: the user's home is not.
    outside = join(homedir(), `.squads-kimi-seatbelt-test-${process.pid}`);
    // Like the real ~/.kimi-code, the state root is NOT under a writable root ($TMPDIR is one).
    khome = join(outside, 'kimi-home', '.kimi-code');
    mkdirSync(join(khome, 'bin'), { recursive: true });
    mkdirSync(join(khome, 'sessions'), { recursive: true });
    writeFileSync(join(khome, 'config.toml'), 'x = 1\n');
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  function run(script: string, denyWriteNames: string[] = []) {
    const profile = join(work, '.profile.sb');
    const sb = resolveKimiSandbox({ workDir: work, writeDirs: [], kimiHome: khome, denyWriteNames }, profile)!;
    writeFileSync(profile, sb.profile!);
    return spawnSync(sb.command, [...sb.args, '/bin/sh', '-c', script], { cwd: work, encoding: 'utf-8' });
  }

  it('allows writes in the worktree and kimi sessions; blocks home, bin and config.toml', () => {
    expect(run(`echo ok > "${join(work, 'a.txt')}"`).status).toBe(0);
    expect(existsSync(join(work, 'a.txt'))).toBe(true);
    expect(run(`echo s > "${join(khome, 'sessions', 's.txt')}"`).status).toBe(0);

    const probe = `${outside}-probe`;
    expect(run(`mkdir "${probe}"`).status).not.toBe(0);
    expect(existsSync(probe)).toBe(false);
    expect(run(`echo x > "${join(khome, 'bin', 'kimi')}"`).status).not.toBe(0);
    expect(run(`echo x >> "${join(khome, 'config.toml')}"`).status).not.toBe(0);
  });

  it('allows the atomic temp+rename of root state files; blocks other root files and updates/', () => {
    const ws = join(khome, 'workspaces.json');
    expect(run(`echo '{}' > "${ws}.tmp-1" && mv "${ws}.tmp-1" "${ws}"`).status).toBe(0);
    expect(existsSync(ws)).toBe(true);
    expect(run(`echo x > "${join(khome, 'tui.toml')}"`).status).not.toBe(0);
    expect(run(`echo x > "${join(khome, 'hooks.toml')}"`).status).not.toBe(0);
    expect(run(`mkdir -p "${join(khome, 'updates')}" && echo x > "${join(khome, 'updates', 'kimi')}"`).status).not.toBe(0);
    expect(run(`mv "${ws}" "${join(khome, 'config.toml')}"`).status).not.toBe(0);
  });

  it('blocks writes to guardrail-named files in any case, allows other files', () => {
    expect(run(`echo x > "${join(work, 'goals.md')}"`, ['goals.md']).status).not.toBe(0);
    expect(run(`echo x > "${join(work, 'GOALS.MD')}"`, ['goals.md']).status).not.toBe(0);
    expect(existsSync(join(work, 'goals.md'))).toBe(false);
    expect(run(`echo x > "${join(work, 'notes.md')}"`, ['goals.md']).status).toBe(0);
  });
});
