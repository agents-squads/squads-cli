import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fetch globally before importing the module
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock squad-parser
vi.mock('../src/lib/squad-parser', () => ({
  findSquadsDir: vi.fn(() => '/fake/squads'),
}));

// Mock fs (for getApprovalTier)
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

import { readFileSync, existsSync } from 'fs';
import { findSquadsDir } from '../src/lib/squad-parser';

describe('slack', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('isSlackConfigured', () => {
    it('returns true when SLACK_BOT_TOKEN is set', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      const { isSlackConfigured } = await import('../src/lib/slack');
      expect(isSlackConfigured()).toBe(true);
    });

    it('returns false when SLACK_BOT_TOKEN is not set', async () => {
      delete process.env.SLACK_BOT_TOKEN;
      const { isSlackConfigured } = await import('../src/lib/slack');
      expect(isSlackConfigured()).toBe(false);
    });
  });

  describe('slackApi', () => {
    it('throws when SLACK_BOT_TOKEN is not set', async () => {
      delete process.env.SLACK_BOT_TOKEN;
      const { slackApi } = await import('../src/lib/slack');
      await expect(slackApi('GET', 'auth.test')).rejects.toThrow(
        'SLACK_BOT_TOKEN not set'
      );
    });

    it('makes GET request with authorization header', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, user: 'test' }),
      });

      const { slackApi } = await import('../src/lib/slack');
      const result = await slackApi('GET', 'auth.test');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://slack.com/api/auth.test',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer xoxb-test-token',
          }),
        })
      );
      expect(result).toEqual({ ok: true, user: 'test' });
    });

    it('makes POST request with JSON body', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, ts: '1234.5678' }),
      });

      const { slackApi } = await import('../src/lib/slack');
      await slackApi('POST', 'chat.postMessage', {
        channel: 'C123',
        text: 'hello',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postMessage',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ channel: 'C123', text: 'hello' }),
        })
      );
    });

    it('throws on Slack API error response', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: false, error: 'channel_not_found' }),
      });

      const { slackApi } = await import('../src/lib/slack');
      await expect(slackApi('GET', 'conversations.list')).rejects.toThrow(
        'Slack API error: channel_not_found'
      );
    });
  });

  describe('getApprovalTier', () => {
    it('returns approve as safe default when squads dir not found', async () => {
      vi.mocked(findSquadsDir).mockReturnValue(null);
      const { getApprovalTier } = await import('../src/lib/slack');
      expect(getApprovalTier('test-squad', 'deploy')).toBe('approve');
    });

    it('returns approve when SQUAD.md does not exist', async () => {
      vi.mocked(findSquadsDir).mockReturnValue('/fake/squads');
      vi.mocked(existsSync).mockReturnValue(false);
      const { getApprovalTier } = await import('../src/lib/slack');
      expect(getApprovalTier('test-squad', 'deploy')).toBe('approve');
    });

    it('returns auto tier for actions listed under auto', async () => {
      vi.mocked(findSquadsDir).mockReturnValue('/fake/squads');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(`---
name: Test
---
# Test Squad

\`\`\`yaml
approvals:
  policy:
    auto:
      - memory.update
      - agent.run.readonly
    approve:
      - agent.run.write
\`\`\`
`);

      const { getApprovalTier } = await import('../src/lib/slack');
      expect(getApprovalTier('test-squad', 'memory.update')).toBe('auto');
    });

    it('returns approve tier for actions listed under approve', async () => {
      vi.mocked(findSquadsDir).mockReturnValue('/fake/squads');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(`\`\`\`yaml
approvals:
  policy:
    auto:
      - memory.update
    approve:
      - agent.run.write
\`\`\``);

      const { getApprovalTier } = await import('../src/lib/slack');
      expect(getApprovalTier('test-squad', 'agent.run.write')).toBe('approve');
    });

    it('returns notify tier for actions listed under notify', async () => {
      vi.mocked(findSquadsDir).mockReturnValue('/fake/squads');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(`\`\`\`yaml
approvals:
  policy:
    notify:
      - status.check
    approve:
      - deploy.prod
\`\`\``);

      const { getApprovalTier } = await import('../src/lib/slack');
      expect(getApprovalTier('test-squad', 'status.check')).toBe('notify');
    });

    it('returns confirm tier for actions listed under confirm', async () => {
      vi.mocked(findSquadsDir).mockReturnValue('/fake/squads');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(`\`\`\`yaml
approvals:
  policy:
    confirm:
      - deploy.prod
    approve:
      - deploy.staging
\`\`\``);

      const { getApprovalTier } = await import('../src/lib/slack');
      expect(getApprovalTier('test-squad', 'deploy.prod')).toBe('confirm');
    });

    it('returns approve for unlisted actions (safe default)', async () => {
      vi.mocked(findSquadsDir).mockReturnValue('/fake/squads');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(`\`\`\`yaml
approvals:
  policy:
    auto:
      - memory.update
\`\`\``);

      const { getApprovalTier } = await import('../src/lib/slack');
      expect(getApprovalTier('test-squad', 'unknown.action')).toBe('approve');
    });

    it('returns approve when no yaml block found', async () => {
      vi.mocked(findSquadsDir).mockReturnValue('/fake/squads');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('# Squad\nNo yaml here.');

      const { getApprovalTier } = await import('../src/lib/slack');
      expect(getApprovalTier('test-squad', 'deploy')).toBe('approve');
    });
  });

  describe('getSquadChannelId', () => {
    it('returns channel ID when found', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channels: [
            { id: 'C111', name: 'squad-engineering' },
            { id: 'C222', name: 'squad-marketing' },
          ],
        }),
      });

      const { getSquadChannelId } = await import('../src/lib/slack');
      const result = await getSquadChannelId('engineering');
      expect(result).toBe('C111');
    });

    it('returns null when channel not found', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channels: [{ id: 'C111', name: 'general' }],
        }),
      });

      const { getSquadChannelId } = await import('../src/lib/slack');
      const result = await getSquadChannelId('nonexistent');
      expect(result).toBeNull();
    });

    it('returns null on API error', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: false, error: 'token_revoked' }),
      });

      const { getSquadChannelId } = await import('../src/lib/slack');
      const result = await getSquadChannelId('engineering');
      expect(result).toBeNull();
    });
  });

  describe('postNotification', () => {
    it('returns null when Slack is not configured', async () => {
      delete process.env.SLACK_BOT_TOKEN;
      const { postNotification } = await import('../src/lib/slack');
      const result = await postNotification('engineering', 'Test message');
      expect(result).toBeNull();
    });

    it('returns null when channel not found', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // conversations.list returns no matching channel
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, channels: [] }),
      });

      const { postNotification } = await import('../src/lib/slack');
      const result = await postNotification('nonexistent', 'Test message');
      expect(result).toBeNull();
    });

    it('posts message with emoji and context blocks', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // conversations.list
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channels: [{ id: 'C123', name: 'squad-engineering' }],
        }),
      });
      // chat.postMessage
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, ts: '1234.5678' }),
      });

      const { postNotification } = await import('../src/lib/slack');
      const result = await postNotification('engineering', 'Deploy complete', {
        emoji: ':rocket:',
        context: 'v1.0.0',
      });

      expect(result).toBe('1234.5678');
      // Verify second call is chat.postMessage
      const postCall = mockFetch.mock.calls[1];
      expect(postCall[0]).toBe('https://slack.com/api/chat.postMessage');
      const body = JSON.parse(postCall[1].body);
      expect(body.channel).toBe('C123');
      expect(body.blocks).toHaveLength(2); // section + context
      expect(body.blocks[0].text.text).toContain(':rocket:');
      expect(body.blocks[1].elements[0].text).toBe('v1.0.0');
    });

    it('returns null on post failure', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // conversations.list
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channels: [{ id: 'C123', name: 'squad-engineering' }],
        }),
      });
      // chat.postMessage fails
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: false, error: 'not_in_channel' }),
      });

      const { postNotification } = await import('../src/lib/slack');
      const result = await postNotification('engineering', 'Test');
      expect(result).toBeNull();
    });
  });

  describe('postApprovalRequest', () => {
    it('returns null when Slack is not configured', async () => {
      delete process.env.SLACK_BOT_TOKEN;
      const { postApprovalRequest } = await import('../src/lib/slack');
      const result = await postApprovalRequest('eng', 'deploy', 'Deploy v1');
      expect(result).toBeNull();
    });

    it('posts approval request with approve/reject buttons', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // Mock findSquadsDir and fs for getApprovalTier
      vi.mocked(findSquadsDir).mockReturnValue(null);

      // conversations.list
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channels: [{ id: 'C123', name: 'squad-eng' }],
        }),
      });
      // chat.postMessage
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, ts: '999.111' }),
      });

      const { postApprovalRequest } = await import('../src/lib/slack');
      const result = await postApprovalRequest('eng', 'deploy.prod', 'Deploy v1.0', {
        agent: 'deployer',
        tier: 'approve',
      });

      expect(result).toEqual({ ts: '999.111', channelId: 'C123' });

      // Verify the posted message contains action buttons
      const postCall = mockFetch.mock.calls[1];
      const body = JSON.parse(postCall[1].body);
      const actionsBlock = body.blocks.find((b: { type: string }) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock.elements).toHaveLength(2);
      expect(actionsBlock.elements[0].text.text).toBe('Approve');
      expect(actionsBlock.elements[1].text.text).toBe('Reject');
    });

    it('posts notification without buttons for notify tier', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // conversations.list
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channels: [{ id: 'C123', name: 'squad-eng' }],
        }),
      });
      // chat.postMessage
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, ts: '999.222' }),
      });

      const { postApprovalRequest } = await import('../src/lib/slack');
      const result = await postApprovalRequest('eng', 'status.check', 'Status update', {
        tier: 'notify',
      });

      expect(result).toEqual({ ts: '999.222', channelId: 'C123' });

      const postCall = mockFetch.mock.calls[1];
      const body = JSON.parse(postCall[1].body);
      const actionsBlock = body.blocks.find((b: { type: string }) => b.type === 'actions');
      expect(actionsBlock).toBeUndefined();
    });
  });

  describe('waitForApproval', () => {
    it('returns true when approved reaction found', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          messages: [
            {
              ts: '1234.5678',
              text: 'Approval',
              blocks: [{ type: 'actions' }],
              reactions: [{ name: 'white_check_mark' }],
            },
          ],
        }),
      });

      const { waitForApproval } = await import('../src/lib/slack');
      const result = await waitForApproval('C123', '1234.5678', 5000);
      expect(result).toBe(true);
    });

    it('returns false when rejected reaction found', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          messages: [
            {
              ts: '1234.5678',
              text: 'Approval',
              blocks: [{ type: 'actions' }],
              reactions: [{ name: 'x' }],
            },
          ],
        }),
      });

      const { waitForApproval } = await import('../src/lib/slack');
      const result = await waitForApproval('C123', '1234.5678', 5000);
      expect(result).toBe(false);
    });

    it('returns true when buttons removed and context says approved', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          messages: [
            {
              ts: '1234.5678',
              text: 'Approval',
              blocks: [
                { type: 'section' },
                {
                  type: 'context',
                  elements: [{ text: 'Approved by @user' }],
                },
              ],
            },
          ],
        }),
      });

      const { waitForApproval } = await import('../src/lib/slack');
      const result = await waitForApproval('C123', '1234.5678', 5000);
      expect(result).toBe(true);
    });

    it('returns false when buttons removed and context says rejected', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          messages: [
            {
              ts: '1234.5678',
              text: 'Approval',
              blocks: [
                { type: 'section' },
                {
                  type: 'context',
                  elements: [{ text: 'Rejected by @admin' }],
                },
              ],
            },
          ],
        }),
      });

      const { waitForApproval } = await import('../src/lib/slack');
      const result = await waitForApproval('C123', '1234.5678', 5000);
      expect(result).toBe(false);
    });

    it('throws on timeout', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // Return pending state (actions still present, no reactions)
      mockFetch.mockResolvedValue({
        json: async () => ({
          ok: true,
          messages: [
            {
              ts: '1234.5678',
              text: 'Approval',
              blocks: [{ type: 'actions' }],
              reactions: [],
            },
          ],
        }),
      });

      const { waitForApproval } = await import('../src/lib/slack');
      // Use very short timeout (100ms) to avoid long test
      await expect(waitForApproval('C123', '1234.5678', 100)).rejects.toThrow(
        'Approval timeout'
      );
    });
  });

  describe('requestApprovalAndWait', () => {
    it('returns true immediately for auto tier', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      vi.mocked(findSquadsDir).mockReturnValue('/fake/squads');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(`\`\`\`yaml
approvals:
  policy:
    auto:
      - memory.update
\`\`\``);

      const { requestApprovalAndWait } = await import('../src/lib/slack');
      const result = await requestApprovalAndWait(
        'test-squad',
        'memory.update',
        'Updating memory'
      );
      expect(result).toBe(true);
      // No Slack API calls should be made
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('posts notification and returns true for notify tier', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      vi.mocked(findSquadsDir).mockReturnValue('/fake/squads');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(`\`\`\`yaml
approvals:
  policy:
    notify:
      - status.check
\`\`\``);

      // conversations.list
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channels: [{ id: 'C123', name: 'squad-test-squad' }],
        }),
      });
      // chat.postMessage
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, ts: '1234.5678' }),
      });

      const { requestApprovalAndWait } = await import('../src/lib/slack');
      const result = await requestApprovalAndWait(
        'test-squad',
        'status.check',
        'Checking status'
      );
      expect(result).toBe(true);
    });

    it('defaults to approved when Slack not available', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      vi.mocked(findSquadsDir).mockReturnValue(null); // triggers 'approve' tier

      // conversations.list returns no matching channel
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, channels: [] }),
      });

      const { requestApprovalAndWait } = await import('../src/lib/slack');
      // Suppress console.warn from the function
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await requestApprovalAndWait('unknown-squad', 'deploy', 'Deploy');
      expect(result).toBe(true);
      warnSpy.mockRestore();
    });
  });

  describe('createSquadChannel', () => {
    it('returns null when Slack is not configured', async () => {
      delete process.env.SLACK_BOT_TOKEN;
      const { createSquadChannel } = await import('../src/lib/slack');
      const result = await createSquadChannel('engineering');
      expect(result).toBeNull();
    });

    it('creates channel and returns ID', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channel: { id: 'C999', name: 'squad-engineering' },
        }),
      });

      const { createSquadChannel } = await import('../src/lib/slack');
      const result = await createSquadChannel('engineering');
      expect(result).toBe('C999');
    });

    it('sets topic when provided', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // conversations.create
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channel: { id: 'C999', name: 'squad-eng' },
        }),
      });
      // conversations.setTopic
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true }),
      });

      const { createSquadChannel } = await import('../src/lib/slack');
      await createSquadChannel('eng', 'Engineering squad channel');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const topicCall = mockFetch.mock.calls[1];
      expect(topicCall[0]).toBe('https://slack.com/api/conversations.setTopic');
    });

    it('returns existing channel ID when name_taken error', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // conversations.create fails with name_taken
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: false, error: 'name_taken' }),
      });
      // conversations.list (fallback lookup)
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channels: [{ id: 'CEXIST', name: 'squad-engineering' }],
        }),
      });

      const { createSquadChannel } = await import('../src/lib/slack');
      const result = await createSquadChannel('engineering');
      expect(result).toBe('CEXIST');
    });

    it('returns null on other errors', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: false, error: 'invalid_auth' }),
      });

      const { createSquadChannel } = await import('../src/lib/slack');
      const result = await createSquadChannel('engineering');
      expect(result).toBeNull();
    });
  });

  describe('notifyTonightStart', () => {
    it('posts to unique squad channels', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // Two squad lookups + two posts
      // engineering channel lookup
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channels: [{ id: 'C1', name: 'squad-engineering' }],
        }),
      });
      // engineering post
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, ts: '1.1' }),
      });
      // research channel lookup
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channels: [{ id: 'C2', name: 'squad-research' }],
        }),
      });
      // research post
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, ts: '2.2' }),
      });

      const { notifyTonightStart } = await import('../src/lib/slack');
      await notifyTonightStart(
        ['engineering/issue-solver', 'engineering/code-reviewer', 'research/researcher'],
        { costCap: 10, stopAt: '06:00' }
      );

      // Should only post to 2 unique squads (engineering, research)
      expect(mockFetch).toHaveBeenCalledTimes(4); // 2 lookups + 2 posts
    });
  });

  describe('notifyTonightComplete', () => {
    it('posts completion with warning emoji when failures exist', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // channel lookup
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channels: [{ id: 'C1', name: 'squad-engineering' }],
        }),
      });
      // post
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, ts: '1.1' }),
      });

      const { notifyTonightComplete } = await import('../src/lib/slack');
      await notifyTonightComplete(
        ['engineering/issue-solver'],
        { duration: 120, cost: 5.50, completed: 3, failed: 1 }
      );

      const postCall = mockFetch.mock.calls[1];
      const body = JSON.parse(postCall[1].body);
      expect(body.blocks[0].text.text).toContain(':warning:');
    });

    it('posts completion with checkmark when no failures', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // channel lookup
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          channels: [{ id: 'C1', name: 'squad-engineering' }],
        }),
      });
      // post
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, ts: '1.1' }),
      });

      const { notifyTonightComplete } = await import('../src/lib/slack');
      await notifyTonightComplete(
        ['engineering/issue-solver'],
        { duration: 60, cost: 2.00, completed: 5, failed: 0 }
      );

      const postCall = mockFetch.mock.calls[1];
      const body = JSON.parse(postCall[1].body);
      expect(body.blocks[0].text.text).toContain(':white_check_mark:');
    });
  });
});
