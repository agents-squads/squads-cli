import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import {
  OpencodeGovernanceError,
  buildBwrapArgs,
  buildSeatbeltProfile,
  compileOpencodePermission,
  opencodeConfigEnv,
  resolveOpencodeSandbox,
} from '../src/lib/opencode-governance.js';
import { getCLIConfig } from '../src/lib/llm-clis.js';
import { DEFAULT_AGENT_TOOLS } from '../src/lib/execution-engine.js';

const PRIMARY = '/repos/squads-cli';
const WORK = '/repos/.worktrees/cli-issue-1';
const GUARDRAIL = { deny: ['Edit(**/goals.md)', 'Write(**/goals.md)', 'Bash(rm:*)'] };
const base = { primaryRoot: PRIMARY, workDir: WORK, memoryDir: '/repos/hq/.agents/memory' };

describe('compileOpencodePermission (cli#1306)', () => {
  it('default-denies and maps a read-only contract', () => {
    const { permission } = compileOpencodePermission({ ...base, tools: ['Read', 'Grep', 'Glob'] });
    expect(permission['*']).toBe('deny');
    expect(permission.grep).toBe('allow');
    expect(permission.glob).toBe('allow');
    expect(permission.edit).toBeUndefined(); // no write grant → falls through to deny
    expect(permission.bash).toBeUndefined();
    expect(permission.webfetch).toBeUndefined();
  });

  it('maps the default agent tool surface (snapshot)', () => {
    const cfg = compileOpencodePermission({ ...base, tools: DEFAULT_AGENT_TOOLS, guardrailPermissions: GUARDRAIL });
    const p = cfg.permission as Record<string, Record<string, string> | string>;
    expect(p['*']).toBe('deny');
    expect(p.webfetch).toBe('allow');
    expect(p.task).toBe('allow');
    // scoped bash grants: both the bare command and `cmd *`
    const bash = p.bash as Record<string, string>;
    expect(bash['*']).toBe('deny');
    expect(bash['git']).toBe('allow');
    expect(bash['git *']).toBe('allow');
    // destructive denies are emitted AFTER the allows (last match wins)
    const keys = Object.keys(bash);
    expect(keys.indexOf('git push --force*')).toBeGreaterThan(keys.indexOf('git *'));
    expect(bash['git push --force*']).toBe('deny');
    expect(bash['git reset --hard*']).toBe('deny');
    expect(bash['npm publish*']).toBe('deny');
    expect(bash['rm *']).toBe('deny'); // guardrail deny Bash(rm:*)
    // governance deny carved out of edit:allow
    const edit = p.edit as Record<string, string>;
    expect(edit['*']).toBe('allow');
    expect(edit['**/goals.md']).toBe('deny');
    // worktree guard: primary checkout read-only, .agents writable (allow AFTER deny)
    expect(edit[`${PRIMARY}/**`]).toBe('deny');
    expect(edit[`${PRIMARY}/.agents/**`]).toBe('allow');
    const ek = Object.keys(edit);
    expect(ek.indexOf(`${PRIMARY}/.agents/**`)).toBeGreaterThan(ek.indexOf(`${PRIMARY}/**`));
    expect(bash[`git -C ${PRIMARY} *`]).toBe('deny');
    expect(bash[`git -C ${PRIMARY} status*`]).toBe('allow');
    // credential dirs unreadable
    const read = p.read as Record<string, string>;
    expect(read[`${homedir()}/.ssh/**`]).toBe('deny');
    expect(read[`${homedir()}/.squads/secrets/**`]).toBe('deny');
    // external dirs denied except memory
    const ext = p.external_directory as Record<string, string>;
    expect(ext['*']).toBe('deny');
    expect(ext['/repos/hq/.agents/memory/**']).toBe('allow');
    // never a blanket allow
    expect(p['*']).not.toBe('allow');
  });

  it('disarms the worktree guard when the lane runs in the primary root', () => {
    const cfg = compileOpencodePermission({ ...base, workDir: PRIMARY, tools: ['Write', 'Edit', 'Bash'] });
    const edit = cfg.permission.edit as Record<string, string>;
    expect(edit[`${PRIMARY}/**`]).toBeUndefined();
    const bash = cfg.permission.bash as Record<string, string>;
    expect(bash['*']).toBe('allow'); // bare Bash grant
  });

  it('fails closed on a grant opencode cannot express (MCP)', () => {
    expect(() => compileOpencodePermission({ ...base, tools: ['Read', 'mcp__slack__post'] }))
      .toThrow(OpencodeGovernanceError);
    expect(() => compileOpencodePermission({ ...base, tools: ['Read', 'mcp__slack__post'] }))
      .toThrow(/--auto/);
  });

  it('fails closed when a half of the Write/Edit pair would be silently widened', () => {
    expect(() => compileOpencodePermission({ ...base, tools: ['Read', 'Write'] })).toThrow(OpencodeGovernanceError);
  });

  it('fails closed on a guardrail deny rule it cannot express', () => {
    expect(() => compileOpencodePermission({
      ...base, tools: ['Read'], guardrailPermissions: { deny: ['WebFetch(domain:evil.com)'] },
    })).toThrow(OpencodeGovernanceError);
    expect(() => compileOpencodePermission({
      ...base, tools: ['Read'], guardrailPermissions: { deny: 'oops' },
    })).toThrow(OpencodeGovernanceError);
  });

  it('delivers the config via OPENCODE_CONFIG_CONTENT', () => {
    const cfg = compileOpencodePermission({ ...base, tools: ['Read'] });
    expect(JSON.parse(opencodeConfigEnv(cfg).OPENCODE_CONFIG_CONTENT)).toEqual(cfg);
  });
});

