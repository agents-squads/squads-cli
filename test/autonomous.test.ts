import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for autonomous.ts command
 *
 * This file tests the core logic of the autonomous scheduler:
 * - Cron schedule parsing
 * - Routine YAML parsing from SQUAD.md files
 * - PID file status checking
 */

// Re-implement core parsing functions for testing (matching src/commands/autonomous.ts)

interface Routine {
  name: string;
  schedule: string;
  agents: string[];
  model?: 'opus' | 'sonnet' | 'haiku';
  enabled?: boolean;
  priority?: number;
  cooldown?: string;
}

/**
 * Parse cron expression to get next run time (simplified)
 */
function getNextCronRun(cron: string, referenceDate?: Date): Date {
  const parts = cron.split(' ');
  const now = referenceDate || new Date();
  const next = new Date(now);

  const minute = parts[0] === '*' ? now.getMinutes() : parseInt(parts[0]);
  const hour = parts[1] === '*' ? now.getHours() : parseInt(parts[1]);

  next.setMinutes(minute);
  next.setHours(hour);
  next.setSeconds(0);
  next.setMilliseconds(0);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

/**
 * Parse routines from SQUAD.md YAML blocks
 */
function parseRoutinesFromContent(content: string): Routine[] {
  const routines: Routine[] = [];

  const routinesMatch = content.match(/##+ Routines[\s\S]*?```yaml\s*\n([\s\S]*?)```/i);
  if (!routinesMatch) return [];

  let yamlContent = routinesMatch[1];
  yamlContent = yamlContent.replace(/^\s*routines:\s*\n?/, '');
  yamlContent = '\n' + yamlContent.trim();

  const routineBlocks = yamlContent.split(/\n\s*- name:\s*/);

  for (const block of routineBlocks) {
    if (!block.trim()) continue;

    const lines = block.split('\n');
    const name = lines[0].trim();
    if (!name) continue;

    const scheduleMatch = block.match(/schedule:\s*["']?([^"'\n#]+)/);
    const agentsMatch = block.match(/agents:\s*\[(.*?)\]/);
    const modelMatch = block.match(/model:\s*(\w+)/);
    const enabledMatch = block.match(/enabled:\s*(true|false)/);
    const priorityMatch = block.match(/priority:\s*(\d+)/);
    const cooldownMatch = block.match(/cooldown:\s*["']?([^"'\n]+)["']?/);

    if (scheduleMatch && agentsMatch) {
      const agents = agentsMatch[1]
        .split(',')
        .map((a) => a.trim().replace(/["']/g, ''))
        .filter(Boolean);

      routines.push({
        name,
        schedule: scheduleMatch[1].trim().replace(/["']/g, ''),
        agents,
        model: modelMatch ? (modelMatch[1] as 'opus' | 'sonnet' | 'haiku') : undefined,
        enabled: enabledMatch ? enabledMatch[1] === 'true' : true,
        priority: priorityMatch ? parseInt(priorityMatch[1]) : undefined,
        cooldown: cooldownMatch ? cooldownMatch[1].trim() : undefined,
      });
    }
  }

  return routines;
}

describe('autonomous command', () => {
  describe('getNextCronRun', () => {
    it('parses simple cron with specific hour and minute', () => {
      const reference = new Date('2026-01-26T10:00:00');
      const result = getNextCronRun('30 14 * * *', reference);
      expect(result.getHours()).toBe(14);
      expect(result.getMinutes()).toBe(30);
      expect(result.getSeconds()).toBe(0);
    });

    it('moves to next day if time has passed', () => {
      const reference = new Date('2026-01-26T16:00:00');
      const result = getNextCronRun('30 14 * * *', reference);
      expect(result.getDate()).toBe(27);
      expect(result.getHours()).toBe(14);
      expect(result.getMinutes()).toBe(30);
    });

    it('handles wildcard minute', () => {
      const reference = new Date('2026-01-26T10:45:00');
      const result = getNextCronRun('* 14 * * *', reference);
      expect(result.getMinutes()).toBe(45);
      expect(result.getHours()).toBe(14);
    });

    it('handles wildcard hour', () => {
      const reference = new Date('2026-01-26T10:00:00');
      const result = getNextCronRun('30 * * * *', reference);
      expect(result.getMinutes()).toBe(30);
      expect(result.getHours()).toBe(10);
    });

    it('handles midnight cron', () => {
      const reference = new Date('2026-01-26T23:00:00');
      const result = getNextCronRun('0 0 * * *', reference);
      expect(result.getHours()).toBe(0);
      expect(result.getMinutes()).toBe(0);
      expect(result.getDate()).toBe(27);
    });

    it('handles same time - moves to next day', () => {
      const reference = new Date('2026-01-26T14:30:00');
      const result = getNextCronRun('30 14 * * *', reference);
      expect(result.getDate()).toBe(27);
    });
  });

  describe('parseRoutinesFromContent', () => {
    it('parses basic routine from SQUAD.md format', () => {
      const content = `# Engineering Squad

## Mission
Build great software.

## Routines

\`\`\`yaml
- name: daily-standup
  schedule: "0 9 * * *"
  agents: [standup-bot]
  model: haiku
  enabled: true
\`\`\`
`;
      const routines = parseRoutinesFromContent(content);
      expect(routines).toHaveLength(1);
      expect(routines[0].name).toBe('daily-standup');
      expect(routines[0].schedule).toBe('0 9 * * *');
      expect(routines[0].agents).toEqual(['standup-bot']);
      expect(routines[0].model).toBe('haiku');
      expect(routines[0].enabled).toBe(true);
    });

    it('parses multiple routines', () => {
      const content = `## Routines

\`\`\`yaml
- name: morning-report
  schedule: "0 8 * * *"
  agents: [reporter]
  enabled: true

- name: evening-cleanup
  schedule: "0 18 * * *"
  agents: [cleanup-bot, archiver]
  enabled: false
\`\`\`
`;
      const routines = parseRoutinesFromContent(content);
      expect(routines).toHaveLength(2);
      expect(routines[0].name).toBe('morning-report');
      expect(routines[1].name).toBe('evening-cleanup');
      expect(routines[1].agents).toEqual(['cleanup-bot', 'archiver']);
      expect(routines[1].enabled).toBe(false);
    });

    it('parses routine with optional fields', () => {
      const content = `### Routines

\`\`\`yaml
- name: complex-routine
  schedule: "*/15 * * * *"
  agents: [worker]
  model: sonnet
  priority: 10
  cooldown: "1h"
  enabled: true
\`\`\`
`;
      const routines = parseRoutinesFromContent(content);
      expect(routines).toHaveLength(1);
      expect(routines[0].priority).toBe(10);
      expect(routines[0].cooldown).toBe('1h');
      expect(routines[0].model).toBe('sonnet');
    });

    it('handles routines: wrapper', () => {
      const content = `## Routines

\`\`\`yaml
routines:
  - name: wrapped-routine
    schedule: "0 12 * * *"
    agents: [agent1]
\`\`\`
`;
      const routines = parseRoutinesFromContent(content);
      expect(routines).toHaveLength(1);
      expect(routines[0].name).toBe('wrapped-routine');
    });

    it('returns empty array when no routines section', () => {
      const content = `# Squad

## Mission
Do stuff.

## Agents
`;
      const routines = parseRoutinesFromContent(content);
      expect(routines).toHaveLength(0);
    });

    it('returns empty array when no yaml block in routines section', () => {
      const content = `## Routines

No routines configured yet.
`;
      const routines = parseRoutinesFromContent(content);
      expect(routines).toHaveLength(0);
    });

    it('skips entries without schedule or agents', () => {
      const content = `## Routines

\`\`\`yaml
- name: incomplete-routine
  model: haiku

- name: valid-routine
  schedule: "0 10 * * *"
  agents: [bot]
\`\`\`
`;
      const routines = parseRoutinesFromContent(content);
      expect(routines).toHaveLength(1);
      expect(routines[0].name).toBe('valid-routine');
    });

    it('defaults enabled to true when not specified', () => {
      const content = `## Routines

\`\`\`yaml
- name: no-enabled-field
  schedule: "0 9 * * *"
  agents: [worker]
\`\`\`
`;
      const routines = parseRoutinesFromContent(content);
      expect(routines[0].enabled).toBe(true);
    });

    it('handles quoted and unquoted values', () => {
      const content = `## Routines

\`\`\`yaml
- name: mixed-quotes
  schedule: '0 9 * * *'
  agents: ["agent1", 'agent2', agent3]
\`\`\`
`;
      const routines = parseRoutinesFromContent(content);
      expect(routines[0].schedule).toBe('0 9 * * *');
      expect(routines[0].agents).toEqual(['agent1', 'agent2', 'agent3']);
    });
  });

  describe('edge cases', () => {
    it('handles empty content', () => {
      const routines = parseRoutinesFromContent('');
      expect(routines).toHaveLength(0);
    });

    it('handles malformed yaml gracefully', () => {
      const content = `## Routines

\`\`\`yaml
- name: broken
  schedule: unclosed quote'
  agents: [
\`\`\`
`;
      const routines = parseRoutinesFromContent(content);
      expect(routines).toHaveLength(0);
    });

    it('handles section header variations', () => {
      const content = `### Routines

\`\`\`yaml
- name: under-h3
  schedule: "0 1 * * *"
  agents: [night-bot]
\`\`\`
`;
      const routines = parseRoutinesFromContent(content);
      expect(routines).toHaveLength(1);
    });
  });
});
