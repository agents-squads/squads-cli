/**
 * squads slack - Manage Slack integration
 *
 * Commands:
 *   squads slack sync              Sync squad channels with Slack
 *   squads slack channels          List Slack channels
 *   squads slack test              Test Slack connection
 */

import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { findSquadsDir } from "../lib/squad-parser.js";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

interface SlackChannel {
  id: string;
  name: string;
  is_archived: boolean;
  topic?: {
    value: string;
  };
}

interface SlackApiResponse<T> {
  ok: boolean;
  error?: string;
  channels?: T[];
  channel?: T;
}

interface SquadChannelInfo {
  name: string;
  channel: string;
  topic: string;
}

/**
 * Make a Slack API call
 */
async function slackApi<T>(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>
): Promise<T> {
  if (!SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN not set in environment");
  }

  const url = `https://slack.com/api/${endpoint}`;
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const data = (await res.json()) as SlackApiResponse<T>;

  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }

  return data as T;
}

/**
 * Get all Slack channels
 */
async function getSlackChannels(): Promise<SlackChannel[]> {
  const response = await slackApi<SlackChannel>(
    "GET",
    "conversations.list?types=public_channel&limit=500"
  );
  return (response as unknown as SlackApiResponse<SlackChannel>).channels || [];
}

/**
 * Create a Slack channel
 */
async function createChannel(name: string): Promise<SlackChannel> {
  const response = await slackApi<SlackChannel>("POST", "conversations.create", {
    name,
    is_private: false,
  });
  return (response as unknown as SlackApiResponse<SlackChannel>).channel!;
}

/**
 * Archive a Slack channel
 */
async function archiveChannel(channelId: string): Promise<void> {
  await slackApi("POST", "conversations.archive", { channel: channelId });
}

/**
 * Set channel topic
 */
async function setChannelTopic(channelId: string, topic: string): Promise<void> {
  await slackApi("POST", "conversations.setTopic", {
    channel: channelId,
    topic,
  });
}

/**
 * Parse SQUAD.md to extract channel info
 */
function parseSquadChannel(squadDir: string, squadName: string): SquadChannelInfo | null {
  const squadFile = join(squadDir, squadName, "SQUAD.md");
  if (!existsSync(squadFile)) {
    return null;
  }

  const content = readFileSync(squadFile, "utf-8");

  // Extract channel name from "## Slack Channel" section
  // Format: `#channel-name` - description
  const channelMatch = content.match(/## Slack Channel\s*\n`#([^`]+)`\s*-\s*([^\n]+)/);
  if (!channelMatch) {
    return null;
  }

  const channel = channelMatch[1];
  const topic = channelMatch[2].trim();

  return {
    name: squadName,
    channel,
    topic,
  };
}

/**
 * Get all squad channel configs
 */
function getSquadChannels(): SquadChannelInfo[] {
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    throw new Error("Could not find .agents/squads directory");
  }

  const squadDirs = readdirSync(squadsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name);

  const channels: SquadChannelInfo[] = [];
  for (const squad of squadDirs) {
    const info = parseSquadChannel(squadsDir, squad);
    if (info) {
      channels.push(info);
    }
  }

  return channels;
}

/**
 * Sync squad channels with Slack
 */
async function syncCommand(options: { dryRun?: boolean }): Promise<void> {
  console.log(chalk.bold("\nSlack Channel Sync\n"));

  if (!SLACK_BOT_TOKEN) {
    console.log(chalk.red("Error: SLACK_BOT_TOKEN not set"));
    console.log(chalk.gray("Add to .env: SLACK_BOT_TOKEN=xoxb-..."));
    process.exit(1);
  }

  // Get squad channel configs from SQUAD.md files
  const squadChannels = getSquadChannels();
  console.log(chalk.gray(`Found ${squadChannels.length} squads with Slack channels defined\n`));

  // Get existing Slack channels
  const slackChannels = await getSlackChannels();
  const slackChannelMap = new Map(slackChannels.map((c) => [c.name, c]));

  // Squad channel names (expected to exist)
  const expectedChannels = new Set(squadChannels.map((s) => s.channel));

  // Track actions
  const created: string[] = [];
  const updated: string[] = [];
  const archived: string[] = [];
  const skipped: string[] = [];

  // Create or update channels for each squad
  for (const squad of squadChannels) {
    const existing = slackChannelMap.get(squad.channel);

    if (!existing) {
      // Channel doesn't exist - create it
      if (options.dryRun) {
        console.log(chalk.green(`  + Would create #${squad.channel}`));
        created.push(squad.channel);
      } else {
        try {
          const channel = await createChannel(squad.channel);
          await setChannelTopic(channel.id, squad.topic);
          console.log(chalk.green(`  + Created #${squad.channel}`));
          created.push(squad.channel);
        } catch (err) {
          console.log(chalk.red(`  ! Failed to create #${squad.channel}: ${err}`));
        }
      }
    } else if (existing.is_archived) {
      // Channel exists but is archived - skip (don't auto-unarchive)
      console.log(chalk.yellow(`  ~ #${squad.channel} is archived (manual unarchive required)`));
      skipped.push(squad.channel);
    } else {
      // Channel exists - check if topic needs update
      const currentTopic = existing.topic?.value || "";
      if (currentTopic !== squad.topic) {
        if (options.dryRun) {
          console.log(chalk.blue(`  ~ Would update topic for #${squad.channel}`));
          updated.push(squad.channel);
        } else {
          try {
            await setChannelTopic(existing.id, squad.topic);
            console.log(chalk.blue(`  ~ Updated topic for #${squad.channel}`));
            updated.push(squad.channel);
          } catch (err) {
            console.log(chalk.red(`  ! Failed to update #${squad.channel}: ${err}`));
          }
        }
      } else {
        console.log(chalk.gray(`  - #${squad.channel} (in sync)`));
      }
    }
  }

  // Find channels to archive (exist in Slack but not in squads)
  // Only consider channels that look like squad channels (no dashes except for client-*)
  const knownPrefixes = ["engineering", "customer", "intelligence", "marketing", "research",
    "product", "company", "website", "finance", "analytics", "cli", "data", "growth", "client-"];

  for (const [name, channel] of slackChannelMap) {
    // Skip if it's an expected channel
    if (expectedChannels.has(name)) continue;

    // Skip archived channels
    if (channel.is_archived) continue;

    // Only archive if it looks like a squad channel (matches known prefixes)
    const looksLikeSquadChannel = knownPrefixes.some((prefix) => name.startsWith(prefix));
    if (!looksLikeSquadChannel) continue;

    if (options.dryRun) {
      console.log(chalk.yellow(`  - Would archive #${name} (no matching squad)`));
      archived.push(name);
    } else {
      try {
        await archiveChannel(channel.id);
        console.log(chalk.yellow(`  - Archived #${name} (no matching squad)`));
        archived.push(name);
      } catch (err) {
        console.log(chalk.red(`  ! Failed to archive #${name}: ${err}`));
      }
    }
  }

  // Summary
  console.log(chalk.bold("\nSummary:"));
  if (options.dryRun) {
    console.log(chalk.gray("  (dry run - no changes made)"));
  }
  if (created.length > 0) {
    console.log(chalk.green(`  Created: ${created.length}`));
  }
  if (updated.length > 0) {
    console.log(chalk.blue(`  Updated: ${updated.length}`));
  }
  if (archived.length > 0) {
    console.log(chalk.yellow(`  Archived: ${archived.length}`));
  }
  if (created.length === 0 && updated.length === 0 && archived.length === 0) {
    console.log(chalk.gray("  Everything in sync!"));
  }
}

