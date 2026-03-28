import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CatalogEntry, ScorecardDefinition, ScorecardResult } from '../../src/lib/idp/types.js';

// --- Mocks (before imports) ---

const mockFindIdpDir = vi.fn<() => string | null>();
vi.mock('../../src/lib/idp/resolver.js', () => ({
  findIdpDir: (...args: unknown[]) => mockFindIdpDir(...(args as [])),
}));

const mockLoadCatalog = vi.fn<() => CatalogEntry[]>();
const mockLoadService = vi.fn<(name: string) => CatalogEntry | null>();
const mockLoadScorecard = vi.fn<(name: string) => ScorecardDefinition | null>();
vi.mock('../../src/lib/idp/catalog-loader.js', () => ({
  loadCatalog: (...args: unknown[]) => mockLoadCatalog(...(args as [])),
  loadService: (...args: unknown[]) => mockLoadService(...(args as [string])),
  loadScorecard: (...args: unknown[]) => mockLoadScorecard(...(args as [string])),
}));

const mockEvaluateService = vi.fn<(entry: CatalogEntry, scorecard: ScorecardDefinition) => ScorecardResult>();
vi.mock('../../src/lib/idp/scorecard-engine.js', () => ({
  evaluateService: (...args: unknown[]) => mockEvaluateService(...(args as [CatalogEntry, ScorecardDefinition])),
}));

const mockWriteLine = vi.fn();
vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: (...args: unknown[]) => mockWriteLine(...args),
  colors: { dim: '', red: '', green: '', yellow: '', cyan: '', white: '', purple: '' },
  bold: '',
  RESET: '',
}));

// --- Import under test ---

import { registerCatalogCommands } from '../../src/commands/catalog.js';
import { Command } from 'commander';

// --- Helpers ---

function makeCatalogEntry(overrides: Partial<{
  name: string;
  type: 'product' | 'domain';
  stack: string;
  owner: string;
  repo: string;
  description: string;
  framework: string;
  scorecard: string;
  ciTemplate: string | null;
  deploy: CatalogEntry['spec']['deploy'];
  health: CatalogEntry['spec']['health'];
  dependencies: CatalogEntry['spec']['dependencies'];
  branches: CatalogEntry['spec']['branches'];
  tags: string[];
}> = {}): CatalogEntry {
  return {
    apiVersion: 'squads/v1',
    kind: 'Service',
    metadata: {
      name: overrides.name ?? 'test-service',
      description: overrides.description ?? 'A test service',
      owner: overrides.owner ?? 'engineering',
      repo: overrides.repo ?? 'org/test-service',
      tags: overrides.tags ?? ['test'],
    },
    spec: {
      type: overrides.type ?? 'product',
      stack: overrides.stack ?? 'node',
      framework: overrides.framework,
      scorecard: overrides.scorecard ?? 'product',
      branches: overrides.branches ?? {
        default: 'main',
        development: 'develop',
        workflow: 'pr-to-develop',
      },
      ci: {
        template: overrides.ciTemplate !== undefined ? overrides.ciTemplate : 'node',
        required_checks: ['build', 'test'],
        build_command: 'npm run build',
        test_command: 'npm test',
      },
      deploy: overrides.deploy !== undefined ? overrides.deploy : {
        target: 'vercel',
        trigger: 'push-to-main',
        environments: [{ name: 'production', url: 'https://example.com' }],
      },
      health: overrides.health ?? [
        { name: 'api', url: 'https://example.com/health', type: 'http', expect: 200 },
      ],
      dependencies: overrides.dependencies ?? {
        runtime: [
          { service: 'postgres', version: '15', required: true, description: 'Primary database' },
        ],
      },
    },
  };
}

function makeScorecard(): ScorecardDefinition {
  return {
    apiVersion: 'squads/v1',
    kind: 'Scorecard',
    metadata: {
      name: 'product',
      description: 'Product service scorecard',
    },
    checks: [
      { name: 'ci-passing', description: 'CI is green', weight: 20, source: 'github', severity: 'critical' },
      { name: 'test-coverage', description: 'Tests exist', weight: 15, source: 'local', severity: 'high' },
      { name: 'readme-exists', description: 'README present', weight: 10, source: 'local', severity: 'medium' },
    ],
    grades: { A: { min: 90 }, B: { min: 70 }, C: { min: 50 }, D: { min: 30 } },
  };
}

