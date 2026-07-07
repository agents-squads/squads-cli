/**
 * init command tests — real filesystem, mocked externals only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, existsSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('ora', () => ({ default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), text: '' })) }));
vi.mock('chalk', () => {
  const p = (s: string) => s;
  const h: ProxyHandler<typeof p> = { get: () => new Proxy(p, h), apply: (_, __, a) => a[0] };
  return { default: new Proxy(p, h) };
});
vi.mock('../src/lib/terminal.js', () => ({ writeLine: vi.fn(), colors: {}, bold: '', RESET: '' }));
vi.mock('../src/lib/telemetry.js', () => ({ track: vi.fn().mockResolvedValue(undefined), Events: { CLI_INIT: 'cli.init', CLI_EMAIL_CAPTURED: 'e' } }));
vi.mock('../src/lib/env-config.js', () => ({ saveEmail: vi.fn() }));

const mockGitStatus = vi.fn();
const mockRepoName = vi.fn();
const mockGitIdentityArgs = vi.fn();
vi.mock('../src/lib/git.js', () => ({
  checkGitStatus: (...a: unknown[]) => mockGitStatus(...a),
  getRepoName: (...a: unknown[]) => mockRepoName(...a),
  gitIdentityArgs: (...a: unknown[]) => mockGitIdentityArgs(...a),
}));

const mockAuthChecks = vi.fn();
const mockGhCli = vi.fn();
const mockDisplayResults = vi.fn();
vi.mock('../src/lib/setup-checks.js', () => ({
  PROVIDERS: {
    claude: { id: 'claude', name: 'Claude Code', requiresSubscription: true, requiresApiKey: false },
    none: { id: 'none', name: 'None', requiresSubscription: false, requiresApiKey: false },
  },
  runAuthChecks: (...a: unknown[]) => mockAuthChecks(...a),
  checkGhCli: (...a: unknown[]) => mockGhCli(...a),
  displayCheckResults: (...a: unknown[]) => mockDisplayResults(...a),
}));

vi.mock('../src/lib/templates.js', () => ({
  loadTemplate: (t: string, v: Record<string, string>) => `# ${t}\n# ${v?.BUSINESS_NAME || 'test'}\n`,
}));

vi.mock('child_process', async (orig) => {
  const a = await orig<typeof import('child_process')>();
  return { ...a, execSync: vi.fn(() => Buffer.from('')) };
});

import { initCommand } from '../src/commands/init.js';

function setupMocks(): void {
  mockGitStatus.mockReturnValue({ isGitRepo: true, hasRemote: true, remoteUrl: 'https://github.com/org/repo.git', branch: 'main', isDirty: false, uncommittedCount: 0 });
  mockRepoName.mockReturnValue('org/repo');
  mockGitIdentityArgs.mockReturnValue('');
  mockAuthChecks.mockReturnValue([{ name: 'Claude CLI', status: 'ok' }]);
  mockGhCli.mockReturnValue({ name: 'GitHub CLI', status: 'ok' });
  mockDisplayResults.mockReturnValue({ hasErrors: false, hasWarnings: false, errorChecks: [], warningChecks: [] });
}

describe('initCommand', () => {
  let dir: string;
  let origCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'init-'));
    origCwd = process.cwd();
    process.chdir(dir);
    vi.clearAllMocks();
    setupMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
  });

  it('creates core squad directories', async () => {
    await initCommand({ yes: true, force: true });
    for (const s of ['company', 'research', 'intelligence', 'product', 'demo'])
      expect(existsSync(join(dir, `.agents/squads/${s}`))).toBe(true);
  });

  it('creates memory directories', async () => {
    await initCommand({ yes: true, force: true });
    for (const d of ['company/manager', 'research/lead', 'intelligence/intel-lead', 'product/lead'])
      expect(existsSync(join(dir, `.agents/memory/${d}`))).toBe(true);
  });

  it('creates BUSINESS_BRIEF.md and skills', async () => {
    await initCommand({ yes: true, force: true });
    expect(existsSync(join(dir, '.agents/BUSINESS_BRIEF.md'))).toBe(true);
    expect(existsSync(join(dir, '.agents/skills/squads-cli/SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.agents/skills/gh/SKILL.md'))).toBe(true);
  });

  it('creates CLAUDE.md and hooks for claude provider', async () => {
    await initCommand({ yes: true, force: true, provider: 'claude' });
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude/settings.json'))).toBe(true);
  });

  it('adds engineering pack with --pack', async () => {
    await initCommand({ yes: true, force: true, pack: ['engineering'] });
    expect(existsSync(join(dir, '.agents/squads/engineering'))).toBe(true);
    expect(existsSync(join(dir, '.agents/memory/engineering/issue-solver'))).toBe(true);
  });

  it('survives re-run without errors', async () => {
    await initCommand({ yes: true, force: true });
    await initCommand({ yes: true, force: true });
    expect(existsSync(join(dir, '.agents/squads/company'))).toBe(true);
  });

  it('creates IDP catalog entry', async () => {
    await initCommand({ yes: true, force: true });
    expect(existsSync(join(dir, '.agents/idp/catalog'))).toBe(true);
  });
});
