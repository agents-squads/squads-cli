import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildQuery,
  buildWhereClause,
  parseDateRange,
} from '../src/lib/dashboard/sources/postgres.js';

describe('Dashboard Postgres Source', () => {
  describe('buildQuery', () => {
    it('builds simple query with one metric', () => {
      const sql = buildQuery(
        'executions',
        [{ name: 'total', sql: 'COUNT(*)' }]
      );
      expect(sql).toBe('SELECT COUNT(*) AS total FROM executions');
    });

    it('builds query with multiple metrics', () => {
      const sql = buildQuery(
        'executions',
        [
          { name: 'total', sql: 'COUNT(*)' },
          { name: 'avg_duration', sql: 'AVG(duration_ms)' },
        ]
      );
      expect(sql).toBe('SELECT COUNT(*) AS total, AVG(duration_ms) AS avg_duration FROM executions');
    });

    it('includes group by columns in select and adds GROUP BY clause', () => {
      const sql = buildQuery(
        'executions',
        [{ name: 'count', sql: 'COUNT(*)' }],
        ['squad', 'status']
      );
      expect(sql).toBe('SELECT squad, status, COUNT(*) AS count FROM executions GROUP BY squad, status');
    });

    it('adds WHERE clause when provided', () => {
      const sql = buildQuery(
        'executions',
        [{ name: 'total', sql: 'COUNT(*)' }],
        undefined,
        "status = 'completed'"
      );
      expect(sql).toBe("SELECT COUNT(*) AS total FROM executions WHERE status = 'completed'");
    });

    it('adds ORDER BY clause when provided', () => {
      const sql = buildQuery(
        'executions',
        [{ name: 'total', sql: 'COUNT(*)' }],
        ['squad'],
        undefined,
        'total DESC'
      );
      expect(sql).toBe('SELECT squad, COUNT(*) AS total FROM executions GROUP BY squad ORDER BY total DESC');
    });

    it('adds LIMIT clause when provided', () => {
      const sql = buildQuery(
        'executions',
        [{ name: 'total', sql: 'COUNT(*)' }],
        ['squad'],
        undefined,
        'total DESC',
        10
      );
      expect(sql).toBe('SELECT squad, COUNT(*) AS total FROM executions GROUP BY squad ORDER BY total DESC LIMIT 10');
    });

    it('combines all clauses correctly', () => {
      const sql = buildQuery(
        'agent_metrics',
        [
          { name: 'runs', sql: 'SUM(run_count)' },
          { name: 'errors', sql: 'SUM(error_count)' },
        ],
        ['agent_name', 'date'],
        "date >= '2026-01-01'",
        'date DESC, runs DESC',
        50
      );
      expect(sql).toBe(
        "SELECT agent_name, date, SUM(run_count) AS runs, SUM(error_count) AS errors " +
        "FROM agent_metrics WHERE date >= '2026-01-01' GROUP BY agent_name, date ORDER BY date DESC, runs DESC LIMIT 50"
      );
    });

    it('handles empty group by array', () => {
      const sql = buildQuery(
        'executions',
        [{ name: 'total', sql: 'COUNT(*)' }],
        []
      );
      expect(sql).toBe('SELECT COUNT(*) AS total FROM executions');
    });

    it('handles complex SQL expressions in metrics', () => {
      const sql = buildQuery(
        'costs',
        [
          { name: 'total_cost', sql: 'SUM(input_tokens * input_cost + output_tokens * output_cost)' },
          { name: 'avg_tokens', sql: 'AVG(input_tokens + output_tokens)' },
        ]
      );
      expect(sql).toBe(
        'SELECT SUM(input_tokens * input_cost + output_tokens * output_cost) AS total_cost, ' +
        'AVG(input_tokens + output_tokens) AS avg_tokens FROM costs'
      );
    });

    it('handles table names with schema prefix', () => {
      const sql = buildQuery(
        'squads.executions',
        [{ name: 'count', sql: 'COUNT(*)' }]
      );
      expect(sql).toBe('SELECT COUNT(*) AS count FROM squads.executions');
    });
  });

  describe('buildWhereClause', () => {
    it('returns null when no filters provided', () => {
      const result = buildWhereClause({}, []);
      expect(result).toBeNull();
    });

    it('returns null when filters have undefined/null values', () => {
      const result = buildWhereClause(
        { status: undefined, squad: null },
        [
          { name: 'status', type: 'select' },
          { name: 'squad', type: 'select' },
        ]
      );
      expect(result).toBeNull();
    });

    it('returns null when filter values do not have definitions', () => {
      const result = buildWhereClause(
        { unknown_filter: 'value' },
        [{ name: 'status', type: 'select' }]
      );
      expect(result).toBeNull();
    });

    it('builds date_range condition with start date', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const result = buildWhereClause(
        { period: { start } },
        [{ name: 'period', field: 'created_at', type: 'date_range' }]
      );
      expect(result).toBe(`created_at >= '${start.toISOString()}'`);
    });

    it('builds date_range condition with end date', () => {
      const end = new Date('2026-01-31T23:59:59Z');
      const result = buildWhereClause(
        { period: { end } },
        [{ name: 'period', field: 'created_at', type: 'date_range' }]
      );
      expect(result).toBe(`created_at <= '${end.toISOString()}'`);
    });

    it('builds date_range condition with both start and end', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const end = new Date('2026-01-31T23:59:59Z');
      const result = buildWhereClause(
        { period: { start, end } },
        [{ name: 'period', field: 'created_at', type: 'date_range' }]
      );
      expect(result).toBe(
        `created_at >= '${start.toISOString()}' AND created_at <= '${end.toISOString()}'`
      );
    });

    it('builds select condition with single value array', () => {
      const result = buildWhereClause(
        { status: ['completed'] },
        [{ name: 'status', type: 'select' }]
      );
      expect(result).toBe("status IN ('completed')");
    });

    it('builds select condition with multiple values', () => {
      const result = buildWhereClause(
        { status: ['completed', 'failed', 'running'] },
        [{ name: 'status', type: 'select' }]
      );
      expect(result).toBe("status IN ('completed', 'failed', 'running')");
    });

    it('escapes single quotes in select values', () => {
      const result = buildWhereClause(
        { name: ["O'Connor", "Test's Value"] },
        [{ name: 'name', type: 'select' }]
      );
      expect(result).toBe("name IN ('O''Connor', 'Test''s Value')");
    });

    it('skips select condition when array is empty', () => {
      const result = buildWhereClause(
        { status: [] },
        [{ name: 'status', type: 'select' }]
      );
      expect(result).toBeNull();
    });

    it('builds boolean condition for true', () => {
      const result = buildWhereClause(
        { active: true },
        [{ name: 'active', type: 'boolean' }]
      );
      expect(result).toBe('active = true');
    });

    it('builds boolean condition for false', () => {
      const result = buildWhereClause(
        { active: false },
        [{ name: 'active', type: 'boolean' }]
      );
      expect(result).toBe('active = false');
    });

    it('builds text condition with ILIKE', () => {
      const result = buildWhereClause(
        { search: 'test' },
        [{ name: 'search', field: 'description', type: 'text' }]
      );
      expect(result).toBe("description ILIKE '%test%'");
    });

    it('escapes single quotes in text values', () => {
      const result = buildWhereClause(
        { search: "test's value" },
        [{ name: 'search', field: 'description', type: 'text' }]
      );
      expect(result).toBe("description ILIKE '%test''s value%'");
    });

    it('uses filter name as field when field is not specified', () => {
      const result = buildWhereClause(
        { squad: ['cli'] },
        [{ name: 'squad', type: 'select' }]
      );
      expect(result).toBe("squad IN ('cli')");
    });

    it('combines multiple conditions with AND', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const result = buildWhereClause(
        {
          period: { start },
          status: ['completed', 'failed'],
          active: true,
        },
        [
          { name: 'period', field: 'created_at', type: 'date_range' },
          { name: 'status', type: 'select' },
          { name: 'active', type: 'boolean' },
        ]
      );
      expect(result).toBe(
        `created_at >= '${start.toISOString()}' AND status IN ('completed', 'failed') AND active = true`
      );
    });

    it('handles date_range with non-object value gracefully', () => {
      const result = buildWhereClause(
        { period: 'invalid' },
        [{ name: 'period', field: 'created_at', type: 'date_range' }]
      );
      // Should skip this filter since value is not an object
      expect(result).toBeNull();
    });
  });

  describe('parseDateRange', () => {
    // Use fixed date for consistent testing
    const realDate = Date;
    const mockDate = new Date('2026-01-15T12:00:00Z');

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(mockDate);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('parses today preset', () => {
      const result = parseDateRange('today');

      expect(result.start.getFullYear()).toBe(2026);
      expect(result.start.getMonth()).toBe(0); // January
      expect(result.start.getDate()).toBe(15);
      expect(result.start.getHours()).toBe(0);
      expect(result.start.getMinutes()).toBe(0);
      expect(result.start.getSeconds()).toBe(0);

      expect(result.end.getFullYear()).toBe(2026);
      expect(result.end.getMonth()).toBe(0);
      expect(result.end.getDate()).toBe(15);
      expect(result.end.getHours()).toBe(23);
      expect(result.end.getMinutes()).toBe(59);
      expect(result.end.getSeconds()).toBe(59);
    });

    it('parses yesterday preset', () => {
      const result = parseDateRange('yesterday');

      expect(result.start.getDate()).toBe(14);
      expect(result.end.getDate()).toBe(14);
    });

    it('parses last_7d preset', () => {
      const result = parseDateRange('last_7d');

      expect(result.start.getDate()).toBe(8); // 15 - 7 = 8
      expect(result.end.getDate()).toBe(15);
    });

    it('parses last_30d preset', () => {
      const result = parseDateRange('last_30d');

      // 15 - 30 = -15, which wraps to December 16
      expect(result.start.getMonth()).toBe(11); // December
      expect(result.start.getDate()).toBe(16);
      expect(result.end.getDate()).toBe(15);
    });

    it('parses this_month preset', () => {
      const result = parseDateRange('this_month');

      expect(result.start.getDate()).toBe(1);
      expect(result.start.getMonth()).toBe(0); // January
      expect(result.end.getDate()).toBe(15);
    });

    it('parses last_month preset', () => {
      const result = parseDateRange('last_month');

      expect(result.start.getMonth()).toBe(11); // December
      expect(result.start.getDate()).toBe(1);
      expect(result.end.getMonth()).toBe(11); // December
      expect(result.end.getDate()).toBe(31); // Last day of December
    });

    it('parses this_quarter preset for Q1', () => {
      const result = parseDateRange('this_quarter');

      expect(result.start.getMonth()).toBe(0); // January (Q1 starts)
      expect(result.start.getDate()).toBe(1);
      expect(result.end.getDate()).toBe(15);
    });

    it('parses this_quarter preset for Q2', () => {
      vi.setSystemTime(new Date('2026-05-15T12:00:00Z'));
      const result = parseDateRange('this_quarter');

      expect(result.start.getMonth()).toBe(3); // April (Q2 starts)
      expect(result.start.getDate()).toBe(1);
    });

    it('parses this_quarter preset for Q3', () => {
      vi.setSystemTime(new Date('2026-08-15T12:00:00Z'));
      const result = parseDateRange('this_quarter');

      expect(result.start.getMonth()).toBe(6); // July (Q3 starts)
      expect(result.start.getDate()).toBe(1);
    });

    it('parses this_quarter preset for Q4', () => {
      vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
      const result = parseDateRange('this_quarter');

      expect(result.start.getMonth()).toBe(9); // October (Q4 starts)
      expect(result.start.getDate()).toBe(1);
    });

    it('defaults to last_7d for unknown preset', () => {
      const result = parseDateRange('unknown_preset');

      expect(result.start.getDate()).toBe(8); // Same as last_7d
      expect(result.end.getDate()).toBe(15);
    });

    it('returns Date objects', () => {
      const result = parseDateRange('today');

      expect(result.start).toBeInstanceOf(Date);
      expect(result.end).toBeInstanceOf(Date);
    });

    it('sets milliseconds correctly for start of day', () => {
      const result = parseDateRange('today');
      expect(result.start.getMilliseconds()).toBe(0);
    });

    it('sets milliseconds correctly for end of day', () => {
      const result = parseDateRange('today');
      expect(result.end.getMilliseconds()).toBe(999);
    });
  });
});
