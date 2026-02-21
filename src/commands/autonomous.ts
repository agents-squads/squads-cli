/**
 * squads autonomous - Local scheduling daemon for autonomous agent execution
 *
 * Commands:
 *   squads autonomous start     Start the daemon (detached background process)
 *   squads autonomous stop      Stop the daemon
 *   squads autonomous status    Show daemon status, running agents, next runs
 *
 * The daemon reads SQUAD.md routines, evaluates cron schedules, and spawns
 * agents via `squads run --background`. No database. No Redis. Just a process.
 *
 * Architecture: Layer 2 in docs/ARCHITECTURE.md
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  mkdirSync,
  appendFileSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn, execSync } from "child_process";
import { findSquadsDir, listSquads, Routine } from "../lib/squad-parser.js";
import {
  cronMatches,
  getNextCronRun,
  parseCooldown,
} from "../lib/cron.js";

// Daemon state directory — persistent across runs
const DAEMON_DIR = join(homedir(), ".squads");
const PID_FILE = join(DAEMON_DIR, "autonomous.pid");
const DAEMON_LOG = join(DAEMON_DIR, "autonomous.log");

// Configuration from env vars (all optional)
const MAX_CONCURRENT = parseInt(process.env.SQUADS_MAX_CONCURRENT || "5");
const AGENT_TIMEOUT_MIN = parseInt(process.env.SQUADS_AGENT_TIMEOUT || "30");
const EVAL_INTERVAL_SEC = parseInt(process.env.SQUADS_EVAL_INTERVAL || "60");

interface RoutineWithSquad extends Routine {
  squad: string;
}

// =============================================================================
// Cron Evaluator - now imported from lib/cron.ts
// =============================================================================
// Functions: cronMatches, getNextCronRun, parseCooldown are now in lib/cron.ts

// =============================================================================
// Routine Collection (from SQUAD.md files)
// =============================================================================

/**
 * Parse routines from SQUAD.md YAML blocks
 */
