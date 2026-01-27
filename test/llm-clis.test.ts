import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';
import {
  LLM_CLIS,
  getCLIConfig,
  commandExists,
  getAllCLIStatus,
  isProviderCLIAvailable,
  type CLIConfig,
} from '../src/lib/llm-clis.js';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(childProcess.execSync);

describe('llm-clis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('LLM_CLIS registry', () => {
    it('contains all expected providers', () => {
      const expectedProviders = [
        'anthropic',
        'google',
        'openai',
        'mistral',
        'xai',
        'aider',
        'ollama',
      ];

      expect(Object.keys(LLM_CLIS)).toEqual(
        expect.arrayContaining(expectedProviders)
      );
      expect(Object.keys(LLM_CLIS)).toHaveLength(expectedProviders.length);
    });

    it('each provider has required fields', () => {
      for (const [key, config] of Object.entries(LLM_CLIS)) {
        expect(config.provider).toBe(key);
        expect(typeof config.displayName).toBe('string');
        expect(config.displayName.length).toBeGreaterThan(0);
        expect(typeof config.command).toBe('string');
        expect(config.command.length).toBeGreaterThan(0);
        expect(typeof config.install).toBe('string');
        expect(config.install.length).toBeGreaterThan(0);
        expect(typeof config.buildArgs).toBe('function');
      }
    });
  });

  describe('buildArgs functions', () => {
    it('anthropic builds correct args', () => {
      const args = LLM_CLIS.anthropic.buildArgs('test prompt');
      expect(args).toEqual(['--print', 'test prompt']);
    });

    it('google builds correct args', () => {
      const args = LLM_CLIS.google.buildArgs('test prompt');
      expect(args).toEqual(['--prompt', 'test prompt']);
    });

    it('openai builds correct args', () => {
      const args = LLM_CLIS.openai.buildArgs('test prompt');
      expect(args).toEqual(['exec', 'test prompt']);
    });

    it('mistral builds correct args', () => {
      const args = LLM_CLIS.mistral.buildArgs('test prompt');
      expect(args).toEqual(['--prompt', 'test prompt', '--auto-approve']);
    });

    it('xai builds correct args', () => {
      const args = LLM_CLIS.xai.buildArgs('test prompt');
      expect(args).toEqual(['--prompt', 'test prompt']);
    });

    it('aider builds correct args', () => {
      const args = LLM_CLIS.aider.buildArgs('test prompt');
      expect(args).toEqual(['--message', 'test prompt', '--yes']);
    });

    it('ollama builds args with default model', () => {
      const args = LLM_CLIS.ollama.buildArgs('test prompt');
      expect(args).toEqual(['run', 'llama3.1', 'test prompt']);
    });

    it('ollama builds args with custom model', () => {
      const args = LLM_CLIS.ollama.buildArgs('test prompt', {
        model: 'codellama',
      });
      expect(args).toEqual(['run', 'codellama', 'test prompt']);
    });
  });

  describe('getCLIConfig', () => {
    it('returns config for valid provider', () => {
      const config = getCLIConfig('anthropic');
      expect(config).toBeDefined();
      expect(config?.provider).toBe('anthropic');
      expect(config?.command).toBe('claude');
    });

    it('returns undefined for unknown provider', () => {
      const config = getCLIConfig('unknown-provider');
      expect(config).toBeUndefined();
    });

    it('returns config for all registered providers', () => {
      for (const provider of Object.keys(LLM_CLIS)) {
        const config = getCLIConfig(provider);
        expect(config).toBeDefined();
        expect(config?.provider).toBe(provider);
      }
    });
  });

  describe('commandExists', () => {
    it('returns true when command exists', () => {
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/bin/ls'));

      const result = commandExists('ls');

      expect(result).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith('which ls', { stdio: 'pipe' });
    });

    it('returns false when command does not exist', () => {
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error('Command not found');
      });

      const result = commandExists('nonexistent-command');

      expect(result).toBe(false);
    });
  });

  describe('getAllCLIStatus', () => {
    it('returns status for all providers', () => {
      // Mock some as available, some as not
      mockedExecSync
        .mockReturnValueOnce(Buffer.from('/usr/bin/claude')) // anthropic
        .mockImplementationOnce(() => {
          throw new Error();
        }) // google
        .mockImplementationOnce(() => {
          throw new Error();
        }) // openai
        .mockImplementationOnce(() => {
          throw new Error();
        }) // mistral
        .mockImplementationOnce(() => {
          throw new Error();
        }) // xai
        .mockImplementationOnce(() => {
          throw new Error();
        }) // aider
        .mockReturnValueOnce(Buffer.from('/usr/bin/ollama')); // ollama

      const status = getAllCLIStatus();

      expect(status).toHaveLength(7);

      const anthropicStatus = status.find((s) => s.provider === 'anthropic');
      expect(anthropicStatus?.available).toBe(true);
      expect(anthropicStatus?.displayName).toBe('Anthropic');
      expect(anthropicStatus?.command).toBe('claude');

      const googleStatus = status.find((s) => s.provider === 'google');
      expect(googleStatus?.available).toBe(false);

      const ollamaStatus = status.find((s) => s.provider === 'ollama');
      expect(ollamaStatus?.available).toBe(true);
    });

    it('includes install instructions for each provider', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error();
      });

      const status = getAllCLIStatus();

      for (const s of status) {
        expect(typeof s.install).toBe('string');
        expect(s.install.length).toBeGreaterThan(0);
      }
    });
  });

  describe('isProviderCLIAvailable', () => {
    it('returns true when provider CLI is available', () => {
      mockedExecSync.mockReturnValueOnce(Buffer.from('/usr/bin/claude'));

      const result = isProviderCLIAvailable('anthropic');

      expect(result).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith('which claude', {
        stdio: 'pipe',
      });
    });

    it('returns false when provider CLI is not available', () => {
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error();
      });

      const result = isProviderCLIAvailable('google');

      expect(result).toBe(false);
    });

    it('returns false for unknown provider', () => {
      const result = isProviderCLIAvailable('unknown-provider');

      expect(result).toBe(false);
      expect(mockedExecSync).not.toHaveBeenCalled();
    });
  });
});
