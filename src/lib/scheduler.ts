/**
 * Unified scheduler infrastructure for `squads run` daemon mode.
 *
 * Consolidates autonomous.ts PID/cooldown/pause management with
 * daemon.ts outcome grading and PR review feedback. Single source
 * of truth for all daemon-mode state.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  mkdirSync,
  appendFileSync,
  openSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { findSquadsDir, listSquads, type Routine } from './squad-parser.js';
import { cronMatches, getNextCronRun, parseCooldown } from './cron.js';
import { writeLine } from './terminal.js';
import chalk from 'chalk';

// ── Constants ──────────────────────────────────────────────────────────

const DAEMON_DIR = join(homedir(), '.squads');
const PID_FILE = join(DAEMON_DIR, 'daemon.pid');
const DAEMON_LOG = join(DAEMON_DIR, 'daemon.log');
const PAUSE_FILE = join(DAEMON_DIR, 'daemon.paused');
const COOLDOWN_FILE = join(DAEMON_DIR, 'daemon.cooldowns.json');

// Also check legacy filenames for backwards compat
const LEGACY_PID_FILE = join(DAEMON_DIR, 'autonomous.pid');
const LEGACY_PAUSE_FILE = join(DAEMON_DIR, 'autonomous.paused');
const LEGACY_COOLDOWN_FILE = join(DAEMON_DIR, 'autonomous.cooldowns.json');

export const MAX_CONCURRENT = parseInt(process.env.SQUADS_MAX_CONCURRENT || '5');
export const AGENT_TIMEOUT_MIN = parseInt(process.env.SQUADS_AGENT_TIMEOUT || '30');
export const EVAL_INTERVAL_SEC = parseInt(process.env.SQUADS_EVAL_INTERVAL || '60');

// ── Types ──────────────────────────────────────────────────────────────

export interface RoutineWithSquad extends Routine {
  squad: string;
}

export interface RunningAgent {
  squad: string;
  agent: string;
  pid: number;
  startedAt: number;
  logFile: string;
}

// ── Daemon Log ─────────────────────────────────────────────────────────

export function daemonLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    if (!existsSync(DAEMON_DIR)) mkdirSync(DAEMON_DIR, { recursive: true });
    appendFileSync(DAEMON_LOG, line);
  } catch { /* ignore */ }
}

export function getDaemonLogPath(): string {
  return DAEMON_LOG;
}

// ── PID Management ─────────────────────────────────────────────────────

export function isDaemonRunning(): { running: boolean; pid?: number } {
  // Check new path first, then legacy
  for (const pidFile of [PID_FILE, LEGACY_PID_FILE]) {
    if (!existsSync(pidFile)) continue;
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim());
    if (isNaN(pid)) continue;
    try {
      process.kill(pid, 0);
      return { running: true, pid };
    } catch {
      try { unlinkSync(pidFile); } catch { /* ignore */ }
    }
  }
  return { running: false };
}

export function writeDaemonPid(): void {
  if (!existsSync(DAEMON_DIR)) mkdirSync(DAEMON_DIR, { recursive: true });
  writeFileSync(PID_FILE, process.pid.toString());
}

export function cleanupDaemonPid(): void {
  for (const pidFile of [PID_FILE, LEGACY_PID_FILE]) {
    try { unlinkSync(pidFile); } catch { /* ignore */ }
  }
}

export function spawnDaemonProcess(): ReturnType<typeof spawn> {
  if (!existsSync(DAEMON_DIR)) mkdirSync(DAEMON_DIR, { recursive: true });
  if (!existsSync(DAEMON_LOG)) writeFileSync(DAEMON_LOG, '');
  const logFd = openSync(DAEMON_LOG, 'a');

  const child = spawn(
    process.execPath,
    [process.argv[1], 'run', '--daemon-internal'],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, SQUADS_DAEMON: '1' },
    }
  );
  child.unref();
  return child;
}

// ── Pause / Resume ─────────────────────────────────────────────────────

export function isPaused(): { paused: boolean; reason?: string; since?: string } {
  for (const pauseFile of [PAUSE_FILE, LEGACY_PAUSE_FILE]) {
    if (!existsSync(pauseFile)) continue;
    try {
      const data = JSON.parse(readFileSync(pauseFile, 'utf-8'));
      return { paused: true, reason: data.reason, since: data.since };
    } catch {
      return { paused: true, reason: 'unknown' };
    }
  }
  return { paused: false };
}

