/**
 * Base Renderer Utilities
 * Shared formatting and rendering functions
 */

import {
  colors,
  bold,
  RESET,
  box,
  padEnd,
  truncate,
  writeLine,
  progressBar,
  sparkline,
  barChart,
  gradient,
} from '../../terminal.js';

export { colors, bold, RESET, box, padEnd, truncate, writeLine, progressBar, sparkline, barChart, gradient };

/**
 * Format a value based on format type
 */
export function formatValue(
  value: unknown,
  format: string,
  truncateLen?: number
): string {
  if (value === null || value === undefined) {
    return `${colors.dim}—${RESET}`;
  }

  const strValue = String(value);

  switch (format) {
    case 'number':
      const num = typeof value === 'number' ? value : parseFloat(strValue);
      if (isNaN(num)) return strValue;
      if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
      if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
      return num.toLocaleString();

    case 'currency':
      const amount = typeof value === 'number' ? value : parseFloat(strValue);
      if (isNaN(amount)) return strValue;
      return `$${amount.toFixed(2)}`;

    case 'percent':
      const pct = typeof value === 'number' ? value : parseFloat(strValue);
      if (isNaN(pct)) return strValue;
      return `${pct.toFixed(1)}%`;

    case 'duration':
      const secs = typeof value === 'number' ? value : parseFloat(strValue);
      if (isNaN(secs)) return strValue;
      if (secs < 60) return `${secs.toFixed(1)}s`;
      if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
      return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;

    case 'tokens':
      const tokens = typeof value === 'number' ? value : parseInt(strValue, 10);
      if (isNaN(tokens)) return strValue;
      if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
      if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
      return tokens.toLocaleString();

    case 'relative_time':
      return formatRelativeTime(value);

    case 'relative_date':
      return formatRelativeDate(value);

    case 'status_badge':
      return formatStatusBadge(strValue);

    case 'progress_bar':
      const progress = typeof value === 'number' ? value : parseFloat(strValue);
      if (isNaN(progress)) return strValue;
      return progressBar(progress, 8);

    default:
      if (truncateLen && strValue.length > truncateLen) {
        return truncate(strValue, truncateLen);
      }
      return strValue;
  }
}

/**
 * Format relative time (e.g., "5 minutes ago")
 */
function formatRelativeTime(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (isNaN(date.getTime())) return String(value);

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Format relative date (e.g., "today", "yesterday", "5 days ago")
 */
function formatRelativeDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (isNaN(date.getTime())) return String(value);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return date.toLocaleDateString();
}

/**
 * Format status badge with color
 */
function formatStatusBadge(status: string): string {
  const lower = status.toLowerCase();

  switch (lower) {
    case 'success':
    case 'completed':
    case 'active':
      return `${colors.green}${status}${RESET}`;

    case 'failed':
    case 'error':
      return `${colors.red}${status}${RESET}`;

    case 'running':
    case 'pending':
    case 'in_progress':
      return `${colors.yellow}${status}${RESET}`;

    case 'timeout':
    case 'cancelled':
      return `${colors.dim}${status}${RESET}`;

    default:
      return status;
  }
}

/**
 * Get color based on value threshold
 */
export function getThresholdColor(
  value: number,
  thresholds: { good?: number; warning?: number; direction?: 'up' | 'down' }
): string {
  const { good = 80, warning = 50, direction = 'up' } = thresholds;

  if (direction === 'up') {
    if (value >= good) return colors.green;
    if (value >= warning) return colors.yellow;
    return colors.red;
  } else {
    if (value <= good) return colors.green;
    if (value <= warning) return colors.yellow;
    return colors.red;
  }
}

/**
 * Render a horizontal divider
 */
export function renderDivider(width: number = 50): void {
  writeLine(`  ${colors.dim}${box.horizontal.repeat(width)}${RESET}`);
}

/**
 * Render section header
 */
export function renderSectionHeader(title: string): void {
  writeLine();
  writeLine(`  ${bold}${title}${RESET}`);
  writeLine();
}

/**
 * Calculate column widths for table rendering
 */
export function calculateColumnWidths(
  rows: Record<string, unknown>[],
  columns: { field: string; label?: string }[],
  maxWidth: number = 80
): number[] {
  const widths = columns.map(col => {
    const headerLen = (col.label || col.field).length;
    const maxValueLen = rows.reduce((max, row) => {
      const val = String(row[col.field] ?? '');
      return Math.max(max, val.length);
    }, 0);
    return Math.min(Math.max(headerLen, maxValueLen) + 2, 30);
  });

  // Scale down if total exceeds maxWidth
  const totalWidth = widths.reduce((sum, w) => sum + w, 0);
  if (totalWidth > maxWidth) {
    const scale = maxWidth / totalWidth;
    return widths.map(w => Math.max(Math.floor(w * scale), 5));
  }

  return widths;
}
