import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseKpiDefinitions } from '../src/lib/kpi.js';

describe('Cycle Sync', () => {
  describe('parseKpiDefinitions (unit tests)', () => {
    it('parses KPI definitions from frontmatter', () => {
      const frontmatter = {
        kpis: [
          { name: 'leads', target: 10, unit: 'count', period: 'weekly' },
          { name: 'revenue', target: 1000, unit: 'USD', period: 'monthly' },
        ],
      };

      const result = parseKpiDefinitions(frontmatter);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('leads');
      expect(result[1].target).toBe(1000);
    });

    it('handles undefined frontmatter', () => {
      const result = parseKpiDefinitions(undefined);
      expect(result).toEqual([]);
    });

    it('handles empty frontmatter', () => {
      const result = parseKpiDefinitions({});
      expect(result).toEqual([]);
    });

    it('handles frontmatter without kpis', () => {
      const result = parseKpiDefinitions({ name: 'test', other: 'field' });
      expect(result).toEqual([]);
    });

    it('filters out invalid KPIs', () => {
      const frontmatter = {
        kpis: [
          { name: '', target: 10, unit: 'items' }, // empty name
          { name: 'valid', target: 0, unit: 'items' }, // zero target
          { name: 'good', target: 50, unit: 'items' }, // valid
        ],
      };

      const result = parseKpiDefinitions(frontmatter);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('good');
    });
  });

  describe('Database Sync (integration)', () => {
    it('isPostgresAvailable returns boolean', async () => {
      const { isPostgresAvailable, closeCycleSyncPool } = await import('../src/lib/cycle-sync.js');

      const available = await isPostgresAvailable();
      expect(typeof available).toBe('boolean');

      await closeCycleSyncPool();
    });

    it('SyncStats interface is correct', async () => {
      const { syncAllCycleData, closeCycleSyncPool } = await import('../src/lib/cycle-sync.js');

      // syncAllCycleData returns SyncResult containing SyncStats per data type
      const result = await syncAllCycleData();

      expect(result.goals).toHaveProperty('synced');
      expect(result.goals).toHaveProperty('skipped');
      expect(result.goals).toHaveProperty('errors');
      expect(typeof result.goals.synced).toBe('number');

      await closeCycleSyncPool();
    });

    it('SyncResult interface is correct', async () => {
      const { syncAllCycleData, isPostgresAvailable, closeCycleSyncPool } = await import('../src/lib/cycle-sync.js');

      const available = await isPostgresAvailable();

      if (available) {
        const result = await syncAllCycleData();

        expect(result).toHaveProperty('goals');
        expect(result).toHaveProperty('feedback');
        expect(result).toHaveProperty('kpis');
        expect(result).toHaveProperty('learnings');
        expect(result).toHaveProperty('duration');
        expect(typeof result.duration).toBe('number');
      }

      await closeCycleSyncPool();
    });
  });

  describe('File structures', () => {
    const testDir = join(tmpdir(), 'cycle-sync-files-' + Date.now());

    beforeEach(() => {
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('feedback.json structure is parseable', () => {
      const feedbackJson = {
        entries: [
          {
            timestamp: '2025-01-10T10:00:00Z',
            rating: 4,
            feedback: 'Good execution',
            learnings: ['Pattern A works well'],
          },
        ],
      };

      const path = join(testDir, 'feedback.json');
      writeFileSync(path, JSON.stringify(feedbackJson));

      const parsed = JSON.parse(require('fs').readFileSync(path, 'utf-8'));
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].rating).toBe(4);
    });

    it('learnings.json structure is parseable', () => {
      const learningsJson = {
        entries: [
          {
            timestamp: '2025-01-10T12:00:00Z',
            insight: 'Using parallel agents speeds up research',
            category: 'pattern',
            tags: ['agents', 'performance'],
          },
        ],
      };

      const path = join(testDir, 'learnings.json');
      writeFileSync(path, JSON.stringify(learningsJson));

      const parsed = JSON.parse(require('fs').readFileSync(path, 'utf-8'));
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].category).toBe('pattern');
    });

    it('kpis.json structure is parseable', () => {
      const kpisJson = {
        squadName: 'test-squad',
        kpis: {
          leads_generated: [
            { timestamp: '2025-01-10T00:00:00Z', value: 5, note: 'First week' },
          ],
        },
        updatedAt: '2025-01-11T00:00:00Z',
      };

      const path = join(testDir, 'kpis.json');
      writeFileSync(path, JSON.stringify(kpisJson));

      const parsed = JSON.parse(require('fs').readFileSync(path, 'utf-8'));
      expect(parsed.kpis.leads_generated).toHaveLength(1);
      expect(parsed.kpis.leads_generated[0].value).toBe(5);
    });
  });
});
