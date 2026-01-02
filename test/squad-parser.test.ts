import { describe, it, expect } from 'vitest';

// Test the parsing logic extracted from squad-parser.ts

interface Agent {
  name: string;
  role: string;
  trigger: string;
}

interface Goal {
  description: string;
  completed: boolean;
  progress?: string;
}

// Parse agents table from SQUAD.md content
function parseAgentsTable(content: string): Agent[] {
  const agents: Agent[] = [];
  const lines = content.split('\n');

  let inAgentsSection = false;
  let headerFound = false;

  for (const line of lines) {
    if (line.startsWith('## Agents')) {
      inAgentsSection = true;
      continue;
    }

    if (inAgentsSection && line.startsWith('## ')) {
      break;
    }

    if (inAgentsSection && line.includes('|')) {
      // Skip header and divider rows
      if (line.includes('Agent') || line.match(/^\s*\|\s*-+/)) {
        headerFound = true;
        continue;
      }

      if (headerFound) {
        const cells = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length >= 3) {
          agents.push({
            name: cells[0],
            role: cells[1],
            trigger: cells[2],
          });
        }
      }
    }
  }

  return agents;
}

// Parse goals table from SQUAD.md content
function parseGoalsTable(content: string): Goal[] {
  const goals: Goal[] = [];
  const lines = content.split('\n');

  let inGoalsSection = false;
  let headerFound = false;

  for (const line of lines) {
    if (line.startsWith('## Goals')) {
      inGoalsSection = true;
      continue;
    }

    if (inGoalsSection && line.startsWith('## ')) {
      break;
    }

    if (inGoalsSection && line.includes('|')) {
      // Skip header and divider rows
      if (line.includes('Priority') || line.includes('Goal') || line.match(/^\s*\|\s*-+/)) {
        headerFound = true;
        continue;
      }

      if (headerFound) {
        const cells = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length >= 2) {
          const progressMatch = cells[cells.length - 1].match(/(\d+)%/);
          goals.push({
            description: cells[1] || cells[0],
            completed: cells[cells.length - 1].includes('100%') || cells[cells.length - 1].toLowerCase().includes('done'),
            progress: progressMatch ? progressMatch[1] + '%' : undefined,
          });
        }
      }
    }
  }

  return goals;
}

describe('squad-parser utilities', () => {
  describe('parseAgentsTable', () => {
    it('parses agents from SQUAD.md format', () => {
      const content = `# Engineering Squad

## Mission
Build great software.

## Agents

| Agent | Purpose | Trigger |
|-------|---------|---------|
| ci-optimizer | Optimize CI/CD | Manual |
| code-reviewer | Review PRs | On PR |
| tech-debt-tracker | Track debt | Weekly |

## Pipelines
`;
      const agents = parseAgentsTable(content);
      expect(agents).toHaveLength(3);
      expect(agents[0].name).toBe('ci-optimizer');
      expect(agents[0].role).toBe('Optimize CI/CD');
      expect(agents[0].trigger).toBe('Manual');
    });

    it('handles empty agents section', () => {
      const content = `# Squad

## Agents

## Goals
`;
      const agents = parseAgentsTable(content);
      expect(agents).toHaveLength(0);
    });

    it('handles missing agents section', () => {
      const content = `# Squad

## Mission
Do stuff.
`;
      const agents = parseAgentsTable(content);
      expect(agents).toHaveLength(0);
    });
  });

  describe('parseGoalsTable', () => {
    it('parses goals from SQUAD.md format', () => {
      const content = `# Squad

## Goals

| Priority | Goal | Progress |
|----------|------|----------|
| P1 | Reduce build time to <3min | 60% |
| P2 | 90% test coverage | 45% |

## Agents
`;
      const goals = parseGoalsTable(content);
      expect(goals).toHaveLength(2);
      expect(goals[0].description).toBe('Reduce build time to <3min');
      expect(goals[0].progress).toBe('60%');
      expect(goals[0].completed).toBe(false);
    });

    it('marks 100% goals as completed', () => {
      const content = `## Goals

| Priority | Goal | Progress |
|----------|------|----------|
| P1 | Deploy v1 | 100% |
`;
      const goals = parseGoalsTable(content);
      expect(goals[0].completed).toBe(true);
    });

    it('handles empty goals section', () => {
      const content = `## Goals

## Agents
`;
      const goals = parseGoalsTable(content);
      expect(goals).toHaveLength(0);
    });
  });
});

describe('markdown table parsing edge cases', () => {
  it('handles extra whitespace in cells', () => {
    const content = `## Agents

| Agent    |   Purpose    | Trigger    |
|----------|--------------|------------|
|  agent1  |  Do things   |  Manual    |
`;
    const agents = parseAgentsTable(content);
    expect(agents[0].name).toBe('agent1');
    expect(agents[0].role).toBe('Do things');
  });

  it('handles special characters in descriptions', () => {
    const content = `## Goals

| Priority | Goal | Progress |
|----------|------|----------|
| P1 | Fix <bug> & "issue" | 50% |
`;
    const goals = parseGoalsTable(content);
    expect(goals[0].description).toBe('Fix <bug> & "issue"');
  });
});
