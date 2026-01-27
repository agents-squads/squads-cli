/**
 * Token-based pruning for context compression.
 *
 * Based on OpenCode's approach: protect recent tool outputs (40K tokens)
 * while pruning older outputs that exceed the threshold.
 *
 * Key insight: Recent context is critical for coherence. Older tool
 * outputs can be removed entirely without summarization.
 */

import { estimateMessageTokens } from './tokens.js';

/**
 * Configuration for token pruning.
 */
export interface PruneConfig {
  /** Tokens to protect from pruning (recent window). Default: 40000 */
  protectRecent: number;
  /** Minimum tokens that must be prunable before we prune. Default: 20000 */
  minimumPrunable: number;
  /** Tool types that should never be pruned */
  protectedTools: string[];
}

const DEFAULT_CONFIG: PruneConfig = {
  protectRecent: 40_000,
  minimumPrunable: 20_000,
  protectedTools: ['skill', 'memory', 'goal'],
};

/**
 * Message structure for pruning.
 */
export interface PrunableMessage {
  role: string;
  content: string | Array<MessagePart>;
  /** Internal: marks message as prunable */
  _prunable?: boolean;
  /** Internal: token count for this message */
  _tokens?: number;
}

export interface MessagePart {
  type: string;
  text?: string;
  tool_use_id?: string;
  name?: string;
  /** Internal: marks part as pruned */
  _pruned?: boolean;
  /** Internal: timestamp when pruned */
  _prunedAt?: number;
}

/**
 * Placeholder for pruned tool output.
 */
export function createPrunedPlaceholder(toolName: string, tokensSaved: number): string {
  return `[Tool output pruned: ${toolName} (~${Math.round(tokensSaved / 1000)}K tokens)]`;
}

/**
 * Token pruner for conversation context.
 */
export class TokenPruner {
  private config: PruneConfig;

  constructor(config: Partial<PruneConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Prune messages to reduce token count.
   *
   * Strategy:
   * 1. Scan messages backward from newest to oldest
   * 2. Accumulate tokens for tool outputs
   * 3. Mark outputs beyond protection window for pruning
   * 4. Replace pruned outputs with placeholders
   *
   * @param messages - Messages to prune
   * @returns Pruned messages (new array, originals not mutated)
   */
  pruneMessages(messages: PrunableMessage[]): PrunableMessage[] {
    // First pass: calculate tokens for each message
    const annotated = messages.map((msg) => ({
      ...msg,
      _tokens: estimateMessageTokens(msg),
    }));

    // Calculate what's prunable
    const analysis = this.analyzePrunability(annotated);

    if (analysis.prunableTokens < this.config.minimumPrunable) {
      // Not enough to prune - return unchanged
      return messages;
    }

    // Second pass: prune from oldest to newest, stopping at protection window
    return this.applyPruning(annotated, analysis.protectionIndex);
  }

  /**
   * Analyze which messages can be pruned.
   */
  private analyzePrunability(messages: Array<PrunableMessage & { _tokens: number }>): {
    prunableTokens: number;
    protectedTokens: number;
    protectionIndex: number;
  } {
    let protectedTokens = 0;
    let protectionIndex = messages.length;

    // Scan backward to find protection boundary
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];

      // Only tool results are prunable
      if (!this.isToolResult(msg)) {
        protectedTokens += msg._tokens;
        continue;
      }

      // Check if tool is protected type
      if (this.isProtectedTool(msg)) {
        protectedTokens += msg._tokens;
        continue;
      }

      // Add to protected until we hit threshold
      if (protectedTokens + msg._tokens <= this.config.protectRecent) {
        protectedTokens += msg._tokens;
      } else {
        // Found the boundary
        protectionIndex = i + 1;
        break;
      }
    }

    // Calculate prunable tokens (everything before protection index that's a tool result)
    let prunableTokens = 0;
    for (let i = 0; i < protectionIndex; i++) {
      const msg = messages[i];
      if (this.isToolResult(msg) && !this.isProtectedTool(msg)) {
        prunableTokens += msg._tokens;
      }
    }

    return { prunableTokens, protectedTokens, protectionIndex };
  }

  /**
   * Apply pruning to messages before the protection index.
   */
  private applyPruning(
    messages: Array<PrunableMessage & { _tokens: number }>,
    protectionIndex: number
  ): PrunableMessage[] {
    return messages.map((msg, i) => {
      // Messages at or after protection index are kept as-is
      if (i >= protectionIndex) {
        // Remove internal annotations
         
        const { _tokens, _prunable, ...clean } = msg;
        return clean;
      }

      // Non-tool messages are kept
      if (!this.isToolResult(msg)) {
         
        const { _tokens, _prunable, ...clean } = msg;
        return clean;
      }

      // Protected tools are kept
      if (this.isProtectedTool(msg)) {
         
        const { _tokens, _prunable, ...clean } = msg;
        return clean;
      }

      // Prune this tool result
      return this.createPrunedMessage(msg);
    });
  }

  /**
   * Create a pruned version of a message.
   */
  private createPrunedMessage(msg: PrunableMessage & { _tokens: number }): PrunableMessage {
    const toolName = this.getToolName(msg);
    const placeholder = createPrunedPlaceholder(toolName, msg._tokens);

    if (typeof msg.content === 'string') {
      return {
        role: msg.role,
        content: placeholder,
      };
    }

    // For array content, replace tool result parts
    const content = msg.content.map((part) => {
      if (part.type === 'tool_result' && part.text) {
        return {
          ...part,
          text: placeholder,
          _pruned: true,
          _prunedAt: Date.now(),
        };
      }
      return part;
    });

    return {
      role: msg.role,
      content,
    };
  }

  /**
   * Check if a message is a tool result.
   */
  private isToolResult(msg: PrunableMessage): boolean {
    if (msg.role === 'tool') return true;

    if (Array.isArray(msg.content)) {
      return msg.content.some((part) => part.type === 'tool_result');
    }

    return false;
  }

  /**
   * Check if a tool is in the protected list.
   */
  private isProtectedTool(msg: PrunableMessage): boolean {
    const toolName = this.getToolName(msg);
    return this.config.protectedTools.includes(toolName.toLowerCase());
  }

  /**
   * Extract tool name from a message.
   */
  private getToolName(msg: PrunableMessage): string {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.name) return part.name;
      }
    }

    // Try to extract from content
    if (typeof msg.content === 'string') {
      const match = msg.content.match(/Tool (?:output|result).*?:\s*(\w+)/i);
      if (match) return match[1];
    }

    return 'unknown';
  }

  /**
   * Get statistics about potential pruning.
   */
  getStats(messages: PrunableMessage[]): {
    totalTokens: number;
    prunableTokens: number;
    protectedTokens: number;
    savingsPercentage: number;
  } {
    const annotated = messages.map((msg) => ({
      ...msg,
      _tokens: estimateMessageTokens(msg),
    }));

    const totalTokens = annotated.reduce((sum, msg) => sum + msg._tokens, 0);
    const analysis = this.analyzePrunability(annotated);

    return {
      totalTokens,
      prunableTokens: analysis.prunableTokens,
      protectedTokens: analysis.protectedTokens,
      savingsPercentage: totalTokens > 0 ? (analysis.prunableTokens / totalTokens) * 100 : 0,
    };
  }
}