function parseRoutinesFromFile(filePath: string): Routine[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const routines: Routine[] = [];

  const routinesMatch = content.match(
    /##+ Routines[\s\S]*?```yaml\s*\n([\s\S]*?)```/i
  );
  if (!routinesMatch) return [];

  let yamlContent = routinesMatch[1];
  yamlContent = yamlContent.replace(/^\s*routines:\s*\n?/, "");
  yamlContent = "\n" + yamlContent.trim();

  const routineBlocks = yamlContent.split(/\n\s*- name:\s*/);

  for (const block of routineBlocks) {
    if (!block.trim()) continue;

    const lines = block.split("\n");
    const name = lines[0].trim();
    if (!name) continue;

    const scheduleMatch = block.match(/schedule:\s*["']?([^"'\n#]+)/);
    const agentsMatch = block.match(/agents:\s*\[(.*?)\]/);
    const modelMatch = block.match(/model:\s*(\w+)/);
    const enabledMatch = block.match(/enabled:\s*(true|false)/);
    const priorityMatch = block.match(/priority:\s*(\d+)/);
    const cooldownMatch = block.match(
      /cooldown:\s*["']?([^"'\n]+)["']?/
    );

    if (scheduleMatch && agentsMatch) {
      const agents = agentsMatch[1]
        .split(",")
        .map((a) => a.trim().replace(/["']/g, ""))
        .filter(Boolean);

      routines.push({
        name,
        schedule: scheduleMatch[1].trim().replace(/["']/g, ""),
        agents,
        model: modelMatch
          ? (modelMatch[1] as "opus" | "sonnet" | "haiku")
          : undefined,
        enabled: enabledMatch ? enabledMatch[1] === "true" : true,
        priority: priorityMatch ? parseInt(priorityMatch[1]) : undefined,
        cooldown: cooldownMatch ? cooldownMatch[1].trim() : undefined,
      });
    }
  }

  return routines;
}

function collectRoutines(): RoutineWithSquad[] {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return [];

  const routines: RoutineWithSquad[] = [];
  const squadNames = listSquads(squadsDir);

  for (const name of squadNames) {
    const squadFile = join(squadsDir, name, "SQUAD.md");
    const squadRoutines = parseRoutinesFromFile(squadFile);

    for (const routine of squadRoutines) {
      routines.push({ ...routine, squad: name });
    }
  }

  return routines;
}

// =============================================================================
// PID File Management
// =============================================================================

/**
 * Find the .agents/logs directory (relative to project root)
 */
function getLogsDir(): string | null {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return null;
  // squadsDir is .agents/squads, logs are at .agents/logs
  return join(squadsDir, "..", "logs");
}

/**
 * Count currently running agents by checking PID files
 */
function getRunningAgents(): {
  squad: string;
  agent: string;
  pid: number;
  startedAt: number;
  logFile: string;
}[] {
  const logsDir = getLogsDir();
  if (!logsDir || !existsSync(logsDir)) return [];

  const running: {
    squad: string;
    agent: string;
    pid: number;
    startedAt: number;
    logFile: string;
  }[] = [];

  let squadDirs: string[];
  try {
    squadDirs = readdirSync(logsDir);
  } catch {
    return [];
  }

  for (const squadDir of squadDirs) {
    const squadPath = join(logsDir, squadDir);
    let files: string[];
    try {
      files = readdirSync(squadPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".pid")) continue;

      const pidPath = join(squadPath, file);
      try {
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim());
        if (isNaN(pid)) continue;

        // Check if process is alive
        try {
          process.kill(pid, 0);
        } catch {
          // Process dead — clean up orphan PID file
          try {
            unlinkSync(pidPath);
          } catch {
            /* ignore */
          }
          continue;
        }

        // Extract agent name and timestamp from filename: agent-timestamp.pid
        const match = file.match(/^(.+)-(\d+)\.pid$/);
        if (!match) continue;

        const agentName = match[1];
        const timestamp = parseInt(match[2]);

        running.push({
          squad: squadDir,
          agent: agentName,
          pid,
          startedAt: timestamp,
          logFile: pidPath.replace(".pid", ".log"),
        });
      } catch {
        continue;
      }
    }
  }

  return running;
}

/**
 * Kill an agent by PID and clean up its PID file
 */
function killAgent(pid: number, pidFile: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
  try {
    process.kill(pid, signal);
    // Give it a moment, then check if it's dead
    if (signal === "SIGTERM") {
      setTimeout(() => {
        try {
          process.kill(pid, 0); // Still alive?
          process.kill(pid, "SIGKILL"); // Force kill
        } catch {
          /* already dead */
        }
      }, 5000);
    }
    try {
      unlinkSync(pidFile);
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Cooldown Parsing - now imported from lib/cron.ts
// =============================================================================
// Function: parseCooldown is now in lib/cron.ts

// =============================================================================
// Daemon Core
// =============================================================================

/**
 * Log a message to the daemon log file with timestamp
 */
function daemonLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    appendFileSync(DAEMON_LOG, line);
  } catch {
    // Can't log — ignore
  }
}

/**
 * The main daemon loop. Runs as a long-lived process.
 */
async function daemonLoop(): Promise<void> {
  daemonLog("Daemon started");

  // Track last spawn time per routine to enforce cooldowns
  const lastSpawned = new Map<string, number>();

  const tick = async () => {
    try {
      const now = new Date();
      now.setSeconds(0, 0); // Round to minute

      // 1. Collect enabled routines
      const routines = collectRoutines().filter((r) => r.enabled !== false);

      // 2. Check running agents
      const running = getRunningAgents();
      const _runningCount = running.length;

      // 3. Timeout enforcement
      for (const agent of running) {
        const runtimeMin = (Date.now() - agent.startedAt) / 60000;
        if (runtimeMin > AGENT_TIMEOUT_MIN) {
          daemonLog(
            `TIMEOUT: ${agent.squad}/${agent.agent} (PID ${agent.pid}, ${Math.round(runtimeMin)}min)`
          );
          const pidFile = agent.logFile.replace(".log", ".pid");
          killAgent(agent.pid, pidFile);
        }
      }

      // 4. Evaluate cron schedules
      for (const routine of routines) {
        if (!cronMatches(routine.schedule, now)) continue;

        for (const agentName of routine.agents) {
          const key = `${routine.squad}/${agentName}`;

          // Cooldown check
          if (routine.cooldown) {
            const last = lastSpawned.get(key);
            const cooldownMs = parseCooldown(routine.cooldown);
            if (last && Date.now() - last < cooldownMs) {
              continue;
            }
          }

          // Already running check
          const alreadyRunning = running.some(
            (r) => r.squad === routine.squad && r.agent === agentName
          );
          if (alreadyRunning) continue;

          // Concurrency check
          const currentRunning = getRunningAgents().length;
          if (currentRunning >= MAX_CONCURRENT) {
            daemonLog(
              `SKIP: ${key} — concurrency limit (${currentRunning}/${MAX_CONCURRENT})`
            );
            continue;
          }

          // Spawn the agent
          daemonLog(`SPAWN: ${key} (routine: ${routine.name})`);
          try {
            const modelFlag = routine.model ? `--model ${routine.model}` : "";
            execSync(
              `squads run ${routine.squad}/${agentName} --background ${modelFlag} --trigger scheduled`,
              {
                cwd: process.cwd(),
                stdio: "ignore",
                timeout: 10000, // 10s to spawn
              }
            );
            lastSpawned.set(key, Date.now());
            daemonLog(`SPAWNED: ${key}`);
          } catch (err) {
            daemonLog(`ERROR: Failed to spawn ${key}: ${err}`);
          }
        }
      }
    } catch (err) {
      daemonLog(`TICK ERROR: ${err}`);
    }
  };

  // Run immediately, then on interval
  await tick();
  setInterval(tick, EVAL_INTERVAL_SEC * 1000);

  // Keep process alive
  process.on("SIGTERM", () => {
    daemonLog("Received SIGTERM, shutting down");
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    process.exit(0);
  });

  process.on("SIGINT", () => {
    daemonLog("Received SIGINT, shutting down");
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
}

// =============================================================================
// Daemon Lifecycle (check/start/stop)
// =============================================================================

function isRunning(): { running: boolean; pid?: number } {
  if (!existsSync(PID_FILE)) return { running: false };

  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
  if (isNaN(pid)) return { running: false };

  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Stale PID file
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    return { running: false };
  }
}

async function startScheduler(): Promise<void> {
  const status = isRunning();
  if (status.running) {
    console.log(
      chalk.yellow(`Daemon already running (PID ${status.pid})`)
    );
    console.log(chalk.gray(`  Log: ${DAEMON_LOG}`));
    return;
  }

  // Ensure daemon directory exists
  if (!existsSync(DAEMON_DIR)) {
    mkdirSync(DAEMON_DIR, { recursive: true });
  }

  const routines = collectRoutines().filter((r) => r.enabled !== false);
  if (routines.length === 0) {
    console.log(chalk.yellow("No enabled routines found."));
    console.log(
      chalk.gray("Add routines to SQUAD.md files under ### Routines section.")
    );
    return;
  }

  // Check if we're being invoked as the daemon itself (--daemon flag)
  if (process.argv.includes("--daemon")) {
    // We ARE the daemon — run the loop
    writeFileSync(PID_FILE, process.pid.toString());
    await daemonLoop();
    // daemonLoop never returns (infinite setInterval)
    // Keep the event loop alive
    await new Promise(() => {});
    return;
  }

  // Spawn a detached daemon process
  const child = spawn(
    process.execPath, // node
    [process.argv[1], "autonomous", "start", "--daemon"],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    }
  );
  child.unref();

  // Wait briefly for PID file to appear
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const check = isRunning();
  if (check.running) {
    console.log(chalk.green(`\n  Daemon started (PID ${check.pid})`));
  } else {
    console.log(chalk.green("\n  Daemon starting..."));
  }

  console.log(chalk.gray(`  Log: ${DAEMON_LOG}`));
  console.log(chalk.gray(`  Config: SQUAD.md routines\n`));

  // Show what's scheduled
  console.log(chalk.cyan("  Routines"));
  const bySquad = new Map<string, RoutineWithSquad[]>();
  for (const r of routines) {
    if (!bySquad.has(r.squad)) bySquad.set(r.squad, []);
    bySquad.get(r.squad)!.push(r);
  }

  for (const [squad, squadRoutines] of bySquad) {
    for (const r of squadRoutines) {
      const next = getNextCronRun(r.schedule);
      const timeStr = next.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      console.log(
        `  ${chalk.green("●")} ${chalk.cyan(squad)}/${r.name} ${chalk.gray(r.schedule)} ${chalk.gray(`→ ${timeStr}`)}`
      );
    }
  }

  console.log(
    chalk.gray(`\n  ${routines.length} routines, max ${MAX_CONCURRENT} concurrent`)
  );
  console.log(chalk.gray("  Stop: squads autonomous stop"));
  console.log(chalk.gray(`  Monitor: tail -f ${DAEMON_LOG}\n`));
}

function stopScheduler(): void {
  const status = isRunning();

  if (!status.running) {
    console.log(chalk.gray("Daemon not running"));
    return;
  }

  try {
    process.kill(status.pid!, "SIGTERM");
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    console.log(chalk.green(`Daemon stopped (PID ${status.pid})`));
  } catch (error) {
    console.error(chalk.red(`Failed to stop daemon: ${error}`));
  }
}

async function showStatus(): Promise<void> {
  const daemon = isRunning();
  const routines = collectRoutines();
  const enabled = routines.filter((r) => r.enabled !== false);
  const running = getRunningAgents();

  console.log(chalk.bold("\n  Autonomous Scheduler\n"));

  // Daemon status
  if (daemon.running) {
    console.log(
      `  ${chalk.green("●")} Daemon running ${chalk.gray(`(PID ${daemon.pid})`)}`
    );
  } else {
    console.log(`  ${chalk.red("●")} Daemon not running`);
  }
  console.log();

  // Running agents
  if (running.length > 0) {
    console.log(chalk.cyan("  Running Agents"));
    for (const agent of running) {
      const runtimeMin = Math.round((Date.now() - agent.startedAt) / 60000);
      const timeoutWarning =
        runtimeMin > AGENT_TIMEOUT_MIN * 0.8 ? chalk.yellow(" ⚠") : "";
      console.log(
        `  ${chalk.green("●")} ${chalk.cyan(agent.squad)}/${agent.agent} ${chalk.gray(`${runtimeMin}min`)}${timeoutWarning} ${chalk.gray(`PID ${agent.pid}`)}`
      );
    }
    console.log();
  }

  // Routine summary
  console.log(chalk.cyan("  Routines"));
  console.log(
    `  ${enabled.length} enabled / ${routines.length} total, ${running.length}/${MAX_CONCURRENT} running`
  );
  console.log();

  // Next 10 upcoming runs
  if (enabled.length > 0) {
    console.log(chalk.cyan("  Next Runs"));

    const now = new Date();
    const nextRuns: {
      squad: string;
      routine: string;
      agent: string;
      nextRun: Date;
    }[] = [];

    for (const r of enabled) {
      const next = getNextCronRun(r.schedule, now);
      for (const agent of r.agents) {
        nextRuns.push({
          squad: r.squad,
          routine: r.name,
          agent,
          nextRun: next,
        });
      }
    }

    nextRuns
      .sort((a, b) => a.nextRun.getTime() - b.nextRun.getTime())
      .slice(0, 10)
      .forEach((run) => {
        const timeStr = run.nextRun.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        const dateStr =
          run.nextRun.toDateString() === now.toDateString()
            ? "today"
            : run.nextRun.toLocaleDateString([], {
                month: "short",
                day: "numeric",
              });
        console.log(
          `  ${chalk.gray(timeStr)} ${chalk.gray(dateStr)} ${chalk.cyan(run.squad)}/${run.agent}`
        );
      });
  }

  console.log();
  console.log(chalk.gray("  Commands:"));
  console.log(chalk.gray("  $ squads autonomous start   Start daemon"));
  console.log(chalk.gray("  $ squads autonomous stop    Stop daemon"));
  console.log(chalk.gray(`  $ tail -f ${DAEMON_LOG}`));
  console.log();
}

// =============================================================================
// Command Registration
// =============================================================================

export function registerAutonomousCommand(program: Command): void {
  const autonomous = program
    .command("autonomous")
    .alias("auto")
    .description("Local scheduling daemon for autonomous agent execution")
    .action(() => { autonomous.outputHelp(); });

  autonomous
    .command("start")
    .description("Start the scheduling daemon")
    .action(async () => {
      await startScheduler();
    });

  autonomous
    .command("stop")
    .description("Stop the scheduling daemon")
    .action(() => {
      stopScheduler();
    });

  autonomous
    .command("status")
    .description("Show daemon status, running agents, and next runs")
    .action(async () => {
      await showStatus();
    });
}
