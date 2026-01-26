/**
 * squads cron - Manage local launchd schedules for agents (macOS only)
 *
 * NOTE: This command uses macOS launchd for scheduling. It is intentionally
 * macOS-only and will show a warning on other platforms. For cross-platform
 * scheduling, use the VM-based scheduler via `squads trigger`.
 *
 * Commands:
 *   squads cron sync              Sync agent schedules from .md files to launchd
 *   squads cron list [squad]      List scheduled agents
 *   squads cron status            Show launchd status and next runs
 *   squads cron enable <agent>    Enable an agent's schedule
 *   squads cron disable <agent>   Disable an agent's schedule
 *   squads cron logs [agent]      Show execution logs
 */

import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { homedir, platform } from "os";
import matter from "gray-matter";

/**
 * Check if running on macOS and show warning if not
 * @returns true if on macOS, false otherwise
 */
function checkPlatform(): boolean {
  if (platform() !== "darwin") {
    console.log(chalk.yellow("\n  ⚠ squads cron is macOS-only (uses launchd)"));
    console.log(chalk.gray("  For cross-platform scheduling, use: squads trigger\n"));
    return false;
  }
  return true;
}

const HQ_PATH = process.env.HQ_PATH || join(homedir(), "agents-squads", "hq");
const SQUADS_PATH = join(HQ_PATH, ".agents", "squads");
const LOG_DIR = join(HQ_PATH, ".agents", "cron-logs");
const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PREFIX = "com.squads.";

interface ScheduledAgent {
  squad: string;
  agent: string;
  schedule: string;
  enabled: boolean;
  description?: string;
}

interface CronEntry {
  schedule: string;
  command: string;
  agent: string;
  squad: string;
}

/**
 * Parse agent .md file for schedule frontmatter
 * Handles files that start with # heading before ---
 */
