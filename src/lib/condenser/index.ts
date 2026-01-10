/**
 * Context Condenser - Main Pipeline
 *
 * Coordinates the three compression strategies:
 * 1. Deduplication (70% threshold) - Replace duplicate file reads
 * 2. Pruning (85% threshold) - Remove old tool outputs
 * 3. Summarization (95% threshold) - LLM-based middle section summary
 *
 * Based on patterns from OpenCode, OpenHands, and Cline.
 */

import {
  TokenTracker,
  createTracker,
  updateTrackerFromMessage,
  getCompressionLevel,
  CompressionLevel,
  ThresholdConfig,
  formatTrackerStatus,
} from './tokens.js';
import { FileDeduplicator } from './deduplication.js';
import { TokenPruner, PruneConfig, PrunableMessage } from './pruning.js';
import { ConversationSummarizer, SummaryConfig, SummarizableMessage } from './summarizer.js';

// Re-export types
export { TokenTracker, CompressionLevel, ThresholdConfig };
export { FileDeduplicator } from './deduplication.js';
export { TokenPruner, PruneConfig } from './pruning.js';
export { ConversationSummarizer, SummaryConfig } from './summarizer.js';
export * from './tokens.js';

/**
 * Configuration for the context condenser.
 */
export interface CondenserConfig {
  /** Whether context compression is enabled */
  enabled: boolean;
  /** Threshold for light compression (deduplication) */
  lightThreshold: number;
  /** Threshold for medium compression (pruning) */
  mediumThreshold: number;
  /** Threshold for heavy compression (summarization) */
  heavyThreshold: number;
  /** Model context limit */
  modelLimit: number;
  /** Model name for tracking */
  model: string;
  /** Pruning configuration */
  pruning: Partial<PruneConfig>;
  /** Summarization configuration */
  summarization: Partial<SummaryConfig>;
}

const DEFAULT_CONFIG: CondenserConfig = {
  enabled: true,
  lightThreshold: 0.7,
  mediumThreshold: 0.85,
  heavyThreshold: 0.95,
  modelLimit: 200_000,
  model: 'claude-sonnet-4-20250514',
  pruning: {},
  summarization: {},
};

/**
 * Message type for the condenser pipeline.
 */
export interface CondenserMessage extends PrunableMessage, SummarizableMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; tool_use_id?: string; name?: string }>;
}

/**
 * Result of a condense operation.
 */
export interface CondenserResult {
  /** Condensed messages */
  messages: CondenserMessage[];
  /** Compression level applied */
  level: CompressionLevel;
  /** Tokens before compression */
  tokensBefore: number;
  /** Tokens after compression */
  tokensAfter: number;
  /** Savings percentage */
  savingsPercentage: number;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Context Condenser - Main class.
 */
export class ContextCondenser {
  private config: CondenserConfig;
  private tracker: TokenTracker;
  private deduplicator: FileDeduplicator;
  private pruner: TokenPruner;
  private summarizer: ConversationSummarizer;

  /** Metrics for tracking */
  private metrics = {
    condensationCount: 0,
    tokensRecovered: 0,
    lastLevel: 'none' as CompressionLevel,
  };

  constructor(config: Partial<CondenserConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tracker = createTracker(this.config.model);
    this.tracker.limit = this.config.modelLimit;
    this.deduplicator = new FileDeduplicator();
    this.pruner = new TokenPruner(this.config.pruning);
    this.summarizer = new ConversationSummarizer(this.config.summarization);
  }

  /**
   * Main entry point - condense messages if needed.
   *
   * @param messages - Current conversation messages
   * @returns Condensed messages and metadata
   */
  async condense(messages: CondenserMessage[]): Promise<CondenserResult> {
    const startTime = Date.now();

    if (!this.config.enabled) {
      return this.createResult(messages, messages, 'none', startTime);
    }

    // Update tracker with all messages
    this.updateTrackerFromMessages(messages);

    const level = getCompressionLevel(this.tracker, {
      light: this.config.lightThreshold,
      medium: this.config.mediumThreshold,
      heavy: this.config.heavyThreshold,
    });

    if (level === 'none') {
      return this.createResult(messages, messages, level, startTime);
    }

    let condensed: CondenserMessage[];

    switch (level) {
      case 'light':
        condensed = this.applyDeduplication(messages);
        break;
      case 'medium':
        condensed = this.applyPruning(messages);
        break;
      case 'heavy':
        condensed = await this.applySummarization(messages);
        break;
    }

    // Update metrics
    this.metrics.condensationCount++;
    this.metrics.lastLevel = level;

    return this.createResult(messages, condensed, level, startTime);
  }

