import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { findMemoryDir } from '../lib/memory.js';
import { findSquadsDir } from '../lib/squad-parser.js';
import { syncAllCycleData, isPostgresAvailable, closeCycleSyncPool, SyncResult } from '../lib/cycle-sync.js';
import {
  colors,
  RESET,
  gradient,
  icons,
  writeLine,
} from '../lib/terminal.js';
import { track, Events } from '../lib/telemetry.js';

interface CommitInfo {
  hash: string;
  date: string;
  message: string;
  files: string[];
}

interface _SquadUpdate {
  squad: string;
  commits: CommitInfo[];
  summary: string;
}

// Map file paths to squads
const PATH_TO_SQUAD: Record<string, string> = {
  'squads-cli': 'product',
  'agents-squads-web': 'website',
  'research': 'research',
  'intelligence': 'intelligence',
  'customer': 'customer',
  'finance': 'finance',
  'engineering': 'engineering',
  'product': 'product',
  'company': 'company',
  '.agents/squads': 'engineering',
  '.agents/memory': 'engineering',
};

// Keywords in commit messages that map to squads
const MESSAGE_TO_SQUAD: Record<string, string> = {
  'cli': 'product',
  'website': 'website',
  'web': 'website',
  'homepage': 'website',
  'research': 'research',
  'intel': 'intelligence',
  'lead': 'customer',
  'finance': 'finance',
  'cost': 'finance',
  'engineering': 'engineering',
  'infra': 'engineering',
};

function getLastSyncTime(memoryDir: string): string | null {
  const syncFile = join(memoryDir, '.last-sync');
  if (existsSync(syncFile)) {
    return readFileSync(syncFile, 'utf-8').trim();
  }
  return null;
}

function updateLastSyncTime(memoryDir: string): void {
  const syncFile = join(memoryDir, '.last-sync');
  writeFileSync(syncFile, new Date().toISOString());
}

function getRecentCommits(since?: string): CommitInfo[] {
  const commits: CommitInfo[] = [];

  try {
    // Get commits with files changed
    const sinceArg = since ? `--since="${since}"` : '-n 20';
    const logOutput = execSync(
      `git log ${sinceArg} --format="%H|%aI|%s" --name-only`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!logOutput) return commits;

    // Parse git log output
    const entries = logOutput.split('\n\n');
    for (const entry of entries) {
      const lines = entry.split('\n').filter(l => l.trim());
      if (lines.length === 0) continue;

      const [header, ...fileLines] = lines;
      const [hash, date, ...messageParts] = header.split('|');
      const message = messageParts.join('|');

      if (hash && date && message) {
        commits.push({
          hash: hash.substring(0, 7),
          date: date.split('T')[0],
          message,
          files: fileLines.filter(f => f && !f.includes('|')),
        });
      }
    }
  } catch {
    // Not in a git repo or other error
  }

  return commits;
}

function detectSquadsFromCommit(commit: CommitInfo): string[] {
  const squads = new Set<string>();

  // Check file paths
  for (const file of commit.files) {
    for (const [pathPattern, squad] of Object.entries(PATH_TO_SQUAD)) {
      if (file.includes(pathPattern)) {
        squads.add(squad);
      }
    }
  }

  // Check commit message
  const msgLower = commit.message.toLowerCase();
  for (const [keyword, squad] of Object.entries(MESSAGE_TO_SQUAD)) {
    if (msgLower.includes(keyword)) {
      squads.add(squad);
    }
  }

  return Array.from(squads);
}

function groupCommitsBySquad(commits: CommitInfo[]): Map<string, CommitInfo[]> {
  const grouped = new Map<string, CommitInfo[]>();

  for (const commit of commits) {
    const squads = detectSquadsFromCommit(commit);

    for (const squad of squads) {
      if (!grouped.has(squad)) {
        grouped.set(squad, []);
      }
      grouped.get(squad)!.push(commit);
    }
  }

  return grouped;
}

function generateSummary(commits: CommitInfo[]): string {
  if (commits.length === 0) return '';

  const messages = commits.map(c => `- ${c.message}`).join('\n');
  const date = new Date().toISOString().split('T')[0];

  return `
## Session Update (${date})

${messages}
`;
}

