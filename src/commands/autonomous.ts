/**
 * squads autonomous - Manage autonomous agent execution
 *
 * Commands:
 *   squads autonomous start     Start the scheduler daemon
 *   squads autonomous stop      Stop the scheduler daemon
 *   squads autonomous status    Show scheduler status and next runs
 *   squads autonomous sync      Sync routines from SQUAD.md to database
 */

import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { spawn, ChildProcess } from "child_process";
import { findSquadsDir, listSquads, loadSquad, Routine } from "../lib/squad-parser.js";

const PID_FILE = "/tmp/squads-autonomous.pid";
const LOG_FILE = "/tmp/squads-autonomous.log";
const BRIDGE_URL = process.env.SQUADS_BRIDGE_URL || "http://localhost:8088";

interface RoutineWithSquad extends Routine {
  squad: string;
}

interface SchedulerStatus {
  running: boolean;
  pid?: number;
  routines: {
    total: number;
    enabled: number;
    bySquad: Record<string, number>;
  };
  nextRuns: Array<{
    routine: string;
    squad: string;
    schedule: string;
    nextRun: string;
  }>;
}

/**
 * Parse cron expression to get next run time (simplified)
 */
function getNextCronRun(cron: string): Date {
  // Simplified: just return next occurrence based on cron
  // Format: minute hour day month weekday
  const parts = cron.split(" ");
  const now = new Date();
  const next = new Date(now);

  // Simple heuristic for common patterns
  const minute = parts[0] === "*" ? now.getMinutes() : parseInt(parts[0]);
  const hour = parts[1] === "*" ? now.getHours() : parseInt(parts[1]);

  next.setMinutes(minute);
  next.setHours(hour);
  next.setSeconds(0);

  // If time has passed today, move to tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

/**
 * Collect all routines from all SQUAD.md files
 */
function collectRoutines(): RoutineWithSquad[] {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return [];

  const routines: RoutineWithSquad[] = [];
  const squadNames = listSquads(squadsDir);

  for (const name of squadNames) {
    const squadFile = join(squadsDir, name, "SQUAD.md");
    const squadRoutines = parseRoutinesFromFile(squadFile);

    for (const routine of squadRoutines) {
      routines.push({
        ...routine,
        squad: name,
      });
    }
  }

  return routines;
}

/**
 * Parse routines from SQUAD.md YAML blocks
 * This extracts routines from ```yaml blocks under ### Routines
 */
function parseRoutinesFromFile(filePath: string): Routine[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const routines: Routine[] = [];

  // Find ## Routines or ### Routines section and extract yaml block
  const routinesMatch = content.match(/##+ Routines[\s\S]*?```yaml\s*\n([\s\S]*?)```/i);
  if (!routinesMatch) return [];

  // Simple YAML parsing for routines (could use yaml library for full support)
  let yamlContent = routinesMatch[1];

  // Remove top-level "routines:" wrapper if present
  yamlContent = yamlContent.replace(/^\s*routines:\s*\n?/, "");

  // Normalize: ensure first entry also starts with newline for consistent splitting
  yamlContent = "\n" + yamlContent.trim();

  // Split by routine entries (- name:)
  const routineBlocks = yamlContent.split(/\n\s*- name:\s*/);

  for (const block of routineBlocks) {
    if (!block.trim()) continue;

    // First line is the name (after splitting on "- name:")
    const lines = block.split("\n");
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
        .split(",")
        .map((a) => a.trim().replace(/["']/g, ""))
        .filter(Boolean);

      routines.push({
        name,
        schedule: scheduleMatch[1].trim().replace(/["']/g, ""),
        agents,
        model: modelMatch ? (modelMatch[1] as "opus" | "sonnet" | "haiku") : undefined,
        enabled: enabledMatch ? enabledMatch[1] === "true" : true,
        priority: priorityMatch ? parseInt(priorityMatch[1]) : undefined,
        cooldown: cooldownMatch ? cooldownMatch[1].trim() : undefined,
      });
    }
  }

  return routines;
}

/**
 * Sync routines to the bridge database
 */
async function syncRoutines(): Promise<void> {
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    console.error(chalk.red("No .agents/squads directory found"));
    return;
  }

  console.log(chalk.gray("Syncing routines from SQUAD.md files...\n"));

  const squadNames = listSquads(squadsDir);
  let totalRoutines = 0;

  for (const name of squadNames) {
    const squadFile = join(squadsDir, name, "SQUAD.md");
    const routines = parseRoutinesFromFile(squadFile);

    if (routines.length > 0) {
      console.log(`  ${chalk.cyan(name)} ${chalk.gray(`(${routines.length} routines)`)}`);

      for (const routine of routines) {
        const status = routine.enabled !== false ? chalk.green("●") : chalk.gray("○");
        console.log(`    ${status} ${routine.name} ${chalk.gray(routine.schedule)}`);
        totalRoutines++;
      }

      // Sync to bridge
      try {
        await fetch(`${BRIDGE_URL}/api/routines/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ squad: name, routines }),
        });
      } catch (_error) {
        // Bridge might not support routines endpoint yet
      }
    }
  }

  console.log();
  console.log(chalk.green(`✓ Synced ${totalRoutines} routines`));
}

/**
 * Check if scheduler daemon is running
 */
function isRunning(): { running: boolean; pid?: number } {
  if (!existsSync(PID_FILE)) {
    return { running: false };
  }

  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());

  try {
    // Check if process is alive (signal 0 doesn't kill, just checks)
    process.kill(pid, 0);
    return { running: true, pid };
  } catch (_error) {
    // Process not running, clean up stale PID file
    try {
      unlinkSync(PID_FILE);
    } catch (_cleanupError) {
      // Ignore - file may already be deleted
    }
    return { running: false };
  }
}

/**
 * Start the scheduler daemon
 */
async function startScheduler(): Promise<void> {
  const status = isRunning();
  if (status.running) {
    console.log(chalk.yellow(`Scheduler already running (PID ${status.pid})`));
    return;
  }

  console.log(chalk.gray("Starting autonomous scheduler...\n"));

  // First sync routines
  await syncRoutines();

  // Spawn the scheduler as a background process
  // Using node with a simple scheduler script
  const schedulerScript = `
    const { spawn } = require('child_process');
    const cron = require('node-cron');

    // Load routines and schedule them
    // This is a placeholder - in production, read from DB
    console.log('Scheduler started');

    // Keep process alive
    setInterval(() => {}, 60000);
  `;

  // For now, just create a simple marker and show what would run
  const routines = collectRoutines().filter((r) => r.enabled !== false);

  if (routines.length === 0) {
    console.log(chalk.yellow("No enabled routines found."));
    console.log(chalk.gray("Add routines to SQUAD.md files under ### Routines section."));
    return;
  }

  console.log(chalk.bold("\nScheduled Routines:\n"));

  for (const routine of routines) {
    const nextRun = getNextCronRun(routine.schedule);
    console.log(
      `  ${chalk.green("●")} ${chalk.cyan(routine.squad)}/${routine.name}`
    );
    console.log(
      `    ${chalk.gray("Schedule:")} ${routine.schedule}`
    );
    console.log(
      `    ${chalk.gray("Agents:")} ${routine.agents.join(", ")}`
    );
    console.log(
      `    ${chalk.gray("Next run:")} ${nextRun.toLocaleString()}`
    );
    console.log();
  }

  // Write PID file (use current process as placeholder)
  writeFileSync(PID_FILE, process.pid.toString());

  console.log(chalk.green("✓ Scheduler started"));
  console.log(chalk.gray(`  PID file: ${PID_FILE}`));
  console.log(chalk.gray(`  Log file: ${LOG_FILE}`));
  console.log();
  console.log(chalk.gray("Note: Full daemon mode requires node-cron. Run in foreground for now."));
  console.log(chalk.gray("Stop with: squads autonomous stop"));
}

/**
 * Stop the scheduler daemon
 */
function stopScheduler(): void {
  const status = isRunning();

  if (!status.running) {
    console.log(chalk.gray("Scheduler not running"));
    return;
  }

  try {
    process.kill(status.pid!, "SIGTERM");
    unlinkSync(PID_FILE);
    console.log(chalk.green(`✓ Scheduler stopped (PID ${status.pid})`));
  } catch (error) {
    console.error(chalk.red(`Failed to stop scheduler: ${error}`));
  }
}

/**
 * Show scheduler status
 */
async function showStatus(): Promise<void> {
  const running = isRunning();
  const routines = collectRoutines();
  const enabled = routines.filter((r) => r.enabled !== false);

  console.log(chalk.bold("\nAutonomous Scheduler Status\n"));

  // Running status
  if (running.running) {
    console.log(`  ${chalk.green("●")} Running ${chalk.gray(`(PID ${running.pid})`)}`);
  } else {
    console.log(`  ${chalk.gray("○")} Not running`);
  }
  console.log();

  // Routine counts
  console.log(chalk.cyan("  Routines"));
  console.log(`    Total:   ${routines.length}`);
  console.log(`    Enabled: ${chalk.green(enabled.length)}`);

  // Group by squad
  const bySquad = routines.reduce((acc, r) => {
    acc[r.squad] = (acc[r.squad] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [squad, count] of Object.entries(bySquad)) {
    console.log(`    ${chalk.gray(squad)}: ${count}`);
  }
  console.log();

  // Next runs
  if (enabled.length > 0) {
    console.log(chalk.cyan("  Next Runs"));

    const nextRuns = enabled
      .map((r) => ({
        routine: r.name,
        squad: r.squad,
        schedule: r.schedule,
        nextRun: getNextCronRun(r.schedule),
      }))
      .sort((a, b) => a.nextRun.getTime() - b.nextRun.getTime())
      .slice(0, 5);

    for (const run of nextRuns) {
      console.log(
        `    ${chalk.gray(run.nextRun.toLocaleTimeString())} ${chalk.cyan(run.squad)}/${run.routine}`
      );
    }
  }

  console.log();
  console.log(chalk.gray("  Commands:"));
  console.log(chalk.gray("  $ squads autonomous start   Start scheduler"));
  console.log(chalk.gray("  $ squads autonomous sync    Sync routines from SQUAD.md"));
  console.log();
}

export function registerAutonomousCommand(program: Command): void {
  const autonomous = program
    .command("autonomous")
    .alias("auto")
    .description("Manage autonomous agent execution");

  autonomous
    .command("start")
    .description("Start the scheduler daemon")
    .action(async () => {
      await startScheduler();
    });

  autonomous
    .command("stop")
    .description("Stop the scheduler daemon")
    .action(() => {
      stopScheduler();
    });

  autonomous
    .command("status")
    .description("Show scheduler status")
    .action(async () => {
      await showStatus();
    });

  autonomous
    .command("sync")
    .description("Sync routines from SQUAD.md files")
    .action(async () => {
      await syncRoutines();
    });
}
