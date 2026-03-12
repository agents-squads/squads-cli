// Terminal utilities - Bun-style approach
// Raw ANSI for performance, no heavy deps

// Check if we should use colors (TTY detection)
// Evaluated once at module load — must be before any ANSI constant definitions
export function isColorEnabled(): boolean {
  // NO_COLOR environment variable (standard: https://no-color.org/)
  if (process.env.NO_COLOR !== undefined) return false;
  // Force color via environment variable
  if (process.env.FORCE_COLOR !== undefined) return true;
  // TTY check first — piped output (squads | grep) never gets colors
  if (process.stdout.isTTY === true) return true;
  // AI coding assistants that may not expose a TTY but support ANSI rendering
  // Only reached when isTTY is undefined (not explicitly a terminal)
  if (isAiCli()) return true;
  return false;
}

// Check if running under an AI coding assistant
// Only include env vars that are EXCLUSIVELY set by the tool's terminal session,
// not general API keys (e.g. GEMINI_API_KEY, CODEIUM_API_KEY) which users set globally
// and cause false positives when piping output.
export function isAiCli(): boolean {
  // Claude Code
  if (process.env.CLAUDECODE !== undefined) return true;
  // Cursor
  if (process.env.CURSOR_CHANNEL !== undefined) return true;
  // Sourcegraph Cody
  if (process.env.CODY_AUTH !== undefined) return true;
  // Copilot CLI
  if (process.env.GITHUB_COPILOT_CLI !== undefined) return true;
  // Aider
  if (process.env.AIDER_MODEL !== undefined) return true;
  // Continue.dev
  if (process.env.CONTINUE_GLOBAL_DIR !== undefined) return true;
  return false;
}

// Master color toggle — when false, all ANSI codes become empty strings
const COLOR_ENABLED = isColorEnabled();

// ANSI escape codes (empty when piped/NO_COLOR)
export const ESC = COLOR_ENABLED ? '\x1b[' : '';
export const RESET = COLOR_ENABLED ? '\x1b[0m' : '';

// Detect true color support
function supportsTrueColor(): boolean {
  if (!COLOR_ENABLED) return false;
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
// Returns empty string when colors are disabled (piped output, NO_COLOR)
export const rgb = (r: number, g: number, b: number) => COLOR_ENABLED ? `\x1b[38;2;${r};${g};${b}m` : '';
export const bgRgb = (r: number, g: number, b: number) => COLOR_ENABLED ? `\x1b[48;2;${r};${g};${b}m` : '';

// Detect light terminal background
// Uses COLORFGBG env var (format: "fg;bg" where bg > 7 = light)
// or SQUADS_THEME env var for explicit override
function isLightBackground(): boolean {
  const theme = process.env.SQUADS_THEME?.toLowerCase();
  if (theme === 'light') return true;
  if (theme === 'dark') return false;

  // COLORFGBG is set by some terminals (xterm, rxvt, etc.)
  // Format: "foreground;background" where numbers are ANSI color indices
  // Light backgrounds typically use indices > 7 (white = 15, light gray = 7)
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(';');
    const bg = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(bg) && (bg === 15 || bg === 7)) return true;
  }

  return false;
}

const USE_LIGHT_MODE = isLightBackground();

// Empty palette for when colors are disabled
const noColors = {
  purple: '', pink: '', cyan: '', green: '', yellow: '',
  red: '', gray: '', dim: '', white: '',
};

// Basic ANSI color codes (work everywhere)
const ansiDark = {
  purple: '\x1b[35m',      // magenta
  pink: '\x1b[95m',        // bright magenta
  cyan: '\x1b[36m',        // cyan
  green: '\x1b[32m',       // green
  yellow: '\x1b[33m',      // yellow
  red: '\x1b[31m',         // red
  gray: '\x1b[90m',        // bright black (gray)
  dim: '\x1b[90m',         // bright black (gray)
  white: '\x1b[97m',       // bright white
};

const ansiLight = {
  purple: '\x1b[35m',      // magenta (same, works on light)
  pink: '\x1b[35m',        // magenta (bright is too light)
  cyan: '\x1b[36m',        // cyan
  green: '\x1b[32m',       // green
  yellow: '\x1b[33m',      // yellow
  red: '\x1b[31m',         // red
  gray: '\x1b[90m',        // bright black (gray)
  dim: '\x1b[90m',         // bright black (gray)
  white: '\x1b[30m',       // black for light backgrounds
};

