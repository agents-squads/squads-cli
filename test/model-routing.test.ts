import { describe, it, expect } from 'vitest';

// Test the model routing logic extracted from run.ts
// This tests the pure function behavior for multi-provider support

type TaskType = 'evaluation' | 'execution' | 'research' | 'lead';
type ClaudeModelAlias = 'opus' | 'sonnet' | 'haiku';

interface ModelConfig {
  default?: string;
  expensive?: string;
  cheap?: string;
}

interface MockSquad {
  context?: {
    model?: ModelConfig;
  };
}

// Extracted from run.ts for testing - supports full model names
function resolveModel(
  explicitModel: string | undefined,
  squad: MockSquad | null,
  taskType: TaskType
): string | undefined {
  if (explicitModel) {
    return explicitModel;
  }

  const modelConfig = squad?.context?.model;
  if (!modelConfig) {
    return undefined;
  }

  switch (taskType) {
    case 'evaluation':
      return modelConfig.cheap || modelConfig.default;
    case 'lead':
      return modelConfig.expensive || modelConfig.default;
    case 'research':
    case 'execution':
    default:
      return modelConfig.default;
  }
}

// Extracted from run.ts - maps full model names to Claude Code aliases
function getClaudeModelAlias(model: string): ClaudeModelAlias | undefined {
  const lower = model.toLowerCase();

  // Direct aliases
  if (lower === 'opus' || lower === 'sonnet' || lower === 'haiku') {
    return lower as ClaudeModelAlias;
  }

  // Full model name mapping
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';

  // Unknown Claude model
  return undefined;
}

describe('Model Routing', () => {
  describe('resolveModel', () => {
    it('explicit model always wins', () => {
      const squad: MockSquad = {
        context: {
          model: { default: 'sonnet', cheap: 'haiku', expensive: 'opus' }
        }
      };

      expect(resolveModel('haiku', squad, 'lead')).toBe('haiku');
      expect(resolveModel('opus', squad, 'evaluation')).toBe('opus');
    });

    it('returns undefined when no squad context', () => {
      expect(resolveModel(undefined, null, 'execution')).toBeUndefined();
      expect(resolveModel(undefined, {}, 'execution')).toBeUndefined();
      expect(resolveModel(undefined, { context: {} }, 'execution')).toBeUndefined();
    });

    it('routes evaluation to cheap model', () => {
      const squad: MockSquad = {
        context: {
          model: { default: 'sonnet', cheap: 'haiku', expensive: 'opus' }
        }
      };

      expect(resolveModel(undefined, squad, 'evaluation')).toBe('haiku');
    });

    it('routes lead to expensive model', () => {
      const squad: MockSquad = {
        context: {
          model: { default: 'sonnet', cheap: 'haiku', expensive: 'opus' }
        }
      };

      expect(resolveModel(undefined, squad, 'lead')).toBe('opus');
    });

    it('routes research to default model', () => {
      const squad: MockSquad = {
        context: {
          model: { default: 'sonnet', cheap: 'haiku', expensive: 'opus' }
        }
      };

      expect(resolveModel(undefined, squad, 'research')).toBe('sonnet');
    });

    it('routes execution to default model', () => {
      const squad: MockSquad = {
        context: {
          model: { default: 'sonnet', cheap: 'haiku', expensive: 'opus' }
        }
      };

      expect(resolveModel(undefined, squad, 'execution')).toBe('sonnet');
    });

    it('falls back to default when cheap not configured', () => {
      const squad: MockSquad = {
        context: {
          model: { default: 'sonnet' }
        }
      };

      expect(resolveModel(undefined, squad, 'evaluation')).toBe('sonnet');
    });

    it('falls back to default when expensive not configured', () => {
      const squad: MockSquad = {
        context: {
          model: { default: 'sonnet' }
        }
      };

      expect(resolveModel(undefined, squad, 'lead')).toBe('sonnet');
    });
  });

  describe('multi-provider model routing', () => {
    it('supports Google Gemini models', () => {
      const squad: MockSquad = {
        context: {
          model: {
            default: 'gemini-2.0-flash',
            cheap: 'gemini-2.5-flash',
            expensive: 'gemini-2.5-pro'
          }
        }
      };

      expect(resolveModel(undefined, squad, 'evaluation')).toBe('gemini-2.5-flash');
      expect(resolveModel(undefined, squad, 'lead')).toBe('gemini-2.5-pro');
      expect(resolveModel(undefined, squad, 'execution')).toBe('gemini-2.0-flash');
    });

    it('supports mixed provider configs', () => {
      const squad: MockSquad = {
        context: {
          model: {
            default: 'claude-sonnet-4',
            cheap: 'gemini-2.5-flash',  // Use cheap Gemini for evals
            expensive: 'claude-opus-4-5'
          }
        }
      };

      expect(resolveModel(undefined, squad, 'evaluation')).toBe('gemini-2.5-flash');
      expect(resolveModel(undefined, squad, 'lead')).toBe('claude-opus-4-5');
      expect(resolveModel(undefined, squad, 'research')).toBe('claude-sonnet-4');
    });

    it('supports full Claude model names', () => {
      const squad: MockSquad = {
        context: {
          model: {
            default: 'claude-sonnet-4',
            cheap: 'claude-3-5-haiku',
            expensive: 'claude-opus-4-5'
          }
        }
      };

      expect(resolveModel(undefined, squad, 'evaluation')).toBe('claude-3-5-haiku');
      expect(resolveModel(undefined, squad, 'lead')).toBe('claude-opus-4-5');
    });
  });

  describe('getClaudeModelAlias', () => {
    it('returns direct aliases unchanged', () => {
      expect(getClaudeModelAlias('opus')).toBe('opus');
      expect(getClaudeModelAlias('sonnet')).toBe('sonnet');
      expect(getClaudeModelAlias('haiku')).toBe('haiku');
    });

    it('maps full Claude model names to aliases', () => {
      expect(getClaudeModelAlias('claude-opus-4-5')).toBe('opus');
      expect(getClaudeModelAlias('claude-opus-4-5-20251101')).toBe('opus');
      expect(getClaudeModelAlias('claude-sonnet-4')).toBe('sonnet');
      expect(getClaudeModelAlias('claude-3-5-sonnet-20241022')).toBe('sonnet');
      expect(getClaudeModelAlias('claude-3-5-haiku')).toBe('haiku');
      expect(getClaudeModelAlias('claude-haiku-3-5')).toBe('haiku');
    });

    it('handles case insensitivity', () => {
      expect(getClaudeModelAlias('OPUS')).toBe('opus');
      expect(getClaudeModelAlias('Sonnet')).toBe('sonnet');
      expect(getClaudeModelAlias('CLAUDE-OPUS-4-5')).toBe('opus');
    });

    it('returns undefined for non-Claude models', () => {
      expect(getClaudeModelAlias('gemini-2.5-flash')).toBeUndefined();
      expect(getClaudeModelAlias('gpt-4o')).toBeUndefined();
      expect(getClaudeModelAlias('mistral-large')).toBeUndefined();
    });
  });
});
