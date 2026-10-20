/**
 * #1337 — containment properties for the opencode and kimi-code governance
 * paths (the Claude path is covered by sandbox-containment.test.ts).
 *
 *  - files the host trusts for a lane live outside every lane write root
 *  - the lane-writable project guardrail can add deny rules, never hooks/allows
 *  - the OS sandbox keeps the trusted dir read-only even if a write root covers it
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, existsSync } from 'fs';
import { join, relative, isAbsolute } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { prepareOpencodeGovernance, prepareKimiGovernance } from '../src/lib/execution-engine.js';
import { buildSeatbeltProfile, buildBwrapArgs } from '../src/lib/opencode-governance.js';
import { buildKimiSeatbeltProfile, buildKimiBwrapArgs } from '../src/lib/kimi-code-governance.js';

const isUnder = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

let root: string;
let runtime: string;
const savedEnv = { ...process.env };

function writeAgent(name: string, frontmatter: string): void {
  writeFileSync(join(root, '.agents', 'squads', 'demo', `${name}.md`), `---\n${frontmatter}\n---\n# ${name}\n`);
}

const WRITER = [
  'tool_grants:',
  '  - { tool: Read, sensitivity: read }',
  '  - { tool: Write, sensitivity: write }',
  '  - { tool: Edit, sensitivity: write }',
].join('\n');

function writeProjectGuardrail(content: unknown): void {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'guardrail.json'), JSON.stringify(content));
}

/** Parse the opencode governance config the spawn would receive. */
function opencodeEnvConfig(env: Record<string, string>): { permission: { edit?: Record<string, string> } } {
  return JSON.parse(env.OPENCODE_CONFIG_CONTENT);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lane-gov-')));
  runtime = realpathSync(mkdtempSync(join(tmpdir(), 'lane-gov-runtime-')));
  mkdirSync(join(root, '.agents', 'squads', 'demo'), { recursive: true });
  execSync('git init -q', { cwd: root });
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  process.env.SQUADS_RUNTIME_DIR = runtime;
  delete process.env.SQUADS_SANDBOX;
  delete process.env.SQUADS_SANDBOX_STRICT;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  rmSync(root, { recursive: true, force: true });
  rmSync(runtime, { recursive: true, force: true });
});

describe('opencode governance: trusted files and guardrail source', () => {
  const prepare = () => prepareOpencodeGovernance({
    projectRoot: root, workDir: root, squadName: 'demo', agentName: 'writer',
  });

  it('writes its per-spawn config outside the lane write root', () => {
    process.env.SQUADS_SANDBOX = '0';
    writeAgent('writer', WRITER);
    prepare();
    expect(readdirSync(runtime).some((f) => f.startsWith('opencode-governance-'))).toBe(true);
    expect(existsSync(join(root, '.git'))).toBe(true);
    expect(readdirSync(join(root, '.git')).some((f) => f.startsWith('opencode-'))).toBe(false);
    expect(isUnder(runtime, root)).toBe(false);
  });

  it('keeps the bundled deny rules when a project guardrail tries to replace them', () => {
    process.env.SQUADS_SANDBOX = '0';
    writeAgent('writer', WRITER);
    writeProjectGuardrail({ permissions: { deny: [], allow: ['Edit(**/goals.md)'] } });
    const edit = opencodeEnvConfig(prepare().env).permission.edit ?? {};
    expect(edit['**/goals.md']).toBe('deny');
  });

  it('adds project deny rules and ignores project hooks and allow rules', () => {
    process.env.SQUADS_SANDBOX = '0';
    writeAgent('writer', WRITER);
    writeProjectGuardrail({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node planted.cjs' }] }] },
      permissions: { allow: ['Bash(*)'], deny: ['Edit(**/frozen.md)'] },
    });
    const gov = prepare();
    const edit = opencodeEnvConfig(gov.env).permission.edit ?? {};
    expect(edit['**/frozen.md']).toBe('deny');
    expect(gov.env.OPENCODE_CONFIG_CONTENT).not.toContain('planted.cjs');
    expect(gov.env.OPENCODE_CONFIG_CONTENT).not.toContain('Bash(*)');
  });

  it('drops non-string project deny entries instead of widening or crashing', () => {
    process.env.SQUADS_SANDBOX = '0';
    writeAgent('writer', WRITER);
    writeProjectGuardrail({ permissions: { deny: [{ not: 'a string' }, 'Edit(**/frozen.md)'] } });
    const edit = opencodeEnvConfig(prepare().env).permission.edit ?? {};
    expect(edit['**/frozen.md']).toBe('deny');
  });

  it.skipIf(process.platform !== 'darwin')('writes the sandbox profile outside the lane and denies writes to the trusted dir', () => {
    writeAgent('writer', WRITER);
    const wrapped = prepare().wrap('opencode', ['run', 'hi']);
    expect(wrapped.command).toBe('sandbox-exec');
    const profilePath = wrapped.args[1];
    expect(isUnder(profilePath, runtime)).toBe(true);
    expect(isUnder(profilePath, join(root, '.git'))).toBe(false);
    expect(readFileSync(profilePath, 'utf-8')).toContain(`(deny file-write* (subpath "${runtime}"))`);
  });
});

