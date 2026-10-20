/**
 * #1337 follow-up — lane containment regressions.
 *
 * Properties pinned here:
 *  - files the host executes or trusts for a lane live outside the lane's write scope
 *  - lane-writable project files cannot contribute hooks or allow rules
 *  - credential stores are denied for read; the unsandboxed-command list stays narrow
 *  - every Claude spawn that bypasses/relaxes prompts carries sandbox settings
 *  - the role classifier takes no shell, a validated model id, and sandbox settings
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative, isAbsolute } from 'path';

const mockExecFileSync = vi.fn();
const mockExecSync = vi.fn();
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  return { ...actual, execFileSync: mockExecFileSync, execSync: mockExecSync };
});

import {
  buildSandboxSettings, readGuardrailPermissions, trustedLaneDir,
  DEFAULT_DENY_READ, DEFAULT_EXCLUDED_COMMANDS, TRUSTED_LANE_DIR_SPEC,
} from '../src/lib/sandbox-settings.js';
import { buildWorktreeGuardHooks, writeWorktreeGuardScript } from '../src/lib/worktree-guard.js';

const SRC = join(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
const isUnder = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

let root: string;
let runtime: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'squads-contain-'));
  runtime = mkdtempSync(join(tmpdir(), 'squads-runtime-test-'));
  process.env.SQUADS_RUNTIME_DIR = runtime;
  delete process.env.SQUADS_SANDBOX;
  mockExecFileSync.mockReset();
  mockExecSync.mockReset();
});
afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(root, { recursive: true, force: true });
  rmSync(runtime, { recursive: true, force: true });
});

describe('host-executed files live outside the lane write scope', () => {
  it('trusted dir is not under the lane cwd and the sandbox denies writes to it', () => {
    const cwd = join(root, 'repo');
    mkdirSync(cwd);
    expect(isUnder(trustedLaneDir(), cwd)).toBe(false);
    const fs = (buildSandboxSettings({ cwd }).sandbox as { filesystem: { denyWrite: string[] } }).filesystem;
    expect(fs.denyWrite).toContain(TRUSTED_LANE_DIR_SPEC);
    expect(fs.denyWrite).toContain(join(cwd, '.claude', 'guardrail.json'));
  });

  it('hook script is owner read/exec only and unique per spawn', () => {
    const a = writeWorktreeGuardScript('/primary', trustedLaneDir());
    const b = writeWorktreeGuardScript('/primary', trustedLaneDir());
    expect(a).not.toBe(b);
    expect(statSync(a).mode & 0o222).toBe(0);
    expect(buildWorktreeGuardHooks(a).PreToolUse).toBeDefined();
  });

  it('no spawn path places hook scripts or settings files under the repo .git dir', () => {
    for (const rel of ['lib/execution-engine.ts', 'lib/workflow.ts']) {
      const src = read(rel);
      expect(src).not.toMatch(/writeWorktreeGuardScript\([^)]*\.git/s);
      expect(src).not.toMatch(/writeSandboxSettingsFile\([^)]*'\.git'/s);
    }
  });
});

describe('project guardrail override cannot contribute hooks or allow rules', () => {
  it('keeps bundled hooks only; project contributes string deny rules', async () => {
    const { resolveLaneGuardrail, resolveBundledGuardrailSettings } = await import('../src/lib/lane-settings.js');
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', 'guardrail.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo project-hook' }] }] },
      permissions: { allow: ['Bash(*)'], deny: ['Edit(**/x.md)', 42] },
    }));
    const lane = resolveLaneGuardrail(root);
    const bundled = JSON.parse(readFileSync(resolveBundledGuardrailSettings()!, 'utf-8')) as {
      hooks: unknown; permissions: { deny: string[] };
    };
    expect(lane.hooks).toEqual(bundled.hooks);
    expect(JSON.stringify(lane.hooks)).not.toContain('project-hook');
    expect(lane.permissions).toEqual({ deny: [...bundled.permissions.deny, 'Edit(**/x.md)'] });
    expect(JSON.stringify(lane.permissions)).not.toContain('allow');
  });

  it('denyOnly reader drops everything except string deny rules', () => {
    const p = join(root, 'g.json');
    writeFileSync(p, JSON.stringify({ permissions: { allow: ['Bash(*)'], deny: ['a', 1] } }));
    expect(readGuardrailPermissions(p, { denyOnly: true })).toEqual({ deny: ['a'] });
  });
});

