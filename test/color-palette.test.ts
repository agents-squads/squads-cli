import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');

/**
 * Official Squads CLI Color Palette
 * All RGB colors used in CLI output must be from this palette.
 *
 * See: src/lib/terminal.ts for the source of truth
 */
const PALETTE = {
  // Primary brand colors
  purple: [168, 85, 247],      // #a855f7
  pink: [236, 72, 153],        // #ec4899
  cyan: [6, 182, 212],         // #06b6d4

  // Status colors
  green: [16, 185, 129],       // #10b981 (success)
  yellow: [234, 179, 8],       // #eab308 (warning)
  red: [239, 68, 68],          // #ef4444 (error)

  // Neutral colors
  gray: [107, 114, 128],       // #6b7280
  dim: [75, 85, 99],           // #4b5563
  white: [255, 255, 255],

  // Gradient stops (used in gradient() function)
  gradientPurple: [168, 85, 247],
  gradientPurpleLight: [192, 132, 252],
  gradientPink: [232, 121, 249],
  gradientPinkLight: [244, 114, 182],
  gradientRose: [251, 113, 133],

  // Light mode palette (for future use)
  lightPurple: [147, 51, 234],
  lightCyan: [14, 165, 233],
  lightGreen: [34, 197, 94],
  lightYellow: [245, 158, 11],
  lightRed: [220, 38, 38],
  lightGray: [156, 163, 175],
  lightDim: [209, 213, 219],
} as const;

/**
 * Extract all RGB color codes from ANSI output
 * Matches patterns like: \x1b[38;2;168;85;247m (foreground RGB)
 * and \x1b[48;2;168;85;247m (background RGB)
 */
function extractRgbColors(output: string): Array<[number, number, number]> {
  const colors: Array<[number, number, number]> = [];
  // Match RGB escape sequences: ESC[38;2;R;G;Bm (foreground) or ESC[48;2;R;G;Bm (background)
  const rgbPattern = /\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/g;

  let match;
  while ((match = rgbPattern.exec(output)) !== null) {
    const r = parseInt(match[1], 10);
    const g = parseInt(match[2], 10);
    const b = parseInt(match[3], 10);
    colors.push([r, g, b]);
  }

  return colors;
}

/**
 * Check if a color is within tolerance of a palette color
 * Allows for gradient interpolation which produces intermediate colors
 */
function isColorInPalette(
  color: [number, number, number],
  tolerance = 0
): { inPalette: boolean; closestMatch?: string; distance?: number } {
  const paletteValues = Object.entries(PALETTE);

  for (const [name, paletteColor] of paletteValues) {
    const distance = Math.sqrt(
      Math.pow(color[0] - paletteColor[0], 2) +
      Math.pow(color[1] - paletteColor[1], 2) +
      Math.pow(color[2] - paletteColor[2], 2)
    );

    if (distance <= tolerance) {
      return { inPalette: true, closestMatch: name, distance };
    }
  }

  // Find closest match for error reporting
  let closestMatch = '';
  let minDistance = Infinity;

  for (const [name, paletteColor] of paletteValues) {
    const distance = Math.sqrt(
      Math.pow(color[0] - paletteColor[0], 2) +
      Math.pow(color[1] - paletteColor[1], 2) +
      Math.pow(color[2] - paletteColor[2], 2)
    );

    if (distance < minDistance) {
      minDistance = distance;
      closestMatch = name;
    }
  }

  return { inPalette: false, closestMatch, distance: minDistance };
}

/**
 * Check if a color is part of a valid gradient interpolation
 * Gradients interpolate between defined stops, producing intermediate colors
 */
function isValidGradientColor(color: [number, number, number]): boolean {
  const gradientStops = [
    PALETTE.gradientPurple,
    PALETTE.gradientPurpleLight,
    PALETTE.gradientPink,
    PALETTE.gradientPinkLight,
    PALETTE.gradientRose,
  ];

  // Check if color falls within any gradient segment
  for (let i = 0; i < gradientStops.length - 1; i++) {
    const start = gradientStops[i];
    const end = gradientStops[i + 1];

    // Check if color is between start and end for each channel
    const rInRange = (color[0] >= Math.min(start[0], end[0]) - 1) &&
                     (color[0] <= Math.max(start[0], end[0]) + 1);
    const gInRange = (color[1] >= Math.min(start[1], end[1]) - 1) &&
                     (color[1] <= Math.max(start[1], end[1]) + 1);
    const bInRange = (color[2] >= Math.min(start[2], end[2]) - 1) &&
                     (color[2] <= Math.max(start[2], end[2]) + 1);

    if (rInRange && gInRange && bInRange) {
      return true;
    }
  }

  // Also check progress bar gradient (green -> cyan)
  // Green: [16, 185, 129] to Purple: [168, 85, 247]
  const barStart = PALETTE.green;
  const barEnd = PALETTE.purple;

  const rInRange = (color[0] >= Math.min(barStart[0], barEnd[0]) - 1) &&
                   (color[0] <= Math.max(barStart[0], barEnd[0]) + 1);
  const gInRange = (color[1] >= Math.min(barStart[1], barEnd[1]) - 1) &&
                   (color[1] <= Math.max(barStart[1], barEnd[1]) + 1);
  const bInRange = (color[2] >= Math.min(barStart[2], barEnd[2]) - 1) &&
                   (color[2] <= Math.max(barStart[2], barEnd[2]) + 1);

  if (rInRange && gInRange && bInRange) {
    return true;
  }

  // Check bar chart gradient (green -> cyan)
  const chartStart = [16, 185, 129] as const;
  const chartEnd = [6, 182, 212] as const;

  const crInRange = (color[0] >= Math.min(chartStart[0], chartEnd[0]) - 1) &&
                    (color[0] <= Math.max(chartStart[0], chartEnd[0]) + 1);
  const cgInRange = (color[1] >= Math.min(chartStart[1], chartEnd[1]) - 1) &&
                    (color[1] <= Math.max(chartStart[1], chartEnd[1]) + 1);
  const cbInRange = (color[2] >= Math.min(chartStart[2], chartEnd[2]) - 1) &&
                    (color[2] <= Math.max(chartStart[2], chartEnd[2]) + 1);

  return crInRange && cgInRange && cbInRange;
}

