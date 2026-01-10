/**
 * File deduplication for context compression.
 *
 * Tracks file reads across a conversation and replaces duplicate
 * reads with concise references to save tokens.
 *
 * Based on Cline's approach: keeping only the latest version of each
 * file prevents LLM confusion during edit operations.
 */

import { estimateTokens } from './tokens.js';

/**
 * Record of a file read in the conversation.
 */
export interface FileReadRecord {
  /** File path that was read */
  path: string;
  /** Turn index where the read occurred */
  turnIndex: number;
  /** Estimated token count of the content */
  tokenCount: number;
  /** Hash of content for change detection */
  contentHash: string;
}

/**
 * Simple content hash for change detection.
 */
function hashContent(content: string): string {
  // Simple hash - just use first 100 chars + length
  // Full crypto hash would be overkill here
  const prefix = content.slice(0, 100);
  return `${content.length}:${prefix}`;
}

/**
 * Tracks file reads across a conversation for deduplication.
 */
export class FileDeduplicator {
  /** Map of file path to all reads of that file */
  private reads: Map<string, FileReadRecord[]> = new Map();

  /** Current turn index */
  private currentTurn = 0;

  /**
   * Record a file read.
   *
   * @param path - File path that was read
   * @param content - File content that was read
   */
  trackRead(path: string, content: string): void {
    const record: FileReadRecord = {
      path,
      turnIndex: this.currentTurn,
      tokenCount: estimateTokens(content, 'code'),
      contentHash: hashContent(content),
    };

    const existing = this.reads.get(path) || [];
    existing.push(record);
    this.reads.set(path, existing);
  }

  /**
   * Advance to next turn.
   */
  nextTurn(): void {
    this.currentTurn++;
  }

  /**
   * Get current turn index.
   */
  getTurn(): number {
    return this.currentTurn;
  }

  /**
   * Check if a file has been read before.
   *
   * @param path - File path to check
   * @returns Previous read record if exists
   */
  getPreviousRead(path: string): FileReadRecord | undefined {
    const reads = this.reads.get(path);
    if (!reads || reads.length === 0) return undefined;
    return reads[reads.length - 1];
  }

  /**
   * Get all files that have been read multiple times.
   *
   * @returns Map of path to read count
   */
  getDuplicateReads(): Map<string, number> {
    const duplicates = new Map<string, number>();
    for (const [path, reads] of this.reads) {
      if (reads.length > 1) {
        duplicates.set(path, reads.length);
      }
    }
    return duplicates;
  }

  /**
   * Calculate potential token savings from deduplication.
   */
  getPotentialSavings(): number {
    let savings = 0;
    for (const reads of this.reads.values()) {
      if (reads.length > 1) {
        // Can save all but the most recent read
        for (let i = 0; i < reads.length - 1; i++) {
          savings += reads[i].tokenCount;
        }
      }
    }
    return savings;
  }

  /**
   * Generate a deduplication reference message.
   *
   * @param path - File path
   * @param previousTurn - Turn where file was previously read
   */
  static createReference(path: string, previousTurn: number): string {
    return `[File "${path}" was read at turn ${previousTurn}. Content unchanged.]`;
  }

  /**
   * Reset tracker state.
   */
  reset(): void {
    this.reads.clear();
    this.currentTurn = 0;
  }

  /**
   * Get statistics for debugging.
   */
  getStats(): {
    filesTracked: number;
    totalReads: number;
    duplicateReads: number;
    potentialSavings: number;
  } {
    let totalReads = 0;
    let duplicateReads = 0;
    for (const reads of this.reads.values()) {
      totalReads += reads.length;
      if (reads.length > 1) {
        duplicateReads += reads.length - 1;
      }
    }

    return {
      filesTracked: this.reads.size,
      totalReads,
      duplicateReads,
      potentialSavings: this.getPotentialSavings(),
    };
  }
}

/**
 * Message type for deduplication processing.
 */
export interface DeduplicatableMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; tool_use_id?: string }>;
}

/**
 * Extract file paths from tool results.
 */
export function extractFileReads(message: DeduplicatableMessage): Array<{ path: string; content: string }> {
  const reads: Array<{ path: string; content: string }> = [];

  if (typeof message.content === 'string') {
    // Look for file read patterns in text
    const fileReadPattern = /(?:Reading|Read|Contents of) (?:file )?[`"']?([^`"'\n]+)[`"']?[\s\S]*?(?:```[\w]*\n([\s\S]*?)```|^(\d+[→│].+)$)/gm;
    let match;
    while ((match = fileReadPattern.exec(message.content)) !== null) {
      const path = match[1];
      const content = match[2] || match[3] || '';
      if (path && content) {
        reads.push({ path, content });
      }
    }
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'tool_result' && part.text) {
        // Tool results often contain file contents
        // Look for common patterns from Read tool
        const lines = part.text.split('\n');
        const firstLine = lines[0] || '';

        // Pattern: "Reading /path/to/file"
        if (firstLine.includes('→') || firstLine.match(/^\s*\d+[│|]/)) {
          // This looks like file content with line numbers
          // Try to extract path from context
          // (In practice, we'd get this from the tool input)
        }
      }
    }
  }

  return reads;
}

/**
 * Check if content represents a file that was previously read.
 *
 * @param deduplicator - Deduplicator instance
 * @param path - File path
 * @param content - Current content
 * @param savingsThreshold - Minimum savings ratio to deduplicate (default: 0.3 = 30%)
 * @returns Reference message if should deduplicate, null otherwise
 */
export function shouldDeduplicate(
  deduplicator: FileDeduplicator,
  path: string,
  content: string,
  savingsThreshold = 0.3
): string | null {
  const previous = deduplicator.getPreviousRead(path);

  if (!previous) {
    // First read - track it
    deduplicator.trackRead(path, content);
    return null;
  }

  const currentHash = hashContent(content);
  const currentTokens = estimateTokens(content, 'code');

  // Check if content changed
  if (previous.contentHash !== currentHash) {
    // Content changed - keep the new version, track it
    deduplicator.trackRead(path, content);
    return null;
  }

  // Calculate savings
  const referenceTokens = estimateTokens(FileDeduplicator.createReference(path, previous.turnIndex));
  const savings = (currentTokens - referenceTokens) / currentTokens;

  if (savings < savingsThreshold) {
    // Not worth deduplicating (Cline uses 30% threshold)
    deduplicator.trackRead(path, content);
    return null;
  }

  // Track this read but return reference
  deduplicator.trackRead(path, content);
  return FileDeduplicator.createReference(path, previous.turnIndex);
}