function parseAgentSchedule(filePath: string): { schedule?: string; trigger?: string } {
  try {
    const content = readFileSync(filePath, "utf-8");

    // First try standard frontmatter
    const { data } = matter(content);
    if (data.schedule) {
      return { schedule: data.schedule, trigger: data.trigger };
    }

    // Handle files with heading before frontmatter: # Title\n\n---\nfrontmatter\n---
    const frontmatterMatch = content.match(/^(?:#[^\n]*\n\n)?---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const yaml = frontmatterMatch[1];
      const scheduleMatch = yaml.match(/^schedule:\s*["']?([^"'\n#]+)/m);
      const triggerMatch = yaml.match(/^trigger:\s*(\S+)/m);

      return {
        schedule: scheduleMatch ? scheduleMatch[1].trim() : undefined,
        trigger: triggerMatch ? triggerMatch[1].trim() : undefined,
      };
    }

    return {};
  } catch {
    return {};
  }
}

/**
 * Scan all squads for agents with schedules
 */
function scanScheduledAgents(): ScheduledAgent[] {
  const scheduled: ScheduledAgent[] = [];

  if (!existsSync(SQUADS_PATH)) {
    return scheduled;
  }

  for (const squad of readdirSync(SQUADS_PATH)) {
    const squadPath = join(SQUADS_PATH, squad);

    try {
      const files = readdirSync(squadPath);

      for (const file of files) {
        if (!file.endsWith(".md") || file === "SQUAD.md") continue;

        const agentPath = join(squadPath, file);
        const { schedule, trigger } = parseAgentSchedule(agentPath);

        // Include if has schedule (either explicit or trigger: scheduled)
        if (schedule && schedule !== "null") {
          const agent = file.replace(".md", "");
          scheduled.push({
            squad,
            agent,
            schedule: schedule.replace(/"/g, ""),
            enabled: true,
            description: `${squad}/${agent}`,
          });
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  return scheduled;
}

/**
 * Convert cron schedule to launchd CalendarInterval
 * Cron: minute hour dayOfMonth month dayOfWeek
 * Launchd: { Minute, Hour, Day, Month, Weekday }
 */
function cronToLaunchd(cron: string): Record<string, number>[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return [{}];

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const intervals: Record<string, number>[] = [];

  // Handle */N patterns (run every N)
  const parseField = (field: string, key: string): number | number[] | null => {
    if (field === "*") return null;
    if (field.startsWith("*/")) {
      // For */5, we'd need multiple entries - simplify to just run at :00
      return 0;
    }
    if (field.includes(",")) {
      return field.split(",").map(Number);
    }
    return parseInt(field, 10);
  };

  const base: Record<string, number> = {};

  const min = parseField(minute, "Minute");
  const hr = parseField(hour, "Hour");
  const dom = parseField(dayOfMonth, "Day");
  const mon = parseField(month, "Month");
  const dow = parseField(dayOfWeek, "Weekday");

  if (typeof min === "number") base.Minute = min;
  if (typeof hr === "number") base.Hour = hr;
  if (typeof dom === "number") base.Day = dom;
  if (typeof mon === "number") base.Month = mon;
  if (typeof dow === "number") base.Weekday = dow;

  // Handle comma-separated values (multiple intervals)
  if (Array.isArray(hr)) {
    for (const h of hr) {
      intervals.push({ ...base, Hour: h });
    }
  } else if (Array.isArray(dom)) {
    for (const d of dom) {
      intervals.push({ ...base, Day: d });
    }
  } else {
    intervals.push(base);
  }

  return intervals.length > 0 ? intervals : [base];
}

/**
 * Generate plist content for an agent
 */
function generatePlist(agent: ScheduledAgent): string {
  const label = `${PLIST_PREFIX}${agent.squad}.${agent.agent}`;
  const logFile = join(LOG_DIR, `${agent.squad}-${agent.agent}.log`);
  const errorFile = join(LOG_DIR, `${agent.squad}-${agent.agent}.error.log`);

  let squadsPath: string;
  try {
    squadsPath = execSync("which squads", { encoding: "utf-8" }).trim();
  } catch {
    squadsPath = "/usr/local/bin/squads";
  }

  const intervals = cronToLaunchd(agent.schedule);

  // Build CalendarInterval array
  const calendarEntries = intervals.map(interval => {
    const entries = Object.entries(interval)
      .map(([k, v]) => `        <key>${k}</key>\n        <integer>${v}</integer>`)
      .join("\n");
    return `      <dict>\n${entries}\n      </dict>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${squadsPath}</string>
    <string>run</string>
    <string>${agent.squad}</string>
    <string>--agent</string>
    <string>${agent.agent}</string>
    <string>--trigger</string>
    <string>scheduled</string>
    <string>-e</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${HQ_PATH}</string>

  <key>StartCalendarInterval</key>
  <array>
${calendarEntries}
  </array>

  <key>StandardOutPath</key>
  <string>${logFile}</string>

  <key>StandardErrorPath</key>
  <string>${errorFile}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>

  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>`;
}

/**
 * Get plist filename for an agent
 */
function getPlistPath(agent: ScheduledAgent): string {
  return join(LAUNCH_AGENTS_DIR, `${PLIST_PREFIX}${agent.squad}.${agent.agent}.plist`);
}

/**
 * Get all installed squads plists
 */
function getInstalledPlists(): string[] {
  if (!existsSync(LAUNCH_AGENTS_DIR)) return [];

  return readdirSync(LAUNCH_AGENTS_DIR)
    .filter(f => f.startsWith(PLIST_PREFIX) && f.endsWith(".plist"));
}

/**
 * Parse cron schedule to human-readable format
 */
function humanReadableSchedule(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Daily at ${hour}:${minute.padStart(2, "0")}`;
  }

  if (dayOfMonth === "*" && month === "*" && dayOfWeek !== "*") {
    const dayName = days[parseInt(dayOfWeek)] || dayOfWeek;
    return `${dayName} at ${hour}:${minute.padStart(2, "0")}`;
  }

  if (dayOfMonth !== "*" && month === "*") {
    return `Day ${dayOfMonth} at ${hour}:${minute.padStart(2, "0")}`;
  }

  return cron;
}

/**
 * Calculate next run time from cron schedule
 */
function getNextRun(schedule: string): string {
  // Simple calculation - just show the schedule for now
  // Could use a cron parser library for accurate next-run calculation
  return humanReadableSchedule(schedule);
}

/**
 * Sync agent schedules to launchd
 */
async function syncCron(options: { dryRun?: boolean } = {}): Promise<void> {
  console.log(chalk.gray("\n  Scanning agent schedules...\n"));

  const agents = scanScheduledAgents();

  if (agents.length === 0) {
    console.log(chalk.yellow("  No scheduled agents found"));
    return;
  }

  // Ensure directories exist
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  }

  // Get currently installed plists
  const installedPlists = getInstalledPlists();
  const newPlistNames = agents.map(a => `${PLIST_PREFIX}${a.squad}.${a.agent}.plist`);

  // Remove old plists that are no longer needed
  for (const plist of installedPlists) {
    if (!newPlistNames.includes(plist)) {
      const plistPath = join(LAUNCH_AGENTS_DIR, plist);
      const label = plist.replace(".plist", "");

      if (!options.dryRun) {
        try {
          execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`, { encoding: "utf-8" });
          unlinkSync(plistPath);
        } catch {
          // Ignore errors on cleanup
        }
      }
      console.log(chalk.yellow(`  - Removed ${label}`));
    }
  }

  // Group by squad for display
  const bySquad = agents.reduce((acc, a) => {
    (acc[a.squad] = acc[a.squad] || []).push(a);
    return acc;
  }, {} as Record<string, ScheduledAgent[]>);

  let installed = 0;
  let updated = 0;

  for (const [squad, squadAgents] of Object.entries(bySquad)) {
    if (!options.dryRun) {
      console.log(chalk.cyan(`  ${squad}`));
    }

    for (const agent of squadAgents) {
      const plistPath = getPlistPath(agent);
      const plistContent = generatePlist(agent);
      const label = `${PLIST_PREFIX}${agent.squad}.${agent.agent}`;
      const isNew = !existsSync(plistPath);

      if (options.dryRun) {
        console.log(chalk.gray(`  Would ${isNew ? "create" : "update"}: ${label}`));
        continue;
      }

      // Unload if exists
      if (!isNew) {
        try {
          execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`, { encoding: "utf-8" });
        } catch {
          // Ignore
        }
      }

      // Write plist
      writeFileSync(plistPath, plistContent);

      // Load plist
      try {
        execSync(`launchctl load "${plistPath}"`, { encoding: "utf-8" });
        const schedule = humanReadableSchedule(agent.schedule);
        console.log(chalk.gray(`    ${chalk.green("●")} ${agent.agent} ${chalk.dim(`(${schedule})`)}`));

        if (isNew) installed++;
        else updated++;
      } catch (error) {
        console.log(chalk.red(`    ✗ ${agent.agent} (load failed)`));
      }
    }
  }

  if (!options.dryRun) {
    console.log();
    console.log(chalk.green(`  ✓ Synced ${agents.length} agents to launchd`));
    if (installed > 0) console.log(chalk.gray(`    ${installed} new, ${updated} updated`));
    console.log();
  }
}

/**
 * List scheduled agents
 */
async function listCron(squad?: string): Promise<void> {
  const agents = scanScheduledAgents();
  const filtered = squad ? agents.filter(a => a.squad === squad) : agents;

  if (filtered.length === 0) {
    console.log(chalk.gray("\n  No scheduled agents found\n"));
    return;
  }

  console.log(chalk.bold("\n  Scheduled Agents\n"));

  // Group by squad
  const bySquad = filtered.reduce((acc, a) => {
    (acc[a.squad] = acc[a.squad] || []).push(a);
    return acc;
  }, {} as Record<string, ScheduledAgent[]>);

  for (const [squadName, squadAgents] of Object.entries(bySquad)) {
    console.log(chalk.cyan(`  ${squadName}`));

    for (const agent of squadAgents) {
      const status = agent.enabled ? chalk.green("●") : chalk.gray("○");
      const schedule = humanReadableSchedule(agent.schedule);
      console.log(`    ${status} ${agent.agent} ${chalk.dim(schedule)}`);
    }
    console.log();
  }
}

/**
 * Show launchd status
 */
async function cronStatus(): Promise<void> {
  const agents = scanScheduledAgents();
  const installedPlists = getInstalledPlists();

  console.log(chalk.bold("\n  Launchd Status\n"));

  // Installation status
  if (installedPlists.length > 0) {
    console.log(chalk.green(`  ● ${installedPlists.length} agents installed`));
  } else {
    console.log(chalk.yellow("  ○ No agents installed") + chalk.gray(" (run: squads cron sync)"));
  }

  // Defined vs installed
  console.log(chalk.gray(`  ${agents.length} scheduled agents defined in .md files`));

  // Check launchd status
  try {
    const loaded = execSync(`launchctl list | grep "${PLIST_PREFIX}" | wc -l`, { encoding: "utf-8" }).trim();
    console.log(chalk.green(`  ● ${loaded} agents loaded in launchd`));
  } catch {
    console.log(chalk.yellow("  ○ Could not query launchd"));
  }

  console.log();

  // Show loaded agents with status
  if (installedPlists.length > 0) {
    console.log(chalk.bold("  Loaded Agents\n"));

    for (const plist of installedPlists.slice(0, 10)) {
      const label = plist.replace(".plist", "");
      const shortName = label.replace(PLIST_PREFIX, "");

      try {
        const status = execSync(`launchctl list "${label}" 2>/dev/null | grep -E "PID|LastExitStatus" || echo "not running"`, { encoding: "utf-8" });
        const isRunning = status.includes("PID") && !status.includes("PID\" = 0");
        const icon = isRunning ? chalk.green("●") : chalk.gray("○");
        console.log(chalk.gray(`    ${icon} ${shortName}`));
      } catch {
        console.log(chalk.gray(`    ${chalk.yellow("?")} ${shortName}`));
      }
    }

    if (installedPlists.length > 10) {
      console.log(chalk.dim(`    ... and ${installedPlists.length - 10} more`));
    }
    console.log();
  }

  // Show recent logs
  if (existsSync(LOG_DIR)) {
    const logs = readdirSync(LOG_DIR).filter(f => f.endsWith(".log") && !f.includes(".error"));
    if (logs.length > 0) {
      console.log(chalk.bold("  Logs\n"));
      console.log(chalk.gray(`    ${LOG_DIR}`));
      console.log(chalk.dim(`    ${logs.length} log files`));
      console.log();
    }
  }
}

/**
 * Show execution logs
 */
async function showLogs(agent?: string): Promise<void> {
  if (!existsSync(LOG_DIR)) {
    console.log(chalk.gray("\n  No logs yet (run: squads cron sync)\n"));
    return;
  }

  const logs = readdirSync(LOG_DIR).filter(f => f.endsWith(".log"));

  if (agent) {
    // Show specific agent log
    const logFile = logs.find(f => f.includes(agent));
    if (logFile) {
      const content = readFileSync(join(LOG_DIR, logFile), "utf-8");
      const lines = content.split("\n").slice(-50);
      console.log(chalk.bold(`\n  ${logFile}\n`));
      console.log(lines.join("\n"));
    } else {
      console.log(chalk.gray(`\n  No logs for ${agent}\n`));
    }
  } else {
    // List all logs
    console.log(chalk.bold("\n  Cron Logs\n"));
    for (const log of logs) {
      const path = join(LOG_DIR, log);
      const stat = require("fs").statSync(path);
      const modified = stat.mtime.toISOString().split("T")[0];
      console.log(chalk.gray(`    ${log} ${chalk.dim(modified)}`));
    }
    console.log();
  }
}

/**
 * Enable/disable an agent's launchd schedule
 */
async function toggleAgent(agentRef: string, enable: boolean): Promise<void> {
  // Parse squad/agent format
  const [squad, agent] = agentRef.includes("/")
    ? agentRef.split("/")
    : [null, agentRef];

  // Find matching plist
  const installedPlists = getInstalledPlists();
  const matchingPlist = installedPlists.find(p => {
    if (squad) {
      return p === `${PLIST_PREFIX}${squad}.${agent}.plist`;
    }
    return p.includes(`.${agent}.plist`);
  });

  if (!matchingPlist) {
    console.log(chalk.red(`\n  Agent '${agentRef}' not found in launchd`));
    console.log(chalk.gray("  Run 'squads cron sync' first\n"));
    return;
  }

  const plistPath = join(LAUNCH_AGENTS_DIR, matchingPlist);
  const label = matchingPlist.replace(".plist", "");

  try {
    if (enable) {
      execSync(`launchctl load "${plistPath}"`, { encoding: "utf-8" });
      console.log(chalk.green(`\n  ✓ Enabled ${label}\n`));
    } else {
      execSync(`launchctl unload "${plistPath}"`, { encoding: "utf-8" });
      console.log(chalk.yellow(`\n  ○ Disabled ${label}\n`));
    }
  } catch (error) {
    console.log(chalk.red(`\n  Failed to ${enable ? "enable" : "disable"} ${label}\n`));
  }
}

export function registerCronCommand(program: Command): void {
  const cron = program
    .command("cron")
    .description("Manage local cron schedules for agents (macOS only)");

  cron
    .command("sync")
    .description("Sync agent schedules from .md files to launchd")
    .option("-n, --dry-run", "Show what would be installed without installing")
    .action(async (options) => {
      if (!checkPlatform()) return;
      await syncCron({ dryRun: options.dryRun });
    });

  cron
    .command("list [squad]")
    .description("List scheduled agents")
    .action(async (squad?: string) => {
      if (!checkPlatform()) return;
      await listCron(squad);
    });

  cron
    .command("status")
    .description("Show cron status and next runs")
    .action(async () => {
      if (!checkPlatform()) return;
      await cronStatus();
    });

  cron
    .command("logs [agent]")
    .description("Show execution logs")
    .action(async (agent?: string) => {
      if (!checkPlatform()) return;
      await showLogs(agent);
    });

  cron
    .command("enable <agent>")
    .description("Enable an agent's schedule")
    .action(async (agent: string) => {
      if (!checkPlatform()) return;
      await toggleAgent(agent, true);
    });

  cron
    .command("disable <agent>")
    .description("Disable an agent's schedule")
    .action(async (agent: string) => {
      if (!checkPlatform()) return;
      await toggleAgent(agent, false);
    });
}
