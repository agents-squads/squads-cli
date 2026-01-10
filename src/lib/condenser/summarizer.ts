/**
 * LLM-based summarization for heavy context compression.
 *
 * Based on OpenHands' Context Condenser approach:
 * - Keep first N events (initial context)
 * - Keep last M events (recent context)
 * - Summarize the middle section via LLM
 *
 * This is the "last resort" compression - only used when at 95%+ context.
 */

import Anthropic from '@anthropic-ai/sdk';
import { estimateTokens } from './tokens.js';

/**
 * Configuration for LLM summarization.
 */
export interface SummaryConfig {
  /** Number of messages to preserve from start. Default: 4 */
  keepFirst: number;
  /** Number of messages to preserve from end. Default: 20 */
  keepLast: number;
  /** Model to use for summarization. Default: 'claude-3-5-haiku-20241022' */
  model: string;
  /** Maximum tokens for summary output. Default: 2000 */
  maxSummaryTokens: number;
}

const DEFAULT_CONFIG: SummaryConfig = {
  keepFirst: 4,
  keepLast: 20,
  model: 'claude-3-5-haiku-20241022', // Cheap and fast
  maxSummaryTokens: 2000,
};

/**
 * Message structure for summarization.
 */
export interface SummarizableMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

/**
 * Summarization prompt template.
 */
const SUMMARIZATION_PROMPT = `You are summarizing a conversation between a user and an AI assistant to reduce context length while preserving essential information.

<conversation_to_summarize>
{{MIDDLE_CONTENT}}
</conversation_to_summarize>

Create a concise summary that preserves:
1. **User's goals** - What the user is trying to accomplish
2. **Progress made** - Key actions taken and their outcomes
3. **Current state** - What's done vs. what still needs to be done
4. **Critical context** - File paths, error messages, decisions made
5. **Blockers** - Any issues that need to be resolved

Format your summary as a structured note that the assistant can reference to continue the work.

Keep the summary under {{MAX_TOKENS}} tokens. Focus on actionable information.`;

/**
 * LLM-based conversation summarizer.
 */
export class ConversationSummarizer {
  private config: SummaryConfig;
  private client: Anthropic | null = null;

