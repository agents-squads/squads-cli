import { readFileSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { join, basename } from 'path';

export type EffortLevel = 'high' | 'medium' | 'low';

export interface Agent {
  name: string;
  role: string;
  trigger: string;
  status?: string;
  filePath?: string;
  squad?: string;
  effort?: EffortLevel;
}

export interface Pipeline {
  name: string;
  agents: string[];
}

export interface Goal {
  description: string;
  completed: boolean;
  progress?: string;
  metrics?: string[];
}

export interface Squad {
  name: string;
  mission: string;
  agents: Agent[];
  pipelines: Pipeline[];
  triggers: {
    scheduled: string[];
    event: string[];
    manual: string[];
  };
  dependencies: string[];
  outputPath: string;
  goals: Goal[];
  effort?: EffortLevel;  // Squad-level default effort
}

export function findSquadsDir(): string | null {
  // Look for .agents/squads in current directory or parent directories
  let dir = process.cwd();

  for (let i = 0; i < 5; i++) {
    const squadsPath = join(dir, '.agents', 'squads');
    if (existsSync(squadsPath)) {
      return squadsPath;
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export function findProjectRoot(): string | null {
  // Find the root of the squads project (where .agents/ lives)
  const squadsDir = findSquadsDir();
  if (!squadsDir) return null;
  // squadsDir is /path/to/.agents/squads, so go up 2 levels
  return join(squadsDir, '..', '..');
}

export function hasLocalInfraConfig(): boolean {
  // Check if the project has a local .env file with infra config
  const projectRoot = findProjectRoot();
  if (!projectRoot) return false;

  const envPath = join(projectRoot, '.env');
  if (!existsSync(envPath)) return false;

  // Check if .env has any infra-related keys
  const content = readFileSync(envPath, 'utf-8');
  const infraKeys = ['LANGFUSE_', 'SQUADS_BRIDGE', 'SQUADS_POSTGRES', 'SQUADS_REDIS'];
  return infraKeys.some(key => content.includes(key));
}

export function listSquads(squadsDir: string): string[] {
  const squads: string[] = [];

  const entries = readdirSync(squadsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('_')) {
      const squadFile = join(squadsDir, entry.name, 'SQUAD.md');
      if (existsSync(squadFile)) {
        squads.push(entry.name);
      }
    }
  }

  return squads;
}

export function listAgents(squadsDir: string, squadName?: string): Agent[] {
  const agents: Agent[] = [];

  const dirs = squadName
    ? [squadName]
    : readdirSync(squadsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('_'))
        .map(e => e.name);

  for (const dir of dirs) {
    const squadPath = join(squadsDir, dir);
    if (!existsSync(squadPath)) continue;

    const files = readdirSync(squadPath);
    for (const file of files) {
      if (file.endsWith('.md') && file !== 'SQUAD.md') {
        const agentName = file.replace('.md', '');
        agents.push({
          name: agentName,
          role: `Agent in ${dir}`,
          trigger: 'manual',
          filePath: join(squadPath, file)
        });
      }
    }
  }

  return agents;
}

export function parseSquadFile(filePath: string): Squad {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const squad: Squad = {
    name: basename(filePath).replace('.md', ''),
    mission: '',
    agents: [],
    pipelines: [],
    triggers: { scheduled: [], event: [], manual: [] },
    dependencies: [],
    outputPath: '',
    goals: []
  };

  let currentSection = '';
  let inTable = false;
  let tableHeaders: string[] = [];

  for (const line of lines) {
    // Extract squad name from title
    if (line.startsWith('# Squad:')) {
      squad.name = line.replace('# Squad:', '').trim().toLowerCase();
      continue;
    }

    // Track sections
    if (line.startsWith('## ')) {
      currentSection = line.replace('## ', '').trim().toLowerCase();
      inTable = false;
      continue;
    }

    // Extract mission
    if (currentSection === 'mission' && line.trim() && !line.startsWith('#')) {
      if (!squad.mission) {
        squad.mission = line.trim();
      }
    }

    // Extract squad-level effort (e.g., "effort: medium" in Context section)
    const effortMatch = line.match(/^effort:\s*(high|medium|low)/i);
    if (effortMatch && !squad.effort) {
      squad.effort = effortMatch[1].toLowerCase() as EffortLevel;
    }

    // Parse agent tables
    if (currentSection.includes('agent') || currentSection.includes('orchestrator') ||
        currentSection.includes('evaluator') || currentSection.includes('builder') ||
        currentSection.includes('priority')) {

      if (line.includes('|') && line.includes('Agent')) {
        inTable = true;
        tableHeaders = line.split('|').map(h => h.trim().toLowerCase());
        continue;
      }

      if (inTable && line.includes('|') && !line.includes('---')) {
        const cells = line.split('|').map(c => c.trim().replace(/`/g, ''));
        const agentIdx = tableHeaders.findIndex(h => h === 'agent');
        const roleIdx = tableHeaders.findIndex(h => h === 'role');
        const triggerIdx = tableHeaders.findIndex(h => h === 'trigger');
        const statusIdx = tableHeaders.findIndex(h => h === 'status');
        const effortIdx = tableHeaders.findIndex(h => h === 'effort');

        if (agentIdx >= 0 && cells[agentIdx]) {
          const effortValue = effortIdx >= 0 ? cells[effortIdx]?.toLowerCase() : undefined;
          const effort = ['high', 'medium', 'low'].includes(effortValue || '')
            ? effortValue as EffortLevel
            : undefined;

          squad.agents.push({
            name: cells[agentIdx],
            role: roleIdx >= 0 ? cells[roleIdx] : '',
            trigger: triggerIdx >= 0 ? cells[triggerIdx] : 'manual',
            status: statusIdx >= 0 ? cells[statusIdx] : 'active',
            effort
          });
        }
      }
    }

    // Parse pipelines (looking for patterns like: agent1 → agent2 → agent3)
    if (line.includes('→') && line.includes('`')) {
      const pipelineMatch = line.match(/`([^`]+)`\s*→\s*`([^`]+)`/g);
      if (pipelineMatch) {
        const agentNames = line.match(/`([^`]+)`/g)?.map(m => m.replace(/`/g, '')) || [];
        if (agentNames.length >= 2) {
          squad.pipelines.push({
            name: 'default',
            agents: agentNames
          });
        }
      }
    }

    // Also look for Pipeline: format
    if (line.toLowerCase().includes('pipeline:')) {
      const pipelineContent = line.split(':')[1];
      if (pipelineContent && pipelineContent.includes('→')) {
        const agentNames = pipelineContent.match(/`([^`]+)`/g)?.map(m => m.replace(/`/g, '')) || [];
        if (agentNames.length >= 2) {
          squad.pipelines.push({
            name: 'default',
            agents: agentNames
          });
        }
      }
    }

    // Extract output path
    if (line.toLowerCase().includes('primary') && line.includes('`')) {
      const match = line.match(/`([^`]+)`/);
      if (match) {
        squad.outputPath = match[1].replace(/\/$/, '');
      }
    }

    // Parse goals (checkbox format: - [ ] or - [x])
    if (currentSection === 'goals') {
      const goalMatch = line.match(/^-\s*\[([ x])\]\s*(.+)$/);
      if (goalMatch) {
        const completed = goalMatch[1] === 'x';
        let description = goalMatch[2].trim();
        let progress: string | undefined;

        // Check for progress annotation
        const progressMatch = description.match(/\(progress:\s*([^)]+)\)/i);
        if (progressMatch) {
          progress = progressMatch[1];
          description = description.replace(progressMatch[0], '').trim();
        }

        squad.goals.push({
          description,
          completed,
          progress
        });
      }
    }
  }

  return squad;
}

export function loadSquad(squadName: string): Squad | null {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return null;

  const squadFile = join(squadsDir, squadName, 'SQUAD.md');
  if (!existsSync(squadFile)) return null;

  return parseSquadFile(squadFile);
}

export function loadAgentDefinition(agentPath: string): string {
  if (!existsSync(agentPath)) return '';
  return readFileSync(agentPath, 'utf-8');
}

export function addGoalToSquad(squadName: string, goal: string): boolean {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return false;

  const squadFile = join(squadsDir, squadName, 'SQUAD.md');
  if (!existsSync(squadFile)) return false;

  let content = readFileSync(squadFile, 'utf-8');

  // Check if Goals section exists
  if (!content.includes('## Goals')) {
    // Add Goals section before Dependencies or at end
    const insertPoint = content.indexOf('## Dependencies');
    if (insertPoint > 0) {
      content = content.slice(0, insertPoint) + `## Goals\n\n- [ ] ${goal}\n\n` + content.slice(insertPoint);
    } else {
      content += `\n## Goals\n\n- [ ] ${goal}\n`;
    }
  } else {
    // Add to existing Goals section
    const goalsIdx = content.indexOf('## Goals');
    const nextSectionIdx = content.indexOf('\n## ', goalsIdx + 1);
    const endIdx = nextSectionIdx > 0 ? nextSectionIdx : content.length;

    // Find last goal line or section header
    const goalsSection = content.slice(goalsIdx, endIdx);
    const lastGoalMatch = goalsSection.match(/^-\s*\[[ x]\].+$/gm);

    if (lastGoalMatch) {
      // Add after last goal
      const lastGoal = lastGoalMatch[lastGoalMatch.length - 1];
      const lastGoalIdx = content.lastIndexOf(lastGoal, endIdx);
      const insertPos = lastGoalIdx + lastGoal.length;
      content = content.slice(0, insertPos) + `\n- [ ] ${goal}` + content.slice(insertPos);
    } else {
      // No goals yet, add after section header
      const headerEnd = goalsIdx + '## Goals'.length;
      content = content.slice(0, headerEnd) + `\n\n- [ ] ${goal}` + content.slice(headerEnd);
    }
  }

  writeFileSync(squadFile, content);
  return true;
}

export function updateGoalInSquad(
  squadName: string,
  goalIndex: number,
  updates: { completed?: boolean; progress?: string }
): boolean {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return false;

  const squadFile = join(squadsDir, squadName, 'SQUAD.md');
  if (!existsSync(squadFile)) return false;

  const content = readFileSync(squadFile, 'utf-8');
  const lines = content.split('\n');

  let currentSection = '';
  let goalCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('## ')) {
      currentSection = line.replace('## ', '').trim().toLowerCase();
      continue;
    }

    if (currentSection === 'goals') {
      const goalMatch = line.match(/^-\s*\[([ x])\]\s*(.+)$/);
      if (goalMatch) {
        if (goalCount === goalIndex) {
          let newLine = '- [' + (updates.completed ? 'x' : ' ') + '] ' + goalMatch[2];

          // Handle progress update
          if (updates.progress !== undefined) {
            // Remove existing progress annotation
            newLine = newLine.replace(/\s*\(progress:\s*[^)]+\)/i, '');
            if (updates.progress) {
              newLine += ` (progress: ${updates.progress})`;
            }
          }

          lines[i] = newLine;
          writeFileSync(squadFile, lines.join('\n'));
          return true;
        }
        goalCount++;
      }
    }
  }

  return false;
}
