import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Command } from 'commander';

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: { dim: '', red: '', green: '', yellow: '', cyan: '', white: '', purple: '' },
  bold: '', RESET: '',
}));
const mockEvaluateService = vi.fn();
vi.mock('../../src/lib/idp/scorecard-engine.js', () => ({
  evaluateService: (...args: unknown[]) => mockEvaluateService(...args),
}));

import { registerCatalogCommands } from '../../src/commands/catalog.js';
import { writeLine } from '../../src/lib/terminal.js';
const mockWriteLine = vi.mocked(writeLine);

const output = () => mockWriteLine.mock.calls.map(c => String(c[0] ?? '')).join('\n');

async function run(args: string[]): Promise<void> {
  const p = new Command(); p.exitOverride();
  registerCatalogCommands(p);
  await p.parseAsync(['node', 'squads', ...args]);
}

// Minimal valid YAML fixtures
const PRODUCT_YAML = 'apiVersion: squads/v1\nkind: Service\nmetadata:\n  name: web-app\n  description: Web app\n  owner: frontend\n  repo: org/web-app\n  tags: [react]\nspec:\n  type: product\n  stack: react\n  framework: next\n  scorecard: product\n  branches: {default: main, development: develop, workflow: pr-to-develop}\n  ci: {template: node, required_checks: [build, test], build_command: npm run build, test_command: npm test}\n  deploy: {target: vercel, trigger: push-to-main, environments: [{name: prod, url: https://example.com}]}\n  health: [{name: api, url: https://example.com/health, type: http, expect: 200}]\n  dependencies: {runtime: [{service: postgres, version: "15", required: true, description: DB}]}\n';
const DOMAIN_YAML = 'apiVersion: squads/v1\nkind: Service\nmetadata:\n  name: docs-repo\n  description: Docs\n  owner: engineering\n  repo: org/docs\n  tags: [docs]\nspec:\n  type: domain\n  stack: markdown\n  scorecard: domain\n  branches: {default: main, workflow: direct-to-main}\n  ci: {template: null, required_checks: []}\n  health: []\n  dependencies: {runtime: []}\n';
const SCORECARD_YAML = 'apiVersion: squads/v1\nkind: Scorecard\nmetadata:\n  name: product\n  description: Scorecard\nchecks:\n  - {name: ci-passing, description: CI green, weight: 20, source: github, severity: critical}\ngrades:\n  A: {min: 90}\n  B: {min: 70}\n';

describe('catalog commands (real IDP directory)', () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'cat-'));
    mkdirSync(join(tmpDir, 'catalog'), { recursive: true });
    mkdirSync(join(tmpDir, 'scorecards'), { recursive: true });
    writeFileSync(join(tmpDir, 'catalog', 'web-app.yaml'), PRODUCT_YAML);
    writeFileSync(join(tmpDir, 'catalog', 'docs-repo.yaml'), DOMAIN_YAML);
    writeFileSync(join(tmpDir, 'scorecards', 'product.yaml'), SCORECARD_YAML);
    savedEnv = process.env.SQUADS_IDP_PATH;
    process.env.SQUADS_IDP_PATH = tmpDir;
  });

  afterEach(() => {
    if (savedEnv !== undefined) process.env.SQUADS_IDP_PATH = savedEnv;
    else delete process.env.SQUADS_IDP_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('catalog list', () => {
    it('lists product and domain services from real YAML', async () => {
      await run(['catalog', 'list']);
      const o = output();
      expect(o).toContain('web-app');
      expect(o).toContain('docs-repo');
      expect(o).toContain('Product Services');
      expect(o).toContain('Domain Repos');
    });

    it('filters by --type product', async () => {
      await run(['catalog', 'list', '--type', 'product']);
      expect(output()).toContain('1 services');
    });

    it('outputs JSON with --json', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await run(['catalog', 'list', '--json']);
      const parsed = JSON.parse(spy.mock.calls[0][0] as string);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe('docs-repo');
      spy.mockRestore();
    });
  });

  describe('catalog show', () => {
    it('shows details from real YAML', async () => {
      await run(['catalog', 'show', 'web-app']);
      const o = output();
      expect(o).toContain('web-app');
      expect(o).toContain('frontend');
      expect(o).toContain('react (next)');
    });

    it('errors on missing service', async () => {
      await run(['catalog', 'show', 'ghost']);
      expect(output()).toContain('Service not found: ghost');
    });
  });

  describe('catalog check', () => {
    it('runs scorecard using real YAML', async () => {
      mockEvaluateService.mockReturnValue({
        service: 'web-app', scorecard: 'product', score: 85, grade: 'B',
        checks: [{ name: 'ci-passing', passed: true, weight: 20, detail: 'ok' }],
        timestamp: new Date().toISOString(),
      });
      await run(['catalog', 'check', 'web-app']);
      expect(mockEvaluateService).toHaveBeenCalledTimes(1);
      expect(output()).toContain('B');
    });
  });

  it('shows IDP not found when path invalid', async () => {
    process.env.SQUADS_IDP_PATH = '/tmp/no-such-idp';
    await run(['catalog', 'list']);
    expect(output()).toContain('IDP not found');
  });
});
