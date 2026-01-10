import { describe, it, expect, vi } from 'vitest';
import {
  ContextCondenser,
  createCondenser,
  CondenserMessage,
} from '../src/lib/condenser/index.js';
import { TokenPruner } from '../src/lib/condenser/pruning.js';
import { FileDeduplicator, shouldDeduplicate } from '../src/lib/condenser/deduplication.js';

describe('ContextCondenser Integration', () => {
  describe('createCondenser with squad config', () => {
    it('creates condenser with default settings', () => {
      const condenser = createCondenser();
      const tracker = condenser.getTracker();

      expect(tracker.limit).toBe(200_000);
    });

    it('creates condenser from squad config', () => {
      const squadConfig = {
        condenser: {
          enabled: true,
          light_threshold: 0.6,
          medium_threshold: 0.8,
          heavy_threshold: 0.9,
          protect_recent: 30_000,
        },
        model: {
          default: 'claude-opus-4-5-20251101',
        },
      };

      const condenser = createCondenser(squadConfig);
      expect(condenser.needsCompression()).toBe('none');
    });

    it('respects disabled flag', async () => {
      const condenser = createCondenser({
        condenser: { enabled: false },
      });

      const messages: CondenserMessage[] = [
        { role: 'user', content: 'a'.repeat(180_000) }, // Would trigger compression
      ];

      const result = await condenser.condense(messages);
      expect(result.level).toBe('none');
      expect(result.messages).toBe(messages); // Unchanged
    });
  });

  describe('Full pipeline', () => {
    it('returns none for low context usage', async () => {
      const condenser = new ContextCondenser();
      const messages: CondenserMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const result = await condenser.condense(messages);

      expect(result.level).toBe('none');
      expect(result.tokensBefore).toBeLessThan(100);
      expect(result.savingsPercentage).toBe(0);
    });

    it('triggers light compression at 70%', async () => {
      // Token estimation: ~4 chars per token
      // So for 1000 token limit, we need ~4000 chars to hit 100%
      // 70% = ~2800 chars
      const condenser = new ContextCondenser({
        modelLimit: 1000, // Small limit for testing
      });

      const messages: CondenserMessage[] = [
        { role: 'user', content: 'a'.repeat(3000) }, // ~750 tokens = 75%
      ];

      const result = await condenser.condense(messages);
      expect(result.level).toBe('light');
    });

    it('triggers medium compression at 85%', async () => {
      const condenser = new ContextCondenser({
        modelLimit: 1000,
      });

      // Need 85-95% = 850-950 tokens
      // At 3.75 chars/token, need ~3400 chars for 90%
      const messages: CondenserMessage[] = [
        { role: 'tool', content: 'a'.repeat(1200) }, // ~320 tokens
        { role: 'tool', content: 'b'.repeat(1200) }, // ~320 tokens
        { role: 'user', content: 'c'.repeat(1000) }, // ~267 tokens + overhead = ~90%
      ];

      const result = await condenser.condense(messages);
      expect(result.level).toBe('medium');
    });

    it('tracks metrics across condensations', async () => {
      const condenser = new ContextCondenser({
        modelLimit: 1000,
      });

      // First condense - trigger light (need 70%+ = 2800+ chars)
      await condenser.condense([
        { role: 'user', content: 'a'.repeat(3000) },
      ]);

      // Second condense - trigger light again
      await condenser.condense([
        { role: 'user', content: 'b'.repeat(3200) },
      ]);

      const metrics = condenser.getMetrics();
      expect(metrics.condensationCount).toBe(2);
    });
  });

  describe('TokenPruner', () => {
    it('protects recent 40K tokens by default', () => {
      const pruner = new TokenPruner();
      const messages: CondenserMessage[] = [
        { role: 'tool', content: 'old output '.repeat(5000) }, // ~15K tokens
        { role: 'tool', content: 'recent output '.repeat(3000) }, // ~10K tokens
        { role: 'user', content: 'current task' },
      ];

      const stats = pruner.getStats(messages);
      expect(stats.protectedTokens).toBeGreaterThan(0);
    });

    it('replaces pruned content with placeholder', () => {
      const pruner = new TokenPruner({
        protectRecent: 100, // Very small protection window
        minimumPrunable: 50,
      });

      const messages: CondenserMessage[] = [
        { role: 'tool', content: 'x'.repeat(500) }, // Will be pruned
        { role: 'user', content: 'keep this' }, // Protected
      ];

      const pruned = pruner.pruneMessages(messages);

      // First message should be pruned
      expect(pruned[0].content).toContain('[Tool output pruned');
    });

    it('never prunes protected tool types', () => {
      const pruner = new TokenPruner({
        protectRecent: 10,
        minimumPrunable: 50,
        protectedTools: ['memory', 'goal'],
      });

      const messages: CondenserMessage[] = [
        {
          role: 'tool',
          content: [{ type: 'tool_result', text: 'x'.repeat(500), name: 'memory' }],
        },
        { role: 'user', content: 'y' },
      ];

      const pruned = pruner.pruneMessages(messages);

      // Memory tool should NOT be pruned
      const content = pruned[0].content;
      if (Array.isArray(content)) {
        expect(content[0].text).not.toContain('[Tool output pruned');
      }
    });
  });

  describe('FileDeduplicator', () => {
    it('tracks file reads', () => {
      const dedup = new FileDeduplicator();

      dedup.trackRead('/src/index.ts', 'const x = 1;');
      dedup.nextTurn();
      dedup.trackRead('/src/utils.ts', 'export {}');

      const stats = dedup.getStats();
      expect(stats.filesTracked).toBe(2);
      expect(stats.totalReads).toBe(2);
    });

    it('detects duplicate reads', () => {
      const dedup = new FileDeduplicator();

      dedup.trackRead('/src/index.ts', 'const x = 1;');
      dedup.nextTurn();
      dedup.trackRead('/src/index.ts', 'const x = 1;'); // Same content

      const duplicates = dedup.getDuplicateReads();
      expect(duplicates.get('/src/index.ts')).toBe(2);
    });

    it('calculates potential savings', () => {
      const dedup = new FileDeduplicator();

      // Large file read multiple times
      const content = 'a'.repeat(1000);
      dedup.trackRead('/large-file.ts', content);
      dedup.nextTurn();
      dedup.trackRead('/large-file.ts', content);
      dedup.nextTurn();
      dedup.trackRead('/large-file.ts', content);

      const savings = dedup.getPotentialSavings();
      expect(savings).toBeGreaterThan(400); // Should save ~2 reads worth
    });

    it('shouldDeduplicate returns reference for unchanged files', () => {
      const dedup = new FileDeduplicator();
      const content = 'a'.repeat(500); // Large enough to be worth deduplicating

      // First read
      const first = shouldDeduplicate(dedup, '/file.ts', content);
      expect(first).toBeNull(); // First read, no dedup

      dedup.nextTurn();

      // Second read with same content
      const second = shouldDeduplicate(dedup, '/file.ts', content);
      expect(second).toContain('[File "/file.ts" was read at turn');
    });

    it('shouldDeduplicate returns null for changed files', () => {
      const dedup = new FileDeduplicator();

      shouldDeduplicate(dedup, '/file.ts', 'version 1');
      dedup.nextTurn();

      // Content changed
      const result = shouldDeduplicate(dedup, '/file.ts', 'version 2 with more content');
      expect(result).toBeNull(); // Don't deduplicate, content changed
    });
  });

  describe('Execution Context + Condenser Integration', () => {
    it('squad config flows through to condenser behavior', async () => {
      // Simulate a squad with aggressive compression thresholds
      const squadConfig = {
        condenser: {
          enabled: true,
          light_threshold: 0.5, // Trigger light at 50%
          medium_threshold: 0.7, // Trigger medium at 70%
          heavy_threshold: 0.85, // Trigger heavy at 85%
          protect_recent: 20_000,
        },
        model: {
          default: 'sonnet',
        },
      };

      const condenser = createCondenser(squadConfig);

      // 200K limit, need 55% = 110K tokens = ~440K chars
      const messages: CondenserMessage[] = [
        { role: 'user', content: 'a'.repeat(440_000) }, // ~110K tokens = 55%
      ];

      const result = await condenser.condense(messages);
      expect(result.level).toBe('light'); // Triggered at 50%
    });

    it('different squads can have different compression settings', async () => {
      // Website squad - aggressive compression (limited context for SEO tools)
      const websiteCondenser = createCondenser({
        condenser: {
          light_threshold: 0.5,
          protect_recent: 20_000,
        },
      });

      // Research squad - conservative compression (need full context)
      const researchCondenser = createCondenser({
        condenser: {
          light_threshold: 0.8,
          protect_recent: 60_000,
        },
      });

      // 200K limit, 60% = 120K tokens = ~480K chars
      const messages: CondenserMessage[] = [
        { role: 'user', content: 'a'.repeat(480_000) }, // ~120K tokens = 60%
      ];

      const websiteResult = await websiteCondenser.condense(messages);
      const researchResult = await researchCondenser.condense(messages);

      expect(websiteResult.level).toBe('light'); // Triggered at 50%
      expect(researchResult.level).toBe('none'); // Not triggered until 80%
    });
  });

  describe('Condenser status and metrics', () => {
    it('formats tracker status correctly', () => {
      const condenser = new ContextCondenser({ modelLimit: 200_000 });

      // Add some content
      condenser.condense([
        { role: 'user', content: 'a'.repeat(50_000) },
      ]);

      const status = condenser.getStatus();
      expect(status).toContain('K');
      expect(status).toContain('%');
    });

    it('reset clears all state', async () => {
      const condenser = new ContextCondenser({ modelLimit: 1000 });

      // Need 70%+ to trigger condensation = 700 tokens = ~2800 chars
      await condenser.condense([
        { role: 'user', content: 'a'.repeat(3000) },
      ]);

      expect(condenser.getMetrics().condensationCount).toBe(1);

      condenser.reset();

      expect(condenser.getMetrics().condensationCount).toBe(0);
      expect(condenser.getTracker().used).toBe(0);
    });
  });
});