function appendToSquadMemory(
  memoryDir: string,
  squad: string,
  summary: string
): boolean {
  // Find the lead agent for this squad
  const squadMemoryDir = join(memoryDir, squad);

  if (!existsSync(squadMemoryDir)) {
    mkdirSync(squadMemoryDir, { recursive: true });
  }

  // Look for existing agent directories or create default
  let agentDir: string;
  const existingDirs = existsSync(squadMemoryDir)
    ? readdirSync(squadMemoryDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];

  if (existingDirs.length > 0) {
    // Use first existing agent (usually the lead)
    agentDir = join(squadMemoryDir, existingDirs[0]);
  } else {
    // Create default agent directory
    agentDir = join(squadMemoryDir, `${squad}-lead`);
    mkdirSync(agentDir, { recursive: true });
  }

  const statePath = join(agentDir, 'state.md');

  let content = '';
  if (existsSync(statePath)) {
    content = readFileSync(statePath, 'utf-8');
  } else {
    content = `# ${squad} Squad - State\n\nUpdated: ${new Date().toISOString().split('T')[0]}\n`;
  }

  // Update the "Updated" line
  content = content.replace(
    /Updated:\s*\d{4}-\d{2}-\d{2}/,
    `Updated: ${new Date().toISOString().split('T')[0]}`
  );

  // Append the summary
  content += summary;

  writeFileSync(statePath, content);
  return true;
}

/**
 * Pull latest memory changes from git remote
 */