/**
 * Validate all colors in output are from the palette
 */
function validateColors(output: string): {
  valid: boolean;
  violations: Array<{ color: [number, number, number]; closestMatch: string; distance: number }>;
  totalColors: number;
} {
  const colors = extractRgbColors(output);
  const violations: Array<{ color: [number, number, number]; closestMatch: string; distance: number }> = [];

  // Use Set to track unique colors
  const uniqueColors = new Map<string, [number, number, number]>();
  for (const color of colors) {
    const key = color.join(',');
    if (!uniqueColors.has(key)) {
      uniqueColors.set(key, color);
    }
  }

  for (const color of uniqueColors.values()) {
    // First check exact palette match (with small tolerance for rounding)
    const paletteCheck = isColorInPalette(color, 2);
    if (paletteCheck.inPalette) continue;

    // Then check if it's a valid gradient interpolation
    if (isValidGradientColor(color)) continue;

    // Color is not in palette and not a valid gradient
    violations.push({
      color,
      closestMatch: paletteCheck.closestMatch || 'unknown',
      distance: paletteCheck.distance || Infinity,
    });
  }

  return {
    valid: violations.length === 0,
    violations,
    totalColors: uniqueColors.size,
  };
}

function runCli(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        COLORTERM: 'truecolor',
      },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      exitCode: e.status || 1,
    };
  }
}

describe('Color Palette Compliance', () => {
  describe('help commands use palette colors', () => {
    it('--help uses only palette colors', () => {
      const result = runCli('--help');
      const validation = validateColors(result.stdout);

      if (!validation.valid) {
        console.log(`Found ${validation.violations.length} color violations in --help:`);
        for (const v of validation.violations.slice(0, 5)) {
          console.log(`  rgb(${v.color.join(', ')}) - closest: ${v.closestMatch} (distance: ${v.distance.toFixed(1)})`);
        }
      }

      expect(validation.valid).toBe(true);
    });

    it('status --help uses only palette colors', () => {
      const result = runCli('status --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('dashboard --help uses only palette colors', () => {
      const result = runCli('dashboard --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('memory --help uses only palette colors', () => {
      const result = runCli('memory --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('goal --help uses only palette colors', () => {
      const result = runCli('goal --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('run --help uses only palette colors', () => {
      const result = runCli('run --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });
  });

  describe('command outputs use palette colors', () => {
    // These tests check actual command output when possible
    // Commands that require specific setup are skipped or use --help

    it('--version uses only palette colors', () => {
      const result = runCli('--version');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('workers --help uses only palette colors', () => {
      const result = runCli('workers --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('trigger --help uses only palette colors', () => {
      const result = runCli('trigger --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('kpi --help uses only palette colors', () => {
      const result = runCli('kpi --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('cost --help uses only palette colors', () => {
      const result = runCli('cost --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('health --help uses only palette colors', () => {
      const result = runCli('health --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('context --help uses only palette colors', () => {
      const result = runCli('context --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('feedback --help uses only palette colors', () => {
      const result = runCli('feedback --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('history --help uses only palette colors', () => {
      const result = runCli('history --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('sessions --help uses only palette colors', () => {
      const result = runCli('sessions --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('skill --help uses only palette colors', () => {
      const result = runCli('skill --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('approval --help uses only palette colors', () => {
      const result = runCli('approval --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('init --help uses only palette colors', () => {
      const result = runCli('init --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('login --help uses only palette colors', () => {
      const result = runCli('login --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('update --help uses only palette colors', () => {
      const result = runCli('update --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('sync --help uses only palette colors', () => {
      const result = runCli('sync --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });

    it('list --help uses only palette colors', () => {
      const result = runCli('list --help');
      const validation = validateColors(result.stdout);
      expect(validation.valid).toBe(true);
    });
  });

  describe('palette exports', () => {
    it('PALETTE contains all expected colors', () => {
      // Core colors
      expect(PALETTE.purple).toEqual([168, 85, 247]);
      expect(PALETTE.pink).toEqual([236, 72, 153]);
      expect(PALETTE.cyan).toEqual([6, 182, 212]);
      expect(PALETTE.green).toEqual([16, 185, 129]);
      expect(PALETTE.yellow).toEqual([234, 179, 8]);
      expect(PALETTE.red).toEqual([239, 68, 68]);
      expect(PALETTE.gray).toEqual([107, 114, 128]);
      expect(PALETTE.dim).toEqual([75, 85, 99]);
      expect(PALETTE.white).toEqual([255, 255, 255]);
    });

    it('gradient stops are defined', () => {
      expect(PALETTE.gradientPurple).toBeDefined();
      expect(PALETTE.gradientPurpleLight).toBeDefined();
      expect(PALETTE.gradientPink).toBeDefined();
      expect(PALETTE.gradientPinkLight).toBeDefined();
      expect(PALETTE.gradientRose).toBeDefined();
    });
  });
});

// Export for use in other tests
export { PALETTE, extractRgbColors, validateColors, isColorInPalette, isValidGradientColor };
