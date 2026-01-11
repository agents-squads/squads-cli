import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  KpiDefinition,
  KpiValue,
  loadKpiStore,
  saveKpiStore,
  recordKpiValue,
  getKpiHistory,
  calculateTrend,
  getKpiState,
  generateKpiInsight,
  parseKpiDefinitions,
  getValuesForPeriod,
  aggregateByPeriod,
} from '../src/lib/kpi.js';

describe('KPI Library', () => {
  const testDir = join(tmpdir(), 'kpi-test-' + Date.now());
  const originalCwd = process.cwd();

  beforeEach(() => {
    // Create test structure: .agents/squads/test-squad/SQUAD.md
    const squadsDir = join(testDir, '.agents', 'squads', 'test-squad');
    const memoryDir = join(testDir, '.agents', 'memory', 'test-squad');
    mkdirSync(squadsDir, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });

    // Create SQUAD.md with KPI definitions
    writeFileSync(
      join(squadsDir, 'SQUAD.md'),
      `---
name: test-squad
kpis:
  - name: leads_generated
    target: 10
    unit: leads
    period: weekly
  - name: revenue
    target: 1000
    unit: USD
    period: monthly
---
# Test Squad
`
    );

    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('parseKpiDefinitions', () => {
    it('parses KPI definitions from frontmatter', () => {
      const frontmatter = {
        kpis: [
          { name: 'metric1', target: 100, unit: 'items', period: 'daily' },
          { name: 'metric2', target: 50, unit: 'things', period: 'weekly' },
        ],
      };

      const kpis = parseKpiDefinitions(frontmatter);

      expect(kpis).toHaveLength(2);
      expect(kpis[0].name).toBe('metric1');
      expect(kpis[0].target).toBe(100);
      expect(kpis[0].period).toBe('daily');
      expect(kpis[1].name).toBe('metric2');
    });

    it('returns empty array for missing kpis', () => {
      const kpis = parseKpiDefinitions({});
      expect(kpis).toHaveLength(0);
    });

    it('filters out invalid KPIs', () => {
      const frontmatter = {
        kpis: [
          { name: '', target: 100, unit: 'items' }, // empty name
          { name: 'valid', target: 0, unit: 'items' }, // zero target
          { name: 'good', target: 50, unit: 'items' }, // valid
        ],
      };

      const kpis = parseKpiDefinitions(frontmatter);
      expect(kpis).toHaveLength(1);
      expect(kpis[0].name).toBe('good');
    });
  });

  describe('KPI Store', () => {
    it('loads empty store for new squad', () => {
      const store = loadKpiStore('new-squad');

      expect(store.squadName).toBe('new-squad');
      expect(store.kpis).toEqual({});
    });

    it('saves and loads store correctly', () => {
      const store = loadKpiStore('test-squad');
      store.kpis['test_metric'] = [
        { timestamp: '2025-01-01T00:00:00Z', value: 42 },
      ];
      saveKpiStore(store);

      const loaded = loadKpiStore('test-squad');
      expect(loaded.kpis['test_metric']).toHaveLength(1);
      expect(loaded.kpis['test_metric'][0].value).toBe(42);
    });
  });

  describe('recordKpiValue', () => {
    it('records a new value', () => {
      const record = recordKpiValue('test-squad', 'leads_generated', 5, 'First record');

      expect(record.value).toBe(5);
      expect(record.note).toBe('First record');
      expect(record.timestamp).toBeDefined();
    });

    it('appends to existing history', () => {
      recordKpiValue('test-squad', 'leads_generated', 5);
      recordKpiValue('test-squad', 'leads_generated', 8);

      const history = getKpiHistory('test-squad', 'leads_generated');
      expect(history).toHaveLength(2);
      expect(history[0].value).toBe(5);
      expect(history[1].value).toBe(8);
    });
  });

  describe('getKpiHistory', () => {
    it('returns empty array for non-existent KPI', () => {
      const history = getKpiHistory('test-squad', 'nonexistent');
      expect(history).toHaveLength(0);
    });

    it('limits results when specified', () => {
      recordKpiValue('test-squad', 'metric', 1);
      recordKpiValue('test-squad', 'metric', 2);
      recordKpiValue('test-squad', 'metric', 3);
      recordKpiValue('test-squad', 'metric', 4);
      recordKpiValue('test-squad', 'metric', 5);

      const history = getKpiHistory('test-squad', 'metric', 3);
      expect(history).toHaveLength(3);
      expect(history[0].value).toBe(3); // Last 3 values
      expect(history[2].value).toBe(5);
    });
  });

  describe('calculateTrend', () => {
    it('returns flat for insufficient data', () => {
      expect(calculateTrend([])).toBe('flat');
      expect(calculateTrend([{ timestamp: '', value: 10 }])).toBe('flat');
    });

    it('detects upward trend', () => {
      const history: KpiValue[] = [
        { timestamp: '', value: 10 },
        { timestamp: '', value: 12 },
        { timestamp: '', value: 14 },
        { timestamp: '', value: 16 },
        { timestamp: '', value: 18 },
      ];

      expect(calculateTrend(history)).toBe('up');
    });

    it('detects downward trend', () => {
      const history: KpiValue[] = [
        { timestamp: '', value: 20 },
        { timestamp: '', value: 18 },
        { timestamp: '', value: 16 },
        { timestamp: '', value: 14 },
        { timestamp: '', value: 12 },
      ];

      expect(calculateTrend(history)).toBe('down');
    });

    it('detects flat trend for small changes', () => {
      const history: KpiValue[] = [
        { timestamp: '', value: 100 },
        { timestamp: '', value: 101 },
        { timestamp: '', value: 99 },
        { timestamp: '', value: 100 },
        { timestamp: '', value: 100 },
      ];

      expect(calculateTrend(history)).toBe('flat');
    });
  });

  describe('getKpiState', () => {
    it('returns KPI state with no data', () => {
      const definition: KpiDefinition = {
        name: 'new_metric',
        target: 100,
        unit: 'items',
        period: 'weekly',
      };

      const state = getKpiState(definition, 'test-squad');

      expect(state.name).toBe('new_metric');
      expect(state.current).toBeUndefined();
      expect(state.trend).toBe('flat');
      expect(state.history).toHaveLength(0);
    });

    it('returns KPI state with data', () => {
      recordKpiValue('test-squad', 'leads_generated', 7);

      const definition: KpiDefinition = {
        name: 'leads_generated',
        target: 10,
        unit: 'leads',
        period: 'weekly',
      };

      const state = getKpiState(definition, 'test-squad');

      expect(state.current).toBe(7);
      expect(state.percentOfTarget).toBe(70);
      expect(state.history).toHaveLength(1);
    });
  });

  describe('generateKpiInsight', () => {
    it('returns null for no data', () => {
      const kpi = {
        name: 'test',
        target: 100,
        unit: 'items',
        period: 'weekly' as const,
        history: [],
      };

      expect(generateKpiInsight(kpi)).toBeNull();
    });

    it('generates target achieved insight', () => {
      const kpi = {
        name: 'test',
        target: 100,
        unit: 'items',
        period: 'weekly' as const,
        current: 120,
        percentOfTarget: 120,
        trend: 'up' as const,
        history: [{ timestamp: '', value: 120 }],
      };

      const insight = generateKpiInsight(kpi);
      expect(insight).toContain('Target achieved');
      expect(insight).toContain('120/100');
    });

    it('generates on track insight', () => {
      const kpi = {
        name: 'test',
        target: 100,
        unit: 'items',
        period: 'weekly' as const,
        current: 80,
        percentOfTarget: 80,
        trend: 'up' as const,
        history: [{ timestamp: '', value: 80 }],
      };

      const insight = generateKpiInsight(kpi);
      expect(insight).toContain('On track');
    });

    it('generates needs attention insight', () => {
      const kpi = {
        name: 'test',
        target: 100,
        unit: 'items',
        period: 'weekly' as const,
        current: 30,
        percentOfTarget: 30,
        trend: 'down' as const,
        history: [{ timestamp: '', value: 30 }],
      };

      const insight = generateKpiInsight(kpi);
      expect(insight).toContain('Needs attention');
    });
  });

  describe('getValuesForPeriod', () => {
    it('filters by daily period', () => {
      const now = new Date();
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      const weekAgo = new Date(now);
      weekAgo.setDate(now.getDate() - 7);

      const history: KpiValue[] = [
        { timestamp: weekAgo.toISOString(), value: 10 },
        { timestamp: yesterday.toISOString(), value: 20 },
        { timestamp: now.toISOString(), value: 30 },
      ];

      const values = getValuesForPeriod(history, 'daily', 3);
      expect(values).toHaveLength(2); // yesterday and today
    });

    it('filters by weekly period', () => {
      const now = new Date();
      const twoWeeksAgo = new Date(now);
      twoWeeksAgo.setDate(now.getDate() - 14);
      const monthAgo = new Date(now);
      monthAgo.setDate(now.getDate() - 30);

      const history: KpiValue[] = [
        { timestamp: monthAgo.toISOString(), value: 10 },
        { timestamp: twoWeeksAgo.toISOString(), value: 20 },
        { timestamp: now.toISOString(), value: 30 },
      ];

      const values = getValuesForPeriod(history, 'weekly', 3);
      expect(values).toHaveLength(2); // last 3 weeks excludes month ago
    });
  });

  describe('aggregateByPeriod', () => {
    it('aggregates daily values', () => {
      const today = new Date().toISOString().split('T')[0];
      const history: KpiValue[] = [
        { timestamp: `${today}T10:00:00Z`, value: 5 },
        { timestamp: `${today}T14:00:00Z`, value: 3 },
        { timestamp: `${today}T18:00:00Z`, value: 2 },
      ];

      const aggregated = aggregateByPeriod(history, 'daily');
      expect(aggregated.get(today)).toBe(10); // Sum of all values
    });

    it('aggregates monthly values', () => {
      const now = new Date();
      const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      const history: KpiValue[] = [
        { timestamp: now.toISOString(), value: 100 },
        { timestamp: now.toISOString(), value: 50 },
      ];

      const aggregated = aggregateByPeriod(history, 'monthly');
      expect(aggregated.get(yearMonth)).toBe(150);
    });
  });
});
