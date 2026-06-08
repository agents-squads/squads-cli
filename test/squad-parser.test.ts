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

// Tests for addGoalToSquad and updateGoalInSquad using temporary directories
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { vi, beforeEach, afterEach } from 'vitest';
import { addGoalToSquad, updateGoalInSquad, parseSquadFile } from '../src/lib/squad-parser.js';

describe('squad-parser file modifications', () => {
  const testDir = join(tmpdir(), 'squad-parser-test-' + Date.now());
  const squadsDir = join(testDir, '.agents', 'squads');
  const testSquadDir = join(squadsDir, 'test-squad');
  const squadFile = join(testSquadDir, 'SQUAD.md');

  const originalCwd = process.cwd;

  beforeEach(() => {
    // Create test directory structure
    mkdirSync(testSquadDir, { recursive: true });

    // Mock process.cwd to return our test directory
    vi.spyOn(process, 'cwd').mockReturnValue(testDir);
  });

  afterEach(() => {
    // Restore process.cwd
    vi.restoreAllMocks();

    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('addGoalToSquad', () => {
    it('creates Goals section if missing', () => {
      const content = `# Test Squad

## Mission

Build great things.

## Dependencies

- squad-a
`;
      writeFileSync(squadFile, content);

      const result = addGoalToSquad('test-squad', 'New goal to add');
      expect(result).toBe(true);

      const updated = readFileSync(squadFile, 'utf-8');
      expect(updated).toContain('## Goals');
      expect(updated).toContain('- [ ] New goal to add');
      // Goals section should be before Dependencies
      const goalsIdx = updated.indexOf('## Goals');
      const depsIdx = updated.indexOf('## Dependencies');
      expect(goalsIdx).toBeLessThan(depsIdx);
    });

    it('inserts goal at end of file when no Dependencies section', () => {
      const content = `# Test Squad

## Mission

Build great things.
`;
      writeFileSync(squadFile, content);

      const result = addGoalToSquad('test-squad', 'New goal at end');
      expect(result).toBe(true);

      const updated = readFileSync(squadFile, 'utf-8');
      expect(updated).toContain('## Goals');
      expect(updated).toContain('- [ ] New goal at end');
    });

    it('appends after last goal in existing Goals section', () => {
      const content = `# Test Squad

## Goals

- [ ] First goal
- [x] Completed goal

## Dependencies

- squad-a
`;
      writeFileSync(squadFile, content);

      const result = addGoalToSquad('test-squad', 'Third goal');
      expect(result).toBe(true);

      const updated = readFileSync(squadFile, 'utf-8');
      const lines = updated.split('\n');
      const goalLines = lines.filter(l => l.match(/^-\s*\[[ x]\]/));
      expect(goalLines).toHaveLength(3);
      expect(goalLines[2]).toContain('Third goal');
    });

    it('adds goal when Goals section exists but is empty', () => {
      const content = `# Test Squad

## Goals

## Dependencies

- squad-a
`;
      writeFileSync(squadFile, content);

      const result = addGoalToSquad('test-squad', 'First goal in empty section');
      expect(result).toBe(true);

      const updated = readFileSync(squadFile, 'utf-8');
      expect(updated).toContain('- [ ] First goal in empty section');
    });

    it('returns false for non-existent squad', () => {
      const result = addGoalToSquad('nonexistent-squad', 'Some goal');
      expect(result).toBe(false);
    });

    it('handles special characters in goal description', () => {
      const content = `# Test Squad

## Goals

- [ ] Existing goal
`;
      writeFileSync(squadFile, content);

      const result = addGoalToSquad('test-squad', 'Fix <bug> & improve "perf"');
      expect(result).toBe(true);

      const updated = readFileSync(squadFile, 'utf-8');
      expect(updated).toContain('Fix <bug> & improve "perf"');
    });
  });

  describe('updateGoalInSquad', () => {
    it('marks goal as completed', () => {
      const content = `# Test Squad

## Goals

- [ ] First goal
- [ ] Second goal

## Agents
`;
      writeFileSync(squadFile, content);

      const result = updateGoalInSquad('test-squad', 0, { completed: true });
      expect(result).toBe(true);

      const updated = readFileSync(squadFile, 'utf-8');
      expect(updated).toContain('- [x] First goal');
      expect(updated).toContain('- [ ] Second goal');
    });

    it('marks completed goal as incomplete', () => {
      const content = `# Test Squad

## Goals

- [x] Completed goal
- [ ] Pending goal
`;
      writeFileSync(squadFile, content);

      const result = updateGoalInSquad('test-squad', 0, { completed: false });
      expect(result).toBe(true);

      const updated = readFileSync(squadFile, 'utf-8');
      expect(updated).toContain('- [ ] Completed goal');
    });

    it('adds progress annotation', () => {
      const content = `# Test Squad

## Goals

- [ ] Goal without progress
`;
      writeFileSync(squadFile, content);

      const result = updateGoalInSquad('test-squad', 0, { completed: false, progress: '50%' });
      expect(result).toBe(true);

      const updated = readFileSync(squadFile, 'utf-8');
      expect(updated).toContain('- [ ] Goal without progress (progress: 50%)');
    });

    it('updates existing progress annotation', () => {
      const content = `# Test Squad

## Goals

- [ ] Goal with progress (progress: 25%)
`;
      writeFileSync(squadFile, content);

      const result = updateGoalInSquad('test-squad', 0, { completed: false, progress: '75%' });
      expect(result).toBe(true);

      const updated = readFileSync(squadFile, 'utf-8');
      expect(updated).toContain('(progress: 75%)');
      expect(updated).not.toContain('(progress: 25%)');
    });

    it('removes progress annotation when empty', () => {
      const content = `# Test Squad

## Goals

- [ ] Goal with progress (progress: 50%)
`;
      writeFileSync(squadFile, content);

      const result = updateGoalInSquad('test-squad', 0, { completed: false, progress: '' });
      expect(result).toBe(true);

      const updated = readFileSync(squadFile, 'utf-8');
      expect(updated).not.toContain('progress:');
    });

    it('updates goal by index (second goal)', () => {
      const content = `# Test Squad

## Goals

- [ ] First goal
- [ ] Second goal
- [ ] Third goal
`;
      writeFileSync(squadFile, content);

      const result = updateGoalInSquad('test-squad', 1, { completed: true });
      expect(result).toBe(true);

      const updated = readFileSync(squadFile, 'utf-8');
      expect(updated).toContain('- [ ] First goal');
      expect(updated).toContain('- [x] Second goal');
      expect(updated).toContain('- [ ] Third goal');
    });

    it('returns false for out-of-bounds index', () => {
      const content = `# Test Squad

## Goals

- [ ] Only goal
`;
      writeFileSync(squadFile, content);

      const result = updateGoalInSquad('test-squad', 5, { completed: true });
      expect(result).toBe(false);
    });

    it('returns false for non-existent squad', () => {
      const result = updateGoalInSquad('nonexistent-squad', 0, { completed: true });
      expect(result).toBe(false);
    });

    it('handles both completed and progress updates together', () => {
      const content = `# Test Squad

## Goals

- [ ] Goal to complete
`;
      writeFileSync(squadFile, content);

      const result = updateGoalInSquad('test-squad', 0, { completed: true, progress: '100%' });
      expect(result).toBe(true);

      const updated = readFileSync(squadFile, 'utf-8');
      expect(updated).toContain('- [x] Goal to complete (progress: 100%)');
    });
  });

  describe('parseSquadFile integration with modifications', () => {
    it('parses goals after addGoalToSquad', () => {
      const content = `# Test Squad

## Mission

Build things.

## Goals

- [ ] Existing goal
`;
      writeFileSync(squadFile, content);

      addGoalToSquad('test-squad', 'New goal');

      const squad = parseSquadFile(squadFile);
      expect(squad.goals).toHaveLength(2);
      expect(squad.goals[0].description).toBe('Existing goal');
      expect(squad.goals[1].description).toBe('New goal');
    });

    it('parses updated goals correctly', () => {
      const content = `# Test Squad

## Mission

Build things.

## Goals

- [ ] First goal
- [ ] Second goal
`;
      writeFileSync(squadFile, content);

      updateGoalInSquad('test-squad', 0, { completed: true, progress: '100%' });

      const squad = parseSquadFile(squadFile);
      expect(squad.goals[0].completed).toBe(true);
      expect(squad.goals[0].progress).toBe('100%');
      expect(squad.goals[1].completed).toBe(false);
    });

    // #449: non-English rosters. Mirrors the real client-graffo SQUAD.md
    // (header "| Agente | Rol | Frecuencia |", role values in Spanish).
    it('parses a Spanish "## Agentes" roster (Agente / Rol / Frecuencia)', () => {
      const content = `# Squad: client-graffo

## Agentes

| Agente | Rol | Frecuencia |
|--------|-----|-----------|
| \`client-graffo-lead\` | Orquestador — coordina el squad | Semanal (lunes 8am CLT) |
| \`finanzas-agent\` | P&L, F29, márgenes, flujo de caja | Semanal (lunes 8am CLT) |
| \`operaciones-agent\` | Inventario, proveedores, despachos | Diario (9am CLT) |
`;
      writeFileSync(squadFile, content);

      const squad = parseSquadFile(squadFile);
      expect(squad.agents).toHaveLength(3);
      const lead = squad.agents.find(a => a.name === 'client-graffo-lead');
      expect(lead).toBeDefined();
      expect(lead!.role).toBe('Orquestador — coordina el squad');
      expect(lead!.trigger).toBe('Semanal (lunes 8am CLT)');
    });
  });
});
