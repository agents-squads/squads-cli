/**
 * Dashboard renderer tests — pure data-in, lines-out. No mocks needed.
 */
import { describe, it, expect } from 'vitest';
import type { ViewDefinition, MetricDefinition, DimensionDefinition, QueryResult } from '../../src/lib/dashboard/types.js';
import { renderView } from '../../src/lib/dashboard/renderers/index.js';
import { formatValue, calculateColumnWidths } from '../../src/lib/dashboard/renderers/base.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const metrics: MetricDefinition[] = [
  { name: 'cost', sql: 'SUM(cost)', format: 'currency', label: 'Cost' },
  { name: 'runs', sql: 'COUNT(*)', format: 'number', label: 'Runs' },
  { name: 'dur', sql: 'AVG(dur)', format: 'duration', label: 'Duration' },
  { name: 'rate', sql: 'AVG(ok)', format: 'percent', label: 'Success' },
  { name: 'tok', sql: 'SUM(tok)', format: 'tokens', label: 'Tokens' },
];
const dims: DimensionDefinition[] = [
  { name: 'squad', sql: 'squad_name', type: 'string', label: 'Squad' },
];

describe('formatValue', () => {
  it('formats currency', () => expect(strip(formatValue(42.5, 'currency'))).toBe('$42.50'));
  it('formats large numbers', () => {
    expect(strip(formatValue(1500, 'number'))).toContain('1.5k');
    expect(strip(formatValue(2_500_000, 'number'))).toContain('2.5M');
  });
  it('formats percent', () => expect(strip(formatValue(85.3, 'percent'))).toBe('85.3%'));
  it('formats short duration', () => expect(strip(formatValue(45.2, 'duration'))).toBe('45.2s'));
  it('formats minute duration', () => expect(strip(formatValue(125, 'duration'))).toContain('2m'));
  it('formats tokens', () => expect(strip(formatValue(150_000, 'tokens'))).toContain('150k'));
  it('handles null', () => expect(strip(formatValue(null, 'number'))).toContain('—'));
  it('formats status badge', () => expect(strip(formatValue('success', 'status_badge'))).toBe('success'));
});

describe('calculateColumnWidths', () => {
  it('respects header and data lengths', () => {
    const rows = [{ name: 'engineering', n: 42 }, { name: 'mkt', n: 7 }];
    const cols = [{ field: 'name', label: 'Squad' }, { field: 'n', label: 'Runs' }];
    const w = calculateColumnWidths(rows, cols);
    expect(w[0]).toBeGreaterThanOrEqual('engineering'.length);
  });

  it('scales down when exceeding maxWidth', () => {
    const rows = [{ a: 'x'.repeat(50), b: 'y'.repeat(50) }];
    const cols = [{ field: 'a', label: 'A' }, { field: 'b', label: 'B' }];
    expect(calculateColumnWidths(rows, cols, 40).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(40);
  });
});

describe('renderView: summary', () => {
  it('renders metrics in one row', () => {
    const view: ViewDefinition = { id: 'kpi', type: 'summary', metrics: ['cost', 'runs'] };
    const data: QueryResult = { rows: [{ cost: 12.5, runs: 150 }], columns: ['cost', 'runs'] };
    const text = renderView(view, data, metrics, dims).map(strip).join(' ');
    expect(text).toContain('$12.50');
    expect(text).toContain('150');
  });

  it('handles missing row data', () => {
    const view: ViewDefinition = { id: 'kpi', type: 'summary', metrics: ['cost'] };
    const data: QueryResult = { rows: [{}], columns: [] };
    expect(renderView(view, data, metrics, []).length).toBeGreaterThanOrEqual(1);
  });
});

describe('renderView: table', () => {
  it('renders header and rows', () => {
    const view: ViewDefinition = { id: 't', type: 'table', title: 'Perf', group_by: ['squad'], metrics: ['runs'] };
    const data: QueryResult = { rows: [{ squad: 'eng', runs: 42 }, { squad: 'mkt', runs: 15 }], columns: ['squad', 'runs'] };
    const text = renderView(view, data, metrics, dims).map(strip).join('\n');
    expect(text).toContain('Perf');
    expect(text).toContain('SQUAD');
    expect(text).toContain('eng');
    expect(text).toContain('mkt');
  });

  it('shows "No data" for empty result', () => {
    const view: ViewDefinition = { id: 'e', type: 'table', metrics: ['runs'] };
    expect(renderView(view, { rows: [], columns: [] }, metrics, dims).map(strip).join(' ')).toContain('No data');
  });
});

describe('renderView: bar', () => {
  it('renders bars', () => {
    const view: ViewDefinition = { id: 'b', type: 'bar', title: 'By Squad', group_by: ['squad'], metrics: ['runs'] };
    const data: QueryResult = { rows: [{ squad: 'eng', runs: 30 }, { squad: 'mkt', runs: 10 }], columns: [] };
    const text = renderView(view, data, metrics, dims).map(strip).join('\n');
    expect(text).toContain('By Squad');
    expect(text).toContain('eng');
  });
});

describe('renderView: list', () => {
  it('renders items', () => {
    const view: ViewDefinition = { id: 'l', type: 'list', title: 'Recent', columns: [{ field: 'name' }, { field: 'status' }] };
    const data: QueryResult = { rows: [{ name: 'deploy', status: 'ok' }], columns: ['name', 'status'] };
    const text = renderView(view, data, [], []).map(strip).join('\n');
    expect(text).toContain('deploy');
  });
});

describe('renderView: unknown type', () => {
  it('returns not-implemented message', () => {
    const lines = renderView({ id: 'x', type: 'heatmap' }, { rows: [], columns: [] }, [], []);
    expect(lines.map(strip).join(' ')).toContain('not yet implemented');
  });
});