function gitPullMemory(): { success: boolean; output: string; behind: number; ahead: number } {
  try {
    // First fetch to see what's different
    execSync('git fetch origin', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

    // Check how many commits behind/ahead
    const status = execSync('git status -sb', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const behindMatch = status.match(/behind (\d+)/);
    const aheadMatch = status.match(/ahead (\d+)/);
    const behind = behindMatch ? parseInt(behindMatch[1]) : 0;
    const ahead = aheadMatch ? parseInt(aheadMatch[1]) : 0;

    if (behind === 0) {
      return { success: true, output: 'Already up to date', behind: 0, ahead };
    }

    // Pull with rebase to get latest
    const output = execSync('git pull --rebase origin main', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { success: true, output: output.trim(), behind, ahead };
  } catch (error) {
    const err = error as { message?: string };
    return { success: false, output: err.message || 'Pull failed', behind: 0, ahead: 0 };
  }
}

/**
 * Sync squad and agent definitions to Postgres dimension tables.
 * Creates/updates dim_squads and dim_agents from SQUAD.md and agent .md files.
 */
async function syncDimensionsToPostgres(verbose?: boolean): Promise<void> {
  const squadsDir = findSquadsDir();
  const bridgeUrl = process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088';

  if (!squadsDir) {
    writeLine(`  ${colors.red}No .agents/squads directory found${RESET}`);
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}sync --dimensions${RESET}`);
  writeLine();
  writeLine(`  ${icons.progress} Collecting squad definitions...`);

  // Collect all squads
  const squadDirs = readdirSync(squadsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const squadsData: Array<{
    name: string;
    mission: string | null;
    domain: string | null;
    default_provider: string;
    daily_budget: number;
    cooldown_seconds: number;
    metadata: Record<string, unknown>;
  }> = [];

  const agentsData: Array<{
    name: string;
    squad: string;
    role: string | null;
    purpose: string | null;
    provider: string | null;
    trigger_type: string;
    mcp_servers: string[];
    skills: string[];
    metadata: Record<string, unknown>;
  }> = [];

  // Parse each squad
  const { loadSquad: loadSquadFn } = await import('../lib/squad-parser.js');

  for (const squadName of squadDirs) {
    const squad = loadSquadFn(squadName);
    if (!squad) continue;

    squadsData.push({
      name: squad.name,
      mission: squad.mission || null,
      domain: squad.domain || null,
      default_provider: squad.providers?.default || 'anthropic',
      daily_budget: squad.context?.budget?.daily || 50,
      cooldown_seconds: squad.context?.cooldown || 300,
      metadata: {
        providers: squad.providers,
        context: squad.context,
        permissions: squad.permissions,
      },
    });

    // Parse agents in this squad
    for (const agent of squad.agents) {
      const agentPath = join(squadsDir, squadName, `${agent.name}.md`);
      if (!existsSync(agentPath)) continue;

      // Extract MCP servers and skills from definition
      const definition = readFileSync(agentPath, 'utf-8');
      const mcpServers = extractMcpServersFromDef(definition);
      const skills = extractSkillsFromDef(definition);

      agentsData.push({
        name: agent.name,
        squad: squadName,
        role: agent.role || null,
        purpose: agent.purpose || null,
        provider: agent.provider || null,
        trigger_type: agent.trigger?.toLowerCase() || 'manual',
        mcp_servers: mcpServers,
        skills: skills,
        metadata: {
          schedule: agent.schedule,
          outputs: agent.outputs,
        },
      });
    }
  }

  writeLine(`  ${icons.success} Found ${colors.cyan}${squadsData.length}${RESET} squads, ${colors.cyan}${agentsData.length}${RESET} agents`);

  if (verbose) {
    writeLine();
    for (const s of squadsData) {
      writeLine(`    ${colors.cyan}${s.name}${RESET} ${colors.dim}(${s.metadata.providers ? 'with providers' : 'default'})${RESET}`);
    }
  }

  // Send to bridge
  writeLine();
  writeLine(`  ${icons.progress} Syncing to Postgres...`);

  try {
    const response = await fetch(`${bridgeUrl}/api/sync/dimensions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ squads: squadsData, agents: agentsData }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Bridge returned ${response.status}: ${error}`);
    }

    const data = await response.json() as { synced_squads: number; synced_agents: number };

    writeLine(`  ${icons.success} Synced ${colors.green}${data.synced_squads}${RESET} squads, ${colors.green}${data.synced_agents}${RESET} agents`);
    writeLine();

  } catch (error) {
    writeLine(`  ${icons.error} ${colors.red}Sync failed: ${error}${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Is the bridge running? Check: curl ${bridgeUrl}/health${RESET}`);
    writeLine();
  }
}

function extractMcpServersFromDef(definition: string): string[] {
  const servers: Set<string> = new Set();
  const knownServers = ['chrome-devtools', 'firecrawl', 'supabase', 'grafana', 'context7', 'huggingface', 'img-gen', 'web-fetch'];

  for (const server of knownServers) {
    if (definition.toLowerCase().includes(server)) {
      servers.add(server);
    }
  }

  const mcpMatch = definition.match(/mcp:\s*\n((?:\s*-\s*\S+\s*\n?)+)/i);
  if (mcpMatch) {
    for (const line of mcpMatch[1].split('\n')) {
      const m = line.match(/^\s*-\s*(\S+)/);
      if (m) servers.add(m[1]);
    }
  }

  return Array.from(servers);
}

function extractSkillsFromDef(definition: string): string[] {
  const skills: Set<string> = new Set();

  const skillsMatch = definition.match(/skills:\s*\n((?:\s*-\s*\S+\s*\n?)+)/i);
  if (skillsMatch) {
    for (const line of skillsMatch[1].split('\n')) {
      const m = line.match(/^\s*-\s*(\S+)/);
      if (m) skills.add(m[1]);
    }
  }

  const slashSkills = definition.match(/\/[\w-]+/g);
  if (slashSkills) {
    for (const skill of slashSkills) {
      if (!skill.startsWith('/exit') && !skill.startsWith('/help')) {
        skills.add(skill.slice(1));
      }
    }
  }

  return Array.from(skills);
}

interface LearningEntry {
  squad: string;
  agent: string | null;
  content: string;
  category: string;
  importance: string;
  source_file: string;
}

/**
 * Parse a learnings.md file into individual learning entries
 */
function parseLearningsFile(filePath: string, squad: string, agent: string | null): LearningEntry[] {
  const content = readFileSync(filePath, 'utf-8');
  const learnings: LearningEntry[] = [];

  // Split by headers (##, ###) to get sections
  const sections = content.split(/^##+ /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const title = lines[0]?.trim();
    const body = lines.slice(1).join('\n').trim();

    if (!body || body.length < 20) continue; // Skip empty or too short

    // Determine category from section title
    let category = 'insight';
    const titleLower = title?.toLowerCase() || '';
    if (titleLower.includes('what works') || titleLower.includes('success')) category = 'success';
    else if (titleLower.includes('what doesn\'t') || titleLower.includes('unsuccessful') || titleLower.includes('fail')) category = 'failure';
    else if (titleLower.includes('pattern')) category = 'pattern';
    else if (titleLower.includes('improvement') || titleLower.includes('next')) category = 'tip';

    // Determine importance from content markers
    let importance = 'normal';
    if (body.includes('**Learning**:') || body.includes('critical') || body.includes('P1')) importance = 'high';

    learnings.push({
      squad,
      agent,
      content: title ? `## ${title}\n${body}` : body,
      category,
      importance,
      source_file: filePath,
    });
  }

  // Also extract individual bullet points marked as learnings
  const learningMatches = content.matchAll(/\*\*Learning\*\*:\s*(.+?)(?=\n\n|\n\*\*|$)/gs);
  for (const match of learningMatches) {
    learnings.push({
      squad,
      agent,
      content: match[1].trim(),
      category: 'insight',
      importance: 'high',
      source_file: filePath,
    });
  }

  return learnings;
}

