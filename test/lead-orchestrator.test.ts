import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initEventsDir,
  signalWorkerComplete,
  getPendingEvents,
  markEventProcessed,
  buildWorkerCommand,
  buildLeadPrompt,
  type WorkerEvent
} from '../src/lib/orchestration/lead-orchestrator';

describe('lead-orchestrator', () => {
  const testRoot = join(tmpdir(), 'squads-test-' + Date.now());
  const eventsDir = join(testRoot, '.agents', 'events');

  beforeEach(() => {
    // Create fresh test directory
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  describe('initEventsDir', () => {
    it('creates events directory structure', () => {
      const result = initEventsDir(testRoot);

      expect(result).toBe(eventsDir);
      expect(existsSync(eventsDir)).toBe(true);
      expect(existsSync(join(eventsDir, 'pending'))).toBe(true);
      expect(existsSync(join(eventsDir, 'processed'))).toBe(true);
    });

    it('is idempotent - can be called multiple times', () => {
      initEventsDir(testRoot);
      const result = initEventsDir(testRoot);

      expect(result).toBe(eventsDir);
      expect(existsSync(join(eventsDir, 'pending'))).toBe(true);
    });
  });

  describe('signalWorkerComplete', () => {
    beforeEach(() => {
      initEventsDir(testRoot);
    });

    it('creates event file for successful completion', () => {
      signalWorkerComplete({
        eventsDir,
        squad: 'cli',
        agent: 'issue-solver',
        executionId: 'exec-123',
        exitCode: 0,
        summary: 'Task completed'
      });

      const files = readdirSync(join(eventsDir, 'pending'));
      expect(files).toHaveLength(1);
      expect(files[0]).toBe('exec-123-issue-solver.json');

      const content = JSON.parse(readFileSync(join(eventsDir, 'pending', files[0]), 'utf-8'));
      expect(content.type).toBe('completed');
      expect(content.squad).toBe('cli');
      expect(content.agent).toBe('issue-solver');
      expect(content.exitCode).toBe(0);
    });

    it('creates event file for failed completion', () => {
      signalWorkerComplete({
        eventsDir,
        squad: 'cli',
        agent: 'issue-solver',
        executionId: 'exec-456',
        exitCode: 1,
        summary: 'Task failed'
      });

      const files = readdirSync(join(eventsDir, 'pending'));
      const content = JSON.parse(readFileSync(join(eventsDir, 'pending', files[0]), 'utf-8'));
      expect(content.type).toBe('failed');
      expect(content.exitCode).toBe(1);
    });

    it('includes optional outputPath', () => {
      signalWorkerComplete({
        eventsDir,
        squad: 'cli',
        agent: 'issue-solver',
        executionId: 'exec-789',
        exitCode: 0,
        outputPath: '/tmp/output.log'
      });

      const files = readdirSync(join(eventsDir, 'pending'));
      const content = JSON.parse(readFileSync(join(eventsDir, 'pending', files[0]), 'utf-8'));
      expect(content.outputPath).toBe('/tmp/output.log');
    });
  });

  describe('getPendingEvents', () => {
    beforeEach(() => {
      initEventsDir(testRoot);
    });

    it('returns empty array when no events', () => {
      const events = getPendingEvents(eventsDir);
      expect(events).toEqual([]);
    });

    it('returns pending events', () => {
      // Create test events
      signalWorkerComplete({
        eventsDir,
        squad: 'cli',
        agent: 'agent1',
        executionId: 'exec-1',
        exitCode: 0
      });
      signalWorkerComplete({
        eventsDir,
        squad: 'cli',
        agent: 'agent2',
        executionId: 'exec-2',
        exitCode: 1
      });

      const events = getPendingEvents(eventsDir);
      expect(events).toHaveLength(2);
      expect(events.map(e => e.agent).sort()).toEqual(['agent1', 'agent2']);
    });

    it('handles non-existent directory gracefully', () => {
      const events = getPendingEvents('/nonexistent/path');
      expect(events).toEqual([]);
    });
  });

  describe('markEventProcessed', () => {
    beforeEach(() => {
      initEventsDir(testRoot);
    });

    it('moves event from pending to processed', () => {
      const event: WorkerEvent = {
        type: 'completed',
        squad: 'cli',
        agent: 'test-agent',
        executionId: 'exec-move',
        timestamp: new Date().toISOString(),
        exitCode: 0
      };

      // Create pending event
      signalWorkerComplete({
        eventsDir,
        squad: event.squad,
        agent: event.agent,
        executionId: event.executionId,
        exitCode: event.exitCode!
      });

      // Mark as processed
      markEventProcessed(eventsDir, event);

      // Check it moved
      const pendingFiles = readdirSync(join(eventsDir, 'pending'));
      const processedFiles = readdirSync(join(eventsDir, 'processed'));

      expect(pendingFiles).toHaveLength(0);
      expect(processedFiles).toHaveLength(1);
      expect(processedFiles[0]).toBe('exec-move-test-agent.json');
    });

    it('handles already-processed events gracefully', () => {
      const event: WorkerEvent = {
        type: 'completed',
        squad: 'cli',
        agent: 'ghost',
        executionId: 'exec-ghost',
        timestamp: new Date().toISOString()
      };

      // Should not throw
      markEventProcessed(eventsDir, event);

      const processedFiles = readdirSync(join(eventsDir, 'processed'));
      expect(processedFiles).toHaveLength(0);
    });
  });

  describe('buildWorkerCommand', () => {
    it('generates valid shell command', () => {
      const command = buildWorkerCommand({
        projectRoot: '/home/user/project',
        squad: 'cli',
        agent: 'issue-solver',
        executionId: 'exec-cmd-test',
        prompt: 'Solve issue #123',
        mcpConfigPath: '/home/user/.mcp.json',
        sessionName: 'squads-cli-issue-solver'
      });

      expect(command).toContain('cd \'/home/user/project\'');
      expect(command).toContain('claude --print');
      expect(command).toContain('--permission-mode acceptEdits');
      expect(command).toContain('--mcp-config \'/home/user/.mcp.json\'');
      expect(command).toContain('Solve issue #123');
      expect(command).toContain('EXIT_CODE=$?');
      expect(command).toContain('exec-cmd-test-issue-solver.json');
      expect(command).toContain('tmux kill-session');
    });

    it('escapes single quotes in prompt', () => {
      const command = buildWorkerCommand({
        projectRoot: '/project',
        squad: 'cli',
        agent: 'agent',
        executionId: 'exec',
        prompt: "Fix the user's problem",
        mcpConfigPath: '/mcp.json',
        sessionName: 'session'
      });

      expect(command).toContain("user'\\''s");
    });
  });

  describe('buildLeadPrompt', () => {
    it('generates lead agent prompt', () => {
      const prompt = buildLeadPrompt({
        squad: 'cli',
        lead: 'lead',
        projectRoot: '/project',
        agents: ['worker1', 'worker2', 'worker3']
      });

      expect(prompt).toContain('You are lead, orchestrating the cli squad');
      expect(prompt).toContain('.agents/squads/cli/SQUAD.md');
      expect(prompt).toContain('.agents/squads/cli/lead.md');
      expect(prompt).toContain('worker1, worker2, worker3');
      expect(prompt).toContain('squads run cli/<agent>');
    });

    it('truncates long agent list', () => {
      const agents = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
      const prompt = buildLeadPrompt({
        squad: 'test',
        lead: 'lead',
        projectRoot: '/p',
        agents
      });

      expect(prompt).toContain('a1, a2, a3, a4, a5');
      expect(prompt).toContain('(+3 more)');
    });
  });
});
