/**
 * Slack integration for squad notifications and approvals.
 *
 * Provides:
 * - Session notifications (start/complete/fail)
 * - Approval requests with interactive buttons
 * - Approval polling (wait for human response)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { findSquadsDir } from './squad-parser.js';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// Approval tiers from SQUAD.md
export type ApprovalTier = 'auto' | 'notify' | 'approve' | 'confirm';

export interface SlackChannel {
  id: string;
  name: string;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: SlackChannel;
  channels?: SlackChannel[];
  messages?: SlackMessage[];
}

interface SlackMessage {
  ts: string;
  text: string;
  blocks?: SlackBlock[];
  reactions?: { name: string }[];
}

interface SlackBlock {
  type: string;
  elements?: { text?: string }[];
}

/**
 * Make a Slack API call
 */
export async function slackApi<T = SlackApiResponse>(
  method: 'GET' | 'POST',
  endpoint: string,
  body?: Record<string, unknown>
): Promise<T> {
  if (!SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN not set in environment');
  }

  const url = `https://slack.com/api/${endpoint}`;
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const data = await res.json() as SlackApiResponse;

  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }

  return data as T;
}

/**
 * Check if Slack is configured
 */
export function isSlackConfigured(): boolean {
  return !!SLACK_BOT_TOKEN;
}

/**
 * Get channel ID for a squad (format: squad-<name>)
 */
export async function getSquadChannelId(squad: string): Promise<string | null> {
  const channelName = `squad-${squad}`;

  try {
    const response = await slackApi<SlackApiResponse>(
      'GET',
      'conversations.list?types=public_channel&limit=200'
    );

    const channel = response.channels?.find((c) => c.name === channelName);
    return channel?.id || null;
  } catch {
    return null;
  }
}

/**
 * Parse approval tier for an action from SQUAD.md
 */
export function getApprovalTier(squad: string, action: string): ApprovalTier {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return 'approve'; // Safe default

  const squadFile = join(squadsDir, squad, 'SQUAD.md');
  if (!existsSync(squadFile)) return 'approve';

  const content = readFileSync(squadFile, 'utf-8');

  // Extract YAML block (between ```yaml and ```)
  const yamlMatch = content.match(/```yaml\n([\s\S]*?)```/);
  if (!yamlMatch) return 'approve';

  const yaml = yamlMatch[1];

  // Check each tier (order matters - most restrictive first)
  if (yaml.includes('confirm:') && yaml.includes(`- ${action}`)) {
    const confirmSection = yaml.split('confirm:')[1]?.split(/\n\s*\w+:/)[0];
    if (confirmSection?.includes(`- ${action}`)) return 'confirm';
  }

  if (yaml.includes('approve:') && yaml.includes(`- ${action}`)) {
    const approveSection = yaml.split('approve:')[1]?.split(/\n\s*\w+:/)[0];
    if (approveSection?.includes(`- ${action}`)) return 'approve';
  }

  if (yaml.includes('notify:') && yaml.includes(`- ${action}`)) {
    const notifySection = yaml.split('notify:')[1]?.split(/\n\s*\w+:/)[0];
    if (notifySection?.includes(`- ${action}`)) return 'notify';
  }

  if (yaml.includes('auto:') && yaml.includes(`- ${action}`)) {
    const autoSection = yaml.split('auto:')[1]?.split(/\n\s*\w+:/)[0];
    if (autoSection?.includes(`- ${action}`)) return 'auto';
  }

  // Default: require approval (safe default)
  return 'approve';
}

/**
 * Post a notification to a squad channel (no approval needed)
 */
