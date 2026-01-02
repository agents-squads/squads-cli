import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { findMemoryDir } from '../lib/memory.js';
import { findSquadsDir, listSquads } from '../lib/squad-parser.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine,
} from '../lib/terminal.js';

interface CommitInfo {
  hash: string;
  date: string;
  message: string;
  files: string[];
}

interface SquadUpdate {
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
  } catch (error) {
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

export async function syncCommand(options: { verbose?: boolean } = {}): Promise<void> {
  const memoryDir = findMemoryDir();
  const squadsDir = findSquadsDir();

  if (!memoryDir) {
    writeLine(`  ${colors.yellow}No .agents/memory directory found${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    return; // Graceful exit - don't fail hooks
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}memory sync${RESET}`);
  writeLine();

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

  // Show helpful commands
  writeLine(`  ${colors.dim}$${RESET} squads memory show ${colors.cyan}<squad>${RESET}   ${colors.dim}View updated memory${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads status               ${colors.dim}See all squads${RESET}`);
  writeLine();
}
