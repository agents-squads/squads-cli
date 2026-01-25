/**
 * Table Renderer
 * Renders data in a tabular format with borders
 */

import type { ViewDefinition, MetricDefinition, DimensionDefinition, QueryResult } from '../types.js';
import { colors, bold, RESET, box, padEnd, formatValue, calculateColumnWidths } from './base.js';

export function renderTable(
  view: ViewDefinition,
  data: QueryResult,
  metricDefs: MetricDefinition[],
  dimensionDefs: DimensionDefinition[]
): string[] {
  const lines: string[] = [];

  if (data.rows.length === 0) {
    lines.push(`  ${colors.dim}No data${RESET}`);
    return lines;
  }

  // Build column definitions
  const columns: { field: string; label: string; format?: string; width: number }[] = [];

  // Add group by columns first (dimensions)
  if (view.group_by) {
    for (const dimName of view.group_by) {
      const def = dimensionDefs.find(d => d.name === dimName);
      columns.push({
        field: dimName,
        label: def?.label || dimName,
        format: undefined,
        width: 0, // Will calculate
      });
    }
  }

  // Add metric columns
  if (view.metrics) {
    for (const metricName of view.metrics) {
      const def = metricDefs.find(m => m.name === metricName);
      columns.push({
        field: metricName,
        label: def?.label || metricName,
        format: def?.format,
        width: 0,
      });
    }
  }

  // Use explicit columns if provided
  if (view.columns && view.columns.length > 0) {
    columns.length = 0;
    for (const col of view.columns) {
      columns.push({
        field: col.field,
        label: col.label || col.field,
        format: col.format,
        width: 0,
      });
    }
  }

  // Calculate widths
  const widths = calculateColumnWidths(data.rows, columns, 70);
  columns.forEach((col, i) => col.width = widths[i]);

  // Calculate table width
  const tableWidth = columns.reduce((sum, col) => sum + col.width, 0) + columns.length + 1;

  // Title
  if (view.title) {
    lines.push(`  ${bold}${view.title}${RESET}`);
    lines.push('');
  }

  // Top border
  lines.push(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  // Header row
  let headerRow = `  ${colors.purple}${box.vertical}${RESET}`;
  for (const col of columns) {
    headerRow += ` ${bold}${padEnd(col.label.toUpperCase(), col.width - 1)}${RESET}`;
  }
  headerRow += `${colors.purple}${box.vertical}${RESET}`;
  lines.push(headerRow);

  // Header divider
  lines.push(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  // Data rows
  for (const row of data.rows) {
    let rowStr = `  ${colors.purple}${box.vertical}${RESET}`;
    for (const col of columns) {
      const value = row[col.field];
      const formatted = formatValue(value, col.format || 'string', col.width - 3);

      // Strip ANSI for padding calculation
      const visibleLen = formatted.replace(/\x1b\[[0-9;]*m/g, '').length;
      const padding = Math.max(0, col.width - 1 - visibleLen);

      rowStr += ` ${formatted}${' '.repeat(padding)}`;
    }
    rowStr += `${colors.purple}${box.vertical}${RESET}`;
    lines.push(rowStr);
  }

  // Bottom border
  lines.push(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);

  return lines;
}

/**
 * Render a simple table without borders
 */
export function renderSimpleTable(
  view: ViewDefinition,
  data: QueryResult,
  metricDefs: MetricDefinition[],
  dimensionDefs: DimensionDefinition[]
): string[] {
  const lines: string[] = [];

  if (data.rows.length === 0) {
    lines.push(`  ${colors.dim}No data${RESET}`);
    return lines;
  }

  // Build columns
  const columns: { field: string; label: string; format?: string }[] = [];

  if (view.group_by) {
    for (const dimName of view.group_by) {
      const def = dimensionDefs.find(d => d.name === dimName);
      columns.push({ field: dimName, label: def?.label || dimName });
    }
  }

  if (view.metrics) {
    for (const metricName of view.metrics) {
      const def = metricDefs.find(m => m.name === metricName);
      columns.push({ field: metricName, label: def?.label || metricName, format: def?.format });
    }
  }

  // Calculate widths
  const widths = calculateColumnWidths(data.rows, columns, 70);

  // Title
  if (view.title) {
    lines.push(`  ${bold}${view.title}${RESET}`);
    lines.push('');
  }

  // Header
  let header = '  ';
  for (let i = 0; i < columns.length; i++) {
    header += `${colors.dim}${padEnd(columns[i].label.toUpperCase(), widths[i])}${RESET}`;
  }
  lines.push(header);

  // Data rows
  for (const row of data.rows) {
    let rowStr = '  ';
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const value = row[col.field];
      const formatted = formatValue(value, col.format || 'string', widths[i] - 2);

      const visibleLen = formatted.replace(/\x1b\[[0-9;]*m/g, '').length;
      const padding = Math.max(0, widths[i] - visibleLen);

      rowStr += `${formatted}${' '.repeat(padding)}`;
    }
    lines.push(rowStr);
  }

  return lines;
}
