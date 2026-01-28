import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadSquad,
  loadAgentDefinition,
  parseAgentProvider,
  listAgents,
} from '../src/lib/squad-parser.js';

describe('run command dependencies', () => {
  let testDir: string;
  let squadsDir: string;
  let originalCwd: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'squads-run-test-' + Date.now());
    squadsDir = join(testDir, '.agents', 'squads');
    mkdirSync(squadsDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('loadAgentDefinition', () => {
    it('loads agent definition content', () => {
      const squadDir = join(squadsDir, 'test');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), '# Test');

      const agentContent = `# Code Reviewer

## Purpose
Review pull requests for quality.

## Tools
- GitHub CLI
- Read
- Write

## Instructions
1. Fetch open PRs
2. Review code changes
3. Provide feedback
`;
      const agentPath = join(squadDir, 'code-reviewer.md');
      writeFileSync(agentPath, agentContent);

      const result = loadAgentDefinition(agentPath);
      expect(result).toContain('Code Reviewer');
      expect(result).toContain('GitHub CLI');
      expect(result).toContain('Review pull requests');
    });

    it('returns empty string for non-existent file', () => {
      const result = loadAgentDefinition('/nonexistent/path.md');
      expect(result).toBe('');
    });
  });

  describe('parseAgentProvider', () => {
    let squadDir: string;

    beforeEach(() => {
      squadDir = join(squadsDir, 'test');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), '# Test');
    });

    it('parses provider from frontmatter', () => {
      const agentPath = join(squadDir, 'grok-agent.md');
      writeFileSync(agentPath, `---
provider: xai
---

# Grok Agent
`);

      const result = parseAgentProvider(agentPath);
      expect(result).toBe('xai');
    });

    it('parses provider from header syntax', () => {
      const agentPath = join(squadDir, 'gemini-agent.md');
      writeFileSync(agentPath, `# Gemini Agent

## Provider
google

## Purpose
Use Gemini for analysis.
`);

      const result = parseAgentProvider(agentPath);
      expect(result).toBe('google');
    });

    it('returns undefined when no provider specified', () => {
      const agentPath = join(squadDir, 'default-agent.md');
      writeFileSync(agentPath, `# Default Agent

## Purpose
Uses default provider.
`);

      const result = parseAgentProvider(agentPath);
      expect(result).toBeUndefined();
    });

    it('normalizes provider to lowercase', () => {
      const agentPath = join(squadDir, 'upper-agent.md');
      writeFileSync(agentPath, `---
provider: ANTHROPIC
---

# Agent
`);

      const result = parseAgentProvider(agentPath);
      expect(result).toBe('anthropic');
    });

    it('returns undefined for non-existent file', () => {
      const result = parseAgentProvider('/nonexistent/agent.md');
      expect(result).toBeUndefined();
    });
  });

  describe('squad provider configuration', () => {
    it('loads squad with default provider', () => {
      const squadDir = join(squadsDir, 'multi-llm');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `---
name: Multi-LLM Squad
providers:
  default: anthropic
  vision: google
  realtime: openai
---

# Multi-LLM Squad
`);

      const result = loadSquad('multi-llm');
      expect(result?.providers?.default).toBe('anthropic');
      expect(result?.providers?.vision).toBe('google');
      expect(result?.providers?.realtime).toBe('openai');
    });
  });

  describe('squad/agent target parsing', () => {
    it('handles squad-only target', () => {
      const squadDir = join(squadsDir, 'engineering');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `# Engineering

## Agents

| Agent | Role | Trigger |
|-------|------|---------|
| code-reviewer | Review PRs | Manual |
`);
      writeFileSync(join(squadDir, 'code-reviewer.md'), '# Code Reviewer');

      const squad = loadSquad('engineering');
      expect(squad).not.toBeNull();
      expect(squad?.agents).toHaveLength(1);
    });

    it('handles slash notation for specific agent', () => {
      const squadDir = join(squadsDir, 'engineering');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), '# Engineering');
      writeFileSync(join(squadDir, 'code-reviewer.md'), '# Code Reviewer');
      writeFileSync(join(squadDir, 'ci-optimizer.md'), '# CI Optimizer');

      // Test that we can find agents using listAgents
      const agents = listAgents(squadsDir, 'engineering');
      const codeReviewer = agents.find(a => a.name === 'code-reviewer');

      expect(codeReviewer).toBeDefined();
      expect(codeReviewer?.filePath).toContain('code-reviewer.md');
    });
  });

  describe('effort level handling', () => {
    it('parses effort from squad frontmatter', () => {
      const squadDir = join(squadsDir, 'low-effort');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `---
effort: low
---

# Low Effort Squad
`);

      const result = loadSquad('low-effort');
      expect(result?.effort).toBe('low');
    });

    it('parses effort from markdown body', () => {
      const squadDir = join(squadsDir, 'med-effort');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `# Medium Effort Squad

effort: medium

## Agents
`);

      const result = loadSquad('med-effort');
      expect(result?.effort).toBe('medium');
    });

    it('validates effort level values', () => {
      const squadDir = join(squadsDir, 'valid-effort');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `---
effort: high
---

# High Effort
`);

      const result = loadSquad('valid-effort');
      expect(['high', 'medium', 'low']).toContain(result?.effort);
    });
  });

  describe('context configuration', () => {
    it('parses MCP server list from context', () => {
      const squadDir = join(squadsDir, 'web-squad');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `---
name: Website Squad
context:
  mcp:
    - chrome-devtools
    - firecrawl
---

# Website Squad
`);

      const result = loadSquad('web-squad');
      expect(result?.context?.mcp).toContain('chrome-devtools');
      expect(result?.context?.mcp).toContain('firecrawl');
    });

    it('parses skills from context', () => {
      const squadDir = join(squadsDir, 'research');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `---
context:
  skills:
    - research-workflow
    - citation-format
---

# Research
`);

      const result = loadSquad('research');
      expect(result?.context?.skills).toContain('research-workflow');
    });

    it('parses budget limits from context', () => {
      const squadDir = join(squadsDir, 'budget');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `---
context:
  budget:
    daily: 10
    weekly: 50
    perExecution: 2
---

# Budgeted Squad
`);

      const result = loadSquad('budget');
      expect(result?.context?.budget?.daily).toBe(10);
      expect(result?.context?.budget?.weekly).toBe(50);
      expect(result?.context?.budget?.perExecution).toBe(2);
    });

    it('parses cooldown from context', () => {
      const squadDir = join(squadsDir, 'cooldown');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `---
context:
  cooldown: 3600
---

# Cooldown Squad
`);

      const result = loadSquad('cooldown');
      expect(result?.context?.cooldown).toBe(3600);
    });
  });
});
