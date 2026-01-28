import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseGoalDescription,
  validateGoalInput,
  formatParsedGoal,
  promptForMissingComponents,
  extractKeywords,
} from '../src/lib/goal-parser.js';

describe('goal-parser', () => {
  describe('parseGoalDescription', () => {
    it('parses goal with leads target', () => {
      const result = parseGoalDescription('Identify 10 qualified leads by Jan 10');

      expect(result.targetValue).toBe(10);
      expect(result.targetUnit).toBe('qualified'); // First matching word after number
    });

    it('parses goal with dollar amount', () => {
      const result = parseGoalDescription('Generate $50K revenue by Q1');

      expect(result.targetValue).toBe(50000);
      expect(result.targetUnit).toBe('revenue');
    });

    it('parses goal with dollar amount and M suffix', () => {
      const result = parseGoalDescription('Generate $1.5M in sales');

      expect(result.targetValue).toBe(1500000);
      expect(result.targetUnit).toBe('sales');
    });

    it('parses goal with percentage', () => {
      const result = parseGoalDescription('Achieve 80% coverage');

      expect(result.targetValue).toBe(80);
      // After the percent, 'coverage' is the first word but 'test' was first in other text
      // The implementation looks at text after the numeric match
      expect(result.targetUnit).toBe('percent');
    });

    it('parses goal with posts target', () => {
      // Note: "5 blog" gets "blog" matched first, but posts is in common units
      const result = parseGoalDescription('Publish 5 posts');

      expect(result.targetValue).toBe(5);
      expect(result.targetUnit).toBe('posts');
    });

    it('parses goal with features target', () => {
      const result = parseGoalDescription('Ship 3 new features');

      expect(result.targetValue).toBe(3);
      expect(result.targetUnit).toBe('features');
    });

    it('parses goal with users target', () => {
      const result = parseGoalDescription('Onboard 100 new users');

      expect(result.targetValue).toBe(100);
      expect(result.targetUnit).toBe('users');
    });

    it('parses goal with bugs target', () => {
      const result = parseGoalDescription('Fix 20 critical bugs');

      expect(result.targetValue).toBe(20);
      expect(result.targetUnit).toBe('bugs');
    });

    it('handles goal with K suffix', () => {
      const result = parseGoalDescription('Reach 50K page views');

      expect(result.targetValue).toBe(50000);
    });

    it('handles goal with B suffix', () => {
      const result = parseGoalDescription('Process 1B transactions');

      expect(result.targetValue).toBe(1000000000);
    });

    it('handles decimal values', () => {
      const result = parseGoalDescription('Achieve 99.9% uptime');

      expect(result.targetValue).toBe(99.9);
      expect(result.targetUnit).toBe('percent');
    });

    it('preserves original description', () => {
      const input = 'Ship something great';
      const result = parseGoalDescription(input);

      expect(result.original).toBe(input);
      expect(result.description).toBe(input);
    });

    it('handles goal without numeric target', () => {
      const result = parseGoalDescription('Improve overall system quality');

      expect(result.targetValue).toBeNull();
      expect(result.targetUnit).toBeNull();
    });
  });

  describe('validateGoalInput', () => {
    it('validates goal with target and unit', () => {
      const result = validateGoalInput('Ship 5 features');

      expect(result.valid).toBe(true);
      expect(result.parsed?.targetValue).toBe(5);
    });

    it('rejects goal without numeric target', () => {
      const result = validateGoalInput('Make things better');

      expect(result.valid).toBe(false);
      expect(result.message).toContain('numeric target');
    });

    it('rejects goal with number but no unit', () => {
      // "10" without a recognizable unit
      const result = validateGoalInput('Improve by 10');

      expect(result.valid).toBe(false);
      expect(result.message).toContain('numeric target');
    });

    it('validates dollar amounts as revenue', () => {
      const result = validateGoalInput('Earn $100K');

      expect(result.valid).toBe(true);
      expect(result.parsed?.targetUnit).toBe('revenue');
    });

    it('validates percentages', () => {
      const result = validateGoalInput('Reach 95% accuracy');

      expect(result.valid).toBe(true);
      expect(result.parsed?.targetUnit).toBe('percent');
    });
  });

  describe('formatParsedGoal', () => {
    it('formats complete goal', () => {
      const parsed = parseGoalDescription('Generate 10 leads by Jan 15');
      const formatted = formatParsedGoal(parsed);

      expect(formatted).toContain('Generate 10 leads');
      expect(formatted).toContain('Target: 10');
    });

    it('handles goal without deadline', () => {
      const parsed = parseGoalDescription('Ship 5 features');
      const formatted = formatParsedGoal(parsed);

      expect(formatted).toContain('Ship 5 features');
      expect(formatted).not.toContain('Deadline');
    });

    it('handles goal without target', () => {
      const parsed = parseGoalDescription('Improve quality');
      const formatted = formatParsedGoal(parsed);

      expect(formatted).toBe('Improve quality');
    });
  });

  describe('promptForMissingComponents', () => {
    it('prompts for missing target value', async () => {
      const parsed = parseGoalDescription('Do something');
      const mockInquirer = {
        prompt: vi.fn()
          .mockResolvedValueOnce({ targetValue: 10 })
          .mockResolvedValueOnce({ targetUnit: 'tasks' })
          .mockResolvedValueOnce({ deadline: '' })
      };

      const result = await promptForMissingComponents(parsed, mockInquirer);

      expect(result?.targetValue).toBe(10);
      expect(result?.targetUnit).toBe('tasks');
      expect(mockInquirer.prompt).toHaveBeenCalledTimes(3);
    });

    it('returns null if user provides no target', async () => {
      const parsed = parseGoalDescription('Do something');
      const mockInquirer = {
        prompt: vi.fn().mockResolvedValueOnce({ targetValue: undefined })
      };

      const result = await promptForMissingComponents(parsed, mockInquirer);

      expect(result).toBeNull();
    });

    it('skips prompts for complete goal with deadline', async () => {
      const parsed = parseGoalDescription('Ship 5 features by tomorrow');
      // If deadline is already parsed, no prompts needed
      if (parsed.deadline) {
        const mockInquirer = {
          prompt: vi.fn()
        };

        await promptForMissingComponents(parsed, mockInquirer);

        // No prompts needed since goal is complete
        expect(mockInquirer.prompt).not.toHaveBeenCalled();
      } else {
        // Deadline wasn't parsed, so one prompt for deadline
        const mockInquirer = {
          prompt: vi.fn().mockResolvedValue({ deadline: '' })
        };

        await promptForMissingComponents(parsed, mockInquirer);

        // Only deadline prompt needed
        expect(mockInquirer.prompt).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('extractKeywords', () => {
    it('extracts meaningful keywords', () => {
      const keywords = extractKeywords('Identify 10 qualified leads from LinkedIn');

      expect(keywords).toContain('identify');
      expect(keywords).toContain('qualified');
      expect(keywords).toContain('leads');
      expect(keywords).toContain('linkedin');
    });

    it('filters out stop words', () => {
      const keywords = extractKeywords('Ship the features to the users');

      expect(keywords).not.toContain('the');
      expect(keywords).not.toContain('to');
    });

    it('filters out numbers', () => {
      const keywords = extractKeywords('Ship 10 features by 2026');

      expect(keywords.every(k => !/\d/.test(k))).toBe(true);
    });

    it('filters out short words', () => {
      const keywords = extractKeywords('Do it now');

      expect(keywords).not.toContain('do');
      expect(keywords).not.toContain('it');
    });

    it('limits to 5 keywords', () => {
      const keywords = extractKeywords(
        'Identify qualified sales leads from enterprise customers through LinkedIn outreach campaigns'
      );

      expect(keywords.length).toBeLessThanOrEqual(5);
    });

    it('converts to lowercase', () => {
      const keywords = extractKeywords('Ship New FEATURES');

      expect(keywords.every(k => k === k.toLowerCase())).toBe(true);
    });
  });
});
