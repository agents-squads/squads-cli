import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';

export interface Agent {
  name: string;
  role: string;
  trigger: string;
  status?: string;
  filePath?: string;
}

export interface Pipeline {
  name: string;
  agents: string[];
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
    outputPath: ''
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

        if (agentIdx >= 0 && cells[agentIdx]) {
          squad.agents.push({
            name: cells[agentIdx],
            role: roleIdx >= 0 ? cells[roleIdx] : '',
            trigger: triggerIdx >= 0 ? cells[triggerIdx] : 'manual',
            status: statusIdx >= 0 ? cells[statusIdx] : 'active'
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
