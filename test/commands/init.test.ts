import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/git.js', () => ({
  checkGitStatus: vi.fn(),
  getRepoName: vi.fn(),
}));

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn(),
  Events: { CLI_INIT: 'cli_init' },
}));

vi.mock('../../src/lib/templates.js', () => ({
  loadTemplate: vi.fn(() => '# Template Content'),
}));

vi.mock('../../src/lib/setup-checks.js', () => ({
  PROVIDERS: {
    claude: { name: 'Claude Code' },
    gemini: { name: 'Gemini' },
    openai: { name: 'OpenAI GPT' },
    ollama: { name: 'Ollama' },
    none: { name: 'None' },
  },
  checkGhCli: vi.fn(() => ({ name: 'GitHub CLI', status: 'ok' })),
  runAuthChecks: vi.fn(() => [{ name: 'Auth', status: 'ok' }]),
  displayCheckResults: vi.fn(() => ({ hasErrors: false })),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
}));

vi.mock('chalk', () => ({
  default: {
    bold: vi.fn((s: string) => s),
    cyan: vi.fn((s: string) => s),
    dim: vi.fn((s: string) => s),
    green: Object.assign(vi.fn((s: string) => s), {
      bold: vi.fn((s: string) => s),
    }),
    red: vi.fn((s: string) => s),
    yellow: vi.fn((s: string) => s),
    blue: vi.fn((s: string) => s),
    gray: vi.fn((s: string) => s),
  },
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    access: vi.fn(() => Promise.reject(new Error('not found'))),
  },
}));

import { initCommand, type InitOptions } from '../../src/commands/init.js';
import { checkGitStatus } from '../../src/lib/git.js';
import { displayCheckResults } from '../../src/lib/setup-checks.js';
import { track } from '../../src/lib/telemetry.js';
import fs from 'fs/promises';

const mockCheckGitStatus = vi.mocked(checkGitStatus);
const mockDisplayCheckResults = vi.mocked(displayCheckResults);
const mockTrack = vi.mocked(track);
const mockMkdir = vi.mocked(fs.mkdir);
const mockWriteFile = vi.mocked(fs.writeFile);

describe('init command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckGitStatus.mockReturnValue({
      isGitRepo: true,
      hasRemote: true,
      remoteUrl: 'https://github.com/test/repo.git',
      branch: 'main',
      clean: true,
    } as ReturnType<typeof checkGitStatus>);
    mockDisplayCheckResults.mockReturnValue({ hasErrors: false, hasMissing: false });
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('runs with --yes flag (non-interactive)', async () => {
    await initCommand({ yes: true, provider: 'claude' });
    expect(mockMkdir).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalled();
  });

  it('runs with --quick flag', async () => {
    await initCommand({ quick: true, provider: 'claude' });
    expect(mockMkdir).toHaveBeenCalled();
  });

  it('creates directories for full-company use case', async () => {
    await initCommand({ yes: true, provider: 'claude' });
    const mkdirCalls = mockMkdir.mock.calls.map(c => c[0] as string);
    // Should create squad dirs for engineering, marketing, operations, company, research, intelligence
    expect(mkdirCalls.some(p => p.includes('engineering'))).toBe(true);
    expect(mkdirCalls.some(p => p.includes('marketing'))).toBe(true);
    expect(mkdirCalls.some(p => p.includes('operations'))).toBe(true);
    expect(mkdirCalls.some(p => p.includes('company'))).toBe(true);
    expect(mkdirCalls.some(p => p.includes('research'))).toBe(true);
    expect(mkdirCalls.some(p => p.includes('intelligence'))).toBe(true);
  });

  it('creates .claude dir for claude provider', async () => {
    await initCommand({ yes: true, provider: 'claude' });
    const mkdirCalls = mockMkdir.mock.calls.map(c => c[0] as string);
    expect(mkdirCalls.some(p => p.includes('.claude'))).toBe(true);
  });

  it('does not create .claude dir for non-claude provider', async () => {
    await initCommand({ yes: true, provider: 'gemini' });
    const mkdirCalls = mockMkdir.mock.calls.map(c => c[0] as string);
    // .claude dir should not be created for gemini
    const claudeDirCalls = mkdirCalls.filter(p => p.endsWith('.claude'));
    expect(claudeDirCalls.length).toBe(0);
  });

  it('exits when checks fail and no --force', async () => {
    mockDisplayCheckResults.mockReturnValue({ hasErrors: true, hasMissing: true });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(initCommand({ yes: true, provider: 'claude' })).rejects.toThrow('process.exit');
    exitSpy.mockRestore();
  });

  it('continues when checks fail with --force', async () => {
    mockDisplayCheckResults.mockReturnValue({ hasErrors: true, hasMissing: true });
    await initCommand({ yes: true, provider: 'claude', force: true });
    expect(mockMkdir).toHaveBeenCalled();
  });

  it('tracks initialization event', async () => {
    await initCommand({ yes: true, provider: 'claude' });
    expect(mockTrack).toHaveBeenCalledWith(
      'cli_init',
      expect.objectContaining({
        success: true,
        provider: 'claude',
        useCase: 'full-company',
      })
    );
  });
});
