import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseGoalDescription,
  validateGoalInput,
  formatParsedGoal,
  extractKeywords,
  promptForMissingComponents,
  type ParsedGoal,
} from '../src/lib/goal-parser.js';

describe('Goal Parser', () => {
  describe('parseGoalDescription', () => {
    it('parses goal with numeric target and unit', () => {
      const result = parseGoalDescription('Identify 10 qualified leads');
      expect(result.targetValue).toBe(10);
      // Parser finds first matching unit after the number - 'qualified' comes before 'leads'
      expect(result.targetUnit).toBe('qualified');
      expect(result.description).toBe('Identify 10 qualified leads');
    });

    it('parses simple goal with direct unit', () => {
      const result = parseGoalDescription('Generate 10 leads');
      expect(result.targetValue).toBe(10);
      expect(result.targetUnit).toBe('leads');
    });

    it('parses dollar amounts with K suffix', () => {
      const result = parseGoalDescription('Generate $50K revenue');
      expect(result.targetValue).toBe(50000);
      expect(result.targetUnit).toBe('revenue');
    });

    it('parses dollar amounts with M suffix', () => {
      const result = parseGoalDescription('Achieve $1.5M in sales');
      expect(result.targetValue).toBe(1500000);
      // 'sales' is found as unit in the text after the number
      expect(result.targetUnit).toBe('sales');
    });

    it('defaults dollar amounts to revenue when no unit found', () => {
      const result = parseGoalDescription('Achieve $1.5M');
      expect(result.targetValue).toBe(1500000);
      expect(result.targetUnit).toBe('revenue');
    });

    it('parses percentage targets', () => {
      const result = parseGoalDescription('Increase conversion rate by 15%');
      expect(result.targetValue).toBe(15);
      expect(result.targetUnit).toBe('percent');
    });

    it('parses various unit types', () => {
      // The parser looks for known units in the first 3 words after the number
      const tests = [
        { input: 'Write 5 posts for the team', expectedUnit: 'posts' },
        { input: 'Ship 3 features this sprint', expectedUnit: 'features' },
        { input: 'Acquire 100 users this month', expectedUnit: 'users' },
        { input: 'Complete 10 demos this week', expectedUnit: 'demos' },
        { input: 'Create 20 tests for validation', expectedUnit: 'tests' },
        { input: 'File 15 issues in tracker', expectedUnit: 'issues' },
      ];

      for (const { input, expectedUnit } of tests) {
        const result = parseGoalDescription(input);
        expect(result.targetUnit, `For input: "${input}"`).toBe(expectedUnit);
      }
    });

    it('returns null for unrecognized units', () => {
      const result = parseGoalDescription('Fix 20 things');
      expect(result.targetValue).toBe(20);
      expect(result.targetUnit).toBeNull();
    });

    it('parses deadlines with "by" keyword', () => {
      const result = parseGoalDescription('Generate 10 leads by January 10 2026');
      expect(result.targetValue).toBe(10);
      expect(result.deadline).not.toBeNull();
      expect(result.deadline?.getMonth()).toBe(0); // January
      expect(result.deadline?.getDate()).toBe(10);
    });

    it('parses deadlines with "before" keyword', () => {
      const result = parseGoalDescription('Ship feature before March 1 2026');
      expect(result.deadline).not.toBeNull();
      expect(result.deadline?.getMonth()).toBe(2); // March
    });

    it('returns null values when no target found', () => {
      const result = parseGoalDescription('Improve documentation');
      expect(result.targetValue).toBeNull();
      expect(result.targetUnit).toBeNull();
    });

    it('preserves original description', () => {
      const input = 'Generate $50K revenue by Q1';
      const result = parseGoalDescription(input);
      expect(result.original).toBe(input);
    });

    it('handles numbers with K suffix without dollar sign', () => {
      const result = parseGoalDescription('Get 5K page views');
      expect(result.targetValue).toBe(5000);
      expect(result.targetUnit).toBe('page');
    });

    it('handles decimal numbers', () => {
      const result = parseGoalDescription('Achieve 2.5 features per sprint');
      expect(result.targetValue).toBe(2.5);
    });
  });

  describe('validateGoalInput', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('validates goal with target and unit', () => {
      const result = validateGoalInput('Generate 10 leads');
      expect(result.valid).toBe(true);
      expect(result.parsed?.targetValue).toBe(10);
    });

    it('fails when no numeric target', () => {
      const result = validateGoalInput('Improve documentation');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('numeric target');
    });

    it('fails when target but no unit', () => {
      const result = validateGoalInput('Get 10 of something');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('numeric target');
    });

    it('warns when no deadline specified', () => {
      validateGoalInput('Generate 10 leads');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No deadline'));
    });

    it('does not warn when deadline is present', () => {
      validateGoalInput('Generate 10 leads by January 10 2026');
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe('formatParsedGoal', () => {
    it('formats goal with target and unit', () => {
      const parsed: ParsedGoal = {
        description: 'Generate 10 leads',
        targetValue: 10,
        targetUnit: 'leads',
        deadline: null,
        original: 'Generate 10 leads',
      };
      const formatted = formatParsedGoal(parsed);
      expect(formatted).toContain('Generate 10 leads');
      expect(formatted).toContain('Target: 10 leads');
    });

    it('formats goal with deadline', () => {
      const deadline = new Date('2026-01-10T00:00:00.000Z');
      const parsed: ParsedGoal = {
        description: 'Generate 10 leads',
        targetValue: 10,
        targetUnit: 'leads',
        deadline,
        original: 'Generate 10 leads by Jan 10',
      };
      const formatted = formatParsedGoal(parsed);
      expect(formatted).toContain('Deadline: 2026-01-10');
    });

    it('handles null target gracefully', () => {
      const parsed: ParsedGoal = {
        description: 'Improve docs',
        targetValue: null,
        targetUnit: null,
        deadline: null,
        original: 'Improve docs',
      };
      const formatted = formatParsedGoal(parsed);
      expect(formatted).toBe('Improve docs');
    });
  });

  describe('extractKeywords', () => {
    it('extracts meaningful keywords', () => {
      const keywords = extractKeywords('Identify 10 qualified leads by January');
      expect(keywords).toContain('identify');
      expect(keywords).toContain('qualified');
      expect(keywords).toContain('leads');
    });

    it('removes stop words', () => {
      const keywords = extractKeywords('Add the feature to the system');
      expect(keywords).not.toContain('the');
      expect(keywords).not.toContain('to');
      expect(keywords).toContain('add');
      expect(keywords).toContain('feature');
      expect(keywords).toContain('system');
    });

    it('removes numbers', () => {
      const keywords = extractKeywords('Generate 50 leads');
      expect(keywords).not.toContain('50');
    });

    it('removes short words (< 3 chars)', () => {
      const keywords = extractKeywords('Do it by Q1 and be quick');
      expect(keywords).not.toContain('do');
      expect(keywords).not.toContain('it');
      expect(keywords).not.toContain('be');
    });

    it('returns at most 5 keywords', () => {
      const keywords = extractKeywords('Identify generate create build ship deploy release publish test validate');
      expect(keywords.length).toBeLessThanOrEqual(5);
    });

    it('lowercases all keywords', () => {
      const keywords = extractKeywords('Generate LEADS quickly');
      expect(keywords).toContain('generate');
      expect(keywords).toContain('leads');
      expect(keywords).toContain('quickly');
    });
  });

  describe('promptForMissingComponents', () => {
    it('returns completed goal when all components present', async () => {
      const parsed: ParsedGoal = {
        description: 'Generate 10 leads',
        targetValue: 10,
        targetUnit: 'leads',
        deadline: new Date('2026-01-10'),
        original: 'Generate 10 leads',
      };

      const mockInquirer = {
        prompt: vi.fn(),
      };

      const result = await promptForMissingComponents(parsed, mockInquirer);
      expect(result).toEqual(parsed);
      expect(mockInquirer.prompt).not.toHaveBeenCalled();
    });

    it('prompts for target value when missing', async () => {
      const parsed: ParsedGoal = {
        description: 'Generate leads',
        targetValue: null,
        targetUnit: null,
        deadline: null,
        original: 'Generate leads',
      };

      const mockInquirer = {
        prompt: vi.fn()
          .mockResolvedValueOnce({ targetValue: 10 })
          .mockResolvedValueOnce({ targetUnit: 'leads' })
          .mockResolvedValueOnce({ deadline: '' }),
      };

      const result = await promptForMissingComponents(parsed, mockInquirer);
      expect(result?.targetValue).toBe(10);
      expect(result?.targetUnit).toBe('leads');
      expect(mockInquirer.prompt).toHaveBeenCalledTimes(3);
    });

    it('returns null if user cancels target value prompt', async () => {
      const parsed: ParsedGoal = {
        description: 'Generate leads',
        targetValue: null,
        targetUnit: null,
        deadline: null,
        original: 'Generate leads',
      };

      const mockInquirer = {
        prompt: vi.fn().mockResolvedValueOnce({ targetValue: 0 }),
      };

      const result = await promptForMissingComponents(parsed, mockInquirer);
      expect(result).toBeNull();
    });

    it('returns null if user cancels unit prompt', async () => {
      const parsed: ParsedGoal = {
        description: 'Generate leads',
        targetValue: 10,
        targetUnit: null,
        deadline: null,
        original: 'Generate leads',
      };

      const mockInquirer = {
        prompt: vi.fn().mockResolvedValueOnce({ targetUnit: '' }),
      };

      const result = await promptForMissingComponents(parsed, mockInquirer);
      expect(result).toBeNull();
    });

    it('parses deadline from user input', async () => {
      const parsed: ParsedGoal = {
        description: 'Generate leads',
        targetValue: 10,
        targetUnit: 'leads',
        deadline: null,
        original: 'Generate leads',
      };

      const mockInquirer = {
        prompt: vi.fn().mockResolvedValueOnce({ deadline: 'January 15 2026' }),
      };

      const result = await promptForMissingComponents(parsed, mockInquirer);
      expect(result?.deadline).not.toBeNull();
      expect(result?.deadline?.getMonth()).toBe(0);
      expect(result?.deadline?.getDate()).toBe(15);
    });

    it('handles invalid deadline gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const parsed: ParsedGoal = {
        description: 'Generate leads',
        targetValue: 10,
        targetUnit: 'leads',
        deadline: null,
        original: 'Generate leads',
      };

      const mockInquirer = {
        prompt: vi.fn().mockResolvedValueOnce({ deadline: 'not-a-date-xyz' }),
      };

      const result = await promptForMissingComponents(parsed, mockInquirer);
      expect(result?.deadline).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Could not parse'));

      consoleSpy.mockRestore();
    });

    it('updates description if target not included', async () => {
      const parsed: ParsedGoal = {
        description: 'Generate leads',
        targetValue: null,
        targetUnit: null,
        deadline: null,
        original: 'Generate leads',
      };

      const mockInquirer = {
        prompt: vi.fn()
          .mockResolvedValueOnce({ targetValue: 10 })
          .mockResolvedValueOnce({ targetUnit: 'leads' })
          .mockResolvedValueOnce({ deadline: '' }),
      };

      const result = await promptForMissingComponents(parsed, mockInquirer);
      expect(result?.description).toContain('10');
      expect(result?.description).toContain('leads');
    });
  });
});