/**
 * Sync learnings from .agents/memory to Postgres
 */
async function syncLearningsToPostgres(verbose?: boolean): Promise<void> {
  const bridgeUrl = process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088';
  const memoryDir = findMemoryDir();

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}sync --learnings${RESET}`);
  writeLine();

  if (!memoryDir) {
    writeLine(`  ${icons.error} ${colors.red}No .agents/memory directory found${RESET}`);
    return;
  }

  // Find all learnings.md files
  writeLine(`  ${icons.progress} Scanning for learnings files...`);

  const learningsFiles: string[] = [];
  const scanDir = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name === 'learnings.md') {
        learningsFiles.push(fullPath);
      }
    }
  };
  scanDir(memoryDir);

  writeLine(`  ${icons.success} Found ${colors.cyan}${learningsFiles.length}${RESET} learnings files`);

  // Parse all learnings
  const allLearnings: LearningEntry[] = [];
  for (const file of learningsFiles) {
    // Extract squad and agent from path: .agents/memory/<squad>/<agent>/learnings.md
    const relativePath = file.replace(memoryDir + '/', '');
    const parts = relativePath.split('/');
    const squad = parts[0] || 'unknown';
    const agent = parts.length > 2 ? parts[1] : null;

    const entries = parseLearningsFile(file, squad, agent);
    allLearnings.push(...entries);

    if (verbose && entries.length > 0) {
      writeLine(`    ${colors.cyan}${squad}${agent ? '/' + agent : ''}${RESET}: ${entries.length} learnings`);
    }
  }

  writeLine(`  ${icons.success} Parsed ${colors.cyan}${allLearnings.length}${RESET} total learnings`);

  if (allLearnings.length === 0) {
    writeLine();
    writeLine(`  ${colors.dim}No learnings to sync${RESET}`);
    return;
  }

  // Send to bridge
  writeLine();
  writeLine(`  ${icons.progress} Syncing to Postgres...`);

  try {
    const response = await fetch(`${bridgeUrl}/api/sync/learnings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ learnings: allLearnings }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Bridge returned ${response.status}: ${errorText}`);
    }

    const result = await response.json() as { imported: number; skipped: number };
    writeLine(`  ${icons.success} Imported ${colors.green}${result.imported}${RESET} learnings${result.skipped > 0 ? `, skipped ${result.skipped} duplicates` : ''}`);

  } catch (error) {
    writeLine(`  ${icons.error} ${colors.red}Sync failed: ${error}${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Is the bridge running? Check: curl ${bridgeUrl}/health${RESET}`);
  }

  writeLine();
}

/**
 * Push local memory changes to git remote
 */
function gitPushMemory(): { success: boolean; output: string } {
  try {
    // Check if there are uncommitted changes in memory
    const status = execSync('git status --porcelain .agents/memory/', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (status) {
      // Stage and commit memory changes
      execSync('git add .agents/memory/', { stdio: ['pipe', 'pipe', 'pipe'] });
      execSync('git commit -m "chore: sync squad memory"', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    // Push to remote
    const output = execSync('git push origin main', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { success: true, output: output.trim() || 'Pushed successfully' };
  } catch (error) {
    const err = error as { message?: string };
    return { success: false, output: err.message || 'Push failed' };
  }
}

export async function syncCommand(options: { verbose?: boolean; push?: boolean; pull?: boolean; postgres?: boolean; dimensions?: boolean; learnings?: boolean } = {}): Promise<void> {
  await track(Events.CLI_MEMORY_SYNC, { push: options.push, pull: options.pull, postgres: options.postgres, dimensions: options.dimensions, learnings: options.learnings });

  // If --dimensions flag, sync squad/agent definitions to Postgres dim tables
  if (options.dimensions) {
    await syncDimensionsToPostgres(options.verbose);
    return;
  }

  // If --learnings flag, sync learnings.md files to Postgres
  if (options.learnings) {
    await syncLearningsToPostgres(options.verbose);
    return;
  }
  const memoryDir = findMemoryDir();
  const _squadsDir = findSquadsDir();

  if (!memoryDir) {
    writeLine(`  ${colors.yellow}No .agents/memory directory found${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    return; // Graceful exit - don't fail hooks
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}memory sync${RESET}`);
  writeLine();

  // Default behavior: pull from remote
  const doPull = options.pull !== false; // Pull by default unless explicitly disabled
  const doPush = options.push === true; // Only push if explicitly requested

  // Step 1: Pull from git remote
  if (doPull) {
    writeLine(`  ${icons.progress} Pulling from remote...`);
    const pullResult = gitPullMemory();

    if (pullResult.success) {
      if (pullResult.behind > 0) {
        writeLine(`  ${icons.success} Pulled ${colors.cyan}${pullResult.behind}${RESET} commits from remote`);
      } else {
        writeLine(`  ${icons.success} ${colors.dim}Already up to date${RESET}`);
      }
      if (pullResult.ahead > 0) {
        writeLine(`  ${colors.dim}  ${pullResult.ahead} local commits to push${RESET}`);
      }
    } else {
      writeLine(`  ${icons.error} ${colors.red}Pull failed: ${pullResult.output}${RESET}`);
    }
    writeLine();
  }

  // Get last sync time
  const lastSync = getLastSyncTime(memoryDir);
  if (lastSync) {
    writeLine(`  ${colors.dim}Last sync: ${lastSync.split('T')[0]}${RESET}`);
  } else {
    writeLine(`  ${colors.dim}First sync${RESET}`);
  }
  writeLine();

  // Get recent commits
  const commits = getRecentCommits(lastSync || undefined);

  if (commits.length === 0) {
    writeLine(`  ${colors.yellow}No new commits since last sync${RESET}`);

    // Still sync to Postgres if requested (even without new commits)
    if (options.postgres) {
      writeLine();
      writeLine(`  ${icons.progress} Syncing cycle data to Postgres...`);

      const pgAvailable = await isPostgresAvailable();
      if (!pgAvailable) {
        writeLine(`  ${icons.error} ${colors.red}Postgres not available${RESET}`);
        writeLine(`  ${colors.dim}Run \`squads stack up\` to start the database${RESET}`);
      } else {
        try {
          const result: SyncResult = await syncAllCycleData();

          const totalSynced = result.goals.synced + result.feedback.synced + result.kpis.synced + result.learnings.synced;
          const totalErrors = result.goals.errors + result.feedback.errors + result.kpis.errors + result.learnings.errors;

          if (totalSynced > 0 || totalErrors > 0) {
            writeLine(`  ${icons.success} Synced to Postgres ${colors.dim}(${result.duration}ms)${RESET}`);
            if (result.goals.synced > 0) {
              writeLine(`    ${colors.dim}Goals:${RESET} ${colors.cyan}${result.goals.synced}${RESET}`);
            }
            if (result.feedback.synced > 0) {
              writeLine(`    ${colors.dim}Feedback:${RESET} ${colors.cyan}${result.feedback.synced}${RESET}`);
            }
            if (result.kpis.synced > 0) {
              writeLine(`    ${colors.dim}KPIs:${RESET} ${colors.cyan}${result.kpis.synced}${RESET}`);
            }
            if (result.learnings.synced > 0) {
              writeLine(`    ${colors.dim}Learnings:${RESET} ${colors.cyan}${result.learnings.synced}${RESET}`);
            }
            if (totalErrors > 0) {
              writeLine(`    ${colors.red}Errors:${RESET} ${totalErrors}`);
            }
          } else {
            writeLine(`  ${icons.success} ${colors.dim}No new cycle data to sync${RESET}`);
          }

          await closeCycleSyncPool();
        } catch (err) {
          writeLine(`  ${icons.error} ${colors.red}Postgres sync failed${RESET}`);
          if (process.env.DEBUG) console.error(err);
        }
      }
    }

    writeLine();
    return;
  }

  writeLine(`  ${colors.cyan}${commits.length}${RESET} commits to process`);
  writeLine();

  // Group by squad
  const bySquad = groupCommitsBySquad(commits);

  if (bySquad.size === 0) {
    writeLine(`  ${colors.yellow}No squad-related commits found${RESET}`);
    writeLine();
    updateLastSyncTime(memoryDir);
    return;
  }

  // Update each squad's memory
  let updated = 0;
  for (const [squad, squadCommits] of bySquad) {
    const summary = generateSummary(squadCommits);

    if (options.verbose) {
      writeLine(`  ${icons.progress} ${colors.cyan}${squad}${RESET}`);
      for (const commit of squadCommits) {
        writeLine(`    ${colors.dim}${commit.hash} ${commit.message}${RESET}`);
      }
    }

    const success = appendToSquadMemory(memoryDir, squad, summary);
    if (success) {
      writeLine(`  ${icons.success} ${colors.cyan}${squad}${RESET} ${colors.dim}(${squadCommits.length} commits)${RESET}`);
      updated++;
    }
  }

  writeLine();
  writeLine(`  ${colors.green}${updated}${RESET} squad memories updated`);
  writeLine();

  // Update last sync time
  updateLastSyncTime(memoryDir);

  // Step 3: Push to remote if requested
  if (doPush) {
    writeLine(`  ${icons.progress} Pushing to remote...`);
    const pushResult = gitPushMemory();

    if (pushResult.success) {
      writeLine(`  ${icons.success} ${colors.green}Pushed memory updates to remote${RESET}`);
    } else {
      writeLine(`  ${icons.error} ${colors.red}Push failed: ${pushResult.output}${RESET}`);
    }
    writeLine();
  }

  // Step 4: Sync to Postgres if requested
  if (options.postgres) {
    writeLine(`  ${icons.progress} Syncing cycle data to Postgres...`);

    const pgAvailable = await isPostgresAvailable();
    if (!pgAvailable) {
      writeLine(`  ${icons.error} ${colors.red}Postgres not available${RESET}`);
      writeLine(`  ${colors.dim}Run \`squads stack up\` to start the database${RESET}`);
      writeLine();
    } else {
      try {
        const result: SyncResult = await syncAllCycleData();

        const totalSynced = result.goals.synced + result.feedback.synced + result.kpis.synced + result.learnings.synced;
        const totalErrors = result.goals.errors + result.feedback.errors + result.kpis.errors + result.learnings.errors;

        if (totalSynced > 0 || totalErrors > 0) {
          writeLine(`  ${icons.success} Synced to Postgres ${colors.dim}(${result.duration}ms)${RESET}`);
          if (result.goals.synced > 0) {
            writeLine(`    ${colors.dim}Goals:${RESET} ${colors.cyan}${result.goals.synced}${RESET}`);
          }
          if (result.feedback.synced > 0) {
            writeLine(`    ${colors.dim}Feedback:${RESET} ${colors.cyan}${result.feedback.synced}${RESET}`);
          }
          if (result.kpis.synced > 0) {
            writeLine(`    ${colors.dim}KPIs:${RESET} ${colors.cyan}${result.kpis.synced}${RESET}`);
          }
          if (result.learnings.synced > 0) {
            writeLine(`    ${colors.dim}Learnings:${RESET} ${colors.cyan}${result.learnings.synced}${RESET}`);
          }
          if (totalErrors > 0) {
            writeLine(`    ${colors.red}Errors:${RESET} ${totalErrors}`);
          }
        } else {
          writeLine(`  ${icons.success} ${colors.dim}No new cycle data to sync${RESET}`);
        }
        writeLine();

        await closeCycleSyncPool();
      } catch (err) {
        writeLine(`  ${icons.error} ${colors.red}Postgres sync failed${RESET}`);
        if (process.env.DEBUG) console.error(err);
        writeLine();
      }
    }
  }

  // Show helpful commands
  writeLine(`  ${colors.dim}$${RESET} squads memory show ${colors.cyan}<squad>${RESET}   ${colors.dim}View updated memory${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads status               ${colors.dim}See all squads${RESET}`);
  if (!doPush && updated > 0) {
    writeLine(`  ${colors.dim}$${RESET} squads memory sync --push   ${colors.dim}Push changes to remote${RESET}`);
  }
  if (!options.postgres) {
    writeLine(`  ${colors.dim}$${RESET} squads memory sync --postgres  ${colors.dim}Sync to Postgres${RESET}`);
  }
  writeLine();
}
