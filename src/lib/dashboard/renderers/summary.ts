/**
 * Summary Renderer
 * Renders key metrics in a horizontal row
 */

import type { ViewDefinition, MetricDefinition, QueryResult } from '../types.js';
import { colors, bold, RESET, formatValue } from './base.js';

export function renderSummary(
  view: ViewDefinition,
  data: QueryResult,
  metricDefs: MetricDefinition[]
): string[] {
  const lines: string[] = [];
  const row = data.rows[0] || {};

  // Build metric display parts
  const parts: string[] = [];

  for (const metricName of view.metrics || []) {
    const def = metricDefs.find(m => m.name === metricName);
    if (!def) continue;

    const value = row[metricName];
    const formatted = formatValue(value, def.format);
    const label = def.label || metricName;

    // Color based on format
    const valueColor = def.format === 'currency' ? colors.green :
                       def.format === 'percent' ? colors.purple :
                       colors.cyan;

    parts.push(`${valueColor}${formatted}${RESET} ${colors.dim}${label}${RESET}`);
  }

  // Join with dividers
  const line = parts.join(`  ${colors.dim}|${RESET}  `);
  lines.push(`  ${line}`);

  return lines;
}

/**
 * Render summary as a boxed card
 */
export function renderSummaryBox(
  view: ViewDefinition,
  data: QueryResult,
  metricDefs: MetricDefinition[]
): string[] {
  const lines: string[] = [];
  const row = data.rows[0] || {};

  if (view.title) {
    lines.push(`  ${bold}${view.title}${RESET}`);
    lines.push('');
  }

  // Render each metric on its own line
  for (const metricName of view.metrics || []) {
    const def = metricDefs.find(m => m.name === metricName);
    if (!def) continue;

    const value = row[metricName];
    const formatted = formatValue(value, def.format);
    const label = def.label || metricName;

    const valueColor = def.format === 'currency' ? colors.green :
                       def.format === 'percent' ? colors.purple :
                       colors.cyan;

    lines.push(`  ${colors.dim}${label.padEnd(16)}${RESET} ${valueColor}${formatted}${RESET}`);
  }

  return lines;
}
