import { describe, it, expect } from 'vitest';
import {
  buildQuery,
  buildWhereClause,
  parseDateRange,
  postgresSource,
} from '../src/lib/dashboard/sources/postgres.js';

describe('dashboard postgres source', () => {
  describe('buildQuery', () => {
    it('builds a simple SELECT with metric', () => {
      const sql = buildQuery('executions', [{ name: 'total', sql: 'COUNT(*)' }]);
      expect(sql).toBe('SELECT COUNT(*) AS total FROM executions');
    });

    it('includes GROUP BY when group_by is provided', () => {
      const sql = buildQuery(
        'executions',
        [{ name: 'total', sql: 'COUNT(*)' }],
        ['squad_name']
      );
      expect(sql).toContain('GROUP BY squad_name');
      expect(sql).toContain('squad_name');
    });

    it('includes WHERE when where clause is provided', () => {
      const sql = buildQuery(
        'executions',
        [{ name: 'total', sql: 'COUNT(*)' }],
        undefined,
        "status = 'success'"
      );
      expect(sql).toContain("WHERE status = 'success'");
    });

    it('includes ORDER BY when orderBy is provided', () => {
      const sql = buildQuery(
        'executions',
        [{ name: 'total', sql: 'COUNT(*)' }],
        undefined,
        undefined,
        'created_at DESC'
      );
      expect(sql).toContain('ORDER BY created_at DESC');
    });

    it('includes LIMIT when limit is provided', () => {
      const sql = buildQuery(
        'executions',
        [{ name: 'total', sql: 'COUNT(*)' }],
        undefined,
        undefined,
        undefined,
        10
      );
      expect(sql).toContain('LIMIT 10');
    });

    it('builds full query with all clauses', () => {
      const sql = buildQuery(
        'executions',
        [{ name: 'total', sql: 'COUNT(*)' }, { name: 'avg_cost', sql: 'AVG(cost)' }],
        ['squad_name', 'status'],
        "created_at > '2024-01-01'",
        'total DESC',
        5
      );
      expect(sql).toContain('SELECT');
      expect(sql).toContain('squad_name');
      expect(sql).toContain('COUNT(*) AS total');
      expect(sql).toContain('AVG(cost) AS avg_cost');
      expect(sql).toContain('FROM executions');
      expect(sql).toContain("WHERE created_at > '2024-01-01'");
      expect(sql).toContain('GROUP BY squad_name, status');
      expect(sql).toContain('ORDER BY total DESC');
      expect(sql).toContain('LIMIT 5');
    });

    it('handles multiple metrics', () => {
      const sql = buildQuery('table1', [
        { name: 'm1', sql: 'COUNT(*)' },
        { name: 'm2', sql: 'SUM(cost)' },
      ]);
      expect(sql).toContain('COUNT(*) AS m1');
      expect(sql).toContain('SUM(cost) AS m2');
    });
  });

  describe('buildWhereClause', () => {
    it('returns null for empty filters', () => {
      const result = buildWhereClause({}, []);
      expect(result).toBeNull();
    });

    it('builds date_range filter', () => {
      const start = new Date('2024-01-01');
      const end = new Date('2024-01-31');
      const result = buildWhereClause(
        { created_at: { start, end } },
        [{ name: 'created_at', field: 'created_at', type: 'date_range' }]
      );
      expect(result).toContain("created_at >= '");
      expect(result).toContain("created_at <= '");
    });

    it('builds select filter with array', () => {
      const result = buildWhereClause(
        { status: ['success', 'failed'] },
        [{ name: 'status', field: 'status', type: 'select' }]
      );
      expect(result).toContain("status IN ('success', 'failed')");
    });

    it('skips empty select arrays', () => {
      const result = buildWhereClause(
        { status: [] },
        [{ name: 'status', field: 'status', type: 'select' }]
      );
      expect(result).toBeNull();
    });

    it('builds boolean filter', () => {
      const result = buildWhereClause(
        { is_active: true },
        [{ name: 'is_active', field: 'is_active', type: 'boolean' }]
      );
      expect(result).toBe('is_active = true');
    });

    it('builds text ILIKE filter', () => {
      const result = buildWhereClause(
        { name: 'engineering' },
        [{ name: 'name', field: 'squad_name', type: 'text' }]
      );
      expect(result).toContain('ILIKE');
      expect(result).toContain('%engineering%');
    });

    it('uses field name as column name when field not specified', () => {
      const result = buildWhereClause(
        { is_active: false },
        [{ name: 'is_active', type: 'boolean' }]
      );
      expect(result).toBe('is_active = false');
    });

    it('skips unknown filter names', () => {
      const result = buildWhereClause(
        { unknown_filter: 'value' },
        [{ name: 'known_filter', field: 'known_filter', type: 'text' }]
      );
      expect(result).toBeNull();
    });

    it('skips null and undefined values', () => {
      const result = buildWhereClause(
        { status: null, squad: undefined },
        [
          { name: 'status', field: 'status', type: 'text' },
          { name: 'squad', field: 'squad', type: 'text' },
        ]
      );
      expect(result).toBeNull();
    });

    it('joins multiple conditions with AND', () => {
      const result = buildWhereClause(
        { is_active: true, is_success: false },
        [
          { name: 'is_active', field: 'is_active', type: 'boolean' },
          { name: 'is_success', field: 'is_success', type: 'boolean' },
        ]
      );
      expect(result).toContain(' AND ');
    });

    it('escapes single quotes in text values', () => {
      const result = buildWhereClause(
        { name: "it's here" },
        [{ name: 'name', field: 'name', type: 'text' }]
      );
      expect(result).toContain("it''s");
    });
  });

  describe('parseDateRange', () => {
    it('parses today', () => {
      const { start, end } = parseDateRange('today');
      const now = new Date();
      expect(start.getDate()).toBe(now.getDate());
      expect(start.getHours()).toBe(0);
      expect(end.getHours()).toBe(23);
    });

    it('parses yesterday', () => {
      const { start, end } = parseDateRange('yesterday');
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      expect(start.getDate()).toBe(yesterday.getDate());
      expect(end.getDate()).toBe(yesterday.getDate());
    });

    it('parses last_7d', () => {
      const { start, end } = parseDateRange('last_7d');
      const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      expect(diffDays).toBeGreaterThanOrEqual(6);
      expect(diffDays).toBeLessThanOrEqual(8);
    });

    it('parses last_30d', () => {
      const { start, end } = parseDateRange('last_30d');
      const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      expect(diffDays).toBeGreaterThanOrEqual(29);
      expect(diffDays).toBeLessThanOrEqual(31);
    });

    it('parses this_month', () => {
      const { start } = parseDateRange('this_month');
      expect(start.getDate()).toBe(1);
    });

    it('parses last_month', () => {
      const { start, end } = parseDateRange('last_month');
      expect(start.getDate()).toBe(1);
      // end should be last day of previous month
      expect(end.getDate()).toBeGreaterThan(27);
    });

    it('parses this_quarter', () => {
      const { start } = parseDateRange('this_quarter');
      const now = new Date();
      const q = Math.floor(now.getMonth() / 3);
      expect(start.getMonth()).toBe(q * 3);
      expect(start.getDate()).toBe(1);
    });

    it('defaults to last_7d for unknown presets', () => {
      const { start: def } = parseDateRange('unknown_preset');
      const { start: last7 } = parseDateRange('last_7d');
      // Both should be approximately the same (within 1 minute)
      expect(Math.abs(def.getTime() - last7.getTime())).toBeLessThan(60 * 1000);
    });

    it('returns Date objects', () => {
      const { start, end } = parseDateRange('today');
      expect(start).toBeInstanceOf(Date);
      expect(end).toBeInstanceOf(Date);
    });
  });

  describe('postgresSource stub', () => {
    it('is always unavailable (stub)', async () => {
      const available = await postgresSource.isAvailable();
      expect(available).toBe(false);
    });

    it('returns empty result on query', async () => {
      const result = await postgresSource.query('SELECT 1');
      expect(result.rows).toEqual([]);
      expect(result.columns).toEqual([]);
    });

    it('close does not throw', async () => {
      await expect(postgresSource.close()).resolves.toBeUndefined();
    });

    it('has name property', () => {
      expect(postgresSource.name).toBe('postgres');
    });
  });
});
