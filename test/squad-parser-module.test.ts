import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  findSquadsDir,
  findProjectRoot,
  listSquads,
  listAgents,
  parseSquadFile,
  loadSquad,
  loadAgentDefinition,
  parseAgentProvider,
  addGoalToSquad,
  updateGoalInSquad,
  hasLocalInfraConfig,
} from '../src/lib/squad-parser.js';

describe('squad-parser module', () => {
  let tempDir: string;
  let squadsDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Create temp directory with resolved symlinks (for macOS)
    const rawTempDir = mkdtempSync(join(tmpdir(), 'squads-parser-test-'));
    tempDir = realpathSync(rawTempDir);
    squadsDir = join(tempDir, '.agents', 'squads');
    mkdirSync(squadsDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('findSquadsDir', () => {
    it('finds .agents/squads in current directory', () => {
      const result = findSquadsDir();
      expect(result ? realpathSync(result) : result).toBe(squadsDir);
    });

    it('finds .agents/squads in parent directory', () => {
      const subDir = join(tempDir, 'sub', 'nested');
      mkdirSync(subDir, { recursive: true });
      process.chdir(subDir);

      const result = findSquadsDir();
      expect(result ? realpathSync(result) : result).toBe(squadsDir);
    });

    it('returns null when no squads directory found', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'squads-empty-'));
      process.chdir(emptyDir);

      const result = findSquadsDir();
      expect(result).toBeNull();

      rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  describe('findProjectRoot', () => {
    it('returns project root containing .agents', () => {
      const result = findProjectRoot();
      expect(result ? realpathSync(result) : result).toBe(tempDir);
    });

    it('returns null when not in a project', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'squads-no-root-'));
      process.chdir(emptyDir);

      const result = findProjectRoot();
      expect(result).toBeNull();

      rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  describe('hasLocalInfraConfig', () => {
    it('returns false when no .env file', () => {
      const result = hasLocalInfraConfig();
      expect(result).toBe(false);
    });

    it('returns false for .env without infra keys', () => {
      // Test with non-infra env vars (APP_KEY is not in infra detection list)
      writeFileSync(join(tempDir, '.env'), 'APP_TOKEN=abc\nDEBUG=true\n');

      const result = hasLocalInfraConfig();
      expect(result).toBe(false);
    });

    it('returns true for .env with LANGFUSE_ keys', () => {
      // LANGFUSE_ prefix triggers infra detection
      writeFileSync(join(tempDir, '.env'), 'LANGFUSE_PUBLIC_HOST=http://localhost\n');

      const result = hasLocalInfraConfig();
      expect(result).toBe(true);
    });

    it('returns true for .env with SQUADS_BRIDGE key', () => {
      writeFileSync(join(tempDir, '.env'), 'SQUADS_BRIDGE_URL=http://localhost:8088\n');

      const result = hasLocalInfraConfig();
      expect(result).toBe(true);
    });
  });

  describe('listSquads', () => {
    it('returns empty array for empty squads directory', () => {
      const result = listSquads(squadsDir);
      expect(result).toEqual([]);
    });

    it('lists squads with SQUAD.md files', () => {
      // Create two valid squads
      mkdirSync(join(squadsDir, 'engineering'), { recursive: true });
      writeFileSync(join(squadsDir, 'engineering', 'SQUAD.md'), '# Engineering Squad');

      mkdirSync(join(squadsDir, 'marketing'), { recursive: true });
      writeFileSync(join(squadsDir, 'marketing', 'SQUAD.md'), '# Marketing Squad');

      // Create invalid directory (no SQUAD.md)
      mkdirSync(join(squadsDir, 'incomplete'), { recursive: true });

      const result = listSquads(squadsDir);
      expect(result).toHaveLength(2);
      expect(result).toContain('engineering');
      expect(result).toContain('marketing');
      expect(result).not.toContain('incomplete');
    });

    it('ignores directories starting with underscore', () => {
      mkdirSync(join(squadsDir, '_templates'), { recursive: true });
      writeFileSync(join(squadsDir, '_templates', 'SQUAD.md'), '# Template');

      mkdirSync(join(squadsDir, 'cli'), { recursive: true });
      writeFileSync(join(squadsDir, 'cli', 'SQUAD.md'), '# CLI Squad');

      const result = listSquads(squadsDir);
      expect(result).toEqual(['cli']);
    });
  });

  describe('listAgents', () => {
    beforeEach(() => {
      // Create a squad with agents
      mkdirSync(join(squadsDir, 'cli'), { recursive: true });
      writeFileSync(join(squadsDir, 'cli', 'SQUAD.md'), '# CLI Squad');
      writeFileSync(join(squadsDir, 'cli', 'issue-solver.md'), '# Issue Solver');
      writeFileSync(join(squadsDir, 'cli', 'code-reviewer.md'), '# Code Reviewer');
    });

    it('lists all agents across all squads', () => {
      const agents = listAgents(squadsDir);
      expect(agents).toHaveLength(2);
      expect(agents.map(a => a.name)).toContain('issue-solver');
      expect(agents.map(a => a.name)).toContain('code-reviewer');
    });

    it('filters agents by squad name', () => {
      // Add another squad
      mkdirSync(join(squadsDir, 'web'), { recursive: true });
      writeFileSync(join(squadsDir, 'web', 'SQUAD.md'), '# Web Squad');
      writeFileSync(join(squadsDir, 'web', 'builder.md'), '# Builder');

      const cliAgents = listAgents(squadsDir, 'cli');
      expect(cliAgents).toHaveLength(2);
      expect(cliAgents.every(a => a.filePath?.includes('/cli/'))).toBe(true);

      const webAgents = listAgents(squadsDir, 'web');
      expect(webAgents).toHaveLength(1);
      expect(webAgents[0].name).toBe('builder');
    });

    it('includes file path in agent objects', () => {
      const agents = listAgents(squadsDir);
      expect(agents[0].filePath).toContain('.md');
    });
  });

  describe('parseSquadFile', () => {
    it('parses basic squad file', () => {
      const squadPath = join(squadsDir, 'test');
      mkdirSync(squadPath, { recursive: true });
      const squadFile = join(squadPath, 'SQUAD.md');
      writeFileSync(squadFile, `---
name: Test Squad
mission: Build amazing things
---

# Test Squad
`);

      const squad = parseSquadFile(squadFile);
      expect(squad.name).toBe('Test Squad');
      expect(squad.mission).toBe('Build amazing things');
      expect(squad.dir).toBe('test');
    });

    it('parses agents table', () => {
      const squadPath = join(squadsDir, 'test');
      mkdirSync(squadPath, { recursive: true });
      const squadFile = join(squadPath, 'SQUAD.md');
      writeFileSync(squadFile, `---
name: Test
---

## Agents

| Agent | Role | Trigger |
|-------|------|---------|
| worker1 | Do work | Manual |
| worker2 | More work | Scheduled |
`);

      const squad = parseSquadFile(squadFile);
      expect(squad.agents).toHaveLength(2);
      expect(squad.agents[0].name).toBe('worker1');
      expect(squad.agents[0].role).toBe('Do work');
      expect(squad.agents[0].trigger).toBe('Manual');
    });

    it('parses goals section with checkboxes', () => {
      const squadPath = join(squadsDir, 'test');
      mkdirSync(squadPath, { recursive: true });
      const squadFile = join(squadPath, 'SQUAD.md');
      writeFileSync(squadFile, `---
name: Test
---

## Goals

- [x] Complete milestone 1
- [ ] Implement feature X (progress: 50% done)
- [ ] Fix all bugs
`);

      const squad = parseSquadFile(squadFile);
      expect(squad.goals).toHaveLength(3);
      expect(squad.goals[0].completed).toBe(true);
      expect(squad.goals[0].description).toBe('Complete milestone 1');
      expect(squad.goals[1].completed).toBe(false);
      expect(squad.goals[1].progress).toBe('50% done');
      expect(squad.goals[2].completed).toBe(false);
    });

    it('parses pipelines', () => {
      const squadPath = join(squadsDir, 'test');
      mkdirSync(squadPath, { recursive: true });
      const squadFile = join(squadPath, 'SQUAD.md');
      writeFileSync(squadFile, `---
name: Test
---

## Pipelines

\`agent1\` → \`agent2\` → \`agent3\`
`);

      const squad = parseSquadFile(squadFile);
      expect(squad.pipelines).toHaveLength(1);
      expect(squad.pipelines[0].agents).toEqual(['agent1', 'agent2', 'agent3']);
    });

    it('parses effort level from frontmatter', () => {
      const squadPath = join(squadsDir, 'test');
      mkdirSync(squadPath, { recursive: true });
      const squadFile = join(squadPath, 'SQUAD.md');
      writeFileSync(squadFile, `---
name: Test
effort: high
---
`);

      const squad = parseSquadFile(squadFile);
      expect(squad.effort).toBe('high');
    });

    it('parses context block from frontmatter', () => {
      const squadPath = join(squadsDir, 'test');
      mkdirSync(squadPath, { recursive: true });
      const squadFile = join(squadPath, 'SQUAD.md');
      writeFileSync(squadFile, `---
name: Test
context:
  mcp:
    - supabase
    - grafana
  skills:
    - research
---
`);

      const squad = parseSquadFile(squadFile);
      expect(squad.context?.mcp).toEqual(['supabase', 'grafana']);
      expect(squad.context?.skills).toEqual(['research']);
    });

    it('parses providers block from frontmatter', () => {
      const squadPath = join(squadsDir, 'test');
      mkdirSync(squadPath, { recursive: true });
      const squadFile = join(squadPath, 'SQUAD.md');
      writeFileSync(squadFile, `---
name: Test
providers:
  default: anthropic
  cheap: google
---
`);

      const squad = parseSquadFile(squadFile);
      expect(squad.providers?.default).toBe('anthropic');
      expect(squad.providers?.cheap).toBe('google');
    });
  });

  describe('loadSquad', () => {
    it('returns null for non-existent squad', () => {
      const result = loadSquad('nonexistent');
      expect(result).toBeNull();
    });

    it('loads and parses existing squad', () => {
      mkdirSync(join(squadsDir, 'cli'), { recursive: true });
      writeFileSync(join(squadsDir, 'cli', 'SQUAD.md'), `---
name: CLI Squad
mission: Build the CLI
---
`);

      const squad = loadSquad('cli');
      expect(squad).not.toBeNull();
      expect(squad?.name).toBe('CLI Squad');
      expect(squad?.mission).toBe('Build the CLI');
    });
  });

  describe('loadAgentDefinition', () => {
    it('returns empty string for non-existent file', () => {
      const result = loadAgentDefinition('/nonexistent/path.md');
      expect(result).toBe('');
    });

    it('returns file content', () => {
      const agentPath = join(squadsDir, 'test-agent.md');
      writeFileSync(agentPath, '# Test Agent\n\nDo stuff.');

      const result = loadAgentDefinition(agentPath);
      expect(result).toContain('# Test Agent');
      expect(result).toContain('Do stuff.');
    });
  });

  describe('parseAgentProvider', () => {
    it('returns undefined for non-existent file', () => {
      const result = parseAgentProvider('/nonexistent/agent.md');
      expect(result).toBeUndefined();
    });

    it('parses provider from frontmatter', () => {
      const agentPath = join(squadsDir, 'agent.md');
      writeFileSync(agentPath, `---
provider: google
---

# Agent
`);

      const result = parseAgentProvider(agentPath);
      expect(result).toBe('google');
    });

    it('parses provider from header syntax', () => {
      const agentPath = join(squadsDir, 'agent.md');
      writeFileSync(agentPath, `# Agent

## Provider
xai

## Instructions
`);

      const result = parseAgentProvider(agentPath);
      expect(result).toBe('xai');
    });

    it('returns undefined when no provider specified', () => {
      const agentPath = join(squadsDir, 'agent.md');
      writeFileSync(agentPath, '# Agent\n\nJust an agent.');

      const result = parseAgentProvider(agentPath);
      expect(result).toBeUndefined();
    });

    it('normalizes provider to lowercase', () => {
      const agentPath = join(squadsDir, 'agent.md');
      writeFileSync(agentPath, `---
provider: GOOGLE
---
`);

      const result = parseAgentProvider(agentPath);
      expect(result).toBe('google');
    });
  });

  describe('addGoalToSquad', () => {
    beforeEach(() => {
      mkdirSync(join(squadsDir, 'test'), { recursive: true });
    });

    it('adds goal to existing Goals section', () => {
      writeFileSync(join(squadsDir, 'test', 'SQUAD.md'), `---
name: Test
---

## Goals

- [ ] Existing goal
`);

      const result = addGoalToSquad('test', 'New goal');
      expect(result).toBe(true);

      const squad = loadSquad('test');
      expect(squad?.goals).toHaveLength(2);
      expect(squad?.goals.map(g => g.description)).toContain('New goal');
    });

    it('creates Goals section if missing', () => {
      writeFileSync(join(squadsDir, 'test', 'SQUAD.md'), `---
name: Test
---

## Mission

Do stuff.
`);

      const result = addGoalToSquad('test', 'First goal');
      expect(result).toBe(true);

      const squad = loadSquad('test');
      expect(squad?.goals).toHaveLength(1);
      expect(squad?.goals[0].description).toBe('First goal');
    });

    it('returns false for non-existent squad', () => {
      const result = addGoalToSquad('nonexistent', 'Goal');
      expect(result).toBe(false);
    });
  });

  describe('updateGoalInSquad', () => {
    beforeEach(() => {
      mkdirSync(join(squadsDir, 'test'), { recursive: true });
      writeFileSync(join(squadsDir, 'test', 'SQUAD.md'), `---
name: Test
---

## Goals

- [ ] Goal 1
- [ ] Goal 2
- [ ] Goal 3
`);
    });

    it('marks goal as completed', () => {
      const result = updateGoalInSquad('test', 0, { completed: true });
      expect(result).toBe(true);

      const squad = loadSquad('test');
      expect(squad?.goals[0].completed).toBe(true);
    });

    it('adds progress annotation', () => {
      const result = updateGoalInSquad('test', 1, { completed: false, progress: '50%' });
      expect(result).toBe(true);

      const squad = loadSquad('test');
      expect(squad?.goals[1].progress).toBe('50%');
    });

    it('returns false for invalid goal index', () => {
      const result = updateGoalInSquad('test', 10, { completed: true });
      expect(result).toBe(false);
    });

    it('returns false for non-existent squad', () => {
      const result = updateGoalInSquad('nonexistent', 0, { completed: true });
      expect(result).toBe(false);
    });
  });
});
