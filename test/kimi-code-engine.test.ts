import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { prepareKimiGovernance } from '../src/lib/execution-engine.js';
import { KimiGovernanceError } from '../src/lib/kimi-code-governance.js';

let root: string;
const sandboxEnv = process.env.SQUADS_SANDBOX;

function writeAgent(name: string, frontmatter: string): void {
  writeFileSync(join(root, '.agents', 'squads', 'demo', `${name}.md`), `---\n${frontmatter}\n---\n# ${name}\n`);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-engine-')));
  mkdirSync(join(root, '.agents', 'squads', 'demo'), { recursive: true });
  execSync('git init -q', { cwd: root });
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  delete process.env.SQUADS_SANDBOX;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (sandboxEnv === undefined) delete process.env.SQUADS_SANDBOX; else process.env.SQUADS_SANDBOX = sandboxEnv;
  rmSync(root, { recursive: true, force: true });
});

describe('prepareKimiGovernance (cli#1309)', () => {
  it('refuses an explicit contract that scopes Bash — kimi -p would silently widen it', () => {
    writeAgent('scoped', [
      'tool_grants:',
      '  - { tool: Read, sensitivity: read }',
      '  - { tool: Write, sensitivity: write }',
      '  - { tool: Edit, sensitivity: write }',
      '  - { tool: "Bash(git:*)", sensitivity: write }',
    ].join('\n'));
    expect(() => prepareKimiGovernance({ projectRoot: root, workDir: root, squadName: 'demo', agentName: 'scoped' }))
      .toThrow(KimiGovernanceError);
  });

  it('refuses a read-only contract', () => {
    writeAgent('reader', ['tool_grants:', '  - { tool: Read, sensitivity: read }'].join('\n'));
    expect(() => prepareKimiGovernance({ projectRoot: root, workDir: root, squadName: 'demo', agentName: 'reader' }))
      .toThrow(/does not grant/);
  });

  it('refuses when the guardrail cannot be enforced because the sandbox is opted out', () => {
    process.env.SQUADS_SANDBOX = '0';
    writeAgent('plain', 'name: plain');
    expect(() => prepareKimiGovernance({ projectRoot: root, workDir: root, squadName: 'demo', agentName: 'plain' }))
      .toThrow(/SQUADS_SANDBOX=0 removes the only mechanism/);
  });

  it.skipIf(process.platform !== 'darwin')('wraps the default surface in sandbox-exec and writes the profile', () => {
    writeAgent('plain', 'name: plain');
    const gov = prepareKimiGovernance({ projectRoot: root, workDir: root, squadName: 'demo', agentName: 'plain' });
    const wrapped = gov.wrap('kimi', ['-p', 'hi']);
    expect(wrapped.command).toBe('sandbox-exec');
    expect(wrapped.args.slice(0, 1)).toEqual(['-f']);
    expect(wrapped.args.slice(-3)).toEqual(['kimi', '-p', 'hi']);
    expect(wrapped.args).not.toContain('--auto');
    const profile = readFileSync(wrapped.args[1], 'utf-8');
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('[gG][oO][aA][lL][sS][.][mM][dD]'); // guardrail goals.md deny
    expect(readdirSync(join(root, '.git')).some((f) => f.startsWith('kimi-sandbox-'))).toBe(true);
  });
});
