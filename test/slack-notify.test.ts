import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('slackNotify', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SQUADS_SLACK_CHANNEL;
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('does nothing when no channel is configured', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    const { slackNotify } = await import('../src/lib/squad-loop');
    await slackNotify('hello');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does nothing when no token is configured', async () => {
    process.env.SQUADS_SLACK_CHANNEL = 'C0123456789';
    const { slackNotify } = await import('../src/lib/squad-loop');
    await slackNotify('hello');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('posts to the configured channel with a timeout', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SQUADS_SLACK_CHANNEL = 'C0123456789';
    mockFetch.mockResolvedValueOnce({ json: async () => ({ ok: true }) });

    const { slackNotify } = await import('../src/lib/squad-loop');
    await slackNotify('escalation: daemon stuck');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(init.body)).toEqual({ channel: 'C0123456789', text: 'escalation: daemon stuck' });
    expect(init.headers.Authorization).toBe('Bearer xoxb-test-token');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never throws when Slack fails', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SQUADS_SLACK_CHANNEL = 'C0123456789';
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    const { slackNotify } = await import('../src/lib/squad-loop');
    await expect(slackNotify('hello')).resolves.toBeUndefined();
  });
});
