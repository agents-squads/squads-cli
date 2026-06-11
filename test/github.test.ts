import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
  };
});

import {
  getCoAuthorTrailer,
  detectGitHubOrg,
  detectGitHubRepo,
  getBotGitEnv,
  getBotGhEnv,
  getBotPushUrl,
  createGitHubRepo,
} from '../src/lib/github.js';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false); // no github app config by default
});

describe('getCoAuthorTrailer', () => {
  it('returns the canonical Claude trailer for anthropic provider', () => {
    const result = getCoAuthorTrailer('anthropic');
    expect(result).toBe('Co-Authored-By: Claude <noreply@anthropic.com>');
  });

  it('returns the canonical Claude trailer for claude provider', () => {
    const result = getCoAuthorTrailer('claude');
    expect(result).toBe('Co-Authored-By: Claude <noreply@anthropic.com>');
  });

  it('strips model suffix from provider name (claude-sonnet → claude)', () => {
    const result = getCoAuthorTrailer('claude-sonnet-4');
    expect(result).toContain('Claude <noreply@anthropic.com>');
  });

  it('returns the DeepSeek trailer for deepseek provider', () => {
    const result = getCoAuthorTrailer('deepseek');
    expect(result).toContain('DeepSeek');
  });

  it('returns gemini trailer for gemini provider', () => {
    const result = getCoAuthorTrailer('gemini');
    expect(result).toContain('gemini-code-assist');
  });

  it('returns gemini trailer for google provider', () => {
    const result = getCoAuthorTrailer('google');
    expect(result).toContain('gemini-code-assist');
  });

  it('returns GPT trailer for openai provider', () => {
    const result = getCoAuthorTrailer('openai');
    expect(result).toContain('GPT');
  });

  it('returns fallback trailer for unknown provider', () => {
    const result = getCoAuthorTrailer('unknown-provider');
    expect(result).toContain('unknown-provider');
    expect(result).toContain('Co-Authored-By:');
    expect(result).toContain('noreply@agents-squads.com');
  });

  it('handles uppercase provider names by lowercasing', () => {
    const result = getCoAuthorTrailer('Anthropic');
    expect(result).toContain('Claude <noreply@anthropic.com>');
  });
});

describe('detectGitHubOrg', () => {
  it('extracts org from HTTPS remote URL', () => {
    mockExecSync.mockReturnValue('https://github.com/my-org/my-repo.git\n' as unknown as Buffer);
    expect(detectGitHubOrg('/some/dir')).toBe('my-org');
  });

  it('extracts org from SSH remote URL', () => {
    mockExecSync.mockReturnValue('git@github.com:my-org/my-repo.git\n' as unknown as Buffer);
    expect(detectGitHubOrg('/some/dir')).toBe('my-org');
  });

  it('returns undefined when not a GitHub remote', () => {
    mockExecSync.mockReturnValue('https://gitlab.com/my-org/my-repo.git\n' as unknown as Buffer);
    expect(detectGitHubOrg('/some/dir')).toBeUndefined();
  });

  it('returns undefined when execSync throws', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo'); });
    expect(detectGitHubOrg('/some/dir')).toBeUndefined();
  });
});

describe('detectGitHubRepo', () => {
  it('extracts org/repo from HTTPS remote URL', () => {
    mockExecSync.mockReturnValue('https://github.com/agents-squads/squads-cli.git\n' as unknown as Buffer);
    expect(detectGitHubRepo('/some/dir')).toBe('agents-squads/squads-cli');
  });

  it('extracts org/repo from SSH remote URL', () => {
    mockExecSync.mockReturnValue('git@github.com:agents-squads/squads-cli.git\n' as unknown as Buffer);
    expect(detectGitHubRepo('/some/dir')).toBe('agents-squads/squads-cli');
  });

  it('returns undefined when not a GitHub remote', () => {
    mockExecSync.mockReturnValue('https://bitbucket.org/my-org/my-repo.git\n' as unknown as Buffer);
    expect(detectGitHubRepo('/some/dir')).toBeUndefined();
  });

  it('returns undefined when execSync throws', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo'); });
    expect(detectGitHubRepo('/some/dir')).toBeUndefined();
  });
});

describe('getBotGitEnv', () => {
  it('returns empty object when no github app config exists', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await getBotGitEnv();
    expect(result).toEqual({});
  });
});

describe('getBotGhEnv', () => {
  it('returns empty object when no github app config exists', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await getBotGhEnv();
    expect(result).toEqual({});
  });
});

describe('getBotPushUrl', () => {
  it('returns null when no github app config exists', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await getBotPushUrl('agents-squads/squads-cli');
    expect(result).toBeNull();
  });
});

describe('createGitHubRepo', () => {
  it('throws when gh CLI is not available', () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd === 'gh --version') {
        throw new Error('command not found: gh');
      }
      return '' as unknown as Buffer;
    });
    expect(() => createGitHubRepo('test-repo')).toThrow('gh CLI not found');
  });

  it('throws when repo already exists', () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('gh --version')) return '' as unknown as Buffer;
      if (typeof cmd === 'string' && cmd.includes('gh repo view')) return '{"name":"test-repo"}' as unknown as Buffer;
      return '' as unknown as Buffer;
    });
    expect(() => createGitHubRepo('test-repo', { org: 'my-org' })).toThrow('already exists');
  });

  it('creates private repo by default', () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('gh --version')) return '' as unknown as Buffer;
      if (typeof cmd === 'string' && cmd.includes('gh repo view')) throw new Error('not found');
      // repo create succeeds
      return 'https://github.com/my-org/test-repo' as unknown as Buffer;
    });
    const result = createGitHubRepo('test-repo', { org: 'my-org' });
    expect(result.fullName).toBe('my-org/test-repo');
    expect(result.url).toContain('github.com');
    // Verify --private flag was used
    const createCall = mockExecSync.mock.calls.find(
      c => typeof c[0] === 'string' && (c[0] as string).includes('repo create')
    );
    expect(createCall?.[0]).toContain('--private');
  });

  it('uses org/repo format when org provided', () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('gh --version')) return '' as unknown as Buffer;
      if (typeof cmd === 'string' && cmd.includes('gh repo view')) throw new Error('not found');
      return 'https://github.com/my-org/new-repo' as unknown as Buffer;
    });
    const result = createGitHubRepo('new-repo', { org: 'my-org' });
    expect(result.fullName).toBe('my-org/new-repo');
  });

  it('uses name only when no org provided', () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('gh --version')) return '' as unknown as Buffer;
      if (typeof cmd === 'string' && cmd.includes('gh repo view')) throw new Error('not found');
      return 'https://github.com/my-repo' as unknown as Buffer;
    });
    const result = createGitHubRepo('my-repo');
    expect(result.fullName).toBe('my-repo');
  });
});