// Dark mode palette (original - for dark backgrounds)
const darkPalette = {
  purple: rgb(168, 85, 247),    // #a855f7
  pink: rgb(236, 72, 153),      // #ec4899
  cyan: rgb(6, 182, 212),       // #06b6d4
  green: rgb(16, 185, 129),     // #10b981
  yellow: rgb(234, 179, 8),     // #eab308
  red: rgb(239, 68, 68),        // #ef4444
  gray: rgb(107, 114, 128),     // #6b7280
  dim: rgb(75, 85, 99),         // #4b5563
  white: rgb(255, 255, 255),
};

// Light mode palette (darker colors for contrast on light backgrounds)
const lightPalette = {
  purple: rgb(124, 58, 237),    // #7c3aed (purple-600)
  pink: rgb(219, 39, 119),      // #db2777 (pink-600)
  cyan: rgb(8, 145, 178),       // #0891b2 (cyan-600)
  green: rgb(22, 163, 74),      // #16a34a (green-600)
  yellow: rgb(202, 138, 4),     // #ca8a04 (yellow-600)
  red: rgb(220, 38, 38),        // #dc2626 (red-600)
  gray: rgb(75, 85, 99),        // #4b5563 (gray-600)
  dim: rgb(107, 114, 128),      // #6b7280 (gray-500)
  white: rgb(0, 0, 0),          // black for light backgrounds
};

// Named colors (our brand palette) - with theme and fallback support
// Returns empty strings when colors are disabled (piped output, NO_COLOR)
export const colors = !COLOR_ENABLED
  ? noColors
  : USE_TRUE_COLOR
    ? (USE_LIGHT_MODE ? lightPalette : darkPalette)
    : (USE_LIGHT_MODE ? ansiLight : ansiDark);

// Styles (empty when colors disabled)
export const bold = COLOR_ENABLED ? '\x1b[1m' : '';
export const dim = COLOR_ENABLED ? '\x1b[2m' : '';

// Cursor control (no-op when piped)
export const cursor = COLOR_ENABLED ? {
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  up: (n = 1) => `\x1b[${n}A`,
  down: (n = 1) => `\x1b[${n}B`,
  left: (n = 1) => `\x1b[${n}D`,
  right: (n = 1) => `\x1b[${n}C`,
  to: (x: number, y: number) => `\x1b[${y};${x}H`,
  save: '\x1b[s',
  restore: '\x1b[u',
} : {
  hide: '',
  show: '',
  up: (_n = 1) => '',
  down: (_n = 1) => '',
  left: (_n = 1) => '',
  right: (_n = 1) => '',
  to: (_x: number, _y: number) => '',
  save: '',
  restore: '',
};

// Clear (no-op when piped)
export const clear = COLOR_ENABLED ? {
  line: '\x1b[2K',
  toEnd: '\x1b[0K',
  screen: '\x1b[2J\x1b[0;0H',
} : {
  line: '',
  toEnd: '',
  screen: '',
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
  if (!COLOR_ENABLED) return text;

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
  // Privacy indicators
  internal: `${colors.purple}🔒${RESET}`,
  publicOk: `${colors.green}🌐${RESET}`,
  caution: `${colors.yellow}⚠️${RESET}`,
} : {
  success: `${colors.green}*${RESET}`,
  warning: `${colors.yellow}!${RESET}`,
  error: `${colors.red}x${RESET}`,
  pending: `${colors.dim}o${RESET}`,
  active: `${colors.green}*${RESET}`,
  running: `${colors.yellow}>${RESET}`,
  progress: `${colors.cyan}>${RESET}`,
  empty: `${colors.dim}.${RESET}`,
  // Privacy indicators (ASCII)
  internal: `${colors.purple}[INTERNAL]${RESET}`,
  publicOk: `${colors.green}[PUBLIC]${RESET}`,
  caution: `${colors.yellow}[CAUTION]${RESET}`,
};

// Privacy level type
export type PrivacyLevel = 'internal' | 'public' | 'caution';

// Privacy header - shows trust indicator at top of output
export function privacyHeader(level: PrivacyLevel = 'internal'): string {
  const headers = {
    internal: `  ${icons.internal} ${colors.purple}INTERNAL ONLY${RESET} ${colors.dim}— not for external sharing${RESET}`,
    public: `  ${icons.publicOk} ${colors.green}PUBLIC OK${RESET} ${colors.dim}— safe to share externally${RESET}`,
    caution: `  ${icons.caution} ${colors.yellow}CAUTION${RESET} ${colors.dim}— review before sharing${RESET}`,
  };
  return headers[level] + '\n  ' + colors.dim + '─'.repeat(50) + RESET;
}

// Strip ANSI escape codes from a string
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// Write without newline
export function write(str: string): void {
  process.stdout.write(str);
}

// Write line
export function writeLine(str = ''): void {
  process.stdout.write(str + '\n');
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
