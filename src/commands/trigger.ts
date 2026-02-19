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

const API_URL = process.env.SQUADS_API_URL || process.env.SCHEDULER_URL || "http://localhost:8090";

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

interface SchedulerStats {
  triggers: {
    total: number;
    enabled: number;
    fired_24h: number;
  };
  executions_24h: {
    total_24h: number;
    completed: number;
    failed: number;
    running: number;
    queued: number;
  };
}

async function fetchScheduler<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
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

  try {
    const result = await fetchScheduler<{ synced: number; triggers: string[]; errors: Array<{ name: string; error: string }> }>(
      "/triggers/sync",
      { method: "POST" }
    );

    if (result.errors && result.errors.length > 0) {
      console.log(chalk.yellow(`Synced with ${result.errors.length} error(s):`));
      for (const err of result.errors) {
        console.log(chalk.red(`  - ${err.name}: ${err.error}`));
      }
    }

    console.log(chalk.green(`Synced ${result.synced} trigger(s)`));
    if (result.triggers && result.triggers.length > 0) {
      for (const name of result.triggers) {
        console.log(chalk.gray(`  - ${name}`));
      }
    }
  } catch (error: unknown) {
    const isConnectionError = error instanceof Error &&
      (error.cause?.toString().includes('ECONNREFUSED') ||
       error.message.includes('fetch failed'));

    if (isConnectionError) {
      console.error(chalk.red("\n  API not running\n"));
      console.log(chalk.gray("  The sync command requires the API to be running.\n"));
      console.log(`  ${chalk.cyan("$ squads stack start")}    Start the local stack`);
      console.log(`  ${chalk.cyan("$ squads health")}        Check service status\n`);
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red("Sync failed:"), message);
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

async function showStatus(): Promise<void> {
  try {
    const stats = await fetchScheduler<SchedulerStats>("/stats");

    console.log(chalk.bold("\nScheduler Status\n"));

    console.log(chalk.cyan("  Triggers"));
    console.log(`    Total:     ${stats.triggers.total}`);
    console.log(`    Enabled:   ${chalk.green(stats.triggers.enabled)}`);
    console.log(`    Fired 24h: ${stats.triggers.fired_24h}`);

    console.log(chalk.cyan("\n  Executions (24h)"));
    console.log(`    Completed: ${chalk.green(stats.executions_24h.completed)}`);
    console.log(`    Failed:    ${chalk.red(stats.executions_24h.failed)}`);
    console.log(`    Running:   ${chalk.yellow(stats.executions_24h.running)}`);
    console.log(`    Queued:    ${stats.executions_24h.queued}`);
    console.log();
  } catch {
    console.error(chalk.red("Scheduler not running or unreachable"));
    console.log(chalk.gray(`  Expected at: ${API_URL}`));
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