/**
 * List Slack channels
 */
async function channelsCommand(): Promise<void> {
  console.log(chalk.bold("\nSlack Channels\n"));

  if (!SLACK_BOT_TOKEN) {
    console.log(chalk.red("Error: SLACK_BOT_TOKEN not set"));
    process.exit(1);
  }

  const channels = await getSlackChannels();
  const squadChannels = getSquadChannels();
  const expectedChannels = new Set(squadChannels.map((s) => s.channel));

  // Group channels
  const squadRelated: SlackChannel[] = [];
  const other: SlackChannel[] = [];

  for (const channel of channels) {
    if (expectedChannels.has(channel.name)) {
      squadRelated.push(channel);
    } else {
      other.push(channel);
    }
  }

  console.log(chalk.cyan("Squad Channels:"));
  for (const channel of squadRelated.sort((a, b) => a.name.localeCompare(b.name))) {
    const archived = channel.is_archived ? chalk.gray(" (archived)") : "";
    console.log(`  #${channel.name}${archived}`);
  }

  if (other.length > 0) {
    console.log(chalk.gray("\nOther Channels:"));
    for (const channel of other.sort((a, b) => a.name.localeCompare(b.name))) {
      const archived = channel.is_archived ? chalk.gray(" (archived)") : "";
      console.log(chalk.gray(`  #${channel.name}${archived}`));
    }
  }

  console.log(chalk.gray(`\nTotal: ${channels.length} channels`));
}

/**
 * Test Slack connection
 */
async function testCommand(): Promise<void> {
  console.log(chalk.bold("\nSlack Connection Test\n"));

  if (!SLACK_BOT_TOKEN) {
    console.log(chalk.red("Error: SLACK_BOT_TOKEN not set"));
    console.log(chalk.gray("Add to .env: SLACK_BOT_TOKEN=xoxb-..."));
    process.exit(1);
  }

  try {
    const response = await slackApi<{
      url: string;
      team: string;
      user: string;
      team_id: string;
      user_id: string;
      bot_id: string;
    }>("POST", "auth.test");

    // Cast to access the properties directly since slackApi returns the full response
    const data = response as unknown as {
      ok: boolean;
      url: string;
      team: string;
      user: string;
      team_id: string;
      user_id: string;
      bot_id: string;
    };

    console.log(chalk.green("  Connection successful!"));
    console.log(chalk.gray(`  Workspace: ${data.team}`));
    console.log(chalk.gray(`  Bot: ${data.user}`));
    console.log(chalk.gray(`  URL: ${data.url}`));

    // Check scopes
    console.log(chalk.bold("\nRequired Scopes:"));
    const requiredScopes = ["channels:manage", "channels:read", "chat:write"];
    console.log(chalk.gray("  (run 'squads slack sync --dry-run' to verify permissions)"));
    for (const scope of requiredScopes) {
      console.log(chalk.gray(`  - ${scope}`));
    }
  } catch (err) {
    console.log(chalk.red(`  Connection failed: ${err}`));
    process.exit(1);
  }
}

/**
 * Register slack command group
 */
export function registerSlackCommand(program: Command): void {
  const slack = program
    .command("slack")
    .description("Manage Slack integration");

  slack
    .command("sync")
    .description("Sync squad channels with Slack (create missing, archive deleted)")
    .option("-d, --dry-run", "Show what would happen without making changes")
    .action((options) => syncCommand(options));

  slack
    .command("channels")
    .description("List Slack channels")
    .action(() => channelsCommand());

  slack
    .command("test")
    .description("Test Slack connection")
    .action(() => testCommand());

  // Default action: show help
  slack.action(() => {
    slack.outputHelp();
  });
}
