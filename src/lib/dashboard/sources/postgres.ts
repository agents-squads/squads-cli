/**
 * PostgreSQL Data Source
 * Executes queries against the squads schema
 */

import { createRequire } from 'module';
import type { DataSource, QueryResult } from '../types.js';

const require = createRequire(import.meta.url);
const pg = require('pg');
const { Pool } = pg;

const DATABASE_URL = process.env.SQUADS_DATABASE_URL ||
  'postgresql://user:password@localhost:5432/squads';

let pool: InstanceType<typeof Pool> | null = null;

function getPool(): InstanceType<typeof Pool> {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    pool.on('error', (err: Error) => {
      if (process.env.DEBUG) {
        console.error('Database pool error:', err);
      }
    });
  }
  return pool;
}

export const postgresSource: DataSource = {
  name: 'postgres',

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const client = await getPool().connect();
    try {
      const result = await client.query(sql, params);
      return {
        rows: result.rows,
        columns: result.fields?.map((f: { name: string }) => f.name) || [],
      };
    } finally {
      client.release();
    }
  },

  async isAvailable(): Promise<boolean> {
    try {
      const client = await getPool().connect();
      await client.query('SELECT 1');
      client.release();
      return true;
    } catch {
      return false;
    }
  },

  async close(): Promise<void> {
    if (pool) {
      await pool.end();
      pool = null;
    }
  },
};

/**
 * Build a SELECT query from dashboard definition
 */
export function buildQuery(
  table: string,
  metrics: { name: string; sql: string }[],
  groupBy?: string[],
  where?: string,
  orderBy?: string,
  limit?: number
): string {
  const selectParts: string[] = [];

  // Add group by columns first
  if (groupBy && groupBy.length > 0) {
    for (const col of groupBy) {
      selectParts.push(col);
    }
  }

  // Add metrics
  for (const metric of metrics) {
    selectParts.push(`${metric.sql} AS ${metric.name}`);
  }

  let sql = `SELECT ${selectParts.join(', ')} FROM ${table}`;

  if (where) {
    sql += ` WHERE ${where}`;
  }

  if (groupBy && groupBy.length > 0) {
    sql += ` GROUP BY ${groupBy.join(', ')}`;
  }

  if (orderBy) {
    sql += ` ORDER BY ${orderBy}`;
  }

  if (limit) {
    sql += ` LIMIT ${limit}`;
  }

  return sql;
}

/**
 * Build WHERE clause from filters
 */
export function buildWhereClause(
  filters: Record<string, unknown>,
  filterDefs: { name: string; field?: string; type: string }[]
): string | null {
  const conditions: string[] = [];

  for (const [name, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;

    const def = filterDefs.find(f => f.name === name);
    if (!def) continue;

    const field = def.field || name;

    if (def.type === 'date_range' && typeof value === 'object') {
      const range = value as { start?: Date; end?: Date };
      if (range.start) {
        conditions.push(`${field} >= '${range.start.toISOString()}'`);
      }
      if (range.end) {
        conditions.push(`${field} <= '${range.end.toISOString()}'`);
      }
    } else if (def.type === 'select' && Array.isArray(value)) {
      if (value.length > 0) {
        const escaped = value.map(v => `'${String(v).replace(/'/g, "''")}'`);
        conditions.push(`${field} IN (${escaped.join(', ')})`);
      }
    } else if (def.type === 'boolean') {
      conditions.push(`${field} = ${value ? 'true' : 'false'}`);
    } else if (def.type === 'text') {
      conditions.push(`${field} ILIKE '%${String(value).replace(/'/g, "''")}%'`);
    }
  }

  return conditions.length > 0 ? conditions.join(' AND ') : null;
}

/**
 * Parse date range presets
 */
export function parseDateRange(preset: string): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  switch (preset) {
    case 'today':
      return { start, end };

    case 'yesterday':
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
      return { start, end };

    case 'last_7d':
      start.setDate(start.getDate() - 7);
      return { start, end };

    case 'last_30d':
      start.setDate(start.getDate() - 30);
      return { start, end };

    case 'this_month':
      start.setDate(1);
      return { start, end };

    case 'last_month':
      start.setMonth(start.getMonth() - 1);
      start.setDate(1);
      end.setDate(0); // Last day of previous month
      return { start, end };

    case 'this_quarter':
      const q = Math.floor(now.getMonth() / 3);
      start.setMonth(q * 3);
      start.setDate(1);
      return { start, end };

    default:
      // Default to last 7 days
      start.setDate(start.getDate() - 7);
      return { start, end };
  }
}