export function pauseDaemon(reason: string): void {
  if (!existsSync(DAEMON_DIR)) mkdirSync(DAEMON_DIR, { recursive: true });
  writeFileSync(PAUSE_FILE, JSON.stringify({
    reason,
    since: new Date().toISOString(),
  }));
  daemonLog(`PAUSED: ${reason}`);
}

export function resumeDaemon(): void {
  for (const pauseFile of [PAUSE_FILE, LEGACY_PAUSE_FILE]) {
    try { unlinkSync(pauseFile); } catch { /* ignore */ }
  }
  daemonLog('RESUMED');
}

// ── Persistent Cooldowns ───────────────────────────────────────────────

export function loadCooldowns(): Map<string, number> {
  const map = new Map<string, number>();
  // Check new file first, then legacy
  for (const file of [COOLDOWN_FILE, LEGACY_COOLDOWN_FILE]) {
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      for (const [key, ts] of Object.entries(data)) {
        if (typeof ts === 'number') map.set(key, ts);
      }
      return map;
    } catch { /* corrupt — start fresh */ }
  }
  return map;
}

export function saveCooldowns(map: Map<string, number>): void {
  try {
    if (!existsSync(DAEMON_DIR)) mkdirSync(DAEMON_DIR, { recursive: true });
    const obj: Record<string, number> = {};
    for (const [key, ts] of map) obj[key] = ts;
    writeFileSync(COOLDOWN_FILE, JSON.stringify(obj));
  } catch { /* best effort */ }
}

// ── Running Agents (PID file tracking) ─────────────────────────────────

function getLogsDir(): string | null {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return null;
  return join(squadsDir, '..', 'logs');
}

export function getRunningAgents(): RunningAgent[] {
  const logsDir = getLogsDir();
  if (!logsDir || !existsSync(logsDir)) return [];

  const running: RunningAgent[] = [];
  let squadDirs: string[];
  try { squadDirs = readdirSync(logsDir); } catch { return []; }

  for (const squadDir of squadDirs) {
    const squadPath = join(logsDir, squadDir);
    let files: string[];
    try { files = readdirSync(squadPath); } catch { continue; }

    for (const file of files) {
      if (!file.endsWith('.pid')) continue;
      const pidPath = join(squadPath, file);
      try {
        const pid = parseInt(readFileSync(pidPath, 'utf-8').trim());
        if (isNaN(pid)) continue;
        try { process.kill(pid, 0); } catch {
          try { unlinkSync(pidPath); } catch { /* ignore */ }
          continue;
        }
        const match = file.match(/^(.+)-(\d+)\.pid$/);
        if (!match) continue;
        running.push({
          squad: squadDir,
          agent: match[1],
          pid,
          startedAt: parseInt(match[2]),
          logFile: pidPath.replace('.pid', '.log'),
        });
      } catch { continue; }
    }
  }
  return running;
}

