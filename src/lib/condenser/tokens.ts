/**
 * Token estimation and tracking for context compression.
 *
 * Uses character-based heuristics for speed (no API calls needed).
 * ~4 characters per token is a reasonable approximation for English text.
 */

// Token-to-character ratios by content type
const RATIOS = {
  english: 4.0, // Standard English text
  code: 3.5, // Code tends to have more tokens per char
  json: 3.0, // JSON has many punctuation tokens
  mixed: 3.75, // Default for mixed content
} as const;

export type ContentType = keyof typeof RATIOS;

/**
 * Estimate token count from text content.
 *
 * @param text - The text to estimate tokens for
 * @param type - Content type hint for better accuracy
 * @returns Estimated token count
 */
export function estimateTokens(text: string, type: ContentType = 'mixed'): number {
  if (!text) return 0;
  const ratio = RATIOS[type];
  return Math.ceil(text.length / ratio);
}

/**
 * Estimate tokens for a message object (handles different formats).
 */
export function estimateMessageTokens(message: {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
}): number {
  // Role overhead (~2-4 tokens)
  let tokens = 4;

  if (typeof message.content === 'string') {
    tokens += estimateTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.text) {
        tokens += estimateTokens(part.text);
      }
      // Tool results, images, etc. add overhead
      tokens += 10;
    }
  }

  return tokens;
}

/**
 * Model context limits (in tokens).
 * These are the input context windows, not output limits.
 */
export const MODEL_LIMITS: Record<string, number> = {
  // Anthropic models
  'claude-opus-4-5-20251101': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  // Aliases
  opus: 200_000,
  sonnet: 200_000,
  haiku: 200_000,
  // Default fallback
  default: 200_000,
};

/**
 * Get the context limit for a model.
 */
export function getModelLimit(model: string): number {
  return MODEL_LIMITS[model] ?? MODEL_LIMITS.default;
}

/**
 * Token usage tracker for a session.
 */
export interface TokenTracker {
  /** Total tokens used so far */
  used: number;
  /** Model's context limit */
  limit: number;
  /** Usage as percentage (0-1) */
  percentage: number;
  /** Breakdown by category */
  breakdown: {
    system: number;
    user: number;
    assistant: number;
    tools: number;
  };
}

/**
 * Create a new token tracker for a session.
 *
 * @param model - Model name to determine context limit
 * @returns Fresh token tracker
 */
export function createTracker(model: string = 'default'): TokenTracker {
  return {
    used: 0,
    limit: getModelLimit(model),
    percentage: 0,
    breakdown: {
      system: 0,
      user: 0,
      assistant: 0,
      tools: 0,
    },
  };
}

/**
 * Update tracker with new content.
 *
 * @param tracker - Tracker to update (mutated in place)
 * @param content - Content to add
 * @param category - Category for breakdown tracking
 */
export function updateTracker(
  tracker: TokenTracker,
  content: string,
  category: keyof TokenTracker['breakdown'] = 'assistant'
): void {
  const tokens = estimateTokens(content);
  tracker.used += tokens;
  tracker.breakdown[category] += tokens;
  tracker.percentage = tracker.used / tracker.limit;
}

/**
 * Update tracker from a message object.
 */
export function updateTrackerFromMessage(
  tracker: TokenTracker,
  message: { role?: string; content?: string | Array<{ type: string; text?: string }> }
): void {
  const tokens = estimateMessageTokens(message);
  const category = mapRoleToCategory(message.role);
  tracker.used += tokens;
  tracker.breakdown[category] += tokens;
  tracker.percentage = tracker.used / tracker.limit;
}

function mapRoleToCategory(role?: string): keyof TokenTracker['breakdown'] {
  switch (role) {
    case 'system':
      return 'system';
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'tool':
    case 'tool_result':
      return 'tools';
    default:
      return 'assistant';
  }
}

/**
 * Check if compression is needed based on thresholds.
 */
export type CompressionLevel = 'none' | 'light' | 'medium' | 'heavy';

export interface ThresholdConfig {
  light: number; // Default: 0.70
  medium: number; // Default: 0.85
  heavy: number; // Default: 0.95
}

const DEFAULT_THRESHOLDS: ThresholdConfig = {
  light: 0.7,
  medium: 0.85,
  heavy: 0.95,
};

/**
 * Determine what level of compression is needed.
 *
 * @param tracker - Current token tracker state
 * @param thresholds - Custom thresholds (optional)
 * @returns Compression level needed
 */
export function getCompressionLevel(
  tracker: TokenTracker,
  thresholds: ThresholdConfig = DEFAULT_THRESHOLDS
): CompressionLevel {
  if (tracker.percentage >= thresholds.heavy) return 'heavy';
  if (tracker.percentage >= thresholds.medium) return 'medium';
  if (tracker.percentage >= thresholds.light) return 'light';
  return 'none';
}

/**
 * Format tracker status for display.
 */
export function formatTrackerStatus(tracker: TokenTracker): string {
  const pct = (tracker.percentage * 100).toFixed(1);
  const used = (tracker.used / 1000).toFixed(1);
  const limit = (tracker.limit / 1000).toFixed(0);
  const level = getCompressionLevel(tracker);

  const levelIndicator =
    level === 'none' ? '' : level === 'light' ? ' [!]' : level === 'medium' ? ' [!!]' : ' [!!!]';

  return `${used}K / ${limit}K tokens (${pct}%)${levelIndicator}`;
}