export async function postNotification(
  squad: string,
  message: string,
  options?: {
    emoji?: string;
    context?: string;
  }
): Promise<string | null> {
  if (!isSlackConfigured()) return null;

  const channelId = await getSquadChannelId(squad);
  if (!channelId) return null;

  const emoji = options?.emoji || ':robot_face:';
  // Type blocks array to accept different Slack block types
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} ${message}`,
      },
    },
  ];

  if (options?.context) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: options.context }],
    });
  }

  try {
    const response = await slackApi<SlackApiResponse>('POST', 'chat.postMessage', {
      channel: channelId,
      text: message,
      blocks,
    });
    return response.ts || null;
  } catch {
    return null;
  }
}

/**
 * Post an approval request with interactive buttons
 */
export async function postApprovalRequest(
  squad: string,
  action: string,
  description: string,
  options?: {
    agent?: string;
    tier?: ApprovalTier;
  }
): Promise<{ ts: string; channelId: string } | null> {
  if (!isSlackConfigured()) return null;

  const channelId = await getSquadChannelId(squad);
  if (!channelId) return null;

  const tier = options?.tier || getApprovalTier(squad, action);

  // Tier-specific formatting
  let emoji = ':rotating_light:';
  let title = 'Approval Required';

  if (tier === 'confirm') {
    emoji = ':warning:';
    title = 'Confirmation Required';
  } else if (tier === 'notify') {
    emoji = ':bell:';
    title = 'Notification';
  }

  // Build fields
  const fields = [
    { type: 'mrkdwn', text: `*Squad:*\n${squad}` },
    { type: 'mrkdwn', text: `*Action:*\n\`${action}\`` },
  ];

  if (options?.agent) {
    fields.splice(1, 0, { type: 'mrkdwn', text: `*Agent:*\n${options.agent}` });
  }

  // Build blocks
  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} ${title}` },
    },
    {
      type: 'section',
      fields,
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: description },
    },
  ];

  // Add buttons for approve/confirm tiers, not for notify
  if (tier !== 'notify') {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve' },
          style: 'primary',
          value: `approve_${squad}_${action}`,
          action_id: 'approve_action',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject' },
          style: 'danger',
          value: `reject_${squad}_${action}`,
          action_id: 'reject_action',
        },
      ],
    });
  } else {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Auto-proceeding (notify tier)_' }],
    });
  }

  try {
    const response = await slackApi<SlackApiResponse>('POST', 'chat.postMessage', {
      channel: channelId,
      text: `${title}: ${action}`,
      blocks,
    });

    if (response.ts) {
      return { ts: response.ts, channelId };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Wait for approval by polling message state.
 * Returns true if approved, false if rejected, throws on timeout.
 */
export async function waitForApproval(
  channelId: string,
  messageTs: string,
  timeoutMs = 300000 // 5 minutes default
): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 3000; // 3 seconds

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await slackApi<SlackApiResponse>(
        'GET',
        `conversations.history?channel=${channelId}&oldest=${messageTs}&latest=${messageTs}&inclusive=true&limit=1`
      );

      const message = response.messages?.[0];
      if (!message) {
        await sleep(pollInterval);
        continue;
      }

      // Check if buttons were replaced (decision made via interactions endpoint)
      const hasActions = message.blocks?.some((b) => b.type === 'actions');
      const contextText = message.blocks
        ?.filter((b) => b.type === 'context')
        ?.flatMap((b) => b.elements?.map((e) => e.text) || [])
        ?.join(' ') || '';

      if (!hasActions) {
        // Buttons removed = decision made
        if (contextText.toLowerCase().includes('approved')) {
          return true;
        }
        if (contextText.toLowerCase().includes('rejected')) {
          return false;
        }
      }

      // Also check emoji reactions as backup
      const reactions = message.reactions?.map((r) => r.name) || [];
      if (reactions.includes('white_check_mark') || reactions.includes('heavy_check_mark')) {
        return true;
      }
      if (reactions.includes('x') || reactions.includes('no_entry')) {
        return false;
      }

      await sleep(pollInterval);
    } catch {
      await sleep(pollInterval);
    }
  }

  throw new Error(`Approval timeout after ${timeoutMs / 1000}s`);
}

/**
 * Request approval and wait for response.
 * Returns true if approved/auto, false if rejected.
 * For notify tier, posts notification and returns true immediately.
 */
export async function requestApprovalAndWait(
  squad: string,
  action: string,
  description: string,
  options?: {
    agent?: string;
    timeoutMs?: number;
  }
): Promise<boolean> {
  const tier = getApprovalTier(squad, action);

  // Auto tier: no Slack interaction needed
  if (tier === 'auto') {
    return true;
  }

  // Notify tier: post and continue
  if (tier === 'notify') {
    await postApprovalRequest(squad, action, description, {
      agent: options?.agent,
      tier,
    });
    return true;
  }

  // Approve/Confirm tier: post and wait
  const result = await postApprovalRequest(squad, action, description, {
    agent: options?.agent,
    tier,
  });

  if (!result) {
    // If Slack isn't available, default to auto-approve
    console.warn(`[Slack] Could not post approval request, defaulting to approved`);
    return true;
  }

  return waitForApproval(result.channelId, result.ts, options?.timeoutMs);
}

// Helper
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Post a "tonight session started" notification
 */
export async function notifyTonightStart(
  targets: string[],
  config: { costCap: number; stopAt: string }
): Promise<void> {
  // Post to all relevant squad channels
  const squadsSeen = new Set<string>();

  for (const target of targets) {
    const squad = target.split('/')[0];
    if (squadsSeen.has(squad)) continue;
    squadsSeen.add(squad);

    await postNotification(
      squad,
      `*Tonight mode started*\nTargets: ${targets.filter((t) => t.startsWith(squad)).join(', ')}`,
      {
        emoji: ':crescent_moon:',
        context: `Cost cap: $${config.costCap} | Stop at: ${config.stopAt}`,
      }
    );
  }
}

/**
 * Post a "tonight session completed" notification
 */
export async function notifyTonightComplete(
  targets: string[],
  stats: { duration: number; cost: number; completed: number; failed: number }
): Promise<void> {
  const squadsSeen = new Set<string>();

  for (const target of targets) {
    const squad = target.split('/')[0];
    if (squadsSeen.has(squad)) continue;
    squadsSeen.add(squad);

    const emoji = stats.failed > 0 ? ':warning:' : ':white_check_mark:';
    await postNotification(
      squad,
      `*Tonight mode completed*\n${stats.completed} completed, ${stats.failed} failed`,
      {
        emoji,
        context: `Duration: ${stats.duration}min | Cost: $${stats.cost.toFixed(2)}`,
      }
    );
  }
}
