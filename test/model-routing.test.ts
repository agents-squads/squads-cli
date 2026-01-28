import { describe, it, expect } from 'vitest';

// Test the model routing logic extracted from run.ts
// This tests the pure function behavior

type ModelTier = 'opus' | 'sonnet' | 'haiku';
type TaskType = 'evaluation' | 'execution' | 'research' | 'lead';

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

// Extracted from run.ts for testing
function resolveModel(
  explicitModel: ModelTier | undefined,
  squad: MockSquad | null,
  taskType: TaskType
): ModelTier | undefined {
  if (explicitModel) {
    return explicitModel;
  }

  const modelConfig = squad?.context?.model;
  if (!modelConfig) {
    return undefined;
  }

  switch (taskType) {
    case 'evaluation':
      return (modelConfig.cheap as ModelTier) || (modelConfig.default as ModelTier);
    case 'lead':
      return (modelConfig.expensive as ModelTier) || (modelConfig.default as ModelTier);
    case 'research':
    case 'execution':
    default:
      return modelConfig.default as ModelTier;
  }
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
});
