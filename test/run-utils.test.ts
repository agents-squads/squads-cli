import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Tests for utility functions used by the run command.
 * These are pure functions that can be tested in isolation.
 */

// Reimplementations of pure functions from run.ts for testing
// (since they're not exported)

/**
 * Generate a unique execution ID for telemetry tracking
 */
function generateExecutionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `exec_${timestamp}_${random}`;
}

/**
 * Parse cooldown duration string to milliseconds
 */
function parseCooldownDuration(cooldown: string): number {
  const match = cooldown.match(/^(\d+)\s*(h|d|m|hours?|days?|minutes?)?$/i);
  if (!match) return 6 * 60 * 60 * 1000; // Default 6 hours

  const value = parseInt(match[1], 10);
  const unit = (match[2] || 'h').toLowerCase();

  if (unit.startsWith('d')) return value * 24 * 60 * 60 * 1000;
  if (unit.startsWith('m')) return value * 60 * 1000;
  return value * 60 * 60 * 1000; // hours
}

/**
 * Format milliseconds as human-readable duration
 */
function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/**
 * Detect task type from agent name patterns
 */
function detectTaskType(agentName: string): 'evaluation' | 'execution' | 'research' | 'lead' {
  const name = agentName.toLowerCase();
  if (name.includes('eval') || name.includes('critic') || name.includes('review') || name.includes('test')) {
    return 'evaluation';
  }
  if (name.includes('lead') || name.includes('orchestrator')) {
    return 'lead';
  }
  if (name.includes('research') || name.includes('analyst') || name.includes('intel')) {
    return 'research';
  }
  return 'execution';
}

/**
 * Extract MCP servers mentioned in an agent definition
 */
function extractMcpServersFromDefinition(definition: string): string[] {
  const servers: Set<string> = new Set();

  const knownServers = [
    'chrome-devtools',
    'firecrawl',
    'supabase',
    'grafana',
    'context7',
    'huggingface',
    'nano-banana'
  ];

  for (const server of knownServers) {
    if (definition.toLowerCase().includes(server)) {
      servers.add(server);
    }
  }

  const mcpMatch = definition.match(/mcp:\s*\n((?:\s*-\s*\S+\s*\n?)+)/i);
  if (mcpMatch) {
    const lines = mcpMatch[1].split('\n');
    for (const line of lines) {
      const serverMatch = line.match(/^\s*-\s*(\S+)/);
      if (serverMatch) {
        servers.add(serverMatch[1]);
      }
    }
  }

  return Array.from(servers);
}

