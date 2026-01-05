// Terminal utilities - Bun-style approach
// Raw ANSI for performance, no heavy deps

// ANSI escape codes
export const ESC = '\x1b[';
export const RESET = `${ESC}0m`;

// Colors (256-color mode for gradients)
export const rgb = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`;
export const bgRgb = (r: number, g: number, b: number) => `${ESC}48;2;${r};${g};${b}m`;

// Named colors (our brand palette)
export const colors = {
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

// Progress bar with gradient fill
export function progressBar(percent: number, width = 20): string {
  // Clamp values to prevent negative repeat counts
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clampedPercent / 100) * width);
  const empty = Math.max(0, width - filled);

  let bar = '';
  for (let i = 0; i < filled; i++) {
    const t = i / Math.max(filled - 1, 1);
    const r = Math.round(16 + (168 - 16) * t);
    const g = Math.round(185 + (85 - 185) * t);
    const b = Math.round(129 + (247 - 129) * t);
    bar += rgb(r, g, b) + '━';
  }

  bar += colors.dim + '━'.repeat(empty) + RESET;
  return bar;
}

// Box drawing
export const box = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeRight: '├',
  teeLeft: '┤',
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

// Spinner frames
export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Status icons
export const icons = {
  success: `${colors.green}●${RESET}`,
  warning: `${colors.yellow}○${RESET}`,
  error: `${colors.red}●${RESET}`,
  pending: `${colors.dim}○${RESET}`,
  active: `${colors.green}●${RESET}`,
  progress: `${colors.cyan}◆${RESET}`,
  empty: `${colors.dim}◇${RESET}`,
};

// Write without newline
export function write(str: string): void {
  process.stdout.write(str);
}

// Write line
export function writeLine(str = ''): void {
  process.stdout.write(str + '\n');
}

// Sparkline chart using block characters
export function sparkline(values: number[], width?: number): string {
  if (values.length === 0) return '';

  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const max = Math.max(...values, 1);

  let result = '';
  for (const val of values) {
    const normalized = val / max;
    const blockIndex = Math.min(Math.floor(normalized * blocks.length), blocks.length - 1);
    const intensity = normalized;

    // Color gradient from dim to cyan to green based on value
    if (normalized === 0) {
      result += colors.dim + blocks[0];
    } else if (normalized < 0.5) {
      result += colors.cyan + blocks[blockIndex];
    } else {
      result += colors.green + blocks[blockIndex];
    }
  }

  return result + RESET;
}

// Bar chart (horizontal)
export function barChart(value: number, max: number, width: number = 20, label?: string): string {
  const filled = Math.round((value / max) * width);
  const empty = width - filled;

  let bar = '';
  for (let i = 0; i < filled; i++) {
    const t = i / Math.max(filled - 1, 1);
    // Green to cyan gradient
    const r = Math.round(16 + (6 - 16) * t);
    const g = Math.round(185 + (182 - 185) * t);
    const b = Math.round(129 + (212 - 129) * t);
    bar += rgb(r, g, b) + '━';
  }

  bar += colors.dim + '━'.repeat(empty) + RESET;

  if (label) {
    return `${bar} ${label}`;
  }
  return bar;
}