function makeScorecardResult(overrides: Partial<ScorecardResult> = {}): ScorecardResult {
  return {
    service: overrides.service ?? 'test-service',
    scorecard: overrides.scorecard ?? 'product',
    score: overrides.score ?? 85,
    grade: overrides.grade ?? 'B',
    checks: overrides.checks ?? [
      { name: 'ci-passing', passed: true, weight: 20, detail: 'latest run: success' },
      { name: 'test-coverage', passed: true, weight: 15, detail: 'test command defined: npm test' },
      { name: 'readme-exists', passed: false, weight: 10, detail: 'README.md not found' },
    ],
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  };
}

/** Create a program, register catalog commands, and parse argv */
async function runCatalog(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit
  registerCatalogCommands(program);
  await program.parseAsync(['node', 'squads', ...args]);
}

// --- Tests ---

describe('catalog command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindIdpDir.mockReturnValue('/tmp/fake-idp');
  });

  // ── catalog list ──

  describe('catalog list', () => {
    it('shows error when IDP is not found', async () => {
      mockFindIdpDir.mockReturnValue(null);

      await runCatalog(['catalog', 'list']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('IDP not found'),
      );
    });

    it('shows message when catalog is empty', async () => {
      mockLoadCatalog.mockReturnValue([]);

      await runCatalog(['catalog', 'list']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('No catalog entries found'),
      );
    });

    it('lists product services', async () => {
      const entry = makeCatalogEntry({ name: 'my-app', type: 'product', stack: 'react' });
      mockLoadCatalog.mockReturnValue([entry]);

      await runCatalog(['catalog', 'list']);

      // Should output the service name
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('my-app'),
      );
      // Should show "Product Services" heading
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('Product Services'),
      );
    });

    it('lists domain repos', async () => {
      const entry = makeCatalogEntry({ name: 'docs-repo', type: 'domain' });
      mockLoadCatalog.mockReturnValue([entry]);

      await runCatalog(['catalog', 'list']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('docs-repo'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('Domain Repos'),
      );
    });

    it('displays both product and domain services', async () => {
      const product = makeCatalogEntry({ name: 'web-app', type: 'product' });
      const domain = makeCatalogEntry({ name: 'knowledge-base', type: 'domain' });
      mockLoadCatalog.mockReturnValue([product, domain]);

      await runCatalog(['catalog', 'list']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('Product Services'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('Domain Repos'),
      );
    });

    it('filters by --type product', async () => {
      const product = makeCatalogEntry({ name: 'web-app', type: 'product' });
      const domain = makeCatalogEntry({ name: 'knowledge', type: 'domain' });
      mockLoadCatalog.mockReturnValue([product, domain]);

      await runCatalog(['catalog', 'list', '--type', 'product']);

      // Should show 1 service (only product)
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('1 services'),
      );
    });

    it('filters by --type domain', async () => {
      const product = makeCatalogEntry({ name: 'web-app', type: 'product' });
      const domain = makeCatalogEntry({ name: 'knowledge', type: 'domain' });
      mockLoadCatalog.mockReturnValue([product, domain]);

      await runCatalog(['catalog', 'list', '--type', 'domain']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('1 services'),
      );
    });

    it('outputs JSON with --json', async () => {
      const entry = makeCatalogEntry({ name: 'my-svc', type: 'product', stack: 'node', owner: 'eng' });
      mockLoadCatalog.mockReturnValue([entry]);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runCatalog(['catalog', 'list', '--json']);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(output).toHaveLength(1);
      expect(output[0]).toEqual(expect.objectContaining({
        name: 'my-svc',
        type: 'product',
        stack: 'node',
        owner: 'eng',
        repo: 'org/test-service',
      }));

      consoleSpy.mockRestore();
    });

    it('shows CI template and deploy target for product services', async () => {
      const entry = makeCatalogEntry({
        name: 'api-svc',
        type: 'product',
        ciTemplate: 'node',
        deploy: { target: 'aws', trigger: 'push-to-main' },
      });
      mockLoadCatalog.mockReturnValue([entry]);

      await runCatalog(['catalog', 'list']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('ci:node'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('deploy:aws'),
      );
    });

    it('shows no-ci when CI template is null', async () => {
      const entry = makeCatalogEntry({ name: 'simple', type: 'product', ciTemplate: null });
      mockLoadCatalog.mockReturnValue([entry]);

      await runCatalog(['catalog', 'list']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('no-ci'),
      );
    });

    it('shows manual deploy when no deploy target', async () => {
      const entry = makeCatalogEntry({ name: 'lib', type: 'product', deploy: null });
      mockLoadCatalog.mockReturnValue([entry]);

      await runCatalog(['catalog', 'list']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('deploy:manual'),
      );
    });
  });

  // ── catalog show ──

  describe('catalog show', () => {
    it('shows error when IDP not found', async () => {
      mockFindIdpDir.mockReturnValue(null);

      await runCatalog(['catalog', 'show', 'my-svc']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('IDP not found'),
      );
    });

    it('shows error when service not found', async () => {
      mockLoadService.mockReturnValue(null);

      await runCatalog(['catalog', 'show', 'nonexistent']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('Service not found: nonexistent'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining("squads catalog list"),
      );
    });

    it('displays service details', async () => {
      const entry = makeCatalogEntry({
        name: 'web-app',
        type: 'product',
        stack: 'react',
        framework: 'next',
        owner: 'frontend',
        repo: 'org/web-app',
        description: 'Main web application',
        tags: ['frontend', 'react'],
      });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'web-app']);

      // Service header
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('web-app'),
      );
      // General section
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('frontend'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('org/web-app'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('react (next)'),
      );
    });

    it('displays branch info', async () => {
      const entry = makeCatalogEntry({
        name: 'svc',
        branches: { default: 'main', development: 'develop', workflow: 'pr-to-develop' },
      });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('main'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('pr-to-develop'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('develop'),
      );
    });

    it('displays CI information when template exists', async () => {
      const entry = makeCatalogEntry({ name: 'svc', ciTemplate: 'node' });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('node'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('build, test'),
      );
    });

    it('skips CI section when template is null', async () => {
      const entry = makeCatalogEntry({ name: 'svc', ciTemplate: null });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      // The "Template:" line should not appear for CI
      const ciTemplateCalls = mockWriteLine.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('Template:'),
      );
      expect(ciTemplateCalls).toHaveLength(0);
    });

    it('displays deploy info', async () => {
      const entry = makeCatalogEntry({
        name: 'svc',
        deploy: {
          target: 'vercel',
          trigger: 'push-to-main',
          environments: [
            { name: 'staging', url: 'https://staging.example.com' },
            { name: 'production', url: 'https://example.com' },
          ],
        },
      });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('vercel'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('staging.example.com'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('example.com'),
      );
    });

    it('skips deploy section when deploy is null', async () => {
      const entry = makeCatalogEntry({ name: 'svc', deploy: null });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      const deployCalls = mockWriteLine.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('Deploy'),
      );
      expect(deployCalls).toHaveLength(0);
    });

    it('displays dependencies', async () => {
      const entry = makeCatalogEntry({
        name: 'svc',
        dependencies: {
          runtime: [
            { service: 'redis', version: '7', required: true, description: 'Cache layer' },
            { service: 'stripe-api', required: false, description: 'Payment provider' },
          ],
        },
      });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('redis'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('(required)'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('stripe-api'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('(optional)'),
      );
    });

    it('skips dependencies section when empty', async () => {
      const entry = makeCatalogEntry({
        name: 'svc',
        dependencies: { runtime: [] },
      });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      const depCalls = mockWriteLine.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('Dependencies'),
      );
      expect(depCalls).toHaveLength(0);
    });

    it('displays health endpoints', async () => {
      const entry = makeCatalogEntry({
        name: 'svc',
        health: [
          { name: 'api', url: 'https://api.example.com/health', type: 'http', expect: 200 },
          { name: 'metrics', url: 'https://api.example.com/metrics', type: 'json', expect: 200 },
        ],
      });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('api.example.com/health'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('api.example.com/metrics'),
      );
    });

    it('skips health section when empty', async () => {
      const entry = makeCatalogEntry({ name: 'svc', health: [] });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      const healthCalls = mockWriteLine.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('Health'),
      );
      expect(healthCalls).toHaveLength(0);
    });

    it('displays tags', async () => {
      const entry = makeCatalogEntry({ name: 'svc', tags: ['backend', 'api', 'graphql'] });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('backend, api, graphql'),
      );
    });

    it('shows none when tags is empty', async () => {
      const entry = makeCatalogEntry({ name: 'svc', tags: [] });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('none'),
      );
    });

    it('shows framework in stack when present', async () => {
      const entry = makeCatalogEntry({ name: 'svc', stack: 'node', framework: 'express' });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('node (express)'),
      );
    });

    it('shows stack without parentheses when no framework', async () => {
      const entry = makeCatalogEntry({ name: 'svc', stack: 'go' });
      // Explicitly no framework
      delete (entry.spec as Record<string, unknown>)['framework'];
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      // Should have 'go' but not '(undefined)' or '()'
      const stackCalls = mockWriteLine.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('Stack:'),
      );
      expect(stackCalls).toHaveLength(1);
      expect(stackCalls[0][0]).toContain('go');
      expect(stackCalls[0][0]).not.toContain('(');
    });

    it('does not show dev branch when not set', async () => {
      const entry = makeCatalogEntry({
        name: 'svc',
        branches: { default: 'main', workflow: 'direct-to-main' },
      });
      mockLoadService.mockReturnValue(entry);

      await runCatalog(['catalog', 'show', 'svc']);

      const devBranchCalls = mockWriteLine.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('Dev branch:'),
      );
      expect(devBranchCalls).toHaveLength(0);
    });

    it('outputs JSON with --json', async () => {
      const entry = makeCatalogEntry({ name: 'json-svc' });
      mockLoadService.mockReturnValue(entry);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runCatalog(['catalog', 'show', 'json-svc', '--json']);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(output.metadata.name).toBe('json-svc');
      expect(output.spec.type).toBe('product');

      consoleSpy.mockRestore();
    });
  });

  // ── catalog check ──

  describe('catalog check', () => {
    it('shows error when IDP not found', async () => {
      mockFindIdpDir.mockReturnValue(null);

      await runCatalog(['catalog', 'check']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('IDP not found'),
      );
    });

    it('shows error when no services found', async () => {
      mockLoadCatalog.mockReturnValue([]);

      await runCatalog(['catalog', 'check']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('No services found'),
      );
    });

    it('checks a specific service by name', async () => {
      const entry = makeCatalogEntry({ name: 'my-svc', scorecard: 'product' });
      const scorecard = makeScorecard();
      const result = makeScorecardResult({ service: 'my-svc', grade: 'A', score: 95 });

      mockLoadService.mockReturnValue(entry);
      mockLoadScorecard.mockReturnValue(scorecard);
      mockEvaluateService.mockReturnValue(result);

      await runCatalog(['catalog', 'check', 'my-svc']);

      expect(mockLoadService).toHaveBeenCalledWith('my-svc');
      expect(mockLoadScorecard).toHaveBeenCalledWith('product');
      expect(mockEvaluateService).toHaveBeenCalledWith(entry, scorecard);

      // Should display grade
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('my-svc'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('A'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('95'),
      );
    });

    it('checks all services when no name given', async () => {
      const entry1 = makeCatalogEntry({ name: 'svc-1', scorecard: 'product' });
      const entry2 = makeCatalogEntry({ name: 'svc-2', scorecard: 'product' });
      const scorecard = makeScorecard();
      const result1 = makeScorecardResult({ service: 'svc-1', grade: 'A', score: 92 });
      const result2 = makeScorecardResult({ service: 'svc-2', grade: 'C', score: 55 });

      mockLoadCatalog.mockReturnValue([entry1, entry2]);
      mockLoadScorecard.mockReturnValue(scorecard);
      mockEvaluateService
        .mockReturnValueOnce(result1)
        .mockReturnValueOnce(result2);

      await runCatalog(['catalog', 'check']);

      expect(mockEvaluateService).toHaveBeenCalledTimes(2);
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('svc-1'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('svc-2'),
      );
    });

    it('shows grade A in green', async () => {
      const entry = makeCatalogEntry({ name: 'svc' });
      const scorecard = makeScorecard();
      const result = makeScorecardResult({ grade: 'A', score: 95 });

      mockLoadService.mockReturnValue(entry);
      mockLoadScorecard.mockReturnValue(scorecard);
      mockEvaluateService.mockReturnValue(result);

      await runCatalog(['catalog', 'check', 'svc']);

      // Grade A is rendered (colors are empty strings in mock)
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('A'),
      );
    });

    it('shows grade B in cyan', async () => {
      const entry = makeCatalogEntry({ name: 'svc' });
      const scorecard = makeScorecard();
      const result = makeScorecardResult({ grade: 'B', score: 80 });

      mockLoadService.mockReturnValue(entry);
      mockLoadScorecard.mockReturnValue(scorecard);
      mockEvaluateService.mockReturnValue(result);

      await runCatalog(['catalog', 'check', 'svc']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('B'),
      );
    });

    it('shows grade C in yellow', async () => {
      const entry = makeCatalogEntry({ name: 'svc' });
      const scorecard = makeScorecard();
      const result = makeScorecardResult({ grade: 'C', score: 55 });

      mockLoadService.mockReturnValue(entry);
      mockLoadScorecard.mockReturnValue(scorecard);
      mockEvaluateService.mockReturnValue(result);

      await runCatalog(['catalog', 'check', 'svc']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('C'),
      );
    });

    it('shows grade D/F in red', async () => {
      const entry = makeCatalogEntry({ name: 'svc' });
      const scorecard = makeScorecard();
      const result = makeScorecardResult({ grade: 'D', score: 30 });

      mockLoadService.mockReturnValue(entry);
      mockLoadScorecard.mockReturnValue(scorecard);
      mockEvaluateService.mockReturnValue(result);

      await runCatalog(['catalog', 'check', 'svc']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('D'),
      );
    });

    it('shows pass/fail for individual checks', async () => {
      const entry = makeCatalogEntry({ name: 'svc' });
      const scorecard = makeScorecard();
      const result = makeScorecardResult({
        checks: [
          { name: 'ci-passing', passed: true, weight: 20, detail: 'latest run: success' },
          { name: 'readme-exists', passed: false, weight: 10, detail: 'README.md not found' },
        ],
      });

      mockLoadService.mockReturnValue(entry);
      mockLoadScorecard.mockReturnValue(scorecard);
      mockEvaluateService.mockReturnValue(result);

      await runCatalog(['catalog', 'check', 'svc']);

      // pass indicator for ci-passing
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('pass'),
      );
      // fail indicator for readme-exists
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('fail'),
      );
      // Check detail
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('latest run: success'),
      );
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('README.md not found'),
      );
    });

    it('skips service when scorecard not found', async () => {
      const entry = makeCatalogEntry({ name: 'svc', scorecard: 'nonexistent' });
      mockLoadCatalog.mockReturnValue([entry]);
      mockLoadScorecard.mockReturnValue(null);

      await runCatalog(['catalog', 'check']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining("No scorecard 'nonexistent'"),
      );
      expect(mockEvaluateService).not.toHaveBeenCalled();
    });

    it('handles specific service not found (empty array after filter)', async () => {
      mockLoadService.mockReturnValue(null);

      await runCatalog(['catalog', 'check', 'ghost']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('No services found'),
      );
    });

    it('outputs JSON with --json', async () => {
      const entry = makeCatalogEntry({ name: 'svc' });
      const scorecard = makeScorecard();
      const result = makeScorecardResult({ service: 'svc', grade: 'B', score: 80 });

      mockLoadService.mockReturnValue(entry);
      mockLoadScorecard.mockReturnValue(scorecard);
      mockEvaluateService.mockReturnValue(result);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runCatalog(['catalog', 'check', 'svc', '--json']);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(output).toHaveLength(1);
      expect(output[0].service).toBe('svc');
      expect(output[0].grade).toBe('B');
      expect(output[0].score).toBe(80);

      consoleSpy.mockRestore();
    });

    it('JSON output includes all services when checking all', async () => {
      const entry1 = makeCatalogEntry({ name: 'svc-1', scorecard: 'product' });
      const entry2 = makeCatalogEntry({ name: 'svc-2', scorecard: 'product' });
      const scorecard = makeScorecard();

      mockLoadCatalog.mockReturnValue([entry1, entry2]);
      mockLoadScorecard.mockReturnValue(scorecard);
      mockEvaluateService
        .mockReturnValueOnce(makeScorecardResult({ service: 'svc-1' }))
        .mockReturnValueOnce(makeScorecardResult({ service: 'svc-2' }));

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runCatalog(['catalog', 'check', '--json']);

      const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(output).toHaveLength(2);
      expect(output.map((r: ScorecardResult) => r.service)).toEqual(['svc-1', 'svc-2']);

      consoleSpy.mockRestore();
    });

    it('does not call writeLine for individual checks in --json mode', async () => {
      const entry = makeCatalogEntry({ name: 'svc' });
      const scorecard = makeScorecard();
      const result = makeScorecardResult();

      mockLoadService.mockReturnValue(entry);
      mockLoadScorecard.mockReturnValue(scorecard);
      mockEvaluateService.mockReturnValue(result);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      mockWriteLine.mockClear();
      await runCatalog(['catalog', 'check', 'svc', '--json']);

      // In --json mode, service-level writeLine calls should not include grade/check lines
      const serviceLines = mockWriteLine.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('pass'),
      );
      expect(serviceLines).toHaveLength(0);

      consoleSpy.mockRestore();
    });
  });

  // ── noIdp helper ──

  describe('noIdp guard', () => {
    it('prints instructions when IDP not found', async () => {
      mockFindIdpDir.mockReturnValue(null);

      await runCatalog(['catalog', 'list']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('SQUADS_IDP_PATH'),
      );
    });

    it('proceeds normally when IDP is found', async () => {
      mockFindIdpDir.mockReturnValue('/some/idp/path');
      mockLoadCatalog.mockReturnValue([]);

      await runCatalog(['catalog', 'list']);

      // Should not show the IDP not found message
      const idpNotFoundCalls = mockWriteLine.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('IDP not found'),
      );
      expect(idpNotFoundCalls).toHaveLength(0);
    });
  });
});
