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
import {
  colors,
  RESET,
  gradient,
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

// Verifies an actual Claude session — installed is not the same as authenticated.
// `claude whoami` is cheap and preferred; a real prompt only runs if whoami is
// unavailable. Any nonzero exit or "Not logged in" output means NOT authenticated.
function verifyClaudeSession(): AuthResult {
  try {
    const whoami = execSync('claude whoami 2>&1', { encoding: 'utf-8', timeout: 5000 });
    if (/not logged in/i.test(whoami)) {
      return { name: 'Claude', authenticated: false, detail: 'run: claude /login' };
    }
    const emailMatch = whoami.match(/[\w.+-]+@[\w.-]+/);
    return { name: 'Claude', authenticated: true, detail: emailMatch ? emailMatch[0] : 'OAuth' };
  } catch {
    try {
      const probe = execSync('claude -p "ok" 2>&1', { encoding: 'utf-8', timeout: 10000 });
      if (/not logged in/i.test(probe)) {
        return { name: 'Claude', authenticated: false, detail: 'run: claude /login' };
      }
      return { name: 'Claude', authenticated: true, detail: 'OAuth' };
    } catch {
      return { name: 'Claude', authenticated: false, detail: 'run: claude /login' };
    }
  }
}

function checkAuth(): AuthResult[] {
  const results: AuthResult[] = [];

  // Claude auth — API key bypasses OAuth; otherwise verify an actual session
  if (process.env.ANTHROPIC_API_KEY) {
    results.push({ name: 'Claude', authenticated: true, detail: 'API key' });
  } else {
    results.push(verifyClaudeSession());
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

  // Google Cloud auth — show active account
  try {
    const output = execSync('gcloud config get-value account 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const account = output.trim();
    if (account && account !== '(unset)') {
      results.push({ name: 'GCP', authenticated: true, detail: account });
    } else {
      results.push({ name: 'GCP', authenticated: false, detail: 'gcloud auth login' });
    }
  } catch {
    // gcloud not installed — skip
  }

  return results;
}

interface ExecutionCheckResult {
  canExecute: boolean;
  reason?: string;
  hint?: string;
}

function checkExecutionPath(): ExecutionCheckResult {
  // Verify claude CLI can actually run — not just that the binary exists
  try {
    execSync('claude --version 2>&1', { encoding: 'utf-8', timeout: 5000 });
  } catch {
    return {
      canExecute: false,
      reason: 'claude CLI found but failed to run',
      hint: 'Try: npm install -g @anthropic-ai/claude-code',
    };
  }

  // Verify squads-cli provider module loads without errors
  try {
    execSync('node -e "require(\'./dist/lib/providers.js\')" 2>&1', {
      encoding: 'utf-8',
      timeout: 5000,
      cwd: process.env.SQUADS_CLI_ROOT || process.cwd(),
    });
  } catch {
    // Non-fatal: only warn if this fails (run path may still work)
  }

  return { canExecute: true };
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

/**
 * Resolve a process's working directory (sync, via lsof). Empty string when
 * unknown — callers must treat unknown as "not ours" (fail closed), otherwise
 * doctor attributes other projects' runs to this one (#1054).
 */
function getPidCwd(pid: string): string {
  try {
    const out = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
    const line = out.split('\n').find(l => l.startsWith('n'));
    return line ? line.slice(1).trim() : '';
  } catch {
    return '';
  }
}

/** True iff cwd is the project root or inside it. */
function cwdInProject(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root.endsWith('/') ? root : root + '/');
}

function checkRunningSquads(): RunningSquad[] {
  try {
    // "Running" means running FOR THIS PROJECT — ps aux is machine-wide
    // (all terminals, all users), so every candidate PID is scoped by its
    // actual cwd before being reported (#1054).
    const root = findProjectRoot();
    if (!root) return [];
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

      const cwd = getPidCwd(pid);
      if (!cwd || !cwdInProject(cwd, root)) continue;

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
    // Same project scoping as checkRunningSquads (#1054): a daemon running
    // for another project on this machine is not THIS project's daemon.
    const projectRoot = findProjectRoot();
    if (!projectRoot) return { running: false };
    const output = execSync('ps aux 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
    for (const line of output.split('\n')) {
      if (line.includes('squads autonomous') && !line.includes('grep')) {
        const pid = line.trim().split(/\s+/)[1];
        const cwd = getPidCwd(pid);
        if (!cwd || !cwdInProject(cwd, projectRoot)) continue;
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

  // Gather all data
  const toolResults = TOOLS.map(checkTool);
  const core = toolResults.filter(r => r.tool.category === 'core');
  const recommended = toolResults.filter(r => r.tool.category === 'recommended');
  const optional = toolResults.filter(r => r.tool.category === 'optional');
  const coreInstalled = core.filter(r => r.installed).length;
  const authResults = checkAuth();
  const executionCheck = checkExecutionPath();
  const project = checkProject();
  const running = checkRunningSquads();
  const daemon = checkDaemon();
  const recentTranscripts = project.hasProject ? getRecentTranscripts(project.squadsDir!) : [];

  // === TOOLS ===
  function printTools(label: string, items: ToolResult[]) {
    const count = items.filter(r => r.installed).length;
    writeLine(`  ${colors.dim}${label}${RESET} ${colors.dim}(${count}/${items.length})${RESET}`);
    for (const r of items) {
      const icon = r.installed ? `${colors.green}✓${RESET}` : `${colors.red}✗${RESET}`;
      const ver = r.installed && r.version ? ` ${colors.dim}${r.version.slice(0, 20)}${RESET}` : '';
      const hint = !r.installed ? `  ${colors.dim}→ ${r.tool.unlocks}${RESET}` : '';
      writeLine(`    ${icon} ${colors.cyan}${padEnd(r.tool.name, 10)}${RESET}${r.tool.purpose}${ver}${hint}`);
      if (!r.installed && options.verbose) {
        writeLine(`      ${colors.dim}$ ${r.tool.installHint}${RESET}`);
      }
    }
  }

  printTools('Core', core);
  printTools('Recommended', recommended);
  if (options.verbose || optional.some(r => r.installed)) {
    printTools('Optional', optional);
  }
  writeLine();

  // === AUTH ===
  const authLine = authResults.map(a => {
    const icon = a.authenticated ? `${colors.green}✓${RESET}` : `${colors.red}✗${RESET}`;
    const detail = a.detail ? ` ${colors.dim}(${a.detail})${RESET}` : '';
    return `${icon} ${a.name}${detail}`;
  }).join('  ');
  writeLine(`  ${authLine}`);
  writeLine();

  // === PROJECT ===
  if (project.hasProject) {
    writeLine(`  ${colors.cyan}${project.squadCount}${RESET} squads  ${colors.dim}│${RESET}  ${colors.cyan}${project.agentCount}${RESET} agents  ${colors.dim}│${RESET}  ${colors.dim}${project.squadsDir}${RESET}`);
  } else {
    writeLine(`  ${colors.yellow}○${RESET} No project found ${colors.dim}— squads init${RESET}`);
  }
  writeLine();

  // === LIVE ===
  const daemonStatus = daemon.running
    ? `${colors.green}✓${RESET} daemon`
    : `${colors.dim}○ daemon off${RESET}`;
  const runCount = running.length > 0
    ? `${colors.green}${running.length}${RESET} running`
    : `${colors.dim}0 running${RESET}`;
  writeLine(`  ${daemonStatus}  ${colors.dim}│${RESET}  ${runCount}`);

  for (const r of running) {
    const task = r.task ? `${colors.dim}${r.task.slice(0, 50)}${RESET}` : '';
    writeLine(`    ${colors.green}▸${RESET} ${colors.cyan}${r.squad}${RESET} ${task}`);
  }

  if (recentTranscripts.length > 0) {
    writeLine();
    for (const t of recentTranscripts.slice(0, 5)) {
      writeLine(`    ${colors.dim}${padEnd(t.ago, 9)}${RESET} ${colors.cyan}${padEnd(t.squad, 13)}${RESET} ${colors.dim}${t.turns} turns  ~$${t.cost}${RESET}`);
    }
  }
  writeLine();

  // === READINESS ===
  if (coreInstalled < core.length) {
    const missing = core.filter(r => !r.installed).map(r => r.tool.name);
    writeLine(`  ${colors.red}✗ Missing core tools: ${missing.join(', ')}${RESET}`);
    process.exitCode = 1;
  } else if (!executionCheck.canExecute) {
    writeLine(`  ${colors.red}✗ Cannot execute agents${RESET}`);
    writeLine(`  ${colors.dim}${executionCheck.reason}${RESET}`);
    if (executionCheck.hint) {
      writeLine(`  ${colors.dim}→ ${executionCheck.hint}${RESET}`);
    }
    writeLine(`  ${colors.dim}Run \`squads run <squad>\` to see the full error.${RESET}`);
  } else if (!project.hasProject) {
    writeLine(`  ${colors.yellow}○ Run: squads init${RESET}`);
  } else {
    writeLine(`  ${colors.green}✓ Ready${RESET}`);
  }
  writeLine();
}
