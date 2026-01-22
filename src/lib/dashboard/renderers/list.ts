/**
 * List Renderer
 * Renders data as a list of items
 */

import type { ViewDefinition, QueryResult, ColumnDefinition } from '../types.js';
import { colors, bold, RESET, padEnd, truncate, formatValue } from './base.js';

export function renderList(
  view: ViewDefinition,
  data: QueryResult
): string[] {
  const lines: string[] = [];

  if (data.rows.length === 0) {
    lines.push(`  ${colors.dim}No data${RESET}`);
    return lines;
  }

  // Title
  if (view.title) {
    lines.push(`  ${bold}${view.title}${RESET}`);
    lines.push('');
  }

  // Get columns from view definition or infer from data
  const columns: ColumnDefinition[] = view.columns || data.columns.map(c => ({ field: c }));

  // Render each row
  for (const row of data.rows) {
    const parts: string[] = [];

    for (const col of columns) {
      const value = row[col.field];
      let formatted = formatValue(value, col.format || 'string', col.truncate);

      // Apply label if this is the first column and we have a label defined
      if (col.label) {
        formatted = `${colors.dim}${col.label}:${RESET} ${formatted}`;
      }

      parts.push(formatted);
    }

    // Join with spacing
    lines.push(`  ${parts.join('  ')}`);
  }

  return lines;
}

/**
 * Render list with detailed multi-line items
 */
export function renderDetailedList(
  view: ViewDefinition,
  data: QueryResult
): string[] {
  const lines: string[] = [];

  if (data.rows.length === 0) {
    lines.push(`  ${colors.dim}No data${RESET}`);
    return lines;
  }

  // Title
  if (view.title) {
    lines.push(`  ${bold}${view.title}${RESET}`);
    lines.push('');
  }

  const columns: ColumnDefinition[] = view.columns || data.columns.map(c => ({ field: c }));

  // Render each row as a multi-line block
  for (let i = 0; i < data.rows.length; i++) {
    const row = data.rows[i];

    // First column as header
    if (columns.length > 0) {
      const mainCol = columns[0];
      const mainValue = formatValue(row[mainCol.field], mainCol.format || 'string');
      lines.push(`  ${colors.cyan}${mainValue}${RESET}`);
    }

    // Remaining columns as details
    for (let j = 1; j < columns.length; j++) {
      const col = columns[j];
      const value = formatValue(row[col.field], col.format || 'string', col.truncate || 50);
      const label = col.label || col.field;
      lines.push(`    ${colors.dim}${label}:${RESET} ${value}`);
    }

    // Add spacing between items
    if (i < data.rows.length - 1) {
      lines.push('');
    }
  }

  return lines;
}

/**
 * Render recent items with time-based header
 */
export function renderRecentList(
  view: ViewDefinition,
  data: QueryResult
): string[] {
  const lines: string[] = [];

  if (data.rows.length === 0) {
    lines.push(`  ${colors.dim}No recent items${RESET}`);
    return lines;
  }

  // Title
  if (view.title) {
    lines.push(`  ${bold}${view.title}${RESET}`);
    lines.push('');
  }

  const columns = view.columns || [];

  // Find time column
  const timeCol = columns.find(c => c.format === 'relative_time' || c.field.includes('_at'));

  // Render each row
  for (const row of data.rows) {
    const parts: string[] = [];

    // Time first if present
    if (timeCol) {
      const timeVal = formatValue(row[timeCol.field], 'relative_time');
      parts.push(`${colors.dim}${timeVal}${RESET}`);
    }

    // Other columns
    for (const col of columns) {
      if (col === timeCol) continue;

      const value = row[col.field];
      const formatted = formatValue(value, col.format || 'string', col.truncate);
      parts.push(formatted);
    }

    lines.push(`  ${parts.join('  ')}`);
  }

  return lines;
}
