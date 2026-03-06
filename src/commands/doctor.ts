/**
 * squads doctor - Check local environment readiness
 *
 * Detects what tools are installed, what's missing, and what capabilities
 * the user has. Helps new users understand what they can do right now
 * vs what needs setup.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  colors,
  RESET,
  bold,
  gradient,
  icons,
  writeLine,
  padEnd,
} from '../lib/terminal.js';
import { findProjectRoot } from '../lib/squad-parser.js';

// Tool categories — ordered by importance for new users
interface Tool {
  name: string;
  command: string;         // Command to check existence
  versionFlag: string;     // Flag to get version
  category: 'core' | 'recommended' | 'optional';
  purpose: string;
  installHint: string;
  unlocks: string;         // What capabilities this enables
}

const TOOLS: Tool[] = [
  // Core — squads won't work well without these
  {
    name: 'claude',
    command: 'claude',
    versionFlag: '--version',
    category: 'core',
    purpose: 'AI agent execution engine',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    unlocks: 'Agent execution (required)',
  },
  {
    name: 'git',
    command: 'git',
    versionFlag: '--version',
    category: 'core',
    purpose: 'Version control and state management',
    installHint: 'xcode-select --install (macOS) or apt install git',
    unlocks: 'Squad memory, conversation transcripts, PR workflows',
  },
  {
    name: 'node',
    command: 'node',
    versionFlag: '--version',
    category: 'core',
    purpose: 'JavaScript runtime',
    installHint: 'https://nodejs.org or nvm install --lts',
    unlocks: 'CLI execution, build tools',
  },

  // Recommended — significantly better experience
  {
    name: 'gh',
    command: 'gh',
    versionFlag: '--version',
    category: 'recommended',
    purpose: 'GitHub CLI for issues, PRs, and repos',
    installHint: 'brew install gh && gh auth login',
    unlocks: 'Issue tracking, PR workflows, cross-repo coordination',
  },
  {
    name: 'python3',
    command: 'python3',
    versionFlag: '--version',
    category: 'recommended',
    purpose: 'Python runtime for data and API agents',
    installHint: 'brew install python3 or https://python.org',
    unlocks: 'Data analysis, API integrations, ML workflows',
  },
  {
    name: 'jq',
    command: 'jq',
    versionFlag: '--version',
    category: 'recommended',
    purpose: 'JSON processor for API responses',
    installHint: 'brew install jq or apt install jq',
    unlocks: 'API response parsing, data extraction',
  },

  // Optional — enhance specific agent capabilities
  {
    name: 'curl',
    command: 'curl',
    versionFlag: '--version',
    category: 'optional',
    purpose: 'HTTP requests for API integrations',
    installHint: 'Usually pre-installed on macOS/Linux',
    unlocks: 'Slack notifications, webhook integrations, API calls',
  },
];

interface ToolResult {
  tool: Tool;
  installed: boolean;
  version?: string;
  error?: string;
}

interface AuthResult {
  name: string;
  authenticated: boolean;
  detail?: string;
}

function checkTool(tool: Tool): ToolResult {
  try {
    const output = execSync(`${tool.command} ${tool.versionFlag} 2>&1`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Extract version from first line
    const version = output.trim().split('\n')[0].replace(/^[^0-9]*/, '').trim();
    return { tool, installed: true, version: version.slice(0, 30) };
  } catch {
    return { tool, installed: false };
  }
}

