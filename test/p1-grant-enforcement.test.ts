import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { compileAllowedTools } from '../src/lib/agent-contract.js';
import { buildDetachedShellScript, buildAgentEnv, DEFAULT_AGENT_TOOLS } from '../src/lib/execution-engine.js';
import { ExecEventWriter, execEventsFile, type PersistedExecEvent } from '../src/lib/exec-events.js';
import { readFileSync } from 'fs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'squads-p1-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeAgentFile(frontmatter: string): string {
  const p = join(dir, 'agent.md');
  writeFileSync(p, `---\n${frontmatter}\n---\n\n# Agent\nbody\n`);
  return p;
}

describe('compileAllowedTools (#920 — deny-by-omission where declared)', () => {
  it('explicit frontmatter tool_grants become the allowlist, unenforceable tokens dropped', () => {
    const p = writeAgentFile([
      'role: worker',
      'tool_grants:',
      '  - tool: Read',
      '    sensitivity: read',
      '  - tool: "Bash(git:*)"',
      '    sensitivity: write',
      '  - tool: "Bash(rm -rf $(pwd))"', // shell metachars — not enforceable
      '    sensitivity: consequential',
    ].join('\n'));

    const compiled = compileAllowedTools(p, DEFAULT_AGENT_TOOLS);
    expect(compiled.source).toBe('contract');
    expect(compiled.tools).toEqual(['Read', 'Bash(git:*)']);
  });

  it('no declared grants → the tuned default surface, unchanged', () => {
    const p = writeAgentFile('role: worker\nmodel: haiku');
    const compiled = compileAllowedTools(p, DEFAULT_AGENT_TOOLS);
    expect(compiled.source).toBe('default');
    expect(compiled.tools).toBe(DEFAULT_AGENT_TOOLS);
  });

  it('missing/unreadable agent file → default surface, never throws', () => {
    const compiled = compileAllowedTools(join(dir, 'nope.md'), ['Read']);
    expect(compiled).toEqual({ tools: ['Read'], source: 'default' });
  });
});

describe('detached executor permissions (#920 — the bypass is closed)', () => {
  const base = {
    projectRoot: '/proj', squadName: 'demo', agentName: 'hello', timestamp: 1,
    escapedPrompt: 'do it', logFile: '/tmp/l.log', pidFile: '/tmp/l.pid',
  };

  it('with compiled tools: --allowedTools present, --dangerously-skip-permissions absent', () => {
    const script = buildDetachedShellScript({ ...base, allowedTools: ['Read', 'Bash(git:*)'] });
    expect(script).toContain(`--allowedTools 'Read' 'Bash(git:*)'`);
    expect(script).not.toContain('--dangerously-skip-permissions');
  });

  it('without allowedTools (SQUADS_SKIP_PERMISSIONS opt-out path): legacy bypass retained', () => {
    const script = buildDetachedShellScript(base);
    expect(script).toContain('--dangerously-skip-permissions');
    expect(script).not.toContain('--allowedTools');
  });
});

describe('root_run_id chain (#920)', () => {
  const ctx = (id: string) => ({ squad: 's', agent: 'a', taskType: 'execution', trigger: 'manual', executionId: id }) as Parameters<typeof buildAgentEnv>[1];

  it('top-level spawn: root = own execution id; parent = own id for children', () => {
    const env = buildAgentEnv({ PATH: '/bin' }, ctx('exec_root_1'));
    expect(env.SQUADS_ROOT_RUN_ID).toBe('exec_root_1');
    expect(env.SQUADS_PARENT_RUN_ID).toBe('exec_root_1');
  });

  it('nested spawn: root propagates unchanged; parent becomes the spawner', () => {
    // Simulate: this CLI was spawned by exec_root_1, and now spawns exec_child_2.
    const inherited = { PATH: '/bin', SQUADS_ROOT_RUN_ID: 'exec_root_1' };
    const env = buildAgentEnv(inherited, ctx('exec_child_2'));
    expect(env.SQUADS_ROOT_RUN_ID).toBe('exec_root_1');
    expect(env.SQUADS_PARENT_RUN_ID).toBe('exec_child_2');
  });

  it('nested runs stamp root on persisted events; top-level runs do not', () => {
    const old = process.env.SQUADS_ROOT_RUN_ID;
    try {
      process.env.SQUADS_ROOT_RUN_ID = 'exec_root_1';
      mkdirSync(join(dir, '.agents'), { recursive: true });
      const file = execEventsFile(dir, 'exec_child_2');
      const w = new ExecEventWriter(file, 'exec_child_2');
      w.emit({ type: 'run_start', squad: 's', mode: 'background', model: '', role: '', startedAt: 'x' });
      w.close();
      const line = JSON.parse(readFileSync(file, 'utf8').trim()) as PersistedExecEvent;
      expect(line.root).toBe('exec_root_1');

      // Top-level: env root equals own runId → no stamp.
      process.env.SQUADS_ROOT_RUN_ID = 'exec_top_3';
      const file2 = execEventsFile(dir, 'exec_top_3');
      const w2 = new ExecEventWriter(file2, 'exec_top_3');
      w2.emit({ type: 'run_start', squad: 's', mode: 'background', model: '', role: '', startedAt: 'x' });
      w2.close();
      const line2 = JSON.parse(readFileSync(file2, 'utf8').trim()) as PersistedExecEvent;
      expect(line2.root).toBeUndefined();
    } finally {
      if (old === undefined) delete process.env.SQUADS_ROOT_RUN_ID;
      else process.env.SQUADS_ROOT_RUN_ID = old;
    }
  });
});
