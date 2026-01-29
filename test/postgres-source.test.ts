/**
 * PostgreSQL Source Tests
 *
 * Tests the SQL query building functions and date range parsing
 * to prevent SQL injection and ensure correct query construction.
 *
 * These are critical security tests since the functions build SQL dynamically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildQuery,
  buildWhereClause,
  parseDateRange,
} from '../src/lib/dashboard/sources/postgres.js';

describe('PostgreSQL Source (postgres.ts)', () => {
  describe('buildQuery', () => {
    it('builds simple SELECT query', () => {
      const sql = buildQuery(
        'squads.metrics',
        [{ name: 'total', sql: 'COUNT(*)' }],
      );

      expect(sql).toBe('SELECT COUNT(*) AS total FROM squads.metrics');
    });

    it('builds query with multiple metrics', () => {
      const sql = buildQuery(
        'squads.metrics',
        [
          { name: 'total_count', sql: 'COUNT(*)' },
          { name: 'sum_value', sql: 'SUM(value)' },
          { name: 'avg_value', sql: 'AVG(value)' },
        ],
      );

      expect(sql).toContain('COUNT(*) AS total_count');
      expect(sql).toContain('SUM(value) AS sum_value');
      expect(sql).toContain('AVG(value) AS avg_value');
    });

    it('builds query with GROUP BY', () => {
      const sql = buildQuery(
        'squads.metrics',
        [{ name: 'count', sql: 'COUNT(*)' }],
        ['squad', 'agent'],
      );

      expect(sql).toContain('squad, agent');
      expect(sql).toContain('GROUP BY squad, agent');
    });

    it('builds query with WHERE clause', () => {
      const sql = buildQuery(
        'squads.metrics',
        [{ name: 'count', sql: 'COUNT(*)' }],
        undefined,
        "squad = 'engineering'",
      );

      expect(sql).toContain("WHERE squad = 'engineering'");
    });

    it('builds query with ORDER BY', () => {
      const sql = buildQuery(
        'squads.metrics',
        [{ name: 'count', sql: 'COUNT(*)' }],
        undefined,
        undefined,
        'count DESC',
      );

      expect(sql).toContain('ORDER BY count DESC');
    });

    it('builds query with LIMIT', () => {
      const sql = buildQuery(
        'squads.metrics',
        [{ name: 'count', sql: 'COUNT(*)' }],
        undefined,
        undefined,
        undefined,
        10,
      );

      expect(sql).toContain('LIMIT 10');
    });

    it('builds complete query with all options', () => {
      const sql = buildQuery(
        'squads.executions',
        [
          { name: 'exec_count', sql: 'COUNT(*)' },
          { name: 'total_cost', sql: 'SUM(cost_usd)' },
        ],
        ['squad'],
        "status = 'completed'",
        'exec_count DESC',
        5,
      );

      expect(sql).toContain('SELECT squad, COUNT(*) AS exec_count, SUM(cost_usd) AS total_cost');
      expect(sql).toContain('FROM squads.executions');
      expect(sql).toContain("WHERE status = 'completed'");
      expect(sql).toContain('GROUP BY squad');
      expect(sql).toContain('ORDER BY exec_count DESC');
      expect(sql).toContain('LIMIT 5');
    });

    it('handles empty groupBy array', () => {
      const sql = buildQuery(
        'squads.metrics',
        [{ name: 'count', sql: 'COUNT(*)' }],
        [],
      );

      expect(sql).not.toContain('GROUP BY');
    });

    it('handles single metric correctly', () => {
      const sql = buildQuery(
        'squads.dashboard_snapshots',
        [{ name: 'latest', sql: 'MAX(captured_at)' }],
      );

      expect(sql).toBe('SELECT MAX(captured_at) AS latest FROM squads.dashboard_snapshots');
    });
  });

  describe('buildWhereClause', () => {
    it('returns null for empty filters', () => {
      const result = buildWhereClause({}, []);
      expect(result).toBeNull();
    });

    it('returns null for undefined/null filter values', () => {
      const result = buildWhereClause(
        { squad: undefined, agent: null },
        [
          { name: 'squad', type: 'text' },
          { name: 'agent', type: 'text' },
        ],
      );

      expect(result).toBeNull();
    });

    it('builds date_range filter', () => {
      const start = new Date('2025-01-01T00:00:00Z');
      const end = new Date('2025-01-31T23:59:59Z');

      const result = buildWhereClause(
        { created: { start, end } },
        [{ name: 'created', field: 'created_at', type: 'date_range' }],
      );

      expect(result).toContain("created_at >= '2025-01-01T00:00:00.000Z'");
      expect(result).toContain("created_at <= '2025-01-31T23:59:59.000Z'");
      expect(result).toContain(' AND ');
    });

    it('builds date_range filter with only start date', () => {
      const start = new Date('2025-01-01T00:00:00Z');

      const result = buildWhereClause(
        { created: { start } },
        [{ name: 'created', field: 'created_at', type: 'date_range' }],
      );

      expect(result).toContain("created_at >= '2025-01-01T00:00:00.000Z'");
      expect(result).not.toContain('<=');
    });

    it('builds date_range filter with only end date', () => {
      const end = new Date('2025-01-31T23:59:59Z');

      const result = buildWhereClause(
        { created: { end } },
        [{ name: 'created', field: 'created_at', type: 'date_range' }],
      );

      expect(result).toContain("created_at <= '2025-01-31T23:59:59.000Z'");
      expect(result).not.toContain('>=');
    });

    it('builds select filter with array values', () => {
      const result = buildWhereClause(
        { squad: ['engineering', 'research'] },
        [{ name: 'squad', type: 'select' }],
      );

      expect(result).toBe("squad IN ('engineering', 'research')");
    });

    it('escapes single quotes in select filter values', () => {
      const result = buildWhereClause(
        { name: ["O'Brien", "test's value"] },
        [{ name: 'name', type: 'select' }],
      );

      expect(result).toContain("O''Brien");
      expect(result).toContain("test''s value");
    });

    it('skips empty array in select filter', () => {
      const result = buildWhereClause(
        { squad: [] },
        [{ name: 'squad', type: 'select' }],
      );

      expect(result).toBeNull();
    });

    it('builds boolean filter - true', () => {
      const result = buildWhereClause(
        { active: true },
        [{ name: 'active', type: 'boolean' }],
      );

      expect(result).toBe('active = true');
    });

    it('builds boolean filter - false', () => {
      const result = buildWhereClause(
        { active: false },
        [{ name: 'active', type: 'boolean' }],
      );

      expect(result).toBe('active = false');
    });

    it('builds text filter with ILIKE', () => {
      const result = buildWhereClause(
        { search: 'test' },
        [{ name: 'search', field: 'description', type: 'text' }],
      );

      expect(result).toBe("description ILIKE '%test%'");
    });

    it('escapes single quotes in text filter', () => {
      const result = buildWhereClause(
        { search: "test's value" },
        [{ name: 'search', field: 'description', type: 'text' }],
      );

      expect(result).toBe("description ILIKE '%test''s value%'");
    });

    it('uses filter name as field when field not specified', () => {
      const result = buildWhereClause(
        { status: true },
        [{ name: 'status', type: 'boolean' }],
      );

      expect(result).toBe('status = true');
    });

    it('combines multiple filters with AND', () => {
      const result = buildWhereClause(
        {
          squad: ['engineering'],
          active: true,
          search: 'test',
        },
        [
          { name: 'squad', type: 'select' },
          { name: 'active', type: 'boolean' },
          { name: 'search', field: 'description', type: 'text' },
        ],
      );

      expect(result).toContain("squad IN ('engineering')");
      expect(result).toContain('active = true');
      expect(result).toContain("description ILIKE '%test%'");
      expect(result?.match(/ AND /g)?.length).toBe(2);
    });

    it('ignores filters not in definitions', () => {
      const result = buildWhereClause(
        { unknown: 'value', known: true },
        [{ name: 'known', type: 'boolean' }],
      );

      expect(result).toBe('known = true');
      expect(result).not.toContain('unknown');
    });
  });

  describe('parseDateRange', () => {
    // Note: These tests use Date comparison logic that accounts for local timezone

    it('parses "today" preset', () => {
      const { start, end } = parseDateRange('today');

      const today = new Date();
      expect(start.getFullYear()).toBe(today.getFullYear());
      expect(start.getMonth()).toBe(today.getMonth());
      expect(start.getDate()).toBe(today.getDate());
      expect(start.getHours()).toBe(0);
      expect(start.getMinutes()).toBe(0);

      expect(end.getHours()).toBe(23);
      expect(end.getMinutes()).toBe(59);
    });

    it('parses "yesterday" preset', () => {
      const { start, end } = parseDateRange('yesterday');

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      expect(start.getDate()).toBe(yesterday.getDate());
      expect(end.getDate()).toBe(yesterday.getDate());
    });

    it('parses "last_7d" preset', () => {
      const { start, end } = parseDateRange('last_7d');

      const today = new Date();
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      expect(start.getDate()).toBe(sevenDaysAgo.getDate());
      expect(end.getDate()).toBe(today.getDate());
    });

    it('parses "last_30d" preset', () => {
      const { start, end } = parseDateRange('last_30d');

      const today = new Date();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      expect(start.getDate()).toBe(thirtyDaysAgo.getDate());
      expect(end.getDate()).toBe(today.getDate());
    });

    it('parses "this_month" preset', () => {
      const { start, end } = parseDateRange('this_month');

      const today = new Date();
      expect(start.getMonth()).toBe(today.getMonth());
      expect(start.getDate()).toBe(1);
      expect(end.getDate()).toBe(today.getDate());
    });

    it('parses "last_month" preset', () => {
      const { start, end } = parseDateRange('last_month');

      const today = new Date();
      const lastMonth = new Date(today);
      lastMonth.setMonth(lastMonth.getMonth() - 1);

      expect(start.getMonth()).toBe(lastMonth.getMonth());
      expect(start.getDate()).toBe(1);
    });

    it('parses "this_quarter" preset', () => {
      const { start } = parseDateRange('this_quarter');

      const today = new Date();
      const quarterStart = Math.floor(today.getMonth() / 3) * 3;

      expect(start.getMonth()).toBe(quarterStart);
      expect(start.getDate()).toBe(1);
    });

    it('defaults to last_7d for unknown preset', () => {
      const { start: startUnknown } = parseDateRange('unknown_preset');
      const { start: startDefault } = parseDateRange('last_7d');

      expect(startUnknown.getDate()).toBe(startDefault.getDate());
    });

    it('returns Date objects with proper time boundaries', () => {
      const { start, end } = parseDateRange('today');

      // Start should be at midnight
      expect(start.getHours()).toBe(0);
      expect(start.getMinutes()).toBe(0);
      expect(start.getSeconds()).toBe(0);
      expect(start.getMilliseconds()).toBe(0);

      // End should be at 23:59:59.999
      expect(end.getHours()).toBe(23);
      expect(end.getMinutes()).toBe(59);
      expect(end.getSeconds()).toBe(59);
      expect(end.getMilliseconds()).toBe(999);
    });
  });

  describe('SQL Injection Prevention', () => {
    it('escapes quotes in select filter values', () => {
      const result = buildWhereClause(
        { name: ["'; DROP TABLE users; --"] },
        [{ name: 'name', type: 'select' }],
      );

      // Single quote at start of value should be escaped as ''
      // Result should be: name IN ('''; DROP TABLE users; --')
      // The leading ' becomes '' (escaped), wrapped in outer quotes
      expect(result).toContain("'''");  // Escaped quote pattern
      expect(result).not.toContain("('; DROP TABLE");  // Unescaped injection attempt
    });

    it('escapes quotes in text filter values', () => {
      const result = buildWhereClause(
        { search: "'; DELETE FROM users; --" },
        [{ name: 'search', field: 'description', type: 'text' }],
      );

      expect(result).toContain("''; DELETE FROM users; --");
    });

    it('handles multiple injection attempts in array', () => {
      const result = buildWhereClause(
        { names: ["normal", "test' OR '1'='1", "another'; --"] },
        [{ name: 'names', type: 'select' }],
      );

      expect(result).toContain("'normal'");
      expect(result).toContain("test'' OR ''1''=''1");
      expect(result).toContain("another''; --");
    });
  });

  describe('postgresSource', () => {
    it('exports postgresSource with required methods', async () => {
      const { postgresSource } = await import('../src/lib/dashboard/sources/postgres.js');

      expect(postgresSource).toHaveProperty('name', 'postgres');
      expect(typeof postgresSource.query).toBe('function');
      expect(typeof postgresSource.isAvailable).toBe('function');
      expect(typeof postgresSource.close).toBe('function');
    });

    it('isAvailable returns boolean', async () => {
      const { postgresSource } = await import('../src/lib/dashboard/sources/postgres.js');

      const available = await postgresSource.isAvailable();
      expect(typeof available).toBe('boolean');

      await postgresSource.close();
    });

    it('close can be called multiple times safely', async () => {
      const { postgresSource } = await import('../src/lib/dashboard/sources/postgres.js');

      // Should not throw
      await postgresSource.close();
      await postgresSource.close();
      await postgresSource.close();
    });
  });

  describe('Edge Cases', () => {
    it('handles empty metrics array in buildQuery', () => {
      const sql = buildQuery('squads.test', []);
      expect(sql).toBe('SELECT  FROM squads.test');
    });

    it('handles special characters in table names', () => {
      // Note: This is still risky in production - table names should be validated
      const sql = buildQuery('squads."my-table"', [{ name: 'c', sql: 'COUNT(*)' }]);
      expect(sql).toContain('squads."my-table"');
    });

    it('handles numeric values in text filter', () => {
      const result = buildWhereClause(
        { search: 12345 as unknown as string },
        [{ name: 'search', field: 'code', type: 'text' }],
      );

      expect(result).toBe("code ILIKE '%12345%'");
    });

    it('handles boolean-like strings in boolean filter', () => {
      // Non-boolean values should still work with type boolean
      const resultTrue = buildWhereClause(
        { active: 'yes' as unknown as boolean },
        [{ name: 'active', type: 'boolean' }],
      );

      // Truthy string should result in true
      expect(resultTrue).toBe('active = true');
    });
  });
});