function checkAuth(): AuthResult[] {
  const results: AuthResult[] = [];

  // Claude auth
  try {
    // Check if claude can authenticate (Max subscription or API key)
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    // Check for OAuth credentials
    const oauthPath = join(homedir(), '.claude', 'credentials.json');
    const hasOAuth = existsSync(oauthPath);

    if (hasApiKey) {
      results.push({ name: 'Anthropic', authenticated: true, detail: 'API key' });
    } else if (hasOAuth) {
      results.push({ name: 'Anthropic', authenticated: true, detail: 'OAuth' });
    } else {
      // May still work via Max subscription keychain
      results.push({ name: 'Anthropic', authenticated: true, detail: 'OAuth (Max subscription)' });
    }
  } catch {
    results.push({ name: 'Anthropic', authenticated: false });
  }

  // GitHub auth
  try {
    execSync('gh auth status 2>&1', { encoding: 'utf-8', timeout: 5000 });
    results.push({ name: 'GitHub', authenticated: true });
  } catch (err) {
    const output = (err as { stdout?: string; stderr?: string }).stderr || '';
    if (output.includes('Logged in')) {
      results.push({ name: 'GitHub', authenticated: true });
    } else {
      results.push({ name: 'GitHub', authenticated: false, detail: 'Run: gh auth login' });
    }
  }

  // Google Cloud auth
  try {
    const output = execSync('gcloud auth list --format="value(account)" 2>&1', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (output.trim()) {
      results.push({ name: 'Google Cloud', authenticated: true, detail: output.trim().split('\n')[0] });
    } else {
      results.push({ name: 'Google Cloud', authenticated: false, detail: 'Run: gcloud auth login' });
    }
  } catch {
    // gcloud not installed — skip
  }

  return results;
}

interface ProjectResult {
  hasProject: boolean;
  squadsDir?: string;
  squadCount?: number;
  agentCount?: number;
  hasMemory?: boolean;
  hasConversations?: boolean;
}

function checkProject(): ProjectResult {
  const root = findProjectRoot();
  if (!root) {
    return { hasProject: false };
  }

  const squadsDir = join(root, '.agents', 'squads');
  let squadCount = 0;
  let agentCount = 0;

  if (existsSync(squadsDir)) {
    try {
      const entries = execSync(`ls -d ${squadsDir}/*/SQUAD.md 2>/dev/null | wc -l`, {
        encoding: 'utf-8',
        timeout: 3000,
      });
      squadCount = parseInt(entries.trim()) || 0;

      const agents = execSync(`find ${squadsDir} -name "*.md" ! -name "SQUAD.md" 2>/dev/null | wc -l`, {
        encoding: 'utf-8',
        timeout: 3000,
      });
      agentCount = parseInt(agents.trim()) || 0;
    } catch { /* ignore */ }
  }

  const memoryDir = join(root, '.agents', 'memory');
  const convDir = join(root, '.agents', 'conversations');

  return {
    hasProject: true,
    squadsDir: root,
    squadCount,
    agentCount,
    hasMemory: existsSync(memoryDir),
    hasConversations: existsSync(convDir),
  };
}

interface RunningSquad {
  squad: string;
  pid: string;
  elapsed?: string;
  task?: string;
}

function checkRunningSquads(): RunningSquad[] {
  try {
    const output = execSync('ps aux 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
    const results: RunningSquad[] = [];

    for (const line of output.split('\n')) {
      if (!line.includes('squads run') || line.includes('grep')) continue;

      const parts = line.trim().split(/\s+/);
      const pid = parts[1];
      const fullCmd = parts.slice(10).join(' ');

      // Extract squad name from "squads run <squad>"
      const squadMatch = fullCmd.match(/squads\s+run\s+(\S+)/);
      if (!squadMatch) continue;

      const squad = squadMatch[1];

      // Extract task if present
      const taskMatch = fullCmd.match(/--task\s+(.+?)(?:\s+--|$)/);
      const task = taskMatch ? taskMatch[1].replace(/^["']|["']$/g, '') : undefined;

      // Calculate elapsed from CPU time column (more reliable than START)
      const timeCol = parts[9]; // TIME column (mm:ss or h:mm:ss)
      let elapsed: string | undefined;
      if (timeCol && timeCol.includes(':')) {
        const timeParts = timeCol.split(':').map(Number);
        if (timeParts.length === 2 && timeParts.every(n => !isNaN(n))) {
          const totalMins = timeParts[0];
          elapsed = totalMins < 60 ? `${totalMins}m` : `${Math.floor(totalMins / 60)}h${totalMins % 60}m`;
        }
      }

      results.push({ squad, pid, elapsed, task });
    }

    return results;
  } catch {
    return [];
  }
}

function checkDaemon(): { running: boolean; pid?: string; routines?: number } {
  try {
    const output = execSync('ps aux 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
    for (const line of output.split('\n')) {
      if (line.includes('squads autonomous') && !line.includes('grep')) {
        const pid = line.trim().split(/\s+/)[1];
        // Try to count routines
        let routines = 0;
        try {
          const root = findProjectRoot();
          if (root) {
            const count = execSync(
              `grep -r "schedule:" ${join(root, '.agents', 'squads')}/*/SQUAD.md 2>/dev/null | wc -l`,
              { encoding: 'utf-8', timeout: 3000 }
            );
            routines = parseInt(count.trim()) || 0;
          }
        } catch { /* ignore */ }
        return { running: true, pid, routines };
      }
    }
    return { running: false };
  } catch {
    return { running: false };
  }
}

interface RecentTranscript {
  squad: string;
  file: string;
  ago: string;
  turns: string;
  cost: string;
}

function getRecentTranscripts(projectRoot: string): RecentTranscript[] {
  try {
    const convDir = join(projectRoot, '.agents', 'conversations');
    if (!existsSync(convDir)) return [];

    const output = execSync(
      `find ${convDir} -name "*.md" -mmin -1440 -exec stat -f "%m %N" {} + 2>/dev/null | sort -rn | head -10`,
      { encoding: 'utf-8', timeout: 5000 }
    );

    const results: RecentTranscript[] = [];
    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;
      const [timestamp, filePath] = line.trim().split(' ', 2);
      if (!filePath) continue;

      const pathParts = filePath.split('/');
      const squad = pathParts[pathParts.length - 2];
      const file = pathParts[pathParts.length - 1];

      // Read first few lines for metadata
      let turns = '?';
      let cost = '?';
      try {
        const head = execSync(`head -5 "${filePath}" 2>/dev/null`, { encoding: 'utf-8', timeout: 2000 });
        const turnsMatch = head.match(/Turns:\s*(\d+)/);
        const costMatch = head.match(/cost:\s*\$?([\d.]+)/);
        if (turnsMatch) turns = turnsMatch[1];
        if (costMatch) cost = costMatch[1];
      } catch { /* ignore */ }

      // Time ago
      const secs = Math.floor(Date.now() / 1000 - parseInt(timestamp));
      let ago: string;
      if (secs < 60) ago = 'just now';
      else if (secs < 3600) ago = `${Math.floor(secs / 60)}m ago`;
      else if (secs < 86400) ago = `${Math.floor(secs / 3600)}h ago`;
      else ago = `${Math.floor(secs / 86400)}d ago`;

      results.push({ squad, file, ago, turns, cost });
    }

    return results;
  } catch {
    return [];
  }
}

export interface DoctorOptions {
  verbose?: boolean;
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}doctor${RESET}`);
  writeLine();

  // === TOOLS ===
  const results = TOOLS.map(checkTool);
  const core = results.filter(r => r.tool.category === 'core');
  const recommended = results.filter(r => r.tool.category === 'recommended');
  const optional = results.filter(r => r.tool.category === 'optional');

  const installedCount = results.filter(r => r.installed).length;
  const coreInstalled = core.filter(r => r.installed).length;

  writeLine(`  ${bold}Tools${RESET} ${colors.dim}(${installedCount}/${results.length} installed)${RESET}`);
  writeLine();

  function printToolSection(label: string, items: ToolResult[]) {
    writeLine(`  ${colors.dim}${label}${RESET}`);
    for (const r of items) {
      const icon = r.installed ? `${colors.green}${icons.success}${RESET}` : `${colors.red}${icons.error}${RESET}`;
      const ver = r.installed && r.version ? ` ${colors.dim}${r.version}${RESET}` : '';
      const unlock = !r.installed ? `  ${colors.dim}→ unlocks: ${r.tool.unlocks}${RESET}` : '';
      writeLine(`    ${icon} ${padEnd(r.tool.name, 12)}${r.tool.purpose}${ver}${unlock}`);
      if (!r.installed && options.verbose) {
        writeLine(`      ${colors.cyan}Install:${RESET} ${r.tool.installHint}`);
      }
    }
    writeLine();
  }

  printToolSection('Core (required)', core);
  printToolSection('Recommended', recommended);
  if (options.verbose || optional.some(r => r.installed)) {
    printToolSection('Optional', optional);
  }

  // === AUTH ===
  const authResults = checkAuth();
  if (authResults.length > 0) {
    writeLine(`  ${bold}Authentication${RESET}`);
    writeLine();
    for (const auth of authResults) {
      const icon = auth.authenticated
        ? `${colors.green}${icons.success}${RESET}`
        : `${colors.red}${icons.error}${RESET}`;
      const detail = auth.detail ? ` ${colors.dim}(${auth.detail})${RESET}` : '';
      writeLine(`    ${icon} ${auth.name}${detail}`);
    }
    writeLine();
  }

  // === PROJECT ===
  const project = checkProject();
  writeLine(`  ${bold}Project${RESET}`);
  writeLine();
  if (project.hasProject) {
    writeLine(`    ${colors.green}${icons.success}${RESET} Squads project found`);
    writeLine(`      ${colors.dim}Root:${RESET} ${project.squadsDir}`);
    writeLine(`      ${colors.dim}Squads:${RESET} ${project.squadCount} ${colors.dim}|${RESET} ${colors.dim}Agents:${RESET} ${project.agentCount}`);
    if (project.hasMemory) writeLine(`      ${colors.green}${icons.success}${RESET} Memory directory exists`);
    if (project.hasConversations) writeLine(`      ${colors.green}${icons.success}${RESET} Conversation transcripts enabled`);
  } else {
    writeLine(`    ${colors.yellow}${icons.warning}${RESET} No squads project found in current directory`);
    writeLine(`      ${colors.cyan}Run:${RESET} squads init`);
  }
  writeLine();

  // === LIVE EXECUTION ===
  const running = checkRunningSquads();
  const daemon = checkDaemon();
  const recentTranscripts = project.hasProject ? getRecentTranscripts(project.squadsDir!) : [];

  writeLine(`  ${bold}Live Execution${RESET}`);
  writeLine();

  // Daemon status
  if (daemon.running) {
    writeLine(`    ${colors.green}${icons.success}${RESET} Daemon running ${colors.dim}(PID ${daemon.pid}, ${daemon.routines} routines)${RESET}`);
  } else {
    writeLine(`    ${colors.dim}○${RESET} Daemon not running ${colors.dim}(squads autonomous start)${RESET}`);
  }

  // Running squads
  if (running.length > 0) {
    writeLine(`    ${colors.cyan}${running.length}${RESET} squad(s) executing now:`);
    for (const r of running) {
      const elapsed = r.elapsed ? ` ${colors.dim}(${r.elapsed})${RESET}` : '';
      writeLine(`      ${colors.green}▸${RESET} ${r.squad}${elapsed}${r.task ? ` ${colors.dim}${r.task.slice(0, 60)}${RESET}` : ''}`);
    }
  } else {
    writeLine(`    ${colors.dim}○${RESET} No squads running`);
  }

  // Recent transcripts
  if (recentTranscripts.length > 0) {
    writeLine();
    writeLine(`    ${colors.dim}Recent conversations:${RESET}`);
    for (const t of recentTranscripts.slice(0, 5)) {
      writeLine(`      ${colors.dim}${t.ago}${RESET} ${t.squad} ${colors.dim}(${t.turns} turns, ~$${t.cost})${RESET}`);
    }
    writeLine(`    ${colors.dim}$ cat .agents/conversations/<squad>/<id>.md${RESET}`);
  }
  writeLine();

  // === READINESS ===
  writeLine(`  ${bold}Readiness${RESET}`);
  writeLine();

  if (coreInstalled === core.length && project.hasProject) {
    writeLine(`    ${colors.green}${icons.success} Ready to run squads${RESET}`);
    writeLine();
    writeLine(`    ${colors.dim}$${RESET} squads run <squad>       ${colors.dim}Run a squad conversation${RESET}`);
    writeLine(`    ${colors.dim}$${RESET} squads status            ${colors.dim}See all squads${RESET}`);
  } else if (coreInstalled === core.length) {
    writeLine(`    ${colors.yellow}${icons.warning} Tools ready, project needed${RESET}`);
    writeLine();
    writeLine(`    ${colors.dim}$${RESET} squads init              ${colors.dim}Initialize a squads project${RESET}`);
  } else {
    const missing = core.filter(r => !r.installed).map(r => r.tool.name);
    writeLine(`    ${colors.red}${icons.error} Missing core tools: ${missing.join(', ')}${RESET}`);
    writeLine();
    for (const r of core.filter(r => !r.installed)) {
      writeLine(`    ${colors.cyan}$${RESET} ${r.tool.installHint}`);
    }
  }

  // Suggest next capability to unlock
  const firstMissingRecommended = recommended.find(r => !r.installed);
  if (firstMissingRecommended && coreInstalled === core.length) {
    writeLine();
    writeLine(`  ${bold}Next unlock${RESET}`);
    writeLine(`    Install ${colors.cyan}${firstMissingRecommended.tool.name}${RESET} → ${firstMissingRecommended.tool.unlocks}`);
    writeLine(`    ${colors.dim}$${RESET} ${firstMissingRecommended.tool.installHint}`);
  }

  writeLine();
}
