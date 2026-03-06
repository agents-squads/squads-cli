import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/llm-clis.js', () => ({
  getAllCLIStatus: vi.fn(),
}));

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn().mockResolvedValue(undefined),
  Events: { CLI_PROVIDERS: 'cli.providers' },
}));

vi.mock('../../src/lib/terminal.js', () => ({
  colors: { dim: '', cyan: '', green: '', red: '', yellow: '' },
  RESET: '',
  gradient: (s: string) => s,
  icons: { success: '✓', error: '✗' },
  writeLine: vi.fn(),
  bold: (s: string) => s,
  padEnd: (s: string, n: number) => s.padEnd(n),
  truncate: (s: string) => s,
}));

import { providersCommand } from '../../src/commands/providers.js';
import { getAllCLIStatus } from '../../src/lib/llm-clis.js';

const mockGetAllCLIStatus = vi.mocked(getAllCLIStatus);

const mockStatuses = [
  { provider: 'claude', displayName: 'Claude', command: 'claude', available: true, install: 'npm i -g @anthropic-ai/claude-cli' },
  { provider: 'openai', displayName: 'OpenAI', command: 'openai', available: false, install: 'npm i -g openai-cli' },
  { provider: 'gemini', displayName: 'Gemini', command: 'gemini', available: true, install: 'npm i -g @google-ai/gemini-cli' },
];

describe('providersCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('JSON output', () => {
    it('outputs JSON with --json flag', async () => {
      mockGetAllCLIStatus.mockReturnValue(mockStatuses);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await providersCommand({ json: true });

      expect(logSpy).toHaveBeenCalledOnce();
      const output = logSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output) as typeof mockStatuses;
      expect(parsed).toHaveLength(3);
      expect(parsed[0].provider).toBe('claude');
      expect(parsed[0].available).toBe(true);

      logSpy.mockRestore();
    });

    it('JSON output includes all provider fields', async () => {
      mockGetAllCLIStatus.mockReturnValue(mockStatuses);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await providersCommand({ json: true });

      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string) as typeof mockStatuses;
      expect(parsed[0]).toHaveProperty('provider');
      expect(parsed[0]).toHaveProperty('displayName');
      expect(parsed[0]).toHaveProperty('command');
      expect(parsed[0]).toHaveProperty('available');
      expect(parsed[0]).toHaveProperty('install');

      logSpy.mockRestore();
    });
  });

  describe('pretty output', () => {
    it('calls getAllCLIStatus to get provider list', async () => {
      mockGetAllCLIStatus.mockReturnValue(mockStatuses);

      await providersCommand({});

      expect(mockGetAllCLIStatus).toHaveBeenCalledOnce();
    });

    it('completes without error when all providers available', async () => {
      const allAvailable = mockStatuses.map((s) => ({ ...s, available: true }));
      mockGetAllCLIStatus.mockReturnValue(allAvailable);

      await expect(providersCommand({})).resolves.toBeUndefined();
    });

    it('completes without error when no providers available', async () => {
      const noneAvailable = mockStatuses.map((s) => ({ ...s, available: false }));
      mockGetAllCLIStatus.mockReturnValue(noneAvailable);

      await expect(providersCommand({})).resolves.toBeUndefined();
    });

    it('completes without error when provider list is empty', async () => {
      mockGetAllCLIStatus.mockReturnValue([]);

      await expect(providersCommand({})).resolves.toBeUndefined();
    });

    it('tracks telemetry with provider counts', async () => {
      const { track } = await import('../../src/lib/telemetry.js');
      mockGetAllCLIStatus.mockReturnValue(mockStatuses);

      await providersCommand({});

      expect(track).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ available: 2, total: 3 })
      );
    });
  });
});
