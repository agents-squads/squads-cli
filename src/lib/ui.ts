// High-level UI components for consistent squads branding
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  icons,
  writeLine,
} from './terminal.js';

// Version from package.json (injected at build time or read dynamically)
const VERSION = '0.1.0';

// Brand header
export function header(title?: string): void {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}v${VERSION}${RESET}`);
  if (title) {
    writeLine(`  ${colors.purple}${title}${RESET}`);
  }
  writeLine();
}

// Section header
export function section(title: string): void {
  writeLine(`  ${colors.purple}${bold}${title}${RESET}`);
  writeLine();
}

// Boxed panel
export function panel(
  title: string,
  content: string[],
  width = 50
): void {
  const titleLen = title.replace(/\x1b\[[0-9;]*m/g, '').length;
  const innerWidth = Math.max(width - 4, titleLen + 2);

  // Top border with title
  writeLine(
    `  ${colors.dim}${box.topLeft}${box.horizontal}${RESET} ${colors.purple}${title}${RESET} ${colors.dim}${box.horizontal.repeat(
      Math.max(0, innerWidth - titleLen - 2)
    )}${box.topRight}${RESET}`
  );

  // Content
  for (const line of content) {
    const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, '').length;
    const padding = Math.max(0, innerWidth - visibleLen);
    writeLine(`  ${colors.dim}${box.vertical}${RESET} ${line}${' '.repeat(padding)} ${colors.dim}${box.vertical}${RESET}`);
  }

  // Bottom border
  writeLine(
    `  ${colors.dim}${box.bottomLeft}${box.horizontal.repeat(innerWidth + 2)}${box.bottomRight}${RESET}`
  );
  writeLine();
}

// Simple box (no title)
export function simpleBox(content: string[], width = 50): void {
  const innerWidth = width - 4;

  writeLine(`  ${colors.dim}${box.topLeft}${box.horizontal.repeat(innerWidth + 2)}${box.topRight}${RESET}`);

  for (const line of content) {
    const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, '').length;
    const padding = Math.max(0, innerWidth - visibleLen);
    writeLine(`  ${colors.dim}${box.vertical}${RESET} ${line}${' '.repeat(padding)} ${colors.dim}${box.vertical}${RESET}`);
  }

  writeLine(`  ${colors.dim}${box.bottomLeft}${box.horizontal.repeat(innerWidth + 2)}${box.bottomRight}${RESET}`);
  writeLine();
}

// Status messages
export function success(message: string): void {
  writeLine(`  ${colors.green}✓${RESET} ${message}`);
}

export function error(message: string): void {
  writeLine(`  ${colors.red}✖${RESET} ${message}`);
}

export function warning(message: string): void {
  writeLine(`  ${colors.yellow}⚠${RESET} ${message}`);
}

export function info(message: string): void {
  writeLine(`  ${colors.cyan}ℹ${RESET} ${message}`);
}

// Key-value pair
export function keyValue(key: string, value: string, keyWidth = 16): void {
  writeLine(`  ${colors.dim}${padEnd(key, keyWidth)}${RESET} ${value}`);
}

// Table header
export function tableHeader(columns: { label: string; width: number }[]): void {
  let header = '  ';
  let divider = '  ';

  for (const col of columns) {
    header += `${colors.dim}${padEnd(col.label, col.width)}${RESET}`;
    divider += `${colors.dim}${box.horizontal.repeat(col.width - 1)} ${RESET}`;
  }

  writeLine(header);
  writeLine(divider);
}

// Table row
export function tableRow(values: string[], widths: number[]): void {
  let row = '  ';
  for (let i = 0; i < values.length; i++) {
    row += padEnd(values[i], widths[i]);
  }
  writeLine(row);
}

// Divider line
export function divider(width = 50): void {
  writeLine(`  ${colors.dim}${box.horizontal.repeat(width)}${RESET}`);
}

// Empty line with indent
export function spacer(): void {
  writeLine();
}

// List item
export function listItem(text: string, bullet = '•'): void {
  writeLine(`  ${colors.purple}${bullet}${RESET} ${text}`);
}

// Numbered list item
export function numberedItem(num: number, text: string): void {
  writeLine(`  ${colors.purple}${num}.${RESET} ${text}`);
}

// Progress indicator
export function progress(label: string, current: number, total: number): void {
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * 20);
  const empty = 20 - filled;

  const bar = `${colors.purple}${'━'.repeat(filled)}${colors.dim}${'━'.repeat(empty)}${RESET}`;
  writeLine(`  ${label} ${bar} ${colors.dim}${percent}%${RESET}`);
}

// Status badge
export function badge(status: 'success' | 'warning' | 'error' | 'pending' | 'active'): string {
  return icons[status];
}

// Hint text (for command suggestions)
export function hint(text: string): void {
  writeLine(`  ${colors.dim}${text}${RESET}`);
}

// Command suggestion
export function command(cmd: string): void {
  writeLine(`  ${colors.dim}$${RESET} ${colors.cyan}${cmd}${RESET}`);
}

// Footer with links
export function footer(): void {
  writeLine();
  writeLine(`  ${colors.dim}View results:${RESET}`);
}

// Export all terminal utilities for advanced use
export { colors, bold, RESET, gradient, box, padEnd, truncate, icons } from './terminal.js';
