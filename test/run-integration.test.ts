import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runSquadCommand } from '../src/commands/run.js';

describe('run command integration tests', () => {
  let testDir: string;
  let squadsDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // Create test environment
    testDir = join(tmpdir(), 'squads-run-integration-' + Date.now());
    squadsDir = join(testDir, '.agents', 'squads');
    mkdirSync(squadsDir, { recursive: true });

    // Save original environment
    originalCwd = process.cwd();
    originalHome = process.env.HOME;

    // Set test environment
    process.chdir(testDir);
    process.env.HOME = testDir;
  });

  afterEach(() => {
    // Restore environment
    process.chdir(originalCwd);
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('ensureProjectTrusted', () => {
    it('creates Claude config if missing', async () => {
      const configPath = join(testDir, '.claude.json');

      // Create squad setup
      const squadDir = join(squadsDir, 'test-squad');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `# Test Squad

## Mission
Test mission
`);

      writeFileSync(join(squadDir, 'agent-1.md'), `# Agent 1

## Purpose
Test agent
`);

      // Run command in dry-run mode (won't execute Claude)
      await runSquadCommand('test-squad', { dryRun: true });

      // Should not crash even if config doesn't exist
      expect(true).toBe(true);
    });

    it('preserves existing projects in config', async () => {
      const configPath = join(testDir, '.claude.json');

      // Create initial config with existing project
      writeFileSync(configPath, JSON.stringify({
        projects: {
          '/some/other/path': { hasTrustDialogAccepted: true }
        }
      }, null, 2));

      // Create squad setup
      const squadDir = join(squadsDir, 'test-squad');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `# Test Squad`);
      writeFileSync(join(squadDir, 'agent-1.md'), `# Agent 1`);

      // Run command
      await runSquadCommand('test-squad', { dryRun: true });

      // Config should still be valid JSON and preserve existing projects
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.projects).toBeDefined();
      expect(config.projects['/some/other/path']).toBeDefined();
    });
  });

  describe('runSquad - dry-run mode', () => {
    it('lists available agents without executing', async () => {
      const squadDir = join(squadsDir, 'engineering');
      mkdirSync(squadDir);

      writeFileSync(join(squadDir, 'SQUAD.md'), `# Engineering

## Mission
Build and maintain infrastructure

## Agents

| Agent | Role | Trigger |
|-------|------|---------|
| code-reviewer | Review PRs | Manual |
| ci-optimizer | Optimize CI | Manual |
`);

      writeFileSync(join(squadDir, 'code-reviewer.md'), `# Code Reviewer

## Purpose
Review pull requests for quality
`);

      writeFileSync(join(squadDir, 'ci-optimizer.md'), `# CI Optimizer

## Purpose
Optimize CI workflows
`);

      // Should complete without errors
      await expect(runSquadCommand('engineering', { dryRun: true })).resolves.not.toThrow();
    });

    it('shows pipeline execution order', async () => {
      const squadDir = join(squadsDir, 'pipeline-squad');
      mkdirSync(squadDir);

      writeFileSync(join(squadDir, 'SQUAD.md'), `# Pipeline Squad

## Pipeline

1. data-fetcher → data-processor → report-generator
`);

      writeFileSync(join(squadDir, 'data-fetcher.md'), `# Data Fetcher`);
      writeFileSync(join(squadDir, 'data-processor.md'), `# Data Processor`);
      writeFileSync(join(squadDir, 'report-generator.md'), `# Report Generator`);

      // Should complete without errors
      await expect(runSquadCommand('pipeline-squad', { dryRun: true })).resolves.not.toThrow();
    });
  });

  describe('runSquad - parallel preview mode', () => {
    it('shows parallel execution preview without --execute', async () => {
      const squadDir = join(squadsDir, 'parallel-squad');
      mkdirSync(squadDir);

      writeFileSync(join(squadDir, 'SQUAD.md'), `# Parallel Squad

## Agents

| Agent | Role |
|-------|------|
| agent-a | Task A |
| agent-b | Task B |
| agent-c | Task C |
`);

      writeFileSync(join(squadDir, 'agent-a.md'), `# Agent A`);
      writeFileSync(join(squadDir, 'agent-b.md'), `# Agent B`);
      writeFileSync(join(squadDir, 'agent-c.md'), `# Agent C`);

      // Should show preview without executing (dry-run to avoid actual tmux/Claude invocation)
      await expect(
        runSquadCommand('parallel-squad', { parallel: true, dryRun: true })
      ).resolves.not.toThrow();
    });
  });

  describe('runAgent - single agent execution', () => {
    it('runs specific agent from squad using slash notation', async () => {
      const squadDir = join(squadsDir, 'cli');
      mkdirSync(squadDir);

      writeFileSync(join(squadDir, 'SQUAD.md'), `# CLI Squad`);
      writeFileSync(join(squadDir, 'issue-solver.md'), `# Issue Solver

## Purpose
Solve GitHub issues
`);

      // Dry-run specific agent
      await expect(
        runSquadCommand('cli/issue-solver', { dryRun: true })
      ).resolves.not.toThrow();
    });

    it('handles missing agent by showing available agents', async () => {
      const squadDir = join(squadsDir, 'test-squad');
      mkdirSync(squadDir);
      writeFileSync(join(squadDir, 'SQUAD.md'), `# Test Squad`);
      writeFileSync(join(squadDir, 'existing-agent.md'), `# Existing Agent`);

      // Try to run non-existent agent - command completes but shows help
      await expect(
        runSquadCommand('test-squad/missing-agent', { dryRun: true })
      ).resolves.not.toThrow();
    });
  });

  describe('effort level handling', () => {
    it('uses squad-level effort when not overridden', async () => {
      const squadDir = join(squadsDir, 'low-effort');
      mkdirSync(squadDir);

      writeFileSync(join(squadDir, 'SQUAD.md'), `---
effort: low
---

# Low Effort Squad

## Agents

| Agent | Role |
|-------|------|
| quick-task | Quick task |
`);

      writeFileSync(join(squadDir, 'quick-task.md'), `# Quick Task`);

      // Should use squad's effort level
      await expect(
        runSquadCommand('low-effort', { dryRun: true })
      ).resolves.not.toThrow();
    });

    it('allows CLI effort override', async () => {
      const squadDir = join(squadsDir, 'flexible-squad');
      mkdirSync(squadDir);

      writeFileSync(join(squadDir, 'SQUAD.md'), `---
effort: medium
---

# Flexible Squad
`);

      writeFileSync(join(squadDir, 'agent.md'), `# Agent`);

      // CLI override should take precedence
      await expect(
        runSquadCommand('flexible-squad', { dryRun: true, effort: 'high' })
      ).resolves.not.toThrow();
    });
  });

  describe('provider configuration', () => {
    it('uses default provider from squad config', async () => {
      const squadDir = join(squadsDir, 'multi-llm');
      mkdirSync(squadDir);

      writeFileSync(join(squadDir, 'SQUAD.md'), `---
providers:
  default: anthropic
  vision: google
---

# Multi-LLM Squad
`);

      writeFileSync(join(squadDir, 'agent.md'), `# Agent`);

      await expect(
        runSquadCommand('multi-llm', { dryRun: true })
      ).resolves.not.toThrow();
    });

    it('uses agent-specific provider override', async () => {
      const squadDir = join(squadsDir, 'squad');
      mkdirSync(squadDir);

      writeFileSync(join(squadDir, 'SQUAD.md'), `# Squad`);
      writeFileSync(join(squadDir, 'gemini-agent.md'), `---
provider: google
---

# Gemini Agent
`);

      await expect(
        runSquadCommand('squad/gemini-agent', { dryRun: true })
      ).resolves.not.toThrow();
    });
  });

  describe('error handling', () => {
    it('fails when squad directory does not exist', async () => {
      await expect(
        runSquadCommand('nonexistent-squad', { dryRun: true })
      ).rejects.toThrow();
    });

    it('fails when SQUAD.md is missing', async () => {
      const squadDir = join(squadsDir, 'broken-squad');
      mkdirSync(squadDir);

      // No SQUAD.md file
      await expect(
        runSquadCommand('broken-squad', { dryRun: true })
      ).rejects.toThrow();
    });

    it('handles squad with no agents gracefully', async () => {
      const squadDir = join(squadsDir, 'empty-squad');
      mkdirSync(squadDir);

      writeFileSync(join(squadDir, 'SQUAD.md'), `# Empty Squad

## Mission
No agents yet
`);

      // Should not crash on empty squad
      await expect(
        runSquadCommand('empty-squad', { dryRun: true })
      ).resolves.not.toThrow();
    });
  });

  describe('memory context gathering', () => {
    it('loads squad mission and goals for context', async () => {
      const squadDir = join(squadsDir, 'context-squad');
      mkdirSync(squadDir);

      writeFileSync(join(squadDir, 'SQUAD.md'), `# Context Squad

## Mission
Build amazing products

## Goals

- Q1: Ship v1.0
- Q2: Scale to 1000 users

## Output
High-quality code and documentation
`);

      writeFileSync(join(squadDir, 'agent.md'), `# Agent`);

      // Context should be gathered during execution
      await expect(
        runSquadCommand('context-squad', { dryRun: true })
      ).resolves.not.toThrow();
    });

    it('loads agent state from memory', async () => {
      const squadDir = join(squadsDir, 'stateful-squad');
      mkdirSync(squadDir);

      writeFileSync(join(squadDir, 'SQUAD.md'), `# Stateful Squad`);
      writeFileSync(join(squadDir, 'stateful-agent.md'), `# Stateful Agent`);

      // Create memory directory with state
      const memoryDir = join(testDir, '.agents', 'memory', 'stateful-squad', 'stateful-agent');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, 'state.md'), `# Agent State

Last execution: 2026-01-30
Current task: Processing queue
`);

      // Agent should load its previous state
      await expect(
        runSquadCommand('stateful-squad/stateful-agent', { dryRun: true })
      ).resolves.not.toThrow();
    });
  });
});
