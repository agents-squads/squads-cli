/**
 * squads trigger - Manage smart triggers
 *
 * Commands:
 *   squads trigger list [squad]     List triggers
 *   squads trigger sync             Sync SQUAD.md triggers to scheduler
 *   squads trigger fire <name>      Manually fire a trigger
 *   squads trigger enable <name>    Enable a trigger
 *   squads trigger disable <name>   Disable a trigger
 *   squads trigger status           Show scheduler status
 */

import { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "fs";

const SCHEDULER_URL = process.env.SCHEDULER_URL || "http://localhost:8090";

interface Trigger {
  id: string;
  name: string;
  squad: string;
  agent: string | null;
  enabled: boolean;
  priority: number;
  cooldown: string;
  last_fired: string | null;
  fire_count: number;
}

interface RecentExecution {
  squad: string;
  agent: string;
  status: string;
  created_at: string;
  duration_seconds: number | null;
}

interface SchedulerStats {
  triggers: {
    total: number;
    enabled: number;
    fired_24h: number;
  };
  current: {
    running: number;
    queued: number;
  };
  executions_1h: {
    total: number;
    completed: number;
    failed: number;
  };
  executions_24h: {
    total: number;
    completed: number;
    failed: number;
  };
  recent: RecentExecution[];
}

async function fetchScheduler<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${SCHEDULER_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Scheduler error: ${res.status} ${error}`);
  }

  return res.json() as T;
}

async function listTriggers(squad?: string): Promise<void> {
  let triggers: Trigger[];

  try {
    const params = squad ? `?squad=${squad}` : "";
    triggers = await fetchScheduler<Trigger[]>(`/triggers${params}`);
  } catch (error: unknown) {
    // Check for connection refused (scheduler offline)
    const isConnectionError = error instanceof Error &&
      (error.cause?.toString().includes('ECONNREFUSED') ||
       error.message.includes('fetch failed'));

    if (isConnectionError) {
      console.error(chalk.red("\n  Scheduler not running\n"));
      console.log(chalk.gray("  The trigger system requires the local stack to be running.\n"));
      console.log(`  ${chalk.cyan("$ squads stack start")}    Start the local stack`);
      console.log(`  ${chalk.cyan("$ squads stack status")}   Check stack status\n`);
      return;
    }

    // Re-throw unexpected errors
    throw error;
  }

  if (triggers.length === 0) {
    console.log(chalk.gray("No triggers found"));
    return;
  }

  console.log(chalk.bold("\nSmart Triggers\n"));

  const grouped = triggers.reduce(
    (acc, t) => {
      (acc[t.squad] = acc[t.squad] || []).push(t);
      return acc;
    },
    {} as Record<string, Trigger[]>
  );

  for (const [squadName, squadTriggers] of Object.entries(grouped)) {
    console.log(chalk.cyan(`  ${squadName}`));

    for (const t of squadTriggers) {
      const status = t.enabled ? chalk.green("●") : chalk.gray("○");
      const agent = t.agent ? `/${t.agent}` : "";
      const fires = t.fire_count > 0 ? chalk.gray(` (${t.fire_count}x)`) : "";

      console.log(
        `    ${status} ${t.name}${chalk.gray(agent)} P${t.priority}${fires}`
      );
    }
    console.log();
  }
}

async function syncTriggers(): Promise<void> {
  console.log(chalk.gray("Syncing triggers from SQUAD.md files...\n"));

  // Call the Python sync script
  const { execSync } = await import("child_process");
  const hqPath = process.env.HQ_PATH || `${process.env.HOME}/agents-squads/hq`;

  try {
    // Use venv Python if available, fallback to system python3
    const venvPython = `${hqPath}/squads-scheduler/.venv/bin/python`;
    const pythonCmd = existsSync(venvPython) ? venvPython : "python3";
    const output = execSync(
      `${pythonCmd} ${hqPath}/squads-scheduler/sync_triggers.py`,
      { encoding: "utf-8", cwd: hqPath }
    );
    console.log(output);
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string };
    console.error(chalk.red("Sync failed:"), execError.stderr || execError);
  }
}

async function fireTrigger(name: string): Promise<void> {
  // Find trigger by name
  const triggers = await fetchScheduler<Trigger[]>(`/triggers`);
  const trigger = triggers.find((t) => t.name === name);

  if (!trigger) {
    console.error(chalk.red(`Trigger '${name}' not found`));
    return;
  }

  console.log(
    chalk.gray(`Firing ${trigger.squad}/${trigger.agent || "*"}...`)
  );

  interface Execution {
    id: string;
    status: string;
  }

  const execution = await fetchScheduler<Execution>(
    `/triggers/${trigger.id}/fire`,
    { method: "POST" }
  );

  console.log(chalk.green(`✓ Queued execution ${execution.id.slice(0, 8)}`));
}

async function toggleTrigger(name: string, enable: boolean): Promise<void> {
  const triggers = await fetchScheduler<Trigger[]>(`/triggers`);
  const trigger = triggers.find((t) => t.name === name);

  if (!trigger) {
    console.error(chalk.red(`Trigger '${name}' not found`));
    return;
  }

  await fetchScheduler(`/triggers/${trigger.id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: enable }),
  });

  const status = enable ? chalk.green("enabled") : chalk.gray("disabled");
  console.log(`${trigger.name} ${status}`);
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
}

