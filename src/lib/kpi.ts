/**
 * KPI Tracking Library
 *
 * Handles KPI definitions, recording values, and generating insights.
 * KPIs are defined in SQUAD.md frontmatter and values stored in memory files.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { findSquadsDir } from './squad-parser.js';

/**
 * KPI definition from SQUAD.md frontmatter
 */
export interface KpiDefinition {
  name: string;
  target: number;
  unit: string;
  period: 'daily' | 'weekly' | 'monthly';
  source?: 'manual' | 'postgres' | 'github' | 'api';
  description?: string;
}

/**
 * Recorded KPI value
 */
export interface KpiValue {
  timestamp: string;  // ISO date
  value: number;
  note?: string;
}

/**
 * KPI with current state and history
 */
export interface Kpi extends KpiDefinition {
  current?: number;
  lastUpdated?: string;
  trend?: 'up' | 'down' | 'flat';
  percentOfTarget?: number;
  history: KpiValue[];
}

/**
 * KPI storage file structure
 */
interface KpiStore {
  squadName: string;
  kpis: Record<string, KpiValue[]>;
  updatedAt: string;
}

/**
 * Get path to KPI store file for a squad
 */
export function getKpiStorePath(squadName: string): string {
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    throw new Error('No .agents/squads directory found');
  }
  return join(dirname(squadsDir), 'memory', squadName, 'kpis.json');
}

/**
 * Load KPI store for a squad
 */
export function loadKpiStore(squadName: string): KpiStore {
  const path = getKpiStorePath(squadName);

  if (!existsSync(path)) {
    return {
      squadName,
      kpis: {},
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as KpiStore;
  } catch {
    return {
      squadName,
      kpis: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Save KPI store for a squad
 */
export function saveKpiStore(store: KpiStore): void {
  const path = getKpiStorePath(store.squadName);
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  store.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(store, null, 2));
}

/**
 * Record a KPI value
 */
export function recordKpiValue(
  squadName: string,
  kpiName: string,
  value: number,
  note?: string
): KpiValue {
  const store = loadKpiStore(squadName);

  if (!store.kpis[kpiName]) {
    store.kpis[kpiName] = [];
  }

  const record: KpiValue = {
    timestamp: new Date().toISOString(),
    value,
    note,
  };

  store.kpis[kpiName].push(record);
  saveKpiStore(store);

  return record;
}

/**
 * Get KPI history for a specific metric
 */
export function getKpiHistory(
  squadName: string,
  kpiName: string,
  limit?: number
): KpiValue[] {
  const store = loadKpiStore(squadName);
  const history = store.kpis[kpiName] || [];

  if (limit) {
    return history.slice(-limit);
  }
  return history;
}

/**
 * Calculate trend from history
 */
export function calculateTrend(history: KpiValue[]): 'up' | 'down' | 'flat' {
  if (history.length < 2) return 'flat';

  const recent = history.slice(-5);
  if (recent.length < 2) return 'flat';

  const first = recent[0].value;
  const last = recent[recent.length - 1].value;
  const change = ((last - first) / first) * 100;

  if (change > 5) return 'up';
  if (change < -5) return 'down';
  return 'flat';
}

/**
 * Get current KPI state with trend
 */
export function getKpiState(
  definition: KpiDefinition,
  squadName: string
): Kpi {
  const history = getKpiHistory(squadName, definition.name);
  const lastValue = history.length > 0 ? history[history.length - 1] : undefined;

  return {
    ...definition,
    current: lastValue?.value,
    lastUpdated: lastValue?.timestamp,
    trend: calculateTrend(history),
    percentOfTarget: lastValue ? Math.round((lastValue.value / definition.target) * 100) : undefined,
    history,
  };
}

/**
 * Generate insight from KPI state
 */
export function generateKpiInsight(kpi: Kpi): string | null {
  if (!kpi.current || !kpi.percentOfTarget) {
    return null;
  }

  const trendEmoji = kpi.trend === 'up' ? '📈' : kpi.trend === 'down' ? '📉' : '➡️';
  const statusEmoji = kpi.percentOfTarget >= 100 ? '✅' : kpi.percentOfTarget >= 70 ? '🟡' : '🔴';

  if (kpi.percentOfTarget >= 100) {
    return `${statusEmoji} ${kpi.name}: Target achieved! ${kpi.current}/${kpi.target} ${kpi.unit} (${kpi.percentOfTarget}%) ${trendEmoji}`;
  } else if (kpi.percentOfTarget >= 70) {
    return `${statusEmoji} ${kpi.name}: On track - ${kpi.current}/${kpi.target} ${kpi.unit} (${kpi.percentOfTarget}%) ${trendEmoji}`;
  } else {
    return `${statusEmoji} ${kpi.name}: Needs attention - ${kpi.current}/${kpi.target} ${kpi.unit} (${kpi.percentOfTarget}%) ${trendEmoji}`;
  }
}

/**
 * Get values for a specific period
 */
export function getValuesForPeriod(
  history: KpiValue[],
  period: 'daily' | 'weekly' | 'monthly',
  count: number = 7
): KpiValue[] {
  const now = new Date();
  const cutoff = new Date();

  switch (period) {
    case 'daily':
      cutoff.setDate(now.getDate() - count);
      break;
    case 'weekly':
      cutoff.setDate(now.getDate() - count * 7);
      break;
    case 'monthly':
      cutoff.setMonth(now.getMonth() - count);
      break;
  }

  return history.filter(v => new Date(v.timestamp) >= cutoff);
}

/**
 * Aggregate values by period
 */
export function aggregateByPeriod(
  history: KpiValue[],
  period: 'daily' | 'weekly' | 'monthly'
): Map<string, number> {
  const aggregated = new Map<string, number[]>();

  for (const value of history) {
    const date = new Date(value.timestamp);
    let key: string;

    switch (period) {
      case 'daily':
        key = date.toISOString().split('T')[0];
        break;
      case 'weekly':
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        key = weekStart.toISOString().split('T')[0];
        break;
      case 'monthly':
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        break;
    }

    if (!aggregated.has(key)) {
      aggregated.set(key, []);
    }
    aggregated.get(key)!.push(value.value);
  }

  // Sum values for each period
  const result = new Map<string, number>();
  for (const [key, values] of aggregated) {
    result.set(key, values.reduce((a, b) => a + b, 0));
  }

  return result;
}

/**
 * Parse KPI definitions from SQUAD.md frontmatter
 */
export function parseKpiDefinitions(frontmatter?: Record<string, unknown>): KpiDefinition[] {
  if (!frontmatter) return [];
  const kpis = frontmatter.kpis as Array<Record<string, unknown>> | undefined;
  if (!kpis || !Array.isArray(kpis)) {
    return [];
  }

  return kpis.map(k => ({
    name: String(k.name || ''),
    target: Number(k.target || 0),
    unit: String(k.unit || ''),
    period: (k.period as KpiDefinition['period']) || 'weekly',
    source: (k.source as KpiDefinition['source']) || 'manual',
    description: k.description ? String(k.description) : undefined,
  })).filter(k => k.name && k.target > 0);
}