describe('kimi-code governance: trusted files and guardrail source', () => {
  const prepare = () => prepareKimiGovernance({
    projectRoot: root, workDir: root, squadName: 'demo', agentName: 'plain',
  });

  it.skipIf(process.platform !== 'darwin')('writes the sandbox profile outside the lane and denies writes to the trusted dir', () => {
    writeAgent('plain', 'name: plain');
    const wrapped = prepare().wrap('kimi', ['-p', 'hi']);
    const profilePath = wrapped.args[1];
    expect(isUnder(profilePath, runtime)).toBe(true);
    expect(readdirSync(join(root, '.git')).some((f) => f.startsWith('kimi-sandbox-'))).toBe(false);
    expect(readFileSync(profilePath, 'utf-8')).toContain(`(deny file-write* (subpath "${runtime}"))`);
  });

  it.skipIf(process.platform !== 'darwin')('keeps the bundled write denies and adds project denies, ignoring project hooks and allows', () => {
    writeAgent('plain', 'name: plain');
    writeProjectGuardrail({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node planted.cjs' }] }] },
      permissions: { allow: ['Bash(*)'], deny: ['Edit(**/frozen.md)'] },
    });
    const profile = readFileSync(prepare().wrap('kimi', ['-p', 'hi']).args[1], 'utf-8');
    expect(profile).toContain('[gG][oO][aA][lL][sS][.][mM][dD]'); // bundled goals.md deny
    expect(profile).toContain('[fF][rR][oO][zZ][eE][nN][.][mM][dD]'); // project deny, additive
    expect(profile).not.toContain('planted.cjs');
  });

  it.skipIf(process.platform !== 'darwin')('keeps the bundled write denies when the project guardrail is empty', () => {
    writeAgent('plain', 'name: plain');
    writeProjectGuardrail({ permissions: { deny: [] } });
    const profile = readFileSync(prepare().wrap('kimi', ['-p', 'hi']).args[1], 'utf-8');
    expect(profile).toContain('[gG][oO][aA][lL][sS][.][mM][dD]');
  });
});

describe('sandbox profiles keep host-trusted paths read-only', () => {
  it('opencode: seatbelt denies and bwrap re-binds read-only the trusted dir', () => {
    const opts = { workDir: root, writeDirs: [] as string[], denyWritePaths: [runtime] };
    expect(buildSeatbeltProfile(opts)).toContain(`(deny file-write* (subpath "${runtime}"))`);
    expect(buildBwrapArgs(opts).join(' ')).toContain(`--ro-bind ${runtime} ${runtime}`);
  });

  it('kimi-code: seatbelt denies and bwrap re-binds read-only the trusted dir', () => {
    const opts = { workDir: root, writeDirs: [] as string[], denyWritePaths: [runtime] };
    expect(buildKimiSeatbeltProfile(opts)).toContain(`(deny file-write* (subpath "${runtime}"))`);
    expect(buildKimiBwrapArgs(opts).join(' ')).toContain(`--ro-bind ${runtime} ${runtime}`);
  });

  it('the deny comes after the writable-root allow (last match wins)', () => {
    // The runtime dir lives under tmpdir(), itself a writable root.
    for (const profile of [
      buildSeatbeltProfile({ workDir: root, writeDirs: [], denyWritePaths: [runtime] }),
      buildKimiSeatbeltProfile({ workDir: root, writeDirs: [], denyWritePaths: [runtime] }),
    ]) {
      expect(profile.lastIndexOf('(deny file-write* (subpath')).toBeGreaterThan(profile.indexOf('(allow file-write* (subpath'));
    }
  });
});
