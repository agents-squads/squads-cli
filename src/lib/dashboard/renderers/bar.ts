/**
 * Bar Chart Renderer
 * Renders horizontal bar charts
 */

import type { ViewDefinition, MetricDefinition, DimensionDefinition, QueryResult } from '../types.js';
import { colors, bold, RESET, padEnd, formatValue, barChart } from './base.js';

export function renderBar(
  view: ViewDefinition,
  data: QueryResult,
  metricDefs: MetricDefinition[],
  _dimensionDefs: DimensionDefinition[]
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

  // Get the primary dimension and metric
  const dimName = view.group_by?.[0];
  const metricName = view.metrics?.[0];

  if (!dimName || !metricName) {
    lines.push(`  ${colors.dim}Bar chart requires group_by and metrics${RESET}`);
    return lines;
  }

  const metricDef = metricDefs.find(m => m.name === metricName);

  // Find max value for scaling
  const values = data.rows.map(row => {
    const val = row[metricName];
    return typeof val === 'number' ? val : parseFloat(String(val)) || 0;
  });
  const maxValue = Math.max(...values, 1);

  // Calculate label width
  const labels = data.rows.map(row => String(row[dimName] || 'Unknown'));
  const maxLabelWidth = Math.min(Math.max(...labels.map(l => l.length)), 20);

  // Render bars
  for (const row of data.rows) {
    const label = String(row[dimName] || 'Unknown');
    const value = row[metricName];
    const numValue = typeof value === 'number' ? value : parseFloat(String(value)) || 0;

    const bar = barChart(numValue, maxValue, 20);
    const formatted = formatValue(value, metricDef?.format || 'number');

    lines.push(`  ${colors.cyan}${padEnd(label.slice(0, maxLabelWidth), maxLabelWidth + 1)}${RESET}${bar} ${colors.dim}${formatted}${RESET}`);
  }

  return lines;
}

/**
 * Render a pie chart as a horizontal distribution
 */
export function renderPie(
  view: ViewDefinition,
  data: QueryResult,
  _metricDefs: MetricDefinition[],
  _dimensionDefs: DimensionDefinition[]
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

  // Get dimension and metric
  const dimName = view.group_by?.[0];
  const metricName = view.metrics?.[0];

  if (!dimName || !metricName) {
    lines.push(`  ${colors.dim}Pie chart requires group_by and metrics${RESET}`);
    return lines;
  }

  // Calculate total and percentages
  const values = data.rows.map(row => {
    const val = row[metricName];
    return {
      label: String(row[dimName] || 'Unknown'),
      value: typeof val === 'number' ? val : parseFloat(String(val)) || 0,
    };
  });

  const total = values.reduce((sum, v) => sum + v.value, 0);
  if (total === 0) {
    lines.push(`  ${colors.dim}No data${RESET}`);
    return lines;
  }

  // Color palette
  const colorPalette = [colors.cyan, colors.green, colors.yellow, colors.purple, colors.red];

  // Render horizontal bar showing distribution
  const barWidth = 40;
  let barStr = '';
  let pos = 0;

  for (let i = 0; i < values.length; i++) {
    const pct = values[i].value / total;
    const width = Math.max(1, Math.round(pct * barWidth));
    const color = colorPalette[i % colorPalette.length];
    barStr += `${color}${'█'.repeat(width)}${RESET}`;
    pos += width;
  }

  // Pad to full width if needed
  if (pos < barWidth) {
    barStr += `${colors.dim}${'░'.repeat(barWidth - pos)}${RESET}`;
  }

  lines.push(`  ${barStr}`);
  lines.push('');

  // Legend
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const pct = (v.value / total) * 100;
    const color = colorPalette[i % colorPalette.length];

    lines.push(`  ${color}■${RESET} ${padEnd(v.label.slice(0, 15), 16)} ${color}${pct.toFixed(1)}%${RESET} ${colors.dim}(${v.value.toLocaleString()})${RESET}`);
  }

  return lines;
}
