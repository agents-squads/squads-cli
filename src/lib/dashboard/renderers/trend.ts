/**
 * Trend Renderer
 * Renders time-series data as sparklines
 */

import type { ViewDefinition, MetricDefinition, QueryResult } from '../types.js';
import { colors, bold, RESET, formatValue, sparkline } from './base.js';

export function renderTrend(
  view: ViewDefinition,
  data: QueryResult,
  metricDefs: MetricDefinition[]
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

  // Render each metric as a sparkline
  for (const metricName of view.metrics || []) {
    const def = metricDefs.find(m => m.name === metricName);
    if (!def) continue;

    // Extract values for sparkline (reversed if data is desc order)
    const values = data.rows.map(row => {
      const val = row[metricName];
      return typeof val === 'number' ? val : parseFloat(String(val)) || 0;
    });

    // Reverse if needed (assume data comes newest first)
    const orderedValues = [...values].reverse();

    // Calculate summary stats
    const total = orderedValues.reduce((sum, v) => sum + v, 0);
    const avg = orderedValues.length > 0 ? total / orderedValues.length : 0;
    const latest = orderedValues[orderedValues.length - 1] || 0;
    const previous = orderedValues[orderedValues.length - 2] || 0;
    const change = previous > 0 ? ((latest - previous) / previous) * 100 : 0;

    // Render sparkline
    const spark = sparkline(orderedValues);

    // Format the summary
    const label = def.label || metricName;
    const totalFormatted = formatValue(total, def.format);
    const avgFormatted = formatValue(avg, def.format);

    // Change indicator
    const changeColor = change > 0 ? colors.green : change < 0 ? colors.red : colors.dim;
    const changeSign = change > 0 ? '+' : '';
    const changeStr = `${changeColor}${changeSign}${change.toFixed(0)}%${RESET}`;

    lines.push(`  ${colors.dim}${label}:${RESET} ${spark}  ${colors.cyan}${totalFormatted}${RESET} total  ${colors.dim}(avg ${avgFormatted})${RESET}  ${changeStr}`);
  }

  return lines;
}

/**
 * Render stacked trend (multiple metrics on same chart)
 */
export function renderStackedTrend(
  view: ViewDefinition,
  data: QueryResult,
  metricDefs: MetricDefinition[]
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

  // Build combined sparkline (showing first metric for the visual)
  const primaryMetric = view.metrics?.[0];
  if (primaryMetric) {
    const values = data.rows.map(row => {
      const val = row[primaryMetric];
      return typeof val === 'number' ? val : parseFloat(String(val)) || 0;
    }).reverse();

    const spark = sparkline(values);
    lines.push(`  ${spark}`);
    lines.push('');
  }

  // Show legend with totals
  const legendParts: string[] = [];
  for (const metricName of view.metrics || []) {
    const def = metricDefs.find(m => m.name === metricName);
    if (!def) continue;

    const total = data.rows.reduce((sum, row) => {
      const val = row[metricName];
      return sum + (typeof val === 'number' ? val : parseFloat(String(val)) || 0);
    }, 0);

    const label = def.label || metricName;
    const formatted = formatValue(total, def.format);

    // Color code by metric position
    const metricColor = metricName === view.metrics?.[0] ? colors.green :
                        metricName === view.metrics?.[1] ? colors.yellow :
                        colors.red;

    legendParts.push(`${metricColor}${formatted}${RESET} ${colors.dim}${label}${RESET}`);
  }

  lines.push(`  ${legendParts.join('  ')}`);

  return lines;
}