function formatTimeAgo(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function successRate(completed: number, failed: number): string {
  const total = completed + failed;
  if (total === 0) return "";
  const rate = Math.round((completed / total) * 100);
  const color = rate >= 95 ? chalk.green : rate >= 80 ? chalk.yellow : chalk.red;
  return color(` (${rate}%)`);
}

async function showStatus(): Promise<void> {
  try {
    const stats = await fetchScheduler<SchedulerStats>("/stats");

    console.log(chalk.bold("\nScheduler Status\n"));

    // Triggers
    console.log(chalk.cyan("  Triggers"));
    console.log(`    Total:     ${stats.triggers.total}`);
    console.log(`    Enabled:   ${chalk.green(stats.triggers.enabled)}`);
    console.log(`    Fired 24h: ${stats.triggers.fired_24h}`);

    // Current state (NOW)
    console.log(chalk.cyan("\n  Now"));
    const running = stats.current.running;
    const queued = stats.current.queued;
    if (running > 0 || queued > 0) {
      console.log(`    Running:   ${chalk.yellow(running)}`);
      console.log(`    Queued:    ${queued}`);
    } else {
      console.log(chalk.gray("    No active executions"));
    }

    // Last 1 hour
    console.log(chalk.cyan("\n  Last 1h"));
    const h1 = stats.executions_1h;
    if (h1.total > 0) {
      console.log(`    Completed: ${chalk.green(h1.completed)}${successRate(h1.completed, h1.failed)}`);
      if (h1.failed > 0) console.log(`    Failed:    ${chalk.red(h1.failed)}`);
    } else {
      console.log(chalk.gray("    No executions"));
    }

    // Last 24 hours
    console.log(chalk.cyan("\n  Last 24h"));
    const h24 = stats.executions_24h;
    console.log(`    Completed: ${chalk.green(h24.completed)}${successRate(h24.completed, h24.failed)}`);
    if (h24.failed > 0) console.log(`    Failed:    ${chalk.red(h24.failed)}`);

    // Recent activity
    if (stats.recent && stats.recent.length > 0) {
      console.log(chalk.cyan("\n  Recent Activity"));
      for (const r of stats.recent.slice(0, 5)) {
        const status = r.status === "completed" ? chalk.green("✓") : chalk.red("✗");
        const duration = r.duration_seconds ? chalk.gray(` (${formatDuration(r.duration_seconds)})`) : "";
        const time = chalk.gray(formatTimeAgo(r.created_at));
        console.log(`    ${status} ${r.squad}/${r.agent}${duration} ${time}`);
      }
    }

    console.log();
  } catch {
    console.error(chalk.red("Scheduler not running or unreachable"));
    console.log(chalk.gray(`  Expected at: ${SCHEDULER_URL}`));
  }
}

export function registerTriggerCommand(program: Command): void {
  const trigger = program
    .command("trigger")
    .description("Manage smart triggers");

  trigger
    .command("list [squad]")
    .description("List triggers")
    .action(async (squad?: string) => {
      await listTriggers(squad);
    });

  trigger
    .command("sync")
    .description("Sync SQUAD.md triggers to scheduler")
    .action(async () => {
      await syncTriggers();
    });

  trigger
    .command("fire <name>")
    .description("Manually fire a trigger")
    .action(async (name: string) => {
      await fireTrigger(name);
    });

  trigger
    .command("enable <name>")
    .description("Enable a trigger")
    .action(async (name: string) => {
      await toggleTrigger(name, true);
    });

  trigger
    .command("disable <name>")
    .description("Disable a trigger")
    .action(async (name: string) => {
      await toggleTrigger(name, false);
    });

  trigger
    .command("status")
    .description("Show scheduler status")
    .action(async () => {
      await showStatus();
    });
}
