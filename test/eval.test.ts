import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('eval', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `squads-eval-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('registerEvalCommand', () => {
    it('registers eval command', async () => {
      const { Command } = await import('commander');
      const { registerEvalCommand } = await import('../src/commands/eval.js');

      const program = new Command();
      registerEvalCommand(program);

      const evalCmd = program.commands.find(c => c.name() === 'eval');
      expect(evalCmd).toBeDefined();
      expect(evalCmd!.description()).toContain('readiness');
    });

    it('eval has --json and --verbose options', async () => {
      const { Command } = await import('commander');
      const { registerEvalCommand } = await import('../src/commands/eval.js');

      const program = new Command();
      registerEvalCommand(program);

      const evalCmd = program.commands.find(c => c.name() === 'eval');
      const options = evalCmd!.options.map(o => o.long);
      expect(options).toContain('--json');
      expect(options).toContain('--verbose');
    });
  });

  describe('evalCommand', () => {
    it('requires squads directory', async () => {
      const { evalCommand } = await import('../src/commands/eval.js');

      // Mock findSquadsDir to return null
      const parserModule = await import('../src/lib/squad-parser.js');
      const spy = vi.spyOn(parserModule, 'findSquadsDir').mockReturnValue(null);

      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => errors.push(args.join(' '));

      await evalCommand('company/coo', {});

      console.error = originalError;
      spy.mockRestore();

      expect(errors.join('\n')).toContain('No .agents/squads/ directory found');
    });

    it('reports squad not found', async () => {
      const { evalCommand } = await import('../src/commands/eval.js');

      // Mock findSquadsDir to return a path
      const parserModule = await import('../src/lib/squad-parser.js');
      const dirSpy = vi.spyOn(parserModule, 'findSquadsDir').mockReturnValue(tmpDir);
      const loadSpy = vi.spyOn(parserModule, 'loadSquad').mockReturnValue(null);

      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => errors.push(args.join(' '));

      await evalCommand('nonexistent/agent', {});

      console.error = originalError;
      dirSpy.mockRestore();
      loadSpy.mockRestore();

      expect(errors.join('\n')).toContain('Squad not found');
    });

    it('evaluates agent with JSON output', async () => {
      const { evalCommand } = await import('../src/commands/eval.js');

      // Create a mock agent file
      const squadDir = join(tmpDir, 'company');
      mkdirSync(squadDir, { recursive: true });

      writeFileSync(join(squadDir, 'SQUAD.md'), `---
name: company
---
# Company Squad
`);

      writeFileSync(join(squadDir, 'test-agent.md'), `---
name: test-agent
role: Test agent for evaluation
model: sonnet
squad: company
trigger: scheduled
schedule: "0 8 * * *"
status: active
timeout: 300
---

## Role
Test agent that validates the eval system.

## Output
Produces structured markdown reports.

## Constraints
- Never delete files
- Always use safe operations
`);

      // Create memory directory
      const memoryDir = join(tmpDir, '..', 'memory', 'company', 'test-agent');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, 'state.md'), `# State
Last run: 2026-02-10
Status: healthy
Tasks completed: 5
`);
      writeFileSync(join(memoryDir, 'output.md'), `## Report
### Summary
All systems operational.
### Details
- Check 1: passed
- Check 2: passed
`);
      writeFileSync(join(memoryDir, 'learnings.md'), `# Learnings
## 2026-02-10
- Learned that X improves Y
- Found pattern in data
`);

      // Mock dependencies
      const parserModule = await import('../src/lib/squad-parser.js');
      const dirSpy = vi.spyOn(parserModule, 'findSquadsDir').mockReturnValue(tmpDir);
      const loadSpy = vi.spyOn(parserModule, 'loadSquad').mockReturnValue({
        name: 'company',
        agentCount: 1,
        agents: [],
        pipelines: [],
        triggers: { scheduled: [], event: [], manual: [] },
        routines: [],
        dependencies: [],
        outputPath: '',
        goals: [],
      });
      const listSpy = vi.spyOn(parserModule, 'listAgents').mockReturnValue([
        { name: 'test-agent', role: 'Test agent', trigger: 'scheduled', filePath: join(squadDir, 'test-agent.md') },
      ]);

      const memoryModule = await import('../src/lib/memory.js');
      const memSpy = vi.spyOn(memoryModule, 'findMemoryDir').mockReturnValue(join(tmpDir, '..', 'memory'));

      const output: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => output.push(args.join(' '));

      await evalCommand('company/test-agent', { json: true });

      console.log = originalLog;
      dirSpy.mockRestore();
      loadSpy.mockRestore();
      listSpy.mockRestore();
      memSpy.mockRestore();

      const jsonOutput = output.join('\n');
      const results = JSON.parse(jsonOutput);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(1);
      expect(results[0].agent).toBe('test-agent');
      expect(results[0].squad).toBe('company');
      expect(results[0].overallScore).toBeGreaterThan(0);
      expect(results[0].readinessLevel).toBeDefined();
      expect(results[0].dimensions.length).toBe(5);
    });
  });
});
