// Terminal utilities - Bun-style approach
// Raw ANSI for performance, no heavy deps

// ANSI escape codes
export const ESC = '\x1b[';
export const RESET = `${ESC}0m`;

// Detect true color support
function supportsTrueColor(): boolean {
  const colorterm = process.env.COLORTERM;
  if (colorterm === 'truecolor' || colorterm === '24bit') return true;
  const term = process.env.TERM || '';
  if (term.includes('256color') || term.includes('truecolor')) return true;
  // iTerm2, VS Code, modern terminals
  if (process.env.TERM_PROGRAM === 'iTerm.app') return true;
  if (process.env.TERM_PROGRAM === 'vscode') return true;
  if (process.env.WT_SESSION) return true; // Windows Terminal
  return false;
}

const USE_TRUE_COLOR = supportsTrueColor();

// Colors - use 24-bit RGB if supported, fallback to basic ANSI
export const rgb = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`;
export const bgRgb = (r: number, g: number, b: number) => `${ESC}48;2;${r};${g};${b}m`;

// Basic ANSI color codes (work everywhere)
const ansi = {
  purple: `${ESC}35m`,      // magenta
  pink: `${ESC}95m`,        // bright magenta
  cyan: `${ESC}36m`,        // cyan
  green: `${ESC}32m`,       // green
  yellow: `${ESC}33m`,      // yellow
  red: `${ESC}31m`,         // red
  gray: `${ESC}90m`,        // bright black (gray)
  dim: `${ESC}90m`,         // bright black (gray)
  white: `${ESC}97m`,       // bright white
};

// Named colors (our brand palette) - with fallback
export const colors = USE_TRUE_COLOR ? {
  purple: rgb(168, 85, 247),    // #a855f7
  pink: rgb(236, 72, 153),      // #ec4899
  cyan: rgb(6, 182, 212),       // #06b6d4
  green: rgb(16, 185, 129),     // #10b981
  yellow: rgb(234, 179, 8),     // #eab308
  red: rgb(239, 68, 68),        // #ef4444
  gray: rgb(107, 114, 128),     // #6b7280
  dim: rgb(75, 85, 99),         // #4b5563
  white: rgb(255, 255, 255),
} : ansi;

// Styles
export const bold = `${ESC}1m`;
export const dim = `${ESC}2m`;

// Cursor control
export const cursor = {
  hide: `${ESC}?25l`,
  show: `${ESC}?25h`,
  up: (n = 1) => `${ESC}${n}A`,
  down: (n = 1) => `${ESC}${n}B`,
  left: (n = 1) => `${ESC}${n}D`,
  right: (n = 1) => `${ESC}${n}C`,
  to: (x: number, y: number) => `${ESC}${y};${x}H`,
  save: `${ESC}s`,
  restore: `${ESC}u`,
};

// Clear
export const clear = {
  line: `${ESC}2K`,
  toEnd: `${ESC}0K`,
  screen: `${ESC}2J${ESC}0;0H`,
};

// Check if terminal supports Unicode
function supportsUnicode(): boolean {
  // Windows CMD typically doesn't support Unicode well
  if (process.platform === 'win32') {
    // Windows Terminal supports Unicode
    if (process.env.WT_SESSION) return true;
    // ConEmu supports Unicode
    if (process.env.ConEmuTask) return true;
    // Fallback: check for UTF-8 codepage
    if (process.env.LANG?.includes('UTF') || process.env.LC_ALL?.includes('UTF')) return true;
    return false;
  }
  // Most modern terminals on macOS/Linux support Unicode
  // But AI CLIs might not render them well in their output
  // Force ASCII for known problematic environments
  if (process.env.SQUADS_ASCII !== undefined) return false;
  return true;
}

const USE_UNICODE = supportsUnicode();

// Gradient text (purple → pink → cyan)
export function gradient(text: string): string {
  const stops = [
    [168, 85, 247],   // purple
    [192, 132, 252],  // purple-light
    [232, 121, 249],  // pink
    [244, 114, 182],  // pink-light
    [251, 113, 133],  // rose
  ];

  let result = '';
  for (let i = 0; i < text.length; i++) {
    const t = i / Math.max(text.length - 1, 1);
    const stopIndex = t * (stops.length - 1);
    const lower = Math.floor(stopIndex);
    const upper = Math.min(lower + 1, stops.length - 1);
    const blend = stopIndex - lower;

    const r = Math.round(stops[lower][0] + (stops[upper][0] - stops[lower][0]) * blend);
    const g = Math.round(stops[lower][1] + (stops[upper][1] - stops[lower][1]) * blend);
    const b = Math.round(stops[lower][2] + (stops[upper][2] - stops[lower][2]) * blend);

    result += rgb(r, g, b) + text[i];
  }
  return result + RESET;
}

// Progress bar characters
const BAR_FILLED = USE_UNICODE ? '━' : '=';
const BAR_EMPTY = USE_UNICODE ? '━' : '-';

// Progress bar with gradient fill
export function progressBar(percent: number, width = 20): string {
  // Clamp values to prevent negative repeat counts
  const clampedPercent = Math.max(0, Math.min(100, percent || 0));
  const filled = Math.round((clampedPercent / 100) * width);
  const empty = Math.max(0, width - filled);

  let bar = '';
  for (let i = 0; i < filled; i++) {
    const t = i / Math.max(filled - 1, 1);
    const r = Math.round(16 + (168 - 16) * t);
    const g = Math.round(185 + (85 - 185) * t);
    const b = Math.round(129 + (247 - 129) * t);
    bar += rgb(r, g, b) + BAR_FILLED;
  }

  bar += colors.dim + BAR_EMPTY.repeat(empty) + RESET;
  return bar;
}

// Box drawing - with ASCII fallback
export const box = USE_UNICODE ? {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeRight: '├',
  teeLeft: '┤',
} : {
  topLeft: '+',
  topRight: '+',
  bottomLeft: '+',
  bottomRight: '+',
  horizontal: '-',
  vertical: '|',
  teeRight: '+',
  teeLeft: '+',
};

// Format helpers
export function padEnd(str: string, len: number): string {
  // Strip ANSI codes for length calculation
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, len - visible.length);
  return str + ' '.repeat(pad);
}

export function truncate(str: string, len: number): string {
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length <= len) return str;

  // Simple truncation (won't handle mid-ANSI truncation perfectly)
  let result = '';
  let count = 0;
  let i = 0;

  while (i < str.length && count < len - 1) {
    if (str[i] === '\x1b') {
      const end = str.indexOf('m', i);
      if (end !== -1) {
        result += str.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    result += str[i];
    count++;
    i++;
  }

  return result + colors.dim + '…' + RESET;
}

// Spinner frames - with ASCII fallback
export const spinnerFrames = USE_UNICODE
  ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  : ['-', '\\', '|', '/'];

// Status icons - with ASCII fallback
export const icons = USE_UNICODE ? {
  success: `${colors.green}●${RESET}`,
  warning: `${colors.yellow}○${RESET}`,
  error: `${colors.red}●${RESET}`,
  pending: `${colors.dim}○${RESET}`,
  active: `${colors.green}●${RESET}`,
  running: `${colors.yellow}◆${RESET}`,
  progress: `${colors.cyan}◆${RESET}`,
  empty: `${colors.dim}◇${RESET}`,
} : {
  success: `${colors.green}*${RESET}`,
  warning: `${colors.yellow}!${RESET}`,
  error: `${colors.red}x${RESET}`,
  pending: `${colors.dim}o${RESET}`,
  active: `${colors.green}*${RESET}`,
  running: `${colors.yellow}>${RESET}`,
  progress: `${colors.cyan}>${RESET}`,
  empty: `${colors.dim}.${RESET}`,
};

// Strip ANSI escape codes from a string
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// Check if running under an AI coding assistant
export function isAiCli(): boolean {
  // Claude Code
  if (process.env.CLAUDECODE !== undefined) return true;
  // Gemini CLI
  if (process.env.GEMINI_API_KEY !== undefined) return true;
  // Cursor
  if (process.env.CURSOR_CHANNEL !== undefined) return true;
  // Sourcegraph Cody
  if (process.env.CODY_AUTH !== undefined) return true;
  // Windsurf (Codeium)
  if (process.env.CODEIUM_API_KEY !== undefined) return true;
  // Copilot CLI
  if (process.env.GITHUB_COPILOT_CLI !== undefined) return true;
  // Aider
  if (process.env.AIDER_MODEL !== undefined) return true;
  // Continue.dev
  if (process.env.CONTINUE_GLOBAL_DIR !== undefined) return true;
  return false;
}

// Check if we should use colors (TTY detection)
export function isColorEnabled(): boolean {
  // NO_COLOR environment variable (standard: https://no-color.org/)
  if (process.env.NO_COLOR !== undefined) return false;
  // Force color via environment variable
  if (process.env.FORCE_COLOR !== undefined) return true;
  // AI coding assistants - enable colors (they support ANSI)
  if (isAiCli()) return true;
  // Check if output is a TTY
  return process.stdout.isTTY ?? false;
}

// Write without newline (strips ANSI codes when piped)
export function write(str: string): void {
  const output = isColorEnabled() ? str : stripAnsi(str);
  process.stdout.write(output);
}

// Write line (strips ANSI codes when piped)
export function writeLine(str = ''): void {
  const output = isColorEnabled() ? str : stripAnsi(str);
  process.stdout.write(output + '\n');
}

// Sparkline characters - Unicode blocks vs ASCII
const SPARKLINE_BLOCKS = USE_UNICODE
  ? ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  : ['_', '.', '-', '=', '+', '#', '#', '#'];

// Sparkline chart using block characters
export function sparkline(values: number[], _width?: number): string {
  if (values.length === 0) return '';

  const max = Math.max(...values, 1);

  let result = '';
  for (const val of values) {
    const normalized = val / max;
    const blockIndex = Math.min(Math.floor(normalized * SPARKLINE_BLOCKS.length), SPARKLINE_BLOCKS.length - 1);

    // Color gradient from dim to cyan to green based on value
    if (normalized === 0) {
      result += colors.dim + SPARKLINE_BLOCKS[0];
    } else if (normalized < 0.5) {
      result += colors.cyan + SPARKLINE_BLOCKS[blockIndex];
    } else {
      result += colors.green + SPARKLINE_BLOCKS[blockIndex];
    }
  }

  return result + RESET;
}

// Bar chart (horizontal)
export function barChart(value: number, max: number, width: number = 20, label?: string): string {
  // Guard against invalid inputs to prevent crashes
  const safeValue = Math.max(0, value || 0);
  const safeMax = Math.max(1, max || 1); // Prevent division by zero
  const ratio = Math.min(1, safeValue / safeMax); // Clamp ratio to 0-1
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  let bar = '';
  for (let i = 0; i < filled; i++) {
    const t = i / Math.max(filled - 1, 1);
    // Green to cyan gradient
    const r = Math.round(16 + (6 - 16) * t);
    const g = Math.round(185 + (182 - 185) * t);
    const b = Math.round(129 + (212 - 129) * t);
    bar += rgb(r, g, b) + BAR_FILLED;
  }

  bar += colors.dim + BAR_EMPTY.repeat(empty) + RESET;

  if (label) {
    return `${bar} ${label}`;
  }
  return bar;
}
