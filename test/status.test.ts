import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSquad, parseSquadFile, findSquadsDir } from '../src/lib/squad-parser.js';
import { findMemoryDir, getSquadState } from '../src/lib/memory.js';

describe('status command dependencies', () => {
  let testDir: string;
  let squadsDir: string;
  let memoryDir: string;
  let originalCwd: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'squads-status-test-' + Date.now());
    squadsDir = join(testDir, '.agents', 'squads');
    memoryDir = join(testDir, '.agents', 'memory');
    mkdirSync(squadsDir, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('loadSquad', () => {
    it('loads squad with basic info', () => {
      const squadDir = join(squadsDir, 'engineering');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `# Engineering Squad

## Mission

Build quality software.

## Goals

- [ ] Reduce build time to <3min
- [x] Set up CI pipeline

## Agents

| Agent | Role | Trigger |
|-------|------|---------|
| code-reviewer | Review PRs | On PR |
| ci-optimizer | Optimize CI | Manual |
`);

      const result = loadSquad('engineering');

      expect(result).not.toBeNull();
      // Name comes from directory name when not in frontmatter
      expect(result?.name).toBe('engineering');
      expect(result?.mission).toBe('Build quality software.');
      expect(result?.goals).toHaveLength(2);
      expect(result?.goals[0].description).toBe('Reduce build time to <3min');
      expect(result?.goals[0].completed).toBe(false);
      expect(result?.goals[1].completed).toBe(true);
    });

    it('returns null for non-existent squad', () => {
      const result = loadSquad('nonexistent');
      expect(result).toBeNull();
    });

    it('parses agents from table', () => {
      const squadDir = join(squadsDir, 'test');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `# Test

## Agents

| Agent | Role | Trigger |
|-------|------|---------|
| agent1 | Role 1 | Manual |
| agent2 | Role 2 | Daily |
`);

      const result = loadSquad('test');
      expect(result?.agents).toHaveLength(2);
      expect(result?.agents[0].name).toBe('agent1');
      expect(result?.agents[0].role).toBe('Role 1');
      expect(result?.agents[0].trigger).toBe('Manual');
    });

    it('parses frontmatter metadata', () => {
      const squadDir = join(squadsDir, 'intel');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `---
name: Intelligence Squad
mission: Monitor competitors
repo: agents-squads/hq
effort: medium
---

# Intelligence Squad
`);

      const result = loadSquad('intel');
      expect(result?.name).toBe('Intelligence Squad');
      expect(result?.mission).toBe('Monitor competitors');
      expect(result?.effort).toBe('medium');
    });

    it('parses context block from frontmatter', () => {
      const squadDir = join(squadsDir, 'research');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `---
name: Research
context:
  mcp:
    - firecrawl
    - context7
  skills:
    - research-workflow
  budget:
    daily: 10
    weekly: 50
---

# Research Squad
`);

      const result = loadSquad('research');
      expect(result?.context?.mcp).toContain('firecrawl');
      expect(result?.context?.mcp).toContain('context7');
      expect(result?.context?.skills).toContain('research-workflow');
      expect(result?.context?.budget?.daily).toBe(10);
      expect(result?.context?.budget?.weekly).toBe(50);
    });
  });

  describe('parseSquadFile', () => {
    it('parses pipelines from arrow notation', () => {
      const squadDir = join(squadsDir, 'demo');
      mkdirSync(squadDir);
      const squadFile = join(squadDir, 'SQUAD.md');
      writeFileSync(squadFile, `# Demo

## Pipeline

\`researcher\` → \`reporter\`
`);

      const result = parseSquadFile(squadFile);
      expect(result.pipelines).toHaveLength(1);
      expect(result.pipelines[0].agents).toEqual(['researcher', 'reporter']);
    });

    it('parses multiple goals with progress', () => {
      const squadDir = join(squadsDir, 'test');
      mkdirSync(squadDir);
      const squadFile = join(squadDir, 'SQUAD.md');
      writeFileSync(squadFile, `# Test

## Goals

- [ ] First goal
- [ ] Second goal (progress: 50%)
- [x] Completed goal (progress: 100%)
`);

      const result = parseSquadFile(squadFile);
      expect(result.goals).toHaveLength(3);
      expect(result.goals[0].description).toBe('First goal');
      expect(result.goals[0].progress).toBeUndefined();
      expect(result.goals[1].description).toBe('Second goal');
      expect(result.goals[1].progress).toBe('50%');
      expect(result.goals[2].completed).toBe(true);
      expect(result.goals[2].progress).toBe('100%');
    });

    it('extracts squad directory name', () => {
      const squadDir = join(squadsDir, 'my-squad');
      mkdirSync(squadDir);
      const squadFile = join(squadDir, 'SQUAD.md');
      writeFileSync(squadFile, '# My Squad');

      const result = parseSquadFile(squadFile);
      expect(result.dir).toBe('my-squad');
    });
  });

  describe('getSquadState (for status display)', () => {
    it('returns state entries for squad with memory', () => {
      // Create squad
      const squadDir = join(squadsDir, 'engineering');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), '# Engineering');

      // Create memory
      const agentMemory = join(memoryDir, 'engineering', 'code-reviewer');
      mkdirSync(agentMemory, { recursive: true });
      writeFileSync(join(agentMemory, 'state.md'), `# Code Reviewer State

Updated: 2026-01-28T10:00:00Z

## Current Status
Monitoring PRs
`);

      const result = getSquadState('engineering');
      expect(result).toHaveLength(1);
      expect(result[0].agent).toBe('code-reviewer');
      expect(result[0].content).toContain('Monitoring PRs');
    });

    it('returns empty array for squad without memory', () => {
      const squadDir = join(squadsDir, 'new-squad');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), '# New Squad');

      const result = getSquadState('new-squad');
      expect(result).toEqual([]);
    });

    it('returns multiple agent states', () => {
      const squadDir = join(squadsDir, 'multi');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), '# Multi');

      // Create memory for multiple agents
      const agent1Memory = join(memoryDir, 'multi', 'agent1');
      mkdirSync(agent1Memory, { recursive: true });
      writeFileSync(join(agent1Memory, 'state.md'), 'Agent 1 state');

      const agent2Memory = join(memoryDir, 'multi', 'agent2');
      mkdirSync(agent2Memory, { recursive: true });
      writeFileSync(join(agent2Memory, 'state.md'), 'Agent 2 state');

      const result = getSquadState('multi');
      expect(result).toHaveLength(2);
    });
  });
});