describe('credential stores and the unsandboxed list', () => {
  it.each(['~/.config/gh', '~/.squads/secrets', '~/.git-credentials', '~/.netrc', '~/.ssh', '~/.aws'])(
    'denies read of %s by default', (p) => {
      expect(DEFAULT_DENY_READ).toContain(p);
      const fs = (buildSandboxSettings({ cwd: '/w' }).sandbox as { filesystem: { denyRead: string[] } }).filesystem;
      expect(fs.denyRead).toContain(p);
    });

  it('keeps standalone gh excluded but not container/IaC runners', () => {
    expect(DEFAULT_EXCLUDED_COMMANDS).toContain('gh *');
    expect(DEFAULT_EXCLUDED_COMMANDS.join(' ')).not.toMatch(/docker|terraform/);
  });
});

describe('every relaxed-permission Claude spawn carries sandbox settings', () => {
  it('files with bypass/auto-accept/skip-permissions flags also pass --settings', () => {
    const offenders = walk(SRC)
      .map((p) => ({
        p,
        // code only: drop comment lines so prose mentioning a flag is not a spawn
        src: readFileSync(p, 'utf-8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n'),
      }))
      .filter(({ src }) => /--permission-mode (bypassPermissions|acceptEdits)|--dangerously-skip-permissions/.test(src))
      // SQUADS_SKIP_PERMISSIONS is an operator opt-in handled alongside --settings in these files
      .filter(({ src }) => !src.includes('--settings'))
      .map(({ p }) => relative(SRC, p));
    expect(offenders).toEqual([]);
  });

  it('worker command from the lead orchestrator passes a settings file', async () => {
    const { buildWorkerCommand } = await import('../src/lib/orchestration/lead-orchestrator.js');
    const cmd = buildWorkerCommand({
      projectRoot: root, squad: 's', agent: 'a', executionId: 'e', prompt: 'p',
      mcpConfigPath: '/m.json', sessionName: 'sess',
    });
    const m = cmd.match(/--settings '([^']+)'/);
    expect(m).not.toBeNull();
    expect(isUnder(m![1], root)).toBe(false);
    const written = JSON.parse(readFileSync(m![1], 'utf-8')) as { sandbox: { enabled: boolean } };
    expect(written.sandbox.enabled).toBe(true);
  });

  it('orchestrate passes --settings on both the foreground and tmux paths', () => {
    const src = read('commands/orchestrate.ts');
    expect(src).toContain("'--settings', settingsPath");
    expect(src).toContain("--settings '${settingsPath}'");
  });
});

describe('role classifier spawn', () => {
  async function classify(model?: string) {
    const agent = join(root, 'agent.md');
    writeFileSync(agent, '---\nrole: scan and write\n---\nbody text\n');
    process.env.SQUADS_CONTEXT_ROLE_LLM = '1';
    if (model) process.env.SQUADS_CONTEXT_ROLE_LLM_MODEL = model;
    mockExecFileSync.mockReturnValue('worker');
    mockExecSync.mockReturnValue('worker');
    const { resolveContextRoleFromAgent } = await import('../src/lib/run-context.js');
    resolveContextRoleFromAgent(agent, 'agent');
  }

  it('uses argv (no shell), no permission bypass, and sandbox settings', async () => {
    await classify();
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    const [bin, args] = mockExecFileSync.mock.calls[0] as [string, string[]];
    expect(bin).toBe('claude');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toContain('--settings');
  });

  it('rejects a model id containing shell metacharacters', async () => {
    await classify('x; touch /tmp/marker');
    const args = mockExecFileSync.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5');
  });
});

