import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We test loader functions by controlling the filesystem via temp dirs and process.cwd()
// The loader walks up from cwd to find .agents/dashboards/

let tempDir: string;
let dashboardsDir: string;
let originalCwd: string;

beforeEach(() => {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'squads-dashboard-test-')));
  dashboardsDir = join(tempDir, '.agents', 'dashboards');
  mkdirSync(dashboardsDir, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

// Helper to write a YAML dashboard file
function writeDashboard(name: string, content: string) {
  writeFileSync(join(dashboardsDir, `${name}.yaml`), content);
}

const VALID_DASHBOARD_YAML = `
name: test-dash
title: Test Dashboard
source: postgres
table: executions
metrics:
  - name: total_runs
    sql: COUNT(*)
    format: number
    label: Total Runs
dimensions:
  - name: squad
    sql: squad_name
    type: string
views:
  - id: overview
    type: summary
    metrics: [total_runs]
`;

describe('dashboard loader', () => {
  describe('findDashboardsDir', () => {
    it('finds .agents/dashboards from cwd', async () => {
      const { findDashboardsDir } = await import('../src/lib/dashboard/loader.js');
      const found = findDashboardsDir();
      expect(found).toBe(dashboardsDir);
    });

    it('returns null when no .agents/dashboards exists', async () => {
      const { findDashboardsDir } = await import('../src/lib/dashboard/loader.js');
      // Remove the dashboards dir
      rmSync(dashboardsDir, { recursive: true });
      // Re-chdir to a clean temp dir with no .agents/dashboards
      const emptyDir = mkdtempSync(join(tmpdir(), 'squads-empty-'));
      process.chdir(emptyDir);
      const found = findDashboardsDir();
      expect(found).toBeNull();
      process.chdir(tempDir);
      rmSync(emptyDir, { recursive: true });
    });
  });

  describe('listDashboards', () => {
    it('returns empty array when no dashboards exist', async () => {
      const { listDashboards } = await import('../src/lib/dashboard/loader.js');
      const names = listDashboards();
      expect(names).toEqual([]);
    });

    it('lists yaml files in dashboards dir', async () => {
      writeDashboard('costs', VALID_DASHBOARD_YAML);
      writeDashboard('runs', VALID_DASHBOARD_YAML);
      const { listDashboards } = await import('../src/lib/dashboard/loader.js');
      const names = listDashboards();
      expect(names).toContain('costs');
      expect(names).toContain('runs');
      expect(names).toHaveLength(2);
    });

    it('excludes files starting with underscore', async () => {
      writeDashboard('visible', VALID_DASHBOARD_YAML);
      writeFileSync(join(dashboardsDir, '_hidden.yaml'), VALID_DASHBOARD_YAML);
      const { listDashboards } = await import('../src/lib/dashboard/loader.js');
      const names = listDashboards();
      expect(names).toContain('visible');
      expect(names).not.toContain('_hidden');
    });

    it('excludes non-yaml files', async () => {
      writeDashboard('valid', VALID_DASHBOARD_YAML);
      writeFileSync(join(dashboardsDir, 'notes.txt'), 'some text');
      const { listDashboards } = await import('../src/lib/dashboard/loader.js');
      const names = listDashboards();
      expect(names).toContain('valid');
      expect(names).not.toContain('notes.txt');
      expect(names).not.toContain('notes');
    });
  });

  describe('loadDashboard', () => {
    it('loads a valid dashboard definition', async () => {
      writeDashboard('test-dash', VALID_DASHBOARD_YAML);
      const { loadDashboard, clearDashboardCache } = await import('../src/lib/dashboard/loader.js');
      clearDashboardCache();
      const def = loadDashboard('test-dash');
      expect(def).not.toBeNull();
      expect(def!.name).toBe('test-dash');
      expect(def!.title).toBe('Test Dashboard');
      expect(def!.source).toBe('postgres');
      expect(def!.metrics).toHaveLength(1);
      expect(def!.views).toHaveLength(1);
    });

    it('returns null for non-existent dashboard', async () => {
      const { loadDashboard, clearDashboardCache } = await import('../src/lib/dashboard/loader.js');
      clearDashboardCache();
      const def = loadDashboard('nonexistent');
      expect(def).toBeNull();
    });

    it('returns null for dashboard with missing required fields', async () => {
      writeDashboard('bad-dash', 'name: incomplete\ntitle: Missing fields');
      const { loadDashboard, clearDashboardCache } = await import('../src/lib/dashboard/loader.js');
      clearDashboardCache();
      const def = loadDashboard('bad-dash');
      expect(def).toBeNull();
    });

    it('caches dashboards after first load', async () => {
      writeDashboard('cached', VALID_DASHBOARD_YAML);
      const { loadDashboard, clearDashboardCache } = await import('../src/lib/dashboard/loader.js');
      clearDashboardCache();
      const def1 = loadDashboard('cached');
      const def2 = loadDashboard('cached');
      expect(def1).toBe(def2); // Same reference = cached
    });
  });

  describe('clearDashboardCache', () => {
    it('clears cached dashboards so they reload from disk', async () => {
      writeDashboard('refresh', VALID_DASHBOARD_YAML);
      const { loadDashboard, clearDashboardCache } = await import('../src/lib/dashboard/loader.js');
      clearDashboardCache();
      const def1 = loadDashboard('refresh');
      clearDashboardCache();
      const def2 = loadDashboard('refresh');
      expect(def1).not.toBe(def2); // Different references after cache clear
      expect(def1?.name).toBe(def2?.name); // But same data
    });
  });

  describe('loadAllDashboards', () => {
    it('returns empty array when no dashboards', async () => {
      const { loadAllDashboards, clearDashboardCache } = await import('../src/lib/dashboard/loader.js');
      clearDashboardCache();
      const all = loadAllDashboards();
      expect(all).toEqual([]);
    });

    it('loads all valid dashboards', async () => {
      writeDashboard('dash-a', VALID_DASHBOARD_YAML);
      writeDashboard('dash-b', VALID_DASHBOARD_YAML.replace('test-dash', 'dash-b').replace('Test Dashboard', 'Dashboard B'));
      const { loadAllDashboards, clearDashboardCache } = await import('../src/lib/dashboard/loader.js');
      clearDashboardCache();
      const all = loadAllDashboards();
      expect(all).toHaveLength(2);
    });
  });

  describe('findDashboard', () => {
    it('finds dashboard by exact name', async () => {
      writeDashboard('costs', VALID_DASHBOARD_YAML);
      const { findDashboard, clearDashboardCache } = await import('../src/lib/dashboard/loader.js');
      clearDashboardCache();
      const def = findDashboard('costs');
      expect(def).not.toBeNull();
    });

    it('finds dashboard by partial match', async () => {
      writeDashboard('agent-costs', VALID_DASHBOARD_YAML);
      const { findDashboard, clearDashboardCache } = await import('../src/lib/dashboard/loader.js');
      clearDashboardCache();
      const def = findDashboard('costs');
      expect(def).not.toBeNull();
    });

    it('returns null when no match found', async () => {
      const { findDashboard, clearDashboardCache } = await import('../src/lib/dashboard/loader.js');
      clearDashboardCache();
      const def = findDashboard('nonexistent');
      expect(def).toBeNull();
    });
  });
});