describe('opencode spawn never auto-approves', () => {
  it('buildArgs has no --auto, with or without options', () => {
    const cfg = getCLIConfig('opencode')!;
    expect(cfg.buildArgs('do it')).not.toContain('--auto');
    expect(cfg.buildArgs('do it', { model: 'deepseek/deepseek-chat', allowedTools: ['Read'] })).not.toContain('--auto');
  });
});

describe('opencode OS sandbox wrapper', () => {
  const opts = { workDir: WORK, writeDirs: ['/repos/squads-cli/.git'] };

  it('seatbelt profile confines writes to the lane and masks credential dirs', () => {
    const sb = buildSeatbeltProfile(opts);
    expect(sb).toContain('(deny file-write*)');
    expect(sb).toContain(`(subpath "${WORK}")`);
    expect(sb).toContain('(subpath "/repos/squads-cli/.git")');
    expect(sb).toContain(`(deny file-read* (subpath "${homedir()}/.ssh"))`);
    expect(sb).toContain(`${homedir()}/.squads/secrets`);
    // deny-read comes after the allows so it wins
    expect(sb.indexOf('(deny file-read*')).toBeGreaterThan(sb.indexOf('(allow file-write*'));
  });

  it('bwrap args make root read-only and mask credential dirs', () => {
    const args = buildBwrapArgs(opts);
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    expect(args).toContain('--chdir');
    expect(args[args.length - 1]).toBe('--');
  });

  it('picks the wrapper per platform and reports unavailability', () => {
    const yes = () => true;
    const no = () => false;
    expect(resolveOpencodeSandbox({ ...opts, platform: 'darwin', hasCommand: yes }, '/p.sb')?.command).toBe('sandbox-exec');
    expect(resolveOpencodeSandbox({ ...opts, platform: 'linux', hasCommand: yes }, '/p.sb')?.command).toBe('bwrap');
    expect(resolveOpencodeSandbox({ ...opts, platform: 'darwin', hasCommand: no }, '/p.sb')).toBeNull();
    expect(resolveOpencodeSandbox({ ...opts, platform: 'win32', hasCommand: yes }, '/p.sb')).toBeNull();
  });

  // Real enforcement: only meaningful where sandbox-exec works (macOS, not nested in another sandbox).
  const probe = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
    ? spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'])
    : null;
  it.skipIf(!probe || probe.status !== 0)('seatbelt blocks a write outside the worktree + a credential-dir read, allows writes inside', () => {
    // Under cwd, NOT tmpdir(): the profile (rightly) makes tmp writable.
    const root = realpathSync(mkdtempSync(join(process.cwd(), '.oc-sbx-')));
    const work = join(root, 'work');
    const outside = join(root, 'outside');
    try {
      spawnSync('mkdir', ['-p', work, outside]);
      const secret = join(root, 'secret');
      spawnSync('mkdir', ['-p', secret]);
      writeFileSync(join(secret, 'key'), 'hunter2');
      const profile = buildSeatbeltProfile({ workDir: work, writeDirs: [], denyRead: [secret] });
      const profPath = join(root, 'p.sb');
      writeFileSync(profPath, profile);
      const inside = spawnSync('/usr/bin/sandbox-exec', ['-f', profPath, '/usr/bin/touch', join(work, 'ok')]);
      const out = spawnSync('/usr/bin/sandbox-exec', ['-f', profPath, '/usr/bin/touch', join(outside, 'nope')]);
      const read = spawnSync('/usr/bin/sandbox-exec', ['-f', profPath, '/bin/cat', join(secret, 'key')]);
      expect(read.status).not.toBe(0);
      expect(read.stdout.toString()).not.toContain('hunter2');
      expect(inside.status).toBe(0);
      expect(out.status).not.toBe(0);
      expect(existsSync(join(outside, 'nope'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
