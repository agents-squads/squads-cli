import { readFileSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import matter from 'gray-matter';
import { resolveMcpConfig, type McpResolution } from './mcp-config.js';

export type EffortLevel = 'high' | 'medium' | 'low';

// Context schema for frontmatter
export interface SquadContext {
  mcp?: string[];
  skills?: string[];
  memory?: {
    load?: string[];
  };
  model?: {
    default?: string;
    expensive?: string;
    cheap?: string;
  };
  budget?: {
    daily?: number;
    weekly?: number;
    perExecution?: number;
  };
  /** Cooldown between executions in seconds */
  cooldown?: number;
}

// Multi-LLM provider configuration
export interface SquadProviders {
  /** Default provider for all agents (default: anthropic) */
  default?: string;
  /** Provider for vision/image tasks */
  vision?: string;
  /** Provider for real-time data access */
  realtime?: string;
  /** Provider for high-volume/cheap operations */
  cheap?: string;
  /** Custom provider mappings by purpose */
  [key: string]: string | undefined;
}

// Frontmatter schema
export interface SquadFrontmatter {
  name?: string;
  mission?: string;
  repo?: string;
  stack?: string;
  context?: SquadContext;
  effort?: EffortLevel;
  /** Multi-LLM provider configuration */
  providers?: SquadProviders;
}

export interface Agent {
  name: string;
  role: string;
  trigger: string;
  status?: string;
  filePath?: string;
  squad?: string;
  effort?: EffortLevel;
  /** LLM provider override (from agent file frontmatter) */
  provider?: string;
  /** Agent purpose (short description) */
  purpose?: string;
  /** Cron schedule for scheduled agents */
  schedule?: string;
  /** Output destinations */
  outputs?: string[];
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

/**
 * Routine definition for autonomous scheduled execution.
 * Defined in SQUAD.md under ### Routines yaml block.
 */
export interface Routine {
  /** Unique name for the routine */
  name: string;
  /** Cron schedule (e.g., "0 8 * * *" for daily 8am) */
  schedule: string;
  /** Agents to run in this batch */
  agents: string[];
  /** Model to use (defaults to squad default or sonnet) */
  model?: 'opus' | 'sonnet' | 'haiku';
  /** Whether the routine is enabled */
  enabled?: boolean;
  /** Priority for execution ordering (lower = higher priority) */
  priority?: number;
  /** Minimum cooldown between runs (e.g., "6 hours") */
  cooldown?: string;
}

export interface Squad {
  name: string;
  /** Directory name for file path resolution (e.g., "engineering") */
  dir: string;
  mission: string;
  agents: Agent[];
  pipelines: Pipeline[];
  triggers: {
    scheduled: string[];
    event: string[];
    manual: string[];
  };
  /** Autonomous routines for scheduled batch execution */
  routines: Routine[];
  dependencies: string[];
  outputPath: string;
  goals: Goal[];
  effort?: EffortLevel;  // Squad-level default effort
  context?: SquadContext;  // Frontmatter context block
  repo?: string;
  stack?: string;
  /** Multi-LLM provider configuration */
  providers?: SquadProviders;
  /** Domain this squad operates in */
  domain?: string;
  /** Permissions for this squad */
  permissions?: Record<string, boolean>;
  /** Raw frontmatter for accessing KPIs and other custom fields */
  frontmatter?: Record<string, unknown>;
}

/**
 * Resolved execution context with paths and metadata.
 * Extends SquadContext with resolved paths for MCP, skills, and memory.
 */
export interface ExecutionContext extends SquadContext {
  /** Squad name this context belongs to */
  squadName: string;
  /** Resolved paths and metadata */
  resolved: {
    /** Path to MCP config file to use */
    mcpConfigPath: string;
    /** Source of MCP config resolution */
    mcpSource: 'user-override' | 'generated' | 'fallback';
    /** List of MCP servers in the config */
    mcpServers: string[];
    /** Resolved skill directory paths */
    skillPaths: string[];
    /** Resolved memory file paths */
    memoryPaths: string[];
  };
}

/**
 * Find the .agents/squads directory by searching current directory and parents.
 * Searches up to 5 parent directories.
 * @returns Path to squads directory or null if not found
 */
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

/**
 * Find the root directory of the squads project (where .agents/ lives).
 * @returns Path to project root or null if not in a squads project
 */
export function findProjectRoot(): string | null {
  // Find the root of the squads project (where .agents/ lives)
  const squadsDir = findSquadsDir();
  if (!squadsDir) return null;
  // squadsDir is /path/to/.agents/squads, so go up 2 levels
  return join(squadsDir, '..', '..');
}

/**
 * Check if the project has local infrastructure configuration.
 * Looks for .env file with infra-related keys (LANGFUSE_, SQUADS_BRIDGE, etc).
 * @returns True if local infra config exists
 */
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

/**
 * List all squad names in the given squads directory.
 * Only includes directories containing a SQUAD.md file.
 * @param squadsDir - Path to the .agents/squads directory
 * @returns Array of squad directory names
 */
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

/**
 * List all agents in the squads directory or a specific squad.
 * Agents are markdown files (excluding SQUAD.md) in squad directories.
 * @param squadsDir - Path to the .agents/squads directory
 * @param squadName - Optional squad name to filter agents
 * @returns Array of Agent objects with basic metadata
 */
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

/**
 * Parse a SQUAD.md file into a Squad object.
 * Extracts frontmatter metadata, agents, pipelines, goals, and routines.
 * @param filePath - Path to the SQUAD.md file
 * @returns Parsed Squad object with all extracted data
 */
export function parseSquadFile(filePath: string): Squad {
  const rawContent = readFileSync(filePath, 'utf-8');

  // Parse frontmatter with gray-matter
  const { data: frontmatter, content: bodyContent } = matter(rawContent);
  const fm = frontmatter as SquadFrontmatter;

  const lines = bodyContent.split('\n');

  // Directory name is used for file paths (e.g., "engineering", "marketing")
  const dirName = basename(dirname(filePath));

  const squad: Squad = {
    // Display name can be different from dir (e.g., "Engineering Squad")
    name: fm.name || dirName,
    // Directory name for file path resolution
    dir: dirName,
    mission: fm.mission || '',
    agents: [],
    pipelines: [],
    triggers: { scheduled: [], event: [], manual: [] },
    routines: [],
    dependencies: [],
    outputPath: '',
    goals: [],
    // Apply frontmatter fields
    effort: fm.effort,
    context: fm.context,
    repo: fm.repo,
    stack: fm.stack,
    providers: fm.providers,
    // Preserve raw frontmatter for KPIs and other custom fields
    frontmatter: frontmatter as Record<string, unknown>,
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

/**
 * Load and parse a squad by name.
 * Convenience function that finds the squads directory and parses the squad file.
 * @param squadName - Name of the squad directory (e.g., "engineering")
 * @returns Parsed Squad object or null if not found
 */
export function loadSquad(squadName: string): Squad | null {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return null;

  const squadFile = join(squadsDir, squadName, 'SQUAD.md');
  if (!existsSync(squadFile)) return null;

  return parseSquadFile(squadFile);
}

/**
 * Load raw content of an agent definition file.
 * @param agentPath - Path to the agent markdown file
 * @returns Raw file content or empty string if file doesn't exist
 */
export function loadAgentDefinition(agentPath: string): string {
  if (!existsSync(agentPath)) return '';
  return readFileSync(agentPath, 'utf-8');
}

/**
 * Parse provider from an agent definition file.
 *
 * Looks for:
 * 1. Frontmatter: `provider: xai`
 * 2. Header syntax: `## Provider\nxai`
 *
 * @returns Provider ID or undefined if not specified
 */
export function parseAgentProvider(agentPath: string): string | undefined {
  if (!existsSync(agentPath)) return undefined;

  const content = readFileSync(agentPath, 'utf-8');

  // Try parsing frontmatter
  try {
    const { data: frontmatter } = matter(content);
    if (frontmatter?.provider && typeof frontmatter.provider === 'string') {
      return frontmatter.provider.toLowerCase();
    }
  } catch {
    // Ignore frontmatter parsing errors
  }

  // Try header syntax: ## Provider\n<provider>
  const providerHeaderMatch = content.match(/##\s*Provider\s*\n+([a-zA-Z0-9_-]+)/i);
  if (providerHeaderMatch) {
    return providerHeaderMatch[1].toLowerCase();
  }

  return undefined;
}

/**
 * Add a new goal to a squad's SQUAD.md file.
 * Creates the Goals section if it doesn't exist.
 * @param squadName - Name of the squad directory
 * @param goal - Goal description text
 * @returns True if goal was added successfully
 */
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

/**
 * Update an existing goal in a squad's SQUAD.md file.
 * Can mark goal as completed or update progress text.
 * @param squadName - Name of the squad directory
 * @param goalIndex - Zero-based index of the goal to update
 * @param updates - Object with optional completed and progress fields
 * @returns True if goal was updated successfully
 */
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

/**
 * Find the skills directory (.claude/skills)
 */
function findSkillsDir(): string | null {
  const projectRoot = findProjectRoot();
  if (!projectRoot) return null;

  const skillsDir = join(projectRoot, '.claude', 'skills');
  return existsSync(skillsDir) ? skillsDir : null;
}

/**
 * Find the memory directory (.agents/memory)
 */
function findMemoryDir(): string | null {
  const projectRoot = findProjectRoot();
  if (!projectRoot) return null;

  const memoryDir = join(projectRoot, '.agents', 'memory');
  return existsSync(memoryDir) ? memoryDir : null;
}

/**
 * Resolve a skill name to its directory path.
 */
function resolveSkillPath(skillName: string): string | null {
  const skillsDir = findSkillsDir();
  if (!skillsDir) return null;

  const skillPath = join(skillsDir, skillName);
  return existsSync(skillPath) ? skillPath : null;
}

/**
 * Resolve memory glob patterns to actual file paths.
 */
function resolveMemoryPaths(patterns: string[]): string[] {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return [];

  const resolved: string[] = [];

  for (const pattern of patterns) {
    // Handle simple patterns like "intelligence/*" or "research/*"
    if (pattern.endsWith('/*')) {
      const subdir = pattern.slice(0, -2);
      const subdirPath = join(memoryDir, subdir);
      if (existsSync(subdirPath)) {
        // Add all .md files in the subdirectory
        try {
          const files = readdirSync(subdirPath);
          for (const file of files) {
            if (file.endsWith('.md')) {
              resolved.push(join(subdirPath, file));
            }
          }
        } catch {
          // Ignore read errors
        }
      }
    } else {
      // Direct path
      const fullPath = join(memoryDir, pattern);
      if (existsSync(fullPath)) {
        resolved.push(fullPath);
      }
    }
  }

  return resolved;
}

/**
 * Resolve execution context for a squad.
 *
 * Takes a Squad object and resolves all context references to actual paths:
 * - MCP config path (three-tier resolution)
 * - Skill directory paths
 * - Memory file paths
 *
 * @param squad - The squad to resolve context for
 * @param forceRegenerate - Force MCP config regeneration
 * @returns Resolved execution context with all paths
 */
export function resolveExecutionContext(
  squad: Squad,
  forceRegenerate = false
): ExecutionContext {
  const ctx = squad.context || {};

  // Resolve MCP config
  const mcpResolution: McpResolution = resolveMcpConfig(
    squad.name,
    ctx.mcp,
    forceRegenerate
  );

  // Resolve skill paths
  const skillPaths: string[] = [];
  if (ctx.skills) {
    for (const skill of ctx.skills) {
      const path = resolveSkillPath(skill);
      if (path) {
        skillPaths.push(path);
      }
    }
  }

  // Resolve memory paths
  const memoryPaths = ctx.memory?.load
    ? resolveMemoryPaths(ctx.memory.load)
    : [];

  return {
    // Copy all SquadContext fields
    ...ctx,
    // Add squad name
    squadName: squad.name,
    // Add resolved paths
    resolved: {
      mcpConfigPath: mcpResolution.path,
      mcpSource: mcpResolution.source,
      mcpServers: mcpResolution.servers || [],
      skillPaths,
      memoryPaths,
    },
  };
}