export function killAgent(pid: number, pidFile: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    process.kill(pid, signal);
    if (signal === 'SIGTERM') {
      setTimeout(() => {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch { /* already dead */ }
      }, 5000);
    }
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

// ── Routine Collection ─────────────────────────────────────────────────

function parseRoutinesFromFile(filePath: string): Routine[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const routines: Routine[] = [];

  const routinesMatch = content.match(/##+ \w*\s*Routines[\s\S]*?```yaml\s*\n([\s\S]*?)```/i);
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
        .map(a => a.trim().replace(/["']/g, ''))
        .filter(Boolean);

      routines.push({
        name,
        schedule: scheduleMatch[1].trim().replace(/["']/g, ''),
        agents,
        model: modelMatch ? modelMatch[1] as 'opus' | 'sonnet' | 'haiku' : undefined,
        enabled: enabledMatch ? enabledMatch[1] === 'true' : true,
        priority: priorityMatch ? parseInt(priorityMatch[1]) : undefined,
        cooldown: cooldownMatch ? cooldownMatch[1].trim() : undefined,
      });
    }
  }
  return routines;
}

export function collectRoutines(): RoutineWithSquad[] {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return [];

  const routines: RoutineWithSquad[] = [];
  const squadNames = listSquads(squadsDir);

  for (const name of squadNames) {
    const squadFile = join(squadsDir, name, 'SQUAD.md');
    for (const routine of parseRoutinesFromFile(squadFile)) {
      routines.push({ ...routine, squad: name });
    }
  }
  return routines;
}

// ── Timeout Enforcement ────────────────────────────────────────────────

export function enforceTimeouts(): void {
  const running = getRunningAgents();
  for (const agent of running) {
    const runtimeMin = (Date.now() - agent.startedAt) / 60000;
    if (runtimeMin > AGENT_TIMEOUT_MIN) {
      daemonLog(`TIMEOUT: ${agent.squad}/${agent.agent} (PID ${agent.pid}, ${Math.round(runtimeMin)}min)`);
      const pidFile = agent.logFile.replace('.log', '.pid');
      killAgent(agent.pid, pidFile);
    }
  }
}

// ── Status Display ─────────────────────────────────────────────────────

export function showDaemonStatus(): void {
  const daemon = isDaemonRunning();
  const routines = collectRoutines();
  const enabled = routines.filter(r => r.enabled !== false);
  const running = getRunningAgents();

  writeLine(chalk.bold('\n  squads daemon\n'));

  // Daemon status
  const pause = isPaused();
  if (daemon.running) {
    if (pause.paused) {
      writeLine(`  ${chalk.yellow('●')} Paused ${chalk.gray(`(PID ${daemon.pid})`)}`);
      writeLine(`    ${chalk.yellow(pause.reason || 'No reason')} ${chalk.gray(`since ${pause.since || 'unknown'}`)}`);
    } else {
      writeLine(`  ${chalk.green('●')} Running ${chalk.gray(`(PID ${daemon.pid})`)}`);
    }
  } else {
    writeLine(`  ${chalk.red('●')} Not running`);
  }
  writeLine();

  // Running agents
  if (running.length > 0) {
    writeLine(chalk.cyan('  Active Agents'));
    for (const agent of running) {
      const runtimeMin = Math.round((Date.now() - agent.startedAt) / 60000);
      const warn = runtimeMin > AGENT_TIMEOUT_MIN * 0.8 ? chalk.yellow(' !') : '';
      writeLine(`  ${chalk.green('●')} ${chalk.cyan(agent.squad)}/${agent.agent} ${chalk.gray(`${runtimeMin}min`)}${warn} ${chalk.gray(`PID ${agent.pid}`)}`);
    }
    writeLine();
  }

  // Routines
  writeLine(chalk.cyan('  Routines'));
  writeLine(`  ${enabled.length} enabled / ${routines.length} total, ${running.length}/${MAX_CONCURRENT} running`);
  writeLine();

  // Next runs
  if (enabled.length > 0) {
    writeLine(chalk.cyan('  Next Runs'));
    const now = new Date();
    const nextRuns: { squad: string; agent: string; nextRun: Date }[] = [];

    for (const r of enabled) {
      const next = getNextCronRun(r.schedule, now);
      for (const agent of r.agents) {
        nextRuns.push({ squad: r.squad, agent, nextRun: next });
      }
    }

    nextRuns
      .sort((a, b) => a.nextRun.getTime() - b.nextRun.getTime())
      .slice(0, 10)
      .forEach(run => {
        const timeStr = run.nextRun.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = run.nextRun.toDateString() === now.toDateString()
          ? 'today'
          : run.nextRun.toLocaleDateString([], { month: 'short', day: 'numeric' });
        writeLine(`  ${chalk.gray(timeStr)} ${chalk.gray(dateStr)} ${chalk.cyan(run.squad)}/${run.agent}`);
      });
  }

  writeLine();
  writeLine(chalk.gray('  Start:   squads run'));
  writeLine(chalk.gray('  Stop:    squads run --stop'));
  writeLine(chalk.gray('  Pause:   squads run --pause'));
  writeLine(chalk.gray('  Resume:  squads run --resume'));
  writeLine(chalk.gray(`  Log:     tail -f ${DAEMON_LOG}`));
  writeLine();
}
