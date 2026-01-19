/**
 * Dashboard Loader
 * Loads and parses dashboard YAML definitions
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { createRequire } from 'module';
import type { DashboardDefinition } from './types.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

// Cache loaded dashboards
const dashboardCache = new Map<string, DashboardDefinition>();

/**
 * Find the dashboards directory
 */
export function findDashboardsDir(): string | null {
  // Start from cwd and walk up
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const dashDir = join(dir, '.agents', 'dashboards');
    if (existsSync(dashDir)) {
      return dashDir;
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * List all available dashboards
 */
export function listDashboards(): string[] {
  const dir = findDashboardsDir();
  if (!dir) return [];

  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.yaml') && !f.startsWith('_'))
      .map(f => basename(f, '.yaml'));
  } catch {
    return [];
  }
}

/**
 * Load a dashboard definition by name
 */
export function loadDashboard(name: string): DashboardDefinition | null {
  // Check cache
  if (dashboardCache.has(name)) {
    return dashboardCache.get(name)!;
  }

  const dir = findDashboardsDir();
  if (!dir) return null;

  const filePath = join(dir, `${name}.yaml`);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const def = yaml.load(content) as DashboardDefinition;

    // Validate required fields
    if (!def.name || !def.title || !def.source || !def.metrics || !def.views) {
      console.error(`Invalid dashboard definition: ${name}`);
      return null;
    }

    // Cache and return
    dashboardCache.set(name, def);
    return def;
  } catch (err) {
    console.error(`Error loading dashboard ${name}:`, err);
    return null;
  }
}

/**
 * Load all dashboards
 */
export function loadAllDashboards(): DashboardDefinition[] {
  const names = listDashboards();
  return names
    .map(name => loadDashboard(name))
    .filter((d): d is DashboardDefinition => d !== null);
}

/**
 * Clear the dashboard cache (useful for hot-reload)
 */
export function clearDashboardCache(): void {
  dashboardCache.clear();
}

/**
 * Get dashboard by partial match (fuzzy find)
 */
export function findDashboard(query: string): DashboardDefinition | null {
  // Exact match first
  const exact = loadDashboard(query);
  if (exact) return exact;

  // Partial match
  const all = listDashboards();
  const match = all.find(name =>
    name.toLowerCase().includes(query.toLowerCase())
  );
  if (match) return loadDashboard(match);

  return null;
}
