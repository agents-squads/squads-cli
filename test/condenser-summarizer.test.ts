import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ConversationSummarizer,
  createFallbackSummary,
  type SummarizableMessage,
  type SummaryConfig,
} from '../src/lib/condenser/summarizer.js';

// Use vi.hoisted to ensure mockCreate is available before vi.mock hoisting
const mockCreate = vi.hoisted(() => vi.fn());

// Mock Anthropic SDK — use a class so `new Anthropic()` always works
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

function makeMessages(count: number, prefix = 'msg'): SummarizableMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${prefix} ${i + 1}`,
  }));
}

describe('ConversationSummarizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('uses default config when no options provided', () => {
      const summarizer = new ConversationSummarizer();
      const stats = summarizer.getStats([]);
      expect(stats.totalMessages).toBe(0);
      expect(stats.wouldKeep).toBe(0);
      expect(stats.wouldSummarize).toBe(0);
    });

    it('merges partial config with defaults', () => {
      const summarizer = new ConversationSummarizer({ keepFirst: 10 });
      const messages = makeMessages(30);
      const stats = summarizer.getStats(messages);
      expect(stats.wouldKeep).toBe(30);
      expect(stats.wouldSummarize).toBe(0);

      const messages31 = makeMessages(31);
      const stats31 = summarizer.getStats(messages31);
      expect(stats31.wouldKeep).toBe(30);
      expect(stats31.wouldSummarize).toBe(1);
    });

    it('accepts full custom config', () => {
      const config: Partial<SummaryConfig> = {
        keepFirst: 2,
        keepLast: 3,
        model: 'claude-3-haiku-20240307',
        maxSummaryTokens: 500,
      };
      const summarizer = new ConversationSummarizer(config);
      const messages = makeMessages(10);
      const stats = summarizer.getStats(messages);
      expect(stats.wouldKeep).toBe(5);
      expect(stats.wouldSummarize).toBe(5);
    });
  });

  describe('summarize', () => {
    it('returns original messages when count <= keepFirst + keepLast', async () => {
      const summarizer = new ConversationSummarizer({ keepFirst: 4, keepLast: 20 });
      const messages = makeMessages(24);

      const result = await summarizer.summarize(messages);
      expect(result).toBe(messages);
    });

    it('returns original messages for small conversations', async () => {
      const summarizer = new ConversationSummarizer({ keepFirst: 4, keepLast: 20 });
      const messages = makeMessages(5);

      const result = await summarizer.summarize(messages);
      expect(result).toBe(messages);
    });

    it('splits messages correctly and inserts summary', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Test summary of middle messages' }],
      });

      const summarizer = new ConversationSummarizer({ keepFirst: 2, keepLast: 3 });
      const messages = makeMessages(10);

      const result = await summarizer.summarize(messages);

      expect(result.length).toBe(6);
      expect(result[0].content).toBe('msg 1');
      expect(result[1].content).toBe('msg 2');
      expect(result[2].role).toBe('user');
      expect(result[2].content).toContain('[Context Summary - 5 messages condensed]');
      expect(result[2].content).toContain('Test summary of middle messages');
      expect(result[3].content).toBe('msg 8');
      expect(result[4].content).toBe('msg 9');
      expect(result[5].content).toBe('msg 10');
    });

    it('handles API errors gracefully', async () => {
      mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'));

      const summarizer = new ConversationSummarizer({ keepFirst: 2, keepLast: 2 });
      const messages = makeMessages(8);

      const result = await summarizer.summarize(messages);

      expect(result.length).toBe(5);
      expect(result[2].content).toContain('Summary generation failed');
      expect(result[2].content).toContain('API rate limit exceeded');
    });

    it('handles non-Error thrown values', async () => {
      mockCreate.mockRejectedValueOnce('string error');

      const summarizer = new ConversationSummarizer({ keepFirst: 2, keepLast: 2 });
      const messages = makeMessages(8);

      const result = await summarizer.summarize(messages);
      expect(result[2].content).toContain('Summary generation failed');
      expect(result[2].content).toContain('string error');
    });

    it('handles API response with no text block', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'test' }],
      });

      const summarizer = new ConversationSummarizer({ keepFirst: 2, keepLast: 2 });
      const messages = makeMessages(8);

      const result = await summarizer.summarize(messages);
      expect(result[2].content).toContain('Summary generation failed - no text in response');
    });

    it('handles messages with array content', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Summarized array content' }],
      });

      const summarizer = new ConversationSummarizer({ keepFirst: 1, keepLast: 1 });
      const messages: SummarizableMessage[] = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: [{ type: 'text', text: 'part 1' }, { type: 'text', text: 'part 2' }] },
        { role: 'user', content: [{ type: 'text', text: 'question' }] },
        { role: 'assistant', content: 'last' },
      ];

      const result = await summarizer.summarize(messages);
      expect(result.length).toBe(3);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[0].content).toContain('ASSISTANT');
      expect(callArgs.messages[0].content).toContain('part 1');
      expect(callArgs.messages[0].content).toContain('part 2');
    });

    it('truncates very long message content in summary input', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Summary' }],
      });

      const summarizer = new ConversationSummarizer({ keepFirst: 1, keepLast: 1 });
      const longContent = 'x'.repeat(5000);
      const messages: SummarizableMessage[] = [
        { role: 'user', content: 'first' },
        { role: 'user', content: longContent },
        { role: 'assistant', content: 'last' },
      ];

      await summarizer.summarize(messages);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain('[...truncated 3000 chars]');
    });

    it('handles array content with missing text fields', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Summary' }],
      });

      const summarizer = new ConversationSummarizer({ keepFirst: 1, keepLast: 1 });
      const messages: SummarizableMessage[] = [
        { role: 'user', content: 'first' },
        { role: 'tool', content: [{ type: 'image' }, { type: 'text', text: 'visible' }] },
        { role: 'assistant', content: 'last' },
      ];

      await summarizer.summarize(messages);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[0].content).toContain('visible');
    });

    it('passes correct model and max_tokens to API', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Summary' }],
      });

      const summarizer = new ConversationSummarizer({
        keepFirst: 1,
        keepLast: 1,
        model: 'claude-3-haiku-20240307',
        maxSummaryTokens: 500,
      });
      const messages = makeMessages(5);

      await summarizer.summarize(messages);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-3-haiku-20240307',
          max_tokens: 500,
        })
      );
    });

    it('includes max_tokens in prompt template', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Summary' }],
      });

      const summarizer = new ConversationSummarizer({
        keepFirst: 1,
        keepLast: 1,
        maxSummaryTokens: 1500,
      });
      const messages = makeMessages(5);

      await summarizer.summarize(messages);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[0].content).toContain('1500');
    });
  });

  describe('estimateCost', () => {
    it('returns 0 when no summarization needed', () => {
      const summarizer = new ConversationSummarizer({ keepFirst: 4, keepLast: 20 });
      const messages = makeMessages(20);
      expect(summarizer.estimateCost(messages)).toBe(0);
    });

    it('returns 0 for empty messages', () => {
      const summarizer = new ConversationSummarizer();
      expect(summarizer.estimateCost([])).toBe(0);
    });

    it('calculates positive cost when summarization needed', () => {
      const summarizer = new ConversationSummarizer({ keepFirst: 2, keepLast: 2 });
      const messages = makeMessages(10);
      const cost = summarizer.estimateCost(messages);
      expect(cost).toBeGreaterThan(0);
    });

    it('cost increases with more middle messages', () => {
      const summarizer = new ConversationSummarizer({ keepFirst: 2, keepLast: 2 });
      const small = makeMessages(6);
      const large = makeMessages(20);
      expect(summarizer.estimateCost(large)).toBeGreaterThan(summarizer.estimateCost(small));
    });

    it('handles messages with array content for cost estimation', () => {
      const summarizer = new ConversationSummarizer({ keepFirst: 1, keepLast: 1 });
      const messages: SummarizableMessage[] = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: [{ type: 'text', text: 'array content' }] },
        { role: 'user', content: 'last' },
      ];
      expect(summarizer.estimateCost(messages)).toBeGreaterThan(0);
    });
  });

  describe('getStats', () => {
    it('returns correct stats for empty messages', () => {
      const summarizer = new ConversationSummarizer({ keepFirst: 4, keepLast: 20 });
      const stats = summarizer.getStats([]);
      expect(stats.totalMessages).toBe(0);
      expect(stats.wouldKeep).toBe(0);
      expect(stats.wouldSummarize).toBe(0);
      expect(stats.estimatedCost).toBe(0);
    });

    it('keeps all messages when count < keepFirst + keepLast', () => {
      const summarizer = new ConversationSummarizer({ keepFirst: 4, keepLast: 20 });
      const stats = summarizer.getStats(makeMessages(10));
      expect(stats.totalMessages).toBe(10);
      expect(stats.wouldKeep).toBe(10);
      expect(stats.wouldSummarize).toBe(0);
    });

    it('calculates summarizable messages correctly', () => {
      const summarizer = new ConversationSummarizer({ keepFirst: 2, keepLast: 3 });
      const stats = summarizer.getStats(makeMessages(15));
      expect(stats.totalMessages).toBe(15);
      expect(stats.wouldKeep).toBe(5);
      expect(stats.wouldSummarize).toBe(10);
      expect(stats.estimatedCost).toBeGreaterThan(0);
    });

    it('exactly at threshold means zero summarizable', () => {
      const summarizer = new ConversationSummarizer({ keepFirst: 5, keepLast: 5 });
      const stats = summarizer.getStats(makeMessages(10));
      expect(stats.wouldKeep).toBe(10);
      expect(stats.wouldSummarize).toBe(0);
    });
  });
});

describe('createFallbackSummary', () => {
  it('returns structured summary for empty messages', () => {
    const result = createFallbackSummary([]);
    expect(result).toContain('## Conversation Summary (Fallback)');
  });

  it('extracts file paths from messages', () => {
    const messages: SummarizableMessage[] = [
      { role: 'user', content: 'Please edit /src/index.ts and /src/utils.ts' },
      { role: 'assistant', content: 'I edited /src/index.ts' },
    ];
    const result = createFallbackSummary(messages);
    expect(result).toContain('### Files Referenced');
    expect(result).toContain('/src/index.ts');
    expect(result).toContain('/src/utils.ts');
  });

  it('deduplicates file paths via Set', () => {
    const messages: SummarizableMessage[] = [
      { role: 'user', content: 'Edit /src/index.ts' },
      { role: 'user', content: 'Also edit /src/index.ts' },
    ];
    const result = createFallbackSummary(messages);
    const matches = result.match(/\/src\/index\.ts/g);
    expect(matches).toHaveLength(1);
  });

  it('extracts error messages', () => {
    const messages: SummarizableMessage[] = [
      { role: 'user', content: 'I got an error: TypeError: Cannot read property of undefined' },
    ];
    const result = createFallbackSummary(messages);
    expect(result).toContain('### Errors Encountered');
    expect(result).toContain('TypeError');
  });

  it('limits errors to 3', () => {
    const messages: SummarizableMessage[] = [
      { role: 'user', content: 'Error: first' },
      { role: 'user', content: 'Error: second' },
      { role: 'user', content: 'Error: third' },
      { role: 'user', content: 'Error: fourth' },
    ];
    const result = createFallbackSummary(messages);
    expect(result).toContain('first');
    expect(result).toContain('third');
    expect(result).not.toContain('fourth');
  });

  it('extracts short assistant actions', () => {
    const messages: SummarizableMessage[] = [
      { role: 'assistant', content: 'I fixed the bug in index.ts' },
      { role: 'assistant', content: 'Deployed to production' },
    ];
    const result = createFallbackSummary(messages);
    expect(result).toContain('### Key Actions');
    expect(result).toContain('I fixed the bug');
  });

  it('skips long assistant messages for actions', () => {
    const messages: SummarizableMessage[] = [
      { role: 'assistant', content: 'x'.repeat(600) },
    ];
    const result = createFallbackSummary(messages);
    expect(result).not.toContain('### Key Actions');
  });

  it('handles array content by stringifying', () => {
    const messages: SummarizableMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Check /src/main.ts for error: connection refused' }],
      },
    ];
    const result = createFallbackSummary(messages);
    expect(result).toContain('/src/main.ts');
    expect(result).toContain('Errors Encountered');
  });

  it('limits file paths to 10', () => {
    const paths = Array.from({ length: 15 }, (_, i) => `/src/file${i}.ts`).join(' ');
    const messages: SummarizableMessage[] = [{ role: 'user', content: paths }];
    const result = createFallbackSummary(messages);
    const fileLines = result.split('\n').filter((l) => l.startsWith('- /'));
    expect(fileLines.length).toBeLessThanOrEqual(10);
  });

  it('limits actions to 5', () => {
    const messages: SummarizableMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: 'assistant' as const,
      content: `Action ${i + 1}`,
    }));
    const result = createFallbackSummary(messages);
    const actionSection = result.split('### Key Actions')[1];
    if (actionSection) {
      const actionLines = actionSection.split('\n').filter((l) => l.startsWith('- '));
      expect(actionLines.length).toBeLessThanOrEqual(5);
    }
  });

  it('combines all sections when all types present', () => {
    const messages: SummarizableMessage[] = [
      { role: 'user', content: 'Fix error: ENOENT in /src/config.ts' },
      { role: 'assistant', content: 'I fixed the config file' },
    ];
    const result = createFallbackSummary(messages);
    expect(result).toContain('## Conversation Summary (Fallback)');
    expect(result).toContain('### Files Referenced');
    expect(result).toContain('### Errors Encountered');
    expect(result).toContain('### Key Actions');
  });
});