describe('run command utilities', () => {
  describe('generateExecutionId', () => {
    it('generates unique IDs', () => {
      const id1 = generateExecutionId();
      const id2 = generateExecutionId();

      expect(id1).not.toBe(id2);
    });

    it('has correct prefix format', () => {
      const id = generateExecutionId();

      expect(id).toMatch(/^exec_[a-z0-9]+_[a-z0-9]+$/);
    });

    it('produces IDs of reasonable length', () => {
      const id = generateExecutionId();

      expect(id.length).toBeGreaterThan(10);
      expect(id.length).toBeLessThan(30);
    });
  });

  describe('parseCooldownDuration', () => {
    it('parses hours with h suffix', () => {
      expect(parseCooldownDuration('6h')).toBe(6 * 60 * 60 * 1000);
      expect(parseCooldownDuration('24h')).toBe(24 * 60 * 60 * 1000);
    });

    it('parses hours with hours suffix', () => {
      expect(parseCooldownDuration('6 hours')).toBe(6 * 60 * 60 * 1000);
      expect(parseCooldownDuration('1 hour')).toBe(1 * 60 * 60 * 1000);
    });

    it('parses days with d suffix', () => {
      expect(parseCooldownDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
      expect(parseCooldownDuration('1d')).toBe(24 * 60 * 60 * 1000);
    });

    it('parses days with days suffix', () => {
      expect(parseCooldownDuration('7 days')).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('parses minutes with m suffix', () => {
      expect(parseCooldownDuration('30m')).toBe(30 * 60 * 1000);
      expect(parseCooldownDuration('90m')).toBe(90 * 60 * 1000);
    });

    it('parses minutes with minutes suffix', () => {
      expect(parseCooldownDuration('30 minutes')).toBe(30 * 60 * 1000);
    });

    it('defaults to 6 hours for invalid format', () => {
      expect(parseCooldownDuration('invalid')).toBe(6 * 60 * 60 * 1000);
      expect(parseCooldownDuration('')).toBe(6 * 60 * 60 * 1000);
    });

    it('defaults to hours for number-only input', () => {
      expect(parseCooldownDuration('12')).toBe(12 * 60 * 60 * 1000);
    });
  });

  describe('formatDuration', () => {
    it('formats minutes only', () => {
      expect(formatDuration(5 * 60 * 1000)).toBe('5m');
      expect(formatDuration(45 * 60 * 1000)).toBe('45m');
    });

    it('formats hours only', () => {
      expect(formatDuration(2 * 60 * 60 * 1000)).toBe('2h');
      expect(formatDuration(5 * 60 * 60 * 1000)).toBe('5h');
    });

    it('formats hours and minutes', () => {
      expect(formatDuration(2 * 60 * 60 * 1000 + 30 * 60 * 1000)).toBe('2h 30m');
      expect(formatDuration(1 * 60 * 60 * 1000 + 15 * 60 * 1000)).toBe('1h 15m');
    });

    it('formats days only', () => {
      expect(formatDuration(24 * 60 * 60 * 1000)).toBe('1d');
      expect(formatDuration(7 * 24 * 60 * 60 * 1000)).toBe('7d');
    });

    it('formats days and hours', () => {
      expect(formatDuration(25 * 60 * 60 * 1000)).toBe('1d 1h');
      expect(formatDuration(26 * 60 * 60 * 1000)).toBe('1d 2h');
    });
  });

  describe('detectTaskType', () => {
    it('detects evaluation agents', () => {
      expect(detectTaskType('code-eval')).toBe('evaluation');
      expect(detectTaskType('pr-reviewer')).toBe('evaluation');
      expect(detectTaskType('quality-critic')).toBe('evaluation');
      expect(detectTaskType('test-runner')).toBe('evaluation');
    });

    it('detects lead agents', () => {
      expect(detectTaskType('cli-lead')).toBe('lead');
      expect(detectTaskType('squad-orchestrator')).toBe('lead');
    });

    it('detects research agents', () => {
      expect(detectTaskType('market-research')).toBe('research');
      expect(detectTaskType('data-analyst')).toBe('research');
      expect(detectTaskType('intel-gatherer')).toBe('research');
    });

    it('defaults to execution for other agents', () => {
      expect(detectTaskType('issue-solver')).toBe('execution');
      expect(detectTaskType('builder')).toBe('execution');
      expect(detectTaskType('deployer')).toBe('execution');
    });

    it('is case insensitive', () => {
      expect(detectTaskType('CODE-EVAL')).toBe('evaluation');
      expect(detectTaskType('CLI-Lead')).toBe('lead');
    });
  });

  describe('extractMcpServersFromDefinition', () => {
    it('extracts known servers from text', () => {
      const definition = `
# Agent
Use chrome-devtools for browser automation.
Connect to supabase for data.
      `;

      const servers = extractMcpServersFromDefinition(definition);
      expect(servers).toContain('chrome-devtools');
      expect(servers).toContain('supabase');
    });

    it('extracts servers from mcp block', () => {
      const definition = `
# Agent

mcp:
  - firecrawl
  - grafana
  - custom-server

## Instructions
      `;

      const servers = extractMcpServersFromDefinition(definition);
      expect(servers).toContain('firecrawl');
      expect(servers).toContain('grafana');
      expect(servers).toContain('custom-server');
    });

    it('combines text mentions and mcp block', () => {
      const definition = `
Use chrome-devtools for UI testing.

mcp:
  - supabase

## Instructions
      `;

      const servers = extractMcpServersFromDefinition(definition);
      expect(servers).toContain('chrome-devtools');
      expect(servers).toContain('supabase');
    });

    it('returns empty array for no servers', () => {
      const definition = `
# Simple Agent
Just do basic stuff.
      `;

      const servers = extractMcpServersFromDefinition(definition);
      expect(servers).toEqual([]);
    });

    it('deduplicates servers', () => {
      const definition = `
Use supabase for reading.
Also use supabase for writing.
      `;

      const servers = extractMcpServersFromDefinition(definition);
      expect(servers.filter(s => s === 'supabase')).toHaveLength(1);
    });
  });
});
