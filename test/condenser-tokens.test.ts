import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateMessageTokens,
  createTracker,
  updateTracker,
  getCompressionLevel,
  formatTrackerStatus,
} from '../src/lib/condenser/tokens.js';

describe('Token Estimation', () => {
  describe('estimateTokens', () => {
    it('estimates tokens for English text', () => {
      const text = 'Hello, world!'; // 13 chars
      const tokens = estimateTokens(text, 'english');
      expect(tokens).toBe(4); // 13 / 4 = 3.25, ceil = 4
    });

    it('estimates tokens for code', () => {
      const code = 'const x = 1;'; // 12 chars
      const tokens = estimateTokens(code, 'code');
      expect(tokens).toBe(4); // 12 / 3.5 = 3.43, ceil = 4
    });

    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('handles long content', () => {
      const longText = 'a'.repeat(10000);
      const tokens = estimateTokens(longText);
      expect(tokens).toBeGreaterThan(2000);
    });
  });

  describe('estimateMessageTokens', () => {
    it('estimates tokens for string content', () => {
      const message = { role: 'user', content: 'Hello!' };
      const tokens = estimateMessageTokens(message);
      expect(tokens).toBeGreaterThan(4); // role overhead + content
    });

    it('estimates tokens for array content', () => {
      const message = {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello!' },
          { type: 'text', text: 'World!' },
        ],
      };
      const tokens = estimateMessageTokens(message);
      expect(tokens).toBeGreaterThan(10); // role + 2 parts with overhead
    });
  });

  describe('TokenTracker', () => {
    it('creates a tracker with default limit', () => {
      const tracker = createTracker();
      expect(tracker.used).toBe(0);
      expect(tracker.limit).toBe(200_000);
      expect(tracker.percentage).toBe(0);
    });

    it('creates a tracker with model-specific limit', () => {
      const tracker = createTracker('haiku');
      expect(tracker.limit).toBe(200_000);
    });

    it('updates correctly', () => {
      const tracker = createTracker();
      updateTracker(tracker, 'Hello, world!');
      expect(tracker.used).toBeGreaterThan(0);
      expect(tracker.percentage).toBeGreaterThan(0);
      expect(tracker.breakdown.assistant).toBeGreaterThan(0);
    });

    it('tracks by category', () => {
      const tracker = createTracker();
      updateTracker(tracker, 'User message', 'user');
      updateTracker(tracker, 'Assistant message', 'assistant');
      updateTracker(tracker, 'Tool output', 'tools');

      expect(tracker.breakdown.user).toBeGreaterThan(0);
      expect(tracker.breakdown.assistant).toBeGreaterThan(0);
      expect(tracker.breakdown.tools).toBeGreaterThan(0);
    });
  });

  describe('getCompressionLevel', () => {
    it('returns none for low usage', () => {
      const tracker = createTracker();
      tracker.percentage = 0.5;
      expect(getCompressionLevel(tracker)).toBe('none');
    });

    it('returns light for 70%+ usage', () => {
      const tracker = createTracker();
      tracker.percentage = 0.72;
      expect(getCompressionLevel(tracker)).toBe('light');
    });

    it('returns medium for 85%+ usage', () => {
      const tracker = createTracker();
      tracker.percentage = 0.88;
      expect(getCompressionLevel(tracker)).toBe('medium');
    });

    it('returns heavy for 95%+ usage', () => {
      const tracker = createTracker();
      tracker.percentage = 0.97;
      expect(getCompressionLevel(tracker)).toBe('heavy');
    });
  });

  describe('formatTrackerStatus', () => {
    it('formats status string', () => {
      const tracker = createTracker();
      tracker.used = 50_000;
      tracker.percentage = 0.25;

      const status = formatTrackerStatus(tracker);
      expect(status).toContain('50.0K');
      expect(status).toContain('200K');
      expect(status).toContain('25.0%');
    });

    it('includes warning for high usage', () => {
      const tracker = createTracker();
      tracker.used = 180_000;
      tracker.percentage = 0.9;

      const status = formatTrackerStatus(tracker);
      expect(status).toContain('[!!]');
    });
  });
});
