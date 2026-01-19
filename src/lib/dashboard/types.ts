/**
 * Dashboard Definition Types
 * Defines the structure of YAML dashboard definitions
 */

export interface DashboardDefinition {
  name: string;
  title: string;
  description?: string;
  source: 'postgres' | 'sessions' | 'langfuse' | 'api';
  table?: string;  // For postgres source

  metrics: MetricDefinition[];
  dimensions: DimensionDefinition[];
  filters?: FilterDefinition[];
  views: ViewDefinition[];
  drills?: DrillDefinition[];
  alerts?: AlertDefinition[];

  // Detail view for single record
  detail?: DetailDefinition;
}

export interface MetricDefinition {
  name: string;
  sql: string;
  format: 'number' | 'currency' | 'percent' | 'duration' | 'tokens';
  label?: string;
}

export interface DimensionDefinition {
  name: string;
  sql: string;
  type: 'string' | 'time' | 'number';
  label?: string;
  grain?: 'day' | 'hour' | 'week' | 'month';  // For time dimensions
}

export interface FilterDefinition {
  name: string;
  type: 'date_range' | 'select' | 'text' | 'number_range' | 'boolean';
  field?: string;
  label?: string;
  default?: string | string[];
  options?: string[];
  source?: string;  // SQL for dynamic options
  multiple?: boolean;
}

export interface ViewDefinition {
  id: string;
  type: 'summary' | 'table' | 'trend' | 'bar' | 'pie' | 'list' | 'histogram' | 'heatmap';
  title?: string;
  metrics?: string[];
  group_by?: string[];
  columns?: ColumnDefinition[];
  filter?: string;  // Additional WHERE clause
  sort?: string;
  limit?: number;
  source?: string;  // Custom SQL override
  stacked?: boolean;
  fill_gaps?: boolean;

  // For histogram
  field?: string;
  buckets?: number;

  // For heatmap
  x_axis?: string;
  y_axis?: string;
  value?: string;
}

export interface ColumnDefinition {
  field: string;
  label?: string;
  format?: 'number' | 'currency' | 'percent' | 'duration' | 'tokens' |
           'relative_time' | 'relative_date' | 'status_badge' | 'progress_bar';
  truncate?: number;
}

export interface DrillDefinition {
  from: string;  // View ID
  to: string;    // View ID or dashboard name
  filter: string | string[];
  param?: string;  // URL param name
}

export interface AlertDefinition {
  name: string;
  condition: string;  // SQL or expression
  filter?: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface DetailDefinition {
  title: string;
  param: string;
  query: string;
  sections: DetailSection[];
}

export interface DetailSection {
  type: 'header' | 'metrics' | 'json' | 'list';
  fields?: string[];
  field?: string;
  title?: string;
}

// Runtime data types

export interface QueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
}

export interface RenderedView {
  id: string;
  type: ViewDefinition['type'];
  title?: string;
  lines: string[];  // Pre-rendered terminal lines
}

export interface DashboardState {
  definition: DashboardDefinition;
  filters: Record<string, unknown>;
  data: Map<string, QueryResult>;
  views: RenderedView[];
}

// Data source interface
export interface DataSource {
  name: string;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  isAvailable(): Promise<boolean>;
  close(): Promise<void>;
}

// Filter values that can be applied
export interface AppliedFilters {
  date_range?: { start: Date; end: Date };
  [key: string]: unknown;
}