  constructor(config: Partial<SummaryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get or create Anthropic client.
   */
  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic();
    }
    return this.client;
  }

  /**
   * Summarize messages to reduce token count.
   *
   * Strategy:
   * 1. Keep first N messages (system prompt, initial context)
   * 2. Keep last M messages (recent context, current task)
   * 3. Summarize everything in between
   *
   * @param messages - Messages to summarize
   * @returns Summarized messages
   */
  async summarize(messages: SummarizableMessage[]): Promise<SummarizableMessage[]> {
    if (messages.length <= this.config.keepFirst + this.config.keepLast) {
      // Not enough messages to summarize
      return messages;
    }

    const firstMessages = messages.slice(0, this.config.keepFirst);
    const middleMessages = messages.slice(this.config.keepFirst, -this.config.keepLast);
    const lastMessages = messages.slice(-this.config.keepLast);

    // Generate summary of middle section
    const summary = await this.generateSummary(middleMessages);

    // Create summary message
    const summaryMessage: SummarizableMessage = {
      role: 'user',
      content: `[Context Summary - ${middleMessages.length} messages condensed]\n\n${summary}`,
    };

    return [...firstMessages, summaryMessage, ...lastMessages];
  }

  /**
   * Generate a summary of the middle messages.
   */
  private async generateSummary(messages: SummarizableMessage[]): Promise<string> {
    const middleContent = this.formatMessagesForSummary(messages);

    const prompt = SUMMARIZATION_PROMPT.replace('{{MIDDLE_CONTENT}}', middleContent).replace(
      '{{MAX_TOKENS}}',
      String(this.config.maxSummaryTokens)
    );

    try {
      const client = this.getClient();
      const response = await client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxSummaryTokens,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      // Extract text from response
      const textBlock = response.content.find((block) => block.type === 'text');
      if (textBlock && 'text' in textBlock) {
        return textBlock.text;
      }

      return '[Summary generation failed - no text in response]';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `[Summary generation failed: ${message}]`;
    }
  }

  /**
   * Format messages for the summarization prompt.
   */
  private formatMessagesForSummary(messages: SummarizableMessage[]): string {
    return messages
      .map((msg, i) => {
        const role = msg.role.toUpperCase();
        const content = this.extractContent(msg);
        return `[${i + 1}] ${role}:\n${content}`;
      })
      .join('\n\n---\n\n');
  }

  /**
   * Extract text content from a message.
   */
  private extractContent(msg: SummarizableMessage): string {
    if (typeof msg.content === 'string') {
      return this.truncateContent(msg.content);
    }

    const parts: string[] = [];
    for (const part of msg.content) {
      if (part.text) {
        parts.push(this.truncateContent(part.text));
      }
    }
    return parts.join('\n');
  }

  /**
   * Truncate very long content for summary input.
   */
  private truncateContent(content: string, maxChars = 2000): string {
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + `\n[...truncated ${content.length - maxChars} chars]`;
  }

  /**
   * Estimate the cost of summarization.
   *
   * @param messages - Messages that would be summarized
   * @returns Estimated cost in USD
   */
  estimateCost(messages: SummarizableMessage[]): number {
    if (messages.length <= this.config.keepFirst + this.config.keepLast) {
      return 0;
    }

    const middleMessages = messages.slice(this.config.keepFirst, -this.config.keepLast);
    const inputTokens = middleMessages.reduce((sum, msg) => {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return sum + estimateTokens(content);
    }, 0);

    // Haiku pricing: $0.25/MTok input, $1.25/MTok output
    const inputCost = (inputTokens / 1_000_000) * 0.25;
    const outputCost = (this.config.maxSummaryTokens / 1_000_000) * 1.25;

    return inputCost + outputCost;
  }

  /**
   * Get statistics about potential summarization.
   */
  getStats(messages: SummarizableMessage[]): {
    totalMessages: number;
    wouldKeep: number;
    wouldSummarize: number;
    estimatedCost: number;
  } {
    const wouldKeep = Math.min(messages.length, this.config.keepFirst + this.config.keepLast);
    const wouldSummarize = Math.max(0, messages.length - wouldKeep);

    return {
      totalMessages: messages.length,
      wouldKeep,
      wouldSummarize,
      estimatedCost: this.estimateCost(messages),
    };
  }
}

/**
 * Create a summary message without LLM call (for testing/fallback).
 */
export function createFallbackSummary(messages: SummarizableMessage[]): string {
  const actions: string[] = [];
  const files: Set<string> = new Set();
  const errors: string[] = [];

  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

    // Extract file paths
    const fileMatches = content.match(/(?:\/[\w.\-/]+\.[\w]+)/g);
    if (fileMatches) {
      fileMatches.forEach((f) => files.add(f));
    }

    // Extract errors
    if (content.toLowerCase().includes('error')) {
      const errorMatch = content.match(/error[:\s]+([^\n]+)/i);
      if (errorMatch && errors.length < 3) {
        errors.push(errorMatch[1].slice(0, 100));
      }
    }

    // Extract key actions (from assistant messages)
    if (msg.role === 'assistant' && content.length < 500) {
      actions.push(content.slice(0, 100));
    }
  }

  const parts: string[] = ['## Conversation Summary (Fallback)', ''];

  if (files.size > 0) {
    parts.push('### Files Referenced');
    parts.push([...files].slice(0, 10).map((f) => `- ${f}`).join('\n'));
    parts.push('');
  }

  if (actions.length > 0) {
    parts.push('### Key Actions');
    parts.push(actions.slice(0, 5).map((a) => `- ${a}`).join('\n'));
    parts.push('');
  }

  if (errors.length > 0) {
    parts.push('### Errors Encountered');
    parts.push(errors.map((e) => `- ${e}`).join('\n'));
  }

  return parts.join('\n');
}
