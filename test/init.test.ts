import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Mocks (must be before imports that use them) ---

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

vi.mock('chalk', () => {
  const passthrough = (s: string) => s;
  const chain: Record<string, unknown> = {};
  const handler: ProxyHandler<typeof passthrough> = {
    get: () => new Proxy(passthrough, handler),
    apply: (_target, _thisArg, args) => args[0],
  };
  return { default: new Proxy(passthrough, handler) };
});

vi.mock('../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: {},
  bold: '',
  RESET: '',
}));

vi.mock('../src/lib/telemetry.js', () => ({
  track: vi.fn().mockResolvedValue(undefined),
  Events: { CLI_INIT: 'cli.init' },
}));

const mockCheckGitStatus = vi.fn();
const mockGetRepoName = vi.fn();
vi.mock('../src/lib/git.js', () => ({
  checkGitStatus: (...args: unknown[]) => mockCheckGitStatus(...args),
  getRepoName: (...args: unknown[]) => mockGetRepoName(...args),
}));

const mockRunAuthChecks = vi.fn();
const mockCheckGhCli = vi.fn();
const mockDisplayCheckResults = vi.fn();
const mockCheckNodeVersion = vi.fn(() => ({ name: 'Node.js', status: 'ok', message: 'v20.0.0' }));
vi.mock('../src/lib/setup-checks.js', () => ({
  PROVIDERS: {
    claude: { id: 'claude', name: 'Claude Code', requiresSubscription: true, requiresApiKey: false },
    gemini: { id: 'gemini', name: 'Gemini', requiresSubscription: false, requiresApiKey: true },
    openai: { id: 'openai', name: 'OpenAI GPT', requiresSubscription: false, requiresApiKey: true },
    ollama: { id: 'ollama', name: 'Ollama', requiresSubscription: false, requiresApiKey: false },
    cursor: { id: 'cursor', name: 'Cursor', requiresSubscription: true, requiresApiKey: false },
    aider: { id: 'aider', name: 'Aider', requiresSubscription: false, requiresApiKey: true },
    none: { id: 'none', name: 'None', requiresSubscription: false, requiresApiKey: false },
  },
  runAuthChecks: (...args: unknown[]) => mockRunAuthChecks(...args),
  checkGhCli: (...args: unknown[]) => mockCheckGhCli(...args),
  displayCheckResults: (...args: unknown[]) => mockDisplayCheckResults(...args),
  checkNodeVersion: (...args: unknown[]) => mockCheckNodeVersion(...args),
}));

