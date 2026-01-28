/**
 * Renderer Index
 * Exports all renderers and provides a unified render function
 */

import type { ViewDefinition, MetricDefinition, DimensionDefinition, QueryResult } from '../types.js';
import { renderSummary } from './summary.js';
import { renderTable } from './table.js';
import { renderTrend, renderStackedTrend } from './trend.js';
import { renderBar, renderPie } from './bar.js';
import { renderList, renderRecentList } from './list.js';
import { colors, RESET } from './base.js';

export * from './base.js';

/**
 * Render a view based on its type
 */
export function renderView(
  view: ViewDefinition,
  data: QueryResult,
  metricDefs: MetricDefinition[],
  dimensionDefs: DimensionDefinition[]
): string[] {
  switch (view.type) {
    case 'summary':
      return renderSummary(view, data, metricDefs);

    case 'table':
      return renderTable(view, data, metricDefs, dimensionDefs);

    case 'trend':
      if (view.stacked) {
        return renderStackedTrend(view, data, metricDefs);
      }
      return renderTrend(view, data, metricDefs);

    case 'bar':
      return renderBar(view, data, metricDefs, dimensionDefs);

    case 'pie':
      return renderPie(view, data, metricDefs, dimensionDefs);

    case 'list': {
      // Detect if this looks like a recent items list
      const hasTimeCol = view.columns?.some(c =>
        c.format === 'relative_time' || c.field.includes('_at')
      );
      if (hasTimeCol) {
        return renderRecentList(view, data);
      }
      return renderList(view, data);
    }

    case 'histogram':
      // TODO: Implement histogram
      return [`  ${colors.dim}Histogram not yet implemented${RESET}`];

    case 'heatmap':
      // TODO: Implement heatmap
      return [`  ${colors.dim}Heatmap not yet implemented${RESET}`];

    default:
      return [`  ${colors.dim}Unknown view type: ${view.type}${RESET}`];
  }
}
