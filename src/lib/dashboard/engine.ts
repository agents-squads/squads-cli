/**
 * Dashboard Engine
 * Orchestrates loading definitions, fetching data, and rendering views
 */

import type {
  DashboardDefinition,
  ViewDefinition,
  QueryResult,
  AppliedFilters,
  DataSource,
} from './types.js';
import { loadDashboard, listDashboards, findDashboard } from './loader.js';
import { postgresSource, buildQuery, buildWhereClause, parseDateRange } from './sources/postgres.js';
import { renderView, writeLine, colors, bold, RESET, gradient } from './renderers/index.js';

export { loadDashboard, listDashboards, findDashboard } from './loader.js';
export * from './types.js';

/**
 * Get the appropriate data source for a dashboard
 */
function getDataSource(sourceName: string): DataSource | null {
  switch (sourceName) {
    case 'postgres':
      return postgresSource;
    // TODO: Add other sources
    case 'sessions':
    case 'langfuse':
    case 'api':
      return null;
    default:
      return null;
  }
}

/**
 * Execute a dashboard and return rendered output
 */
export async function executeDashboard(
  name: string,
  options: {
    filters?: AppliedFilters;
    views?: string[];  // Specific views to render (default: all)
    verbose?: boolean;
  } = {}
): Promise<{ success: boolean; lines: string[] }> {
  const lines: string[] = [];

  // Load definition
  const def = findDashboard(name);
  if (!def) {
    return {
      success: false,
      lines: [`${colors.red}Dashboard not found: ${name}${RESET}`],
    };
  }

  // Get data source
  const source = getDataSource(def.source);
  if (!source) {
    return {
      success: false,
      lines: [`${colors.red}Data source not available: ${def.source}${RESET}`],
    };
  }

  // Check availability
  const available = await source.isAvailable();
  if (!available) {
    return {
      success: false,
      lines: [`${colors.red}Cannot connect to ${def.source}${RESET}`],
    };
  }

  // Apply default filters
  const filters = { ...options.filters };
  for (const filterDef of def.filters || []) {
    if (filters[filterDef.name] === undefined && filterDef.default) {
      if (filterDef.type === 'date_range') {
        filters[filterDef.name] = parseDateRange(filterDef.default as string);
      } else {
        filters[filterDef.name] = filterDef.default;
      }
    }
  }

  // Header
  lines.push('');
  lines.push(`  ${gradient('squads')} ${colors.dim}${def.title}${RESET}`);
  if (def.description && options.verbose) {
    lines.push(`  ${colors.dim}${def.description}${RESET}`);
  }
  lines.push('');

  // Determine which views to render
  const viewsToRender = options.views
    ? def.views.filter(v => options.views!.includes(v.id))
    : def.views;

  // Execute each view
  for (const view of viewsToRender) {
    try {
      const data = await fetchViewData(def, view, filters, source);
      const viewLines = renderView(view, data, def.metrics, def.dimensions || []);
      lines.push(...viewLines);
      lines.push('');
    } catch (err) {
      if (options.verbose) {
        lines.push(`  ${colors.red}Error rendering ${view.id}: ${err}${RESET}`);
      }
    }
  }

  // Cleanup
  await source.close();

  return { success: true, lines };
}

/**
 * Fetch data for a specific view
 */
async function fetchViewData(
  def: DashboardDefinition,
  view: ViewDefinition,
  filters: AppliedFilters,
  source: DataSource
): Promise<QueryResult> {
  // If view has custom source SQL, use it directly
  if (view.source) {
    return source.query(view.source);
  }

  // Build query from definition
  if (!def.table) {
    throw new Error('Dashboard requires table or view.source');
  }

  // Get metrics for this view
  const metrics = (view.metrics || []).map(name => {
    const m = def.metrics.find(m => m.name === name);
    if (!m) throw new Error(`Unknown metric: ${name}`);
    return m;
  });

  // Build WHERE clause
  const filterDefs = def.filters || [];
  let where = buildWhereClause(filters, filterDefs);

  // Add view-specific filter
  if (view.filter) {
    where = where ? `(${where}) AND (${view.filter})` : view.filter;
  }

  // Build and execute query
  const sql = buildQuery(
    def.table,
    metrics,
    view.group_by,
    where ?? undefined,
    view.sort,
    view.limit
  );

  return source.query(sql);
}

/**
 * Render a dashboard to the terminal
 */
export async function renderDashboard(
  name: string,
  options: {
    filters?: AppliedFilters;
    views?: string[];
    verbose?: boolean;
  } = {}
): Promise<boolean> {
  const result = await executeDashboard(name, options);

  for (const line of result.lines) {
    writeLine(line);
  }

  return result.success;
}

/**
 * List all available dashboards with descriptions
 */
export function showAvailableDashboards(): void {
  const names = listDashboards();

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}dashboards${RESET}`);
  writeLine();

  if (names.length === 0) {
    writeLine(`  ${colors.dim}No dashboards found${RESET}`);
    writeLine(`  ${colors.dim}Create dashboards in .agents/dashboards/*.yaml${RESET}`);
    writeLine();
    return;
  }

  for (const name of names) {
    const def = loadDashboard(name);
    if (def) {
      writeLine(`  ${colors.cyan}${name.padEnd(16)}${RESET} ${colors.dim}${def.title}${RESET}`);
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}Usage:${RESET} squads dash ${colors.cyan}<dashboard>${RESET}`);
  writeLine(`  ${colors.dim}       squads dash ${colors.cyan}<dashboard>${RESET} ${colors.dim}--view=<view-id>${RESET}`);
  writeLine();
}

/**
 * Interactive dashboard with filter support
 */
export async function interactiveDashboard(
  name: string,
  initialFilters?: AppliedFilters
): Promise<void> {
  // For now, just render the dashboard
  // TODO: Add interactive filter selection
  await renderDashboard(name, { filters: initialFilters });
}