describe('file tools are denied the credential stores', () => {
  async function laneDenyRules(): Promise<string[]> {
    const { writeLaneSettings } = await import('../src/lib/lane-settings.js');
    const path = writeLaneSettings(root);
    const settings = JSON.parse(readFileSync(path, 'utf-8')) as { permissions: { deny: string[] } };
    return settings.permissions.deny;
  }

  it('denies Read/Grep/Glob/Edit/Write on every credential path', async () => {
    const deny = await laneDenyRules();
    for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write']) {
      expect(deny).toContain(`${tool}(~/.ssh/**)`);
      expect(deny).toContain(`${tool}(~/.config/gh/**)`);
      expect(deny).toContain(`${tool}(~/.squads/secrets/**)`);
      expect(deny).toContain(`${tool}(~/.aws/**)`);
      expect(deny).toContain(`${tool}(~/.config/gcloud/**)`);
      expect(deny).toContain(`${tool}(~/.gnupg/**)`);
      expect(deny).toContain(`${tool}(~/.git-credentials)`);
      expect(deny).toContain(`${tool}(~/.netrc)`);
    }
  });
});

describe('native Claude settings/hook files are not lane-editable', () => {
  async function laneDenyRules(): Promise<string[]> {
    const { writeLaneSettings } = await import('../src/lib/lane-settings.js');
    const settings = JSON.parse(readFileSync(writeLaneSettings(root), 'utf-8')) as { permissions: { deny: string[] } };
    return settings.permissions.deny;
  }

  it('permissions deny Edit/Write of the native settings files and hooks dir', async () => {
    const deny = await laneDenyRules();
    for (const p of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']) {
      expect(deny).toContain(`Edit(${p})`);
      expect(deny).toContain(`Write(${p})`);
    }
    expect(deny).toContain('Edit(.claude/hooks/**)');
    expect(deny).toContain('Write(.claude/hooks/**)');
  });

  it('sandbox denyWrite covers the native settings files under the lane cwd', () => {
    const cwd = join(root, 'repo');
    mkdirSync(cwd);
    const fs = (buildSandboxSettings({ cwd }).sandbox as { filesystem: { denyWrite: string[] } }).filesystem;
    expect(fs.denyWrite).toContain(join(cwd, '.claude', 'settings.json'));
    expect(fs.denyWrite).toContain(join(cwd, '.claude', 'settings.local.json'));
    expect(fs.denyWrite).toContain(join(cwd, '.claude', 'hooks'));
    expect(fs.denyWrite).toContain(join(cwd, '.mcp.json'));
  });
});

describe('trusted runtime dir is resolved in the host, not the lane', () => {
  it('sandbox denyWrite uses the resolved runtime dir, not just the literal spec', () => {
    const cwd = join(root, 'repo');
    mkdirSync(cwd);
    const fs = (buildSandboxSettings({ cwd }).sandbox as { filesystem: { denyWrite: string[] } }).filesystem;
    expect(fs.denyWrite).toContain(runtime);
  });

  it('buildAgentEnv strips SQUADS_RUNTIME_DIR from the lane env', async () => {
    const { buildAgentEnv } = await import('../src/lib/execution-engine.js');
    const env = buildAgentEnv(
      { PATH: '/bin', SQUADS_RUNTIME_DIR: '/tmp/lane-chosen', KEEP: 'yes' },
      { squad: 's', agent: 'a', taskType: 'execution', trigger: 'manual', executionId: 'e' },
    );
    expect(env.SQUADS_RUNTIME_DIR).toBeUndefined();
    expect(env.KEEP).toBe('yes');
  });
});

describe('one shared credential deny list across harnesses', () => {
  it('Claude, opencode and kimi deny the same credential stores', async () => {
    const { OPENCODE_DENY_READ } = await import('../src/lib/opencode-governance.js');
    const { KIMI_DENY_READ } = await import('../src/lib/kimi-code-governance.js');
    expect(OPENCODE_DENY_READ).toEqual(DEFAULT_DENY_READ);
    expect(KIMI_DENY_READ).toEqual(DEFAULT_DENY_READ);
    for (const p of [
      '~/.git-credentials', '~/.netrc', '~/.gnupg', '~/.claude.json',
      '~/.claude/.credentials.json', '~/.config/opencode/auth.json',
      '~/.npmrc', '~/.docker/config.json', '~/.kube/config',
    ]) {
      expect(DEFAULT_DENY_READ).toContain(p);
    }
  });
});