const mockLoadTemplate = vi.fn();
vi.mock('../src/lib/templates.js', () => ({
  loadTemplate: (...args: unknown[]) => mockLoadTemplate(...args),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

// --- Now import the module under test ---
import { initCommand, type InitOptions } from '../src/commands/init.js';
import { track } from '../src/lib/telemetry.js';
import { execSync } from 'child_process';

// ---- Helpers ----

function setupDefaults(): void {
  mockCheckGitStatus.mockReturnValue({
    isGitRepo: true,
    hasRemote: true,
    remoteUrl: 'https://github.com/test-org/test-repo.git',
    branch: 'main',
    isDirty: false,
    uncommittedCount: 0,
  });
  mockGetRepoName.mockReturnValue('test-org/test-repo');
  mockRunAuthChecks.mockReturnValue([
    { name: 'Claude CLI', status: 'ok' },
  ]);
  mockCheckGhCli.mockReturnValue({ name: 'GitHub CLI', status: 'ok' });
  mockDisplayCheckResults.mockReturnValue({ hasErrors: false, hasWarnings: false, errorChecks: [], warningChecks: [] });

  // loadTemplate returns the template path as content (easy to assert which templates were loaded)
  mockLoadTemplate.mockImplementation((tplPath: string, vars: Record<string, string>) => {
    const name = vars?.['BUSINESS_NAME'] || 'test-project';
    return `# Template: ${tplPath}\n# Business: ${name}\n`;
  });

  (execSync as Mock).mockImplementation(() => Buffer.from(''));
}

// ---- Tests ----

describe('initCommand', () => {
  let testDir: string;
  let originalCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = join(tmpdir(), `squads-init-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(testDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);

    vi.clearAllMocks();
    setupDefaults();

    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    exitSpy.mockRestore();
  });

  // ---------- Core structure ----------

  describe('directory structure', () => {
    it('creates all 4 core squad directories', async () => {
      await initCommand({ yes: true, force: true });

      for (const squad of ['company', 'research', 'intelligence', 'product']) {
        expect(existsSync(join(testDir, `.agents/squads/${squad}`))).toBe(true);
      }
    });

    it('creates memory directories for core squads', async () => {
      await initCommand({ yes: true, force: true });

      const expectedMemoryDirs = [
        '.agents/memory/company/manager',
        '.agents/memory/company/event-dispatcher',
        '.agents/memory/company/goal-tracker',
        '.agents/memory/company/company-eval',
        '.agents/memory/company/company-critic',
        '.agents/memory/research/lead',
        '.agents/memory/research/analyst',
        '.agents/memory/research/synthesizer',
        '.agents/memory/intelligence/intel-lead',
        '.agents/memory/intelligence/intel-eval',
        '.agents/memory/intelligence/intel-critic',
        '.agents/memory/product/lead',
      ];

      for (const dir of expectedMemoryDirs) {
        expect(existsSync(join(testDir, dir))).toBe(true);
      }
    });

    it('creates skills directories', async () => {
      await initCommand({ yes: true, force: true });

      expect(existsSync(join(testDir, '.agents/skills/squads-cli'))).toBe(true);
      expect(existsSync(join(testDir, '.agents/skills/gh'))).toBe(true);
    });

    it('creates config directory', async () => {
      await initCommand({ yes: true, force: true });

      expect(existsSync(join(testDir, '.agents/config'))).toBe(true);
    });
  });

  // ---------- Squad files ----------

  describe('squad file creation', () => {
    it('writes core squad definition files from templates', async () => {
      await initCommand({ yes: true, force: true });

      // Check that loadTemplate was called for core squads
      const templateCalls = mockLoadTemplate.mock.calls.map((c: unknown[]) => c[0]);

      expect(templateCalls).toContain('seed/squads/company/SQUAD.md');
      expect(templateCalls).toContain('seed/squads/company/manager.md');
      expect(templateCalls).toContain('seed/squads/research/SQUAD.md');
      expect(templateCalls).toContain('seed/squads/research/lead.md');
      expect(templateCalls).toContain('seed/squads/intelligence/SQUAD.md');
      expect(templateCalls).toContain('seed/squads/intelligence/intel-lead.md');
      expect(templateCalls).toContain('seed/squads/product/SQUAD.md');
      expect(templateCalls).toContain('seed/squads/product/lead.md');
    });

    it('writes squad files to disk', async () => {
      await initCommand({ yes: true, force: true });

      // Files should exist on disk with template content
      const squadMd = readFileSync(join(testDir, '.agents/squads/company/SQUAD.md'), 'utf-8');
      expect(squadMd).toContain('Template: seed/squads/company/SQUAD.md');
    });
  });

  // ---------- Config and skills ----------

  describe('config and skills', () => {
    it('creates provider.yaml', async () => {
      await initCommand({ yes: true, force: true });

      const templateCalls = mockLoadTemplate.mock.calls.map((c: unknown[]) => c[0]);
      expect(templateCalls).toContain('seed/config/provider.yaml');
      expect(existsSync(join(testDir, '.agents/config/provider.yaml'))).toBe(true);
    });

    it('creates SYSTEM.md', async () => {
      await initCommand({ yes: true, force: true });

      const templateCalls = mockLoadTemplate.mock.calls.map((c: unknown[]) => c[0]);
      expect(templateCalls).toContain('seed/config/SYSTEM.md');
      expect(existsSync(join(testDir, '.agents/config/SYSTEM.md'))).toBe(true);
    });

    it('creates squads-cli skill files', async () => {
      await initCommand({ yes: true, force: true });

      expect(existsSync(join(testDir, '.agents/skills/squads-cli/SKILL.md'))).toBe(true);
      expect(existsSync(join(testDir, '.agents/skills/squads-cli/references/commands.md'))).toBe(true);
    });

    it('creates gh skill', async () => {
      await initCommand({ yes: true, force: true });

      expect(existsSync(join(testDir, '.agents/skills/gh/SKILL.md'))).toBe(true);
    });
  });

  // ---------- Memory and state ----------

  describe('memory state files', () => {
    it('creates core memory state files', async () => {
      await initCommand({ yes: true, force: true });

      const templateCalls = mockLoadTemplate.mock.calls.map((c: unknown[]) => c[0]);
      expect(templateCalls).toContain('seed/memory/company/manager/state.md');
      expect(templateCalls).toContain('seed/memory/research/lead/state.md');
      expect(templateCalls).toContain('seed/memory/intelligence/intel-lead/state.md');
      expect(templateCalls).toContain('seed/memory/product/lead/state.md');
    });

    it('creates priorities.md and goals.md for each squad', async () => {
      await initCommand({ yes: true, force: true });

      const templateCalls = mockLoadTemplate.mock.calls.map((c: unknown[]) => c[0]);
      expect(templateCalls).toContain('seed/memory/_squad/priorities.md');
      expect(templateCalls).toContain('seed/memory/_squad/goals.md');

      for (const squad of ['company', 'research', 'intelligence', 'product']) {
        expect(existsSync(join(testDir, `.agents/memory/${squad}/priorities.md`))).toBe(true);
        expect(existsSync(join(testDir, `.agents/memory/${squad}/goals.md`))).toBe(true);
      }
    });

    it('does not overwrite existing state files on re-run', async () => {
      // First run
      await initCommand({ yes: true, force: true });

      // Write custom content to a state file
      const statePath = join(testDir, '.agents/memory/company/manager/state.md');
      writeFileSync(statePath, '# Custom state');

      // Second run
      await initCommand({ yes: true, force: true });

      const content = readFileSync(statePath, 'utf-8');
      expect(content).toBe('# Custom state');
    });

    it('does not overwrite existing priorities on re-run', async () => {
      // First run
      await initCommand({ yes: true, force: true });

      const prioPath = join(testDir, '.agents/memory/company/priorities.md');
      writeFileSync(prioPath, '# Custom priorities');

      // Second run
      await initCommand({ yes: true, force: true });

      const content = readFileSync(prioPath, 'utf-8');
      expect(content).toBe('# Custom priorities');
    });
  });

  // ---------- Root-level files ----------

  describe('root-level files', () => {
    it('creates AGENTS.md', async () => {
      await initCommand({ yes: true, force: true });

      expect(existsSync(join(testDir, 'AGENTS.md'))).toBe(true);
    });

    it('does not overwrite existing AGENTS.md', async () => {
      writeFileSync(join(testDir, 'AGENTS.md'), '# Existing');
      await initCommand({ yes: true, force: true });

      expect(readFileSync(join(testDir, 'AGENTS.md'), 'utf-8')).toBe('# Existing');
    });

    it('creates BUSINESS_BRIEF.md', async () => {
      await initCommand({ yes: true, force: true });

      expect(existsSync(join(testDir, '.agents/BUSINESS_BRIEF.md'))).toBe(true);
    });

    it('creates company.md context', async () => {
      await initCommand({ yes: true, force: true });

      expect(existsSync(join(testDir, '.agents/memory/company/company.md'))).toBe(true);
    });

    it('creates directives.md', async () => {
      await initCommand({ yes: true, force: true });

      expect(existsSync(join(testDir, '.agents/memory/company/directives.md'))).toBe(true);
    });

    it('creates README.md when none exists', async () => {
      await initCommand({ yes: true, force: true });

      expect(existsSync(join(testDir, 'README.md'))).toBe(true);
    });

    it('does not overwrite existing README.md with real content', async () => {
      writeFileSync(join(testDir, 'README.md'), '# My Project\n\nDescription here.\n');
      await initCommand({ yes: true, force: true });

      expect(readFileSync(join(testDir, 'README.md'), 'utf-8')).toBe('# My Project\n\nDescription here.\n');
    });

    it('overwrites stub README.md (single-line heading only)', async () => {
      writeFileSync(join(testDir, 'README.md'), '# test-repo\n');
      await initCommand({ yes: true, force: true });

      const content = readFileSync(join(testDir, 'README.md'), 'utf-8');
      expect(content).toContain('Template: seed/README.md.template');
    });
  });

  // ---------- Claude provider ----------

  describe('Claude provider', () => {
    it('creates .claude directory', async () => {
      await initCommand({ yes: true, force: true, provider: 'claude' });

      expect(existsSync(join(testDir, '.claude'))).toBe(true);
    });

    it('creates CLAUDE.md', async () => {
      await initCommand({ yes: true, force: true, provider: 'claude' });

      expect(existsSync(join(testDir, 'CLAUDE.md'))).toBe(true);
    });

    it('creates .claude/settings.json', async () => {
      await initCommand({ yes: true, force: true, provider: 'claude' });

      expect(existsSync(join(testDir, '.claude/settings.json'))).toBe(true);
    });

    it('does not create .claude dir for non-Claude provider', async () => {
      await initCommand({ yes: true, force: true, provider: 'gemini' });

      expect(existsSync(join(testDir, '.claude'))).toBe(false);
      expect(existsSync(join(testDir, 'CLAUDE.md'))).toBe(false);
    });
  });

  // ---------- Pack support ----------

  describe('pack support', () => {
    it('--pack engineering adds engineering squad', async () => {
      await initCommand({ yes: true, force: true, pack: ['engineering'] });

      expect(existsSync(join(testDir, '.agents/squads/engineering'))).toBe(true);
      expect(existsSync(join(testDir, '.agents/memory/engineering/issue-solver'))).toBe(true);

      const templateCalls = mockLoadTemplate.mock.calls.map((c: unknown[]) => c[0]);
      expect(templateCalls).toContain('seed/squads/engineering/SQUAD.md');
      expect(templateCalls).toContain('seed/squads/engineering/issue-solver.md');
    });

    it('--pack marketing adds marketing squad', async () => {
      await initCommand({ yes: true, force: true, pack: ['marketing'] });

      expect(existsSync(join(testDir, '.agents/squads/marketing'))).toBe(true);
      expect(existsSync(join(testDir, '.agents/memory/marketing/content-drafter'))).toBe(true);
    });

    it('--pack operations adds operations squad', async () => {
      await initCommand({ yes: true, force: true, pack: ['operations'] });

      expect(existsSync(join(testDir, '.agents/squads/operations'))).toBe(true);
      expect(existsSync(join(testDir, '.agents/memory/operations/ops-lead'))).toBe(true);
    });

    it('--pack all adds all three squads', async () => {
      await initCommand({ yes: true, force: true, pack: ['all'] });

      for (const squad of ['engineering', 'marketing', 'operations']) {
        expect(existsSync(join(testDir, `.agents/squads/${squad}`))).toBe(true);
      }
    });

    it('deduplicates squads when same pack specified twice', async () => {
      await initCommand({ yes: true, force: true, pack: ['engineering', 'engineering'] });

      // Should not fail — dedup works
      expect(existsSync(join(testDir, '.agents/squads/engineering'))).toBe(true);

      // Count how many times engineering SQUAD.md template was loaded
      const engineeringSquadCalls = mockLoadTemplate.mock.calls
        .filter((c: unknown[]) => c[0] === 'seed/squads/engineering/SQUAD.md');
      expect(engineeringSquadCalls.length).toBe(1);
    });

    it('creates priorities and goals for pack squads', async () => {
      await initCommand({ yes: true, force: true, pack: ['engineering'] });

      expect(existsSync(join(testDir, '.agents/memory/engineering/priorities.md'))).toBe(true);
      expect(existsSync(join(testDir, '.agents/memory/engineering/goals.md'))).toBe(true);
    });
  });

  // ---------- IDP catalog ----------

  describe('IDP catalog', () => {
    it('creates IDP catalog entry', async () => {
      await initCommand({ yes: true, force: true });

      const idpDir = join(testDir, '.agents/idp/catalog');
      expect(existsSync(idpDir)).toBe(true);

      const templateCalls = mockLoadTemplate.mock.calls.map((c: unknown[]) => c[0]);
      expect(templateCalls).toContain('seed/idp/catalog/service.yaml.template');
    });

    it('skips IDP catalog if .agents/idp/catalog already exists', async () => {
      mkdirSync(join(testDir, '.agents/idp/catalog'), { recursive: true });
      await initCommand({ yes: true, force: true });

      const templateCalls = mockLoadTemplate.mock.calls.map((c: unknown[]) => c[0]);
      expect(templateCalls).not.toContain('seed/idp/catalog/service.yaml.template');
    });

    it('detects Node stack from package.json', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({
        name: 'my-app',
        dependencies: { react: '^18.0.0' },
      }));

      await initCommand({ yes: true, force: true });

      // Check the variables passed to the IDP template
      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      expect(idpCall).toBeDefined();
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_STACK']).toBe('react');
      expect(vars['SERVICE_TYPE']).toBe('product');
      expect(vars['BUILD_COMMAND']).toBe('npm run build');
      expect(vars['TEST_COMMAND']).toBe('npm test');
    });

    it('detects Go stack from go.mod', async () => {
      writeFileSync(join(testDir, 'go.mod'), 'module example.com/myapp\n\ngo 1.21\n');

      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_STACK']).toBe('go');
      expect(vars['BUILD_COMMAND']).toBe('go build ./...');
      expect(vars['TEST_COMMAND']).toBe('go test ./...');
    });

    it('detects Python stack from requirements.txt', async () => {
      writeFileSync(join(testDir, 'requirements.txt'), 'flask==2.0\n');

      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_STACK']).toBe('python');
      expect(vars['TEST_COMMAND']).toBe('pytest');
    });

    it('detects Rust stack from Cargo.toml', async () => {
      writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "myapp"\n');

      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_STACK']).toBe('rust');
      expect(vars['BUILD_COMMAND']).toBe('cargo build');
      expect(vars['TEST_COMMAND']).toBe('cargo test');
    });

    it('detects Ruby stack from Gemfile', async () => {
      writeFileSync(join(testDir, 'Gemfile'), "source 'https://rubygems.org'\n");

      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_STACK']).toBe('ruby');
      expect(vars['TEST_COMMAND']).toBe('bundle exec rspec');
    });

    it('defaults to unknown stack when no project files found', async () => {
      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_STACK']).toBe('unknown');
      expect(vars['SERVICE_TYPE']).toBe('domain');
    });

    it('uses repo name from git remote', async () => {
      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['REPO_NAME']).toBe('test-org/test-repo');
      expect(vars['SERVICE_NAME']).toBe('test-repo');
    });

    it('detects Python stack from pyproject.toml', async () => {
      writeFileSync(join(testDir, 'pyproject.toml'), '[project]\nname = "my-app"\n');

      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_STACK']).toBe('python');
      expect(vars['SERVICE_TYPE']).toBe('product');
      expect(vars['TEST_COMMAND']).toBe('pytest');
    });

    it('detects Python stack from setup.py', async () => {
      writeFileSync(join(testDir, 'setup.py'), 'from setuptools import setup\nsetup(name="app")\n');

      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_STACK']).toBe('python');
    });

    it('detects Next.js framework from dependencies', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({
        name: 'next-app',
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
      }));

      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_STACK']).toBe('next');
    });

    it('detects Nuxt framework from dependencies', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({
        name: 'nuxt-app',
        dependencies: { nuxt: '^3.0.0' },
      }));

      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_STACK']).toBe('nuxt');
    });

    it('detects Vue framework from dependencies', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({
        name: 'vue-app',
        dependencies: { vue: '^3.0.0' },
      }));

      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_STACK']).toBe('vue');
    });

    it('detects Astro framework from dependencies', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({
        name: 'astro-app',
        dependencies: { astro: '^4.0.0' },
      }));

      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_STACK']).toBe('astro');
    });

    it('sets product-type IDP variables for product services', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'my-app' }));

      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_TYPE']).toBe('product');
      expect(vars['SERVICE_SCORECARD']).toBe('product');
      expect(vars['BRANCHES_WORKFLOW']).toBe('pr-to-develop');
      expect(vars['BRANCHES_DEVELOPMENT']).toBe('develop');
      expect(vars['CI_TEMPLATE']).toBe('node');
    });

    it('sets domain-type IDP variables when no project files detected', async () => {
      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['SERVICE_TYPE']).toBe('domain');
      expect(vars['SERVICE_SCORECARD']).toBe('domain');
      expect(vars['BRANCHES_WORKFLOW']).toBe('direct-to-main');
      expect(vars['BRANCHES_DEVELOPMENT']).toBe('');
      expect(vars['CI_TEMPLATE']).toBe('null');
    });

    it('sets BUILD_COMMAND to null when no build command detected', async () => {
      writeFileSync(join(testDir, 'requirements.txt'), 'flask==2.0\n');

      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      // Python has no build command
      expect(vars['BUILD_COMMAND']).toBe('null');
    });

    it('writes IDP catalog file with project name as filename', async () => {
      await initCommand({ yes: true, force: true });

      const catalogFile = join(testDir, '.agents/idp/catalog/test-repo.yaml');
      expect(existsSync(catalogFile)).toBe(true);
    });

    it('sets OWNER_SQUAD from first squad in use case config', async () => {
      await initCommand({ yes: true, force: true });

      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      expect(vars['OWNER_SQUAD']).toBeDefined();
      expect(typeof vars['OWNER_SQUAD']).toBe('string');
      expect(vars['OWNER_SQUAD'].length).toBeGreaterThan(0);
    });

    it('handles malformed package.json gracefully', async () => {
      writeFileSync(join(testDir, 'package.json'), '{ invalid json }}}');

      await initCommand({ yes: true, force: true });

      // Should still complete and fall back to node stack
      const idpCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/idp/catalog/service.yaml.template',
      );
      const vars = idpCall![1] as Record<string, string>;
      // When JSON.parse fails, catch block ignores error, stack stays 'node' (from package.json existing)
      expect(vars['SERVICE_STACK']).toBe('node');
    });
  });

  // ---------- Template variables ----------

  describe('template variables', () => {
    it('passes correct business variables in --yes mode', async () => {
      await initCommand({ yes: true, force: true });

      // Find the BUSINESS_BRIEF template call
      const briefCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/BUSINESS_BRIEF.md.template',
      );
      expect(briefCall).toBeDefined();
      const vars = briefCall![1] as Record<string, string>;
      // In --yes mode, business name = directory basename
      expect(vars['BUSINESS_NAME']).toBe(testDir.split('/').pop());
      expect(vars['BUSINESS_DESCRIPTION']).toContain('AI smart capabilities');
      expect(vars['PROVIDER']).toBe('claude'); // default
    });

    it('passes provider name to templates', async () => {
      await initCommand({ yes: true, force: true, provider: 'gemini' });

      const briefCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/BUSINESS_BRIEF.md.template',
      );
      const vars = briefCall![1] as Record<string, string>;
      expect(vars['PROVIDER']).toBe('gemini');
      expect(vars['PROVIDER_NAME']).toBe('Gemini');
    });

    it('includes CURRENT_DATE in variables', async () => {
      await initCommand({ yes: true, force: true });

      const briefCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/BUSINESS_BRIEF.md.template',
      );
      const vars = briefCall![1] as Record<string, string>;
      expect(vars['CURRENT_DATE']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  // ---------- Auto-commit ----------

  describe('auto-commit', () => {
    it('attempts git add + commit after scaffolding', async () => {
      await initCommand({ yes: true, force: true });

      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('git add -A && git commit'),
        expect.objectContaining({ stdio: 'ignore' }),
      );
    });

    it('does not fail if auto-commit fails', async () => {
      (execSync as Mock).mockImplementation(() => {
        throw new Error('nothing to commit');
      });

      // Should not throw
      await initCommand({ yes: true, force: true });
    });
  });

  // ---------- Telemetry ----------

  describe('telemetry', () => {
    it('tracks CLI_INIT event on success', async () => {
      await initCommand({ yes: true, force: true });

      expect(track).toHaveBeenCalledWith('cli.init', expect.objectContaining({
        success: true,
        provider: 'claude',
        hasGit: true,
        hasRemote: true,
      }));
    });

    it('tracks agent and squad counts', async () => {
      await initCommand({ yes: true, force: true, pack: ['all'] });

      expect(track).toHaveBeenCalledWith('cli.init', expect.objectContaining({
        agentCount: expect.any(Number),
        squadCount: expect.any(Number),
      }));

      const call = (track as Mock).mock.calls[0];
      const props = call[1] as Record<string, number>;
      // Core: 14 agents + engineering(3) + marketing(3) + operations(3) = 23
      expect(props['agentCount']).toBe(23);
      // Core: 4 squads + 3 pack squads = 7
      expect(props['squadCount']).toBe(7);
    });
  });

  // ---------- Prerequisite checks ----------

  describe('prerequisite checks', () => {
    it('exits when checks fail without --force', async () => {
      mockDisplayCheckResults.mockReturnValue({
        hasErrors: true,
        hasWarnings: false,
        errorChecks: [{ name: 'Claude CLI', status: 'missing' }],
        warningChecks: [],
      });

      await expect(initCommand({ yes: true })).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('continues when checks fail with --force', async () => {
      mockDisplayCheckResults.mockReturnValue({
        hasErrors: true,
        hasWarnings: false,
        errorChecks: [{ name: 'Claude CLI', status: 'missing' }],
        warningChecks: [],
      });

      // Should NOT throw
      await initCommand({ yes: true, force: true });
      expect(existsSync(join(testDir, '.agents/squads/company'))).toBe(true);
    });

    it('adds git repo check when not a git repo', async () => {
      mockCheckGitStatus.mockReturnValue({
        isGitRepo: false,
        hasRemote: false,
        isDirty: false,
        uncommittedCount: 0,
      });
      mockDisplayCheckResults.mockReturnValue({ hasErrors: false, hasWarnings: false, errorChecks: [], warningChecks: [] });

      await initCommand({ yes: true, force: true });

      // displayCheckResults should receive a check with 'Git Repository' name
      const checksArg = mockDisplayCheckResults.mock.calls[0][0] as Array<{ name: string; status: string }>;
      const gitCheck = checksArg.find(c => c.name === 'Git Repository');
      expect(gitCheck).toBeDefined();
      expect(gitCheck!.status).toBe('missing');
    });

    it('shows git repo as ok when in a git repo', async () => {
      await initCommand({ yes: true, force: true });

      const checksArg = mockDisplayCheckResults.mock.calls[0][0] as Array<{ name: string; status: string }>;
      const gitCheck = checksArg.find(c => c.name === 'Git Repository');
      expect(gitCheck).toBeDefined();
      expect(gitCheck!.status).toBe('ok');
    });
  });

  // ---------- Non-interactive mode ----------

  describe('non-interactive mode (--yes)', () => {
    it('uses directory name as business name', async () => {
      await initCommand({ yes: true, force: true });

      const briefCall = mockLoadTemplate.mock.calls.find(
        (c: unknown[]) => c[0] === 'seed/BUSINESS_BRIEF.md.template',
      );
      const vars = briefCall![1] as Record<string, string>;
      expect(vars['BUSINESS_NAME']).toBe(testDir.split('/').pop());
    });

    it('selects custom use case (core squads only)', async () => {
      await initCommand({ yes: true, force: true });

      // No engineering/marketing/operations unless --pack is used
      expect(existsSync(join(testDir, '.agents/squads/engineering'))).toBe(false);
      expect(existsSync(join(testDir, '.agents/squads/marketing'))).toBe(false);
      expect(existsSync(join(testDir, '.agents/squads/operations'))).toBe(false);
    });
  });

  // ---------- Error handling ----------

  describe('error handling', () => {
    it('exits with code 1 on template loading failure', async () => {
      mockLoadTemplate.mockImplementation(() => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      });

      await expect(initCommand({ yes: true, force: true })).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('handles ENOENT errors gracefully', async () => {
      mockLoadTemplate.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT', path: '/missing/template' });
      });

      await expect(initCommand({ yes: true, force: true })).rejects.toThrow('process.exit');
    });
  });
});