  /**
   * Apply light compression (deduplication).
   */
  private applyDeduplication(messages: CondenserMessage[]): CondenserMessage[] {
    // For now, just return messages as-is
    // Full deduplication requires tracking reads across tool calls
    // which we'd integrate with the actual tool execution layer
    return messages;
  }

  /**
   * Apply medium compression (pruning).
   */
  private applyPruning(messages: CondenserMessage[]): CondenserMessage[] {
    return this.pruner.pruneMessages(messages) as CondenserMessage[];
  }

  /**
   * Apply heavy compression (summarization).
   */
  private async applySummarization(messages: CondenserMessage[]): Promise<CondenserMessage[]> {
    // First apply pruning
    const pruned = this.applyPruning(messages);

    // Then summarize if still needed
    const summarized = await this.summarizer.summarize(pruned);

    return summarized as CondenserMessage[];
  }

  /**
   * Update tracker from messages.
   */
  private updateTrackerFromMessages(messages: CondenserMessage[]): void {
    // Reset tracker
    this.tracker = createTracker(this.config.model);
    this.tracker.limit = this.config.modelLimit;

    // Add all messages
    for (const msg of messages) {
      updateTrackerFromMessage(this.tracker, msg);
    }
  }

  /**
   * Create result object.
   */
  private createResult(
    before: CondenserMessage[],
    after: CondenserMessage[],
    level: CompressionLevel,
    startTime: number
  ): CondenserResult {
    const tokensBefore = this.estimateTokens(before);
    const tokensAfter = this.estimateTokens(after);
    const savings = tokensBefore > 0 ? ((tokensBefore - tokensAfter) / tokensBefore) * 100 : 0;

    if (level !== 'none') {
      this.metrics.tokensRecovered += tokensBefore - tokensAfter;
    }

    return {
      messages: after,
      level,
      tokensBefore,
      tokensAfter,
      savingsPercentage: savings,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Estimate tokens for messages.
   */
  private estimateTokens(messages: CondenserMessage[]): number {
    const tempTracker = createTracker(this.config.model);
    for (const msg of messages) {
      updateTrackerFromMessage(tempTracker, msg);
    }
    return tempTracker.used;
  }

  /**
   * Get current tracker status.
   */
  getStatus(): string {
    return formatTrackerStatus(this.tracker);
  }

  /**
   * Get tracker for external monitoring.
   */
  getTracker(): TokenTracker {
    return { ...this.tracker };
  }

  /**
   * Get metrics.
   */
  getMetrics(): typeof this.metrics {
    return { ...this.metrics };
  }

  /**
   * Check if compression is needed.
   */
  needsCompression(): CompressionLevel {
    return getCompressionLevel(this.tracker, {
      light: this.config.lightThreshold,
      medium: this.config.mediumThreshold,
      heavy: this.config.heavyThreshold,
    });
  }

  /**
   * Reset condenser state.
   */
  reset(): void {
    this.tracker = createTracker(this.config.model);
    this.tracker.limit = this.config.modelLimit;
    this.deduplicator.reset();
    this.metrics = {
      condensationCount: 0,
      tokensRecovered: 0,
      lastLevel: 'none',
    };
  }

  /**
   * Get file deduplicator for integration with tool layer.
   */
  getDeduplicator(): FileDeduplicator {
    return this.deduplicator;
  }
}

/**
 * Create a condenser with squad-specific configuration.
 */
export function createCondenser(squadConfig?: {
  condenser?: {
    enabled?: boolean;
    light_threshold?: number;
    medium_threshold?: number;
    heavy_threshold?: number;
    protect_recent?: number;
  };
  model?: {
    default?: string;
  };
}): ContextCondenser {
  const condenserConfig = squadConfig?.condenser || {};
  const modelConfig = squadConfig?.model || {};

  return new ContextCondenser({
    enabled: condenserConfig.enabled ?? true,
    lightThreshold: condenserConfig.light_threshold ?? 0.7,
    mediumThreshold: condenserConfig.medium_threshold ?? 0.85,
    heavyThreshold: condenserConfig.heavy_threshold ?? 0.95,
    model: modelConfig.default ?? 'claude-sonnet-4-20250514',
    pruning: {
      protectRecent: condenserConfig.protect_recent ?? 40_000,
    },
  });
}
