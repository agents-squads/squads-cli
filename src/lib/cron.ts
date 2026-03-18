/**
 * Zero-dependency cron evaluator utilities + routine collection from SQUAD.md files.
 * Cron logic extracted from autonomous.ts; routine parsing consolidated here.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { findSquadsDir, listSquads, type Routine } from './squad-parser.js';

// Persistent cooldown state file
const COOLDOWN_FILE = join(homedir(), '.squads', 'autonomous.cooldowns.json');

// ── Routine with squad name ──────────────────────────────────────────

export interface RoutineWithSquad extends Routine {
  squad: string;
}

// ── Routine parsing from SQUAD.md files ──────────────────────────────

/**
 * Parse routines from a SQUAD.md file's YAML block.
 */
export function parseRoutinesFromFile(filePath: string): Routine[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf-8');
  const routines: Routine[] = [];

  const routinesMatch = content.match(
    /##+ \w*\s*Routines[\s\S]*?```yaml\s*\n([\s\S]*?)```/i
  );
  if (!routinesMatch) return [];

  let yamlContent = routinesMatch[1];
  yamlContent = yamlContent.replace(/^\s*routines:\s*\n?/, '');
  yamlContent = '\n' + yamlContent.trim();

  const routineBlocks = yamlContent.split(/\n\s*- name:\s*/);

  for (const block of routineBlocks) {
    if (!block.trim()) continue;

    const lines = block.split('\n');
    const name = lines[0].trim();
    if (!name) continue;

    const scheduleMatch = block.match(/schedule:\s*["']?([^"'\n#]+)/);
    const agentsMatch = block.match(/agents:\s*\[(.*?)\]/);
    const modelMatch = block.match(/model:\s*(\w+)/);
    const enabledMatch = block.match(/enabled:\s*(true|false)/);
    const priorityMatch = block.match(/priority:\s*(\d+)/);
    const cooldownMatch = block.match(
      /cooldown:\s*["']?([^"'\n]+)["']?/
    );

    if (scheduleMatch && agentsMatch) {
      const agents = agentsMatch[1]
        .split(',')
        .map((a) => a.trim().replace(/["']/g, ''))
        .filter(Boolean);

      routines.push({
        name,
        schedule: scheduleMatch[1].trim().replace(/["']/g, ''),
        agents,
        model: modelMatch
          ? (modelMatch[1] as 'opus' | 'sonnet' | 'haiku')
          : undefined,
        enabled: enabledMatch ? enabledMatch[1] === 'true' : true,
        priority: priorityMatch ? parseInt(priorityMatch[1]) : undefined,
        cooldown: cooldownMatch ? cooldownMatch[1].trim() : undefined,
      });
    }
  }

  return routines;
}

/**
 * Collect all routines from all squads.
 */
export function collectRoutines(): RoutineWithSquad[] {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return [];

  const routines: RoutineWithSquad[] = [];
  const squadNames = listSquads(squadsDir);

  for (const name of squadNames) {
    const squadFile = join(squadsDir, name, 'SQUAD.md');
    const squadRoutines = parseRoutinesFromFile(squadFile);

    for (const routine of squadRoutines) {
      routines.push({ ...routine, squad: name });
    }
  }

  return routines;
}

// ── Persistent cooldowns ─────────────────────────────────────────────

export function loadCooldowns(): Map<string, number> {
  const map = new Map<string, number>();
  if (!existsSync(COOLDOWN_FILE)) return map;
  try {
    const data = JSON.parse(readFileSync(COOLDOWN_FILE, 'utf-8'));
    for (const [key, ts] of Object.entries(data)) {
      if (typeof ts === 'number') map.set(key, ts);
    }
  } catch {
    /* corrupt file — start fresh */
  }
  return map;
}

export function saveCooldowns(map: Map<string, number>): void {
  try {
    const obj: Record<string, number> = {};
    for (const [key, ts] of map) {
      obj[key] = ts;
    }
    writeFileSync(COOLDOWN_FILE, JSON.stringify(obj));
  } catch {
    /* best effort */
  }
}

// ── Cron evaluation ──────────────────────────────────────────────────

/**
 * Check if a cron expression matches a given date
 * @param cron - Cron expression (minute hour day month weekday)
 * @param date - Date to check against
 * @returns true if the cron matches the date
 */
export function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const fields = [
    { value: date.getMinutes(), field: parts[0], min: 0, max: 59 },
    { value: date.getHours(), field: parts[1], min: 0, max: 23 },
    { value: date.getDate(), field: parts[2], min: 1, max: 31 },
    { value: date.getMonth() + 1, field: parts[3], min: 1, max: 12 },
    { value: date.getDay(), field: parts[4], min: 0, max: 6 },
  ];

  return fields.every(({ value, field, min, max }) =>
    fieldMatches(field, value, min, max)
  );
}

/**
 * Check if a cron field matches a value
 * Handles wildcards, ranges, steps, and lists
 */
export function fieldMatches(
  field: string,
  value: number,
  min: number,
  max: number
): boolean {
  // Handle lists: "1,3,5"
  if (field.includes(",")) {
    return field.split(",").some((part) => fieldMatches(part.trim(), value, min, max));
  }

  // Handle step: "*/5" or "1-10/2"
  if (field.includes("/")) {
    const [range, stepStr] = field.split("/");
    const step = parseInt(stepStr);
    if (isNaN(step) || step <= 0) return false;

    let start = min;
    let end = max;
    if (range !== "*") {
      if (range.includes("-")) {
        [start, end] = range.split("-").map(Number);
      } else {
        start = parseInt(range);
      }
    }
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  }

  // Handle range: "1-5"
  if (field.includes("-")) {
    const [start, end] = field.split("-").map(Number);
    return value >= start && value <= end;
  }

  // Wildcard
  if (field === "*") return true;

  // Exact match
  return parseInt(field) === value;
}

/**
 * Get the next occurrence of a cron expression after `after`.
 * Brute-forces minute by minute (max 48h lookahead).
 */
export function getNextCronRun(cron: string, after: Date = new Date()): Date {
  const next = new Date(after);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1); // Start from next minute

  const maxIterations = 60 * 24 * 8; // 8 days (covers weekly schedules)
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatches(cron, next)) return next;
    next.setMinutes(next.getMinutes() + 1);
  }

  // Fallback: 24h from now
  const fallback = new Date(after);
  fallback.setDate(fallback.getDate() + 1);
  return fallback;
}

/**
 * Parse a cooldown string like "30m", "6 hours", "7d" into milliseconds
 * @param cooldown - String like "30m", "6 hours", "7d"
 * @returns milliseconds, or 0 if invalid
 */
export function parseCooldown(cooldown: string): number {
  const match = cooldown.match(/^(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i);
  if (!match) return 0;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  if (unit.startsWith("m")) return value * 60 * 1000;
  if (unit.startsWith("h")) return value * 60 * 60 * 1000;
  if (unit.startsWith("d")) return value * 24 * 60 * 60 * 1000;
  return 0;
}
