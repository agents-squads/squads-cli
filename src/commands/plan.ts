/**
 * `squads plan [--json]` — the project roadmap, as data (agents-squads/squads-cli#1279).
 *
 * Reads the **plan-of-record tracking issue** (`.squads/config.yml`:
 * `plan_issue: owner/repo#n`, overridden by `SQUADS_PLAN_ISSUE`) and reports
 * each deliverable of its `## Order` table as done / ready / blocked, with the
 * refs still blocking it. The roadmap logic lives here — in the CLI — so it
 * works in any project right after `squads init`, not just in one private hook.
 *
 * Unconfigured is not an error: `{ "configured": false }` and exit 0, with a
 * one-line hint. A live console polls this, so failure to reach GitHub falls
 * back to the last good roadmap (`.agents/observability/cache/plan.json`) with
 * `stale: true` — only a first-ever run with no cache exits non-zero.
 *
 * See `lib/plan-roadmap.ts` for parsing, the JSON contract, and the two-call,
 * argument-vector-only `gh` access.
 */

import { loadProjectConfig } from '../lib/config.js';
import {
  PLAN_HINT,
  PLAN_ROADMAP_VERSION,
  emptyRoadmap,
  errorMessage,
  loadPlanRoadmap,
  parsePlanRef,
  planCachePath,
  resolvePlanRef,
  type GhRunner,
  type PlanRoadmap,
  type PlanRow,
  type UnconfiguredPlan,
} from '../lib/plan-roadmap.js';
import { RESET, bold, colors, dim, padEnd, truncate, writeLine } from '../lib/terminal.js';

export interface PlanCommandOptions {
  json?: boolean;
}

export interface PlanCommandDeps {
  /** Environment to read `SQUADS_PLAN_ISSUE` from (tests). */
  env?: NodeJS.ProcessEnv;
  /** `gh` runner — defaults to execFile with an argument vector. */
  runner?: GhRunner;
  /** Cache path; defaults to the project's plan.json. Pass null to disable. */
  cachePath?: string | null;
  now?: () => Date;
  /** Stand-in for `.squads/config.yml`'s `plan_issue` (tests). */
  configPlanIssue?: string | null;
}

/** Rows listed per group in the human table before it says "… +N more". */
const GROUP_LIMIT = 20;
const TITLE_WIDTH = 52;
const LABEL_WIDTH = 7;

// ── Human output ─────────────────────────────────────────────────────

/**
 * Blockers as a human reads them: refs in the plan's own repo shorten to
 * `#n` (the way they're written in the `## Order` table), and a human blocker
 * is named as written.
 */
function blockerText(row: PlanRow, planRepo: string): string {
  const parts = row.blockers.map(ref =>
    ref.toLowerCase().startsWith(`${planRepo.toLowerCase()}#`) ? ref.slice(planRepo.length) : ref,
  );
  if (row.humanBlocker) parts.push(row.humanBlocker);
  return parts.length > 0 ? parts.join(', ') : 'unknown';
}

function group(label: string, color: string, rows: PlanRow[], planRepo: string): void {
  if (rows.length === 0) {
    writeLine(`  ${color}${bold}${padEnd(label, LABEL_WIDTH)}${RESET} ${dim}—${RESET}`);
    return;
  }
  rows.slice(0, GROUP_LIMIT).forEach((row, index) => {
    const head = index === 0 ? `${color}${bold}${padEnd(label, LABEL_WIDTH)}${RESET}` : ' '.repeat(LABEL_WIDTH);
    const blockedBy =
      row.state === 'blocked' ? `  ${dim}← blocked by ${blockerText(row, planRepo)}${RESET}` : '';
    writeLine(`  ${head} ${bold}#${padEnd(String(row.n), 3)}${RESET}${truncate(row.title, TITLE_WIDTH)}${blockedBy}`);
  });
  if (rows.length > GROUP_LIMIT) {
    writeLine(`  ${' '.repeat(LABEL_WIDTH)} ${dim}… +${rows.length - GROUP_LIMIT} more (use --json)${RESET}`);
  }
}

export function renderPlanHuman(roadmap: PlanRoadmap): void {
  const { counts } = roadmap;
  const planRepo = roadmap.plan.replace(/#\d+$/, '');
  const next = roadmap.next === null ? null : roadmap.rows.find(r => r.n === roadmap.next) ?? null;

  writeLine('');
  writeLine(`  ${bold}PLAN${RESET}    ${colors.cyan}${roadmap.plan}${RESET}  ${dim}${roadmap.url}${RESET}`);
  writeLine(
    `  ${' '.repeat(LABEL_WIDTH)}${dim}${counts.total} deliverables · ${counts.done} done · ${counts.ready} ready · ${counts.blocked} blocked${RESET}`,
  );
  if (roadmap.stale) {
    writeLine(
      `  ${colors.yellow}${bold}${padEnd('STALE', LABEL_WIDTH)}${RESET} ${dim}showing the roadmap cached at ${roadmap.fetchedAt} — ${roadmap.error ?? 'fetch failed'}${RESET}`,
    );
  }

  writeLine('');
  group('NEXT', colors.green, next ? [next] : [], planRepo);
  group('READY', colors.cyan, roadmap.rows.filter(r => r.state === 'ready'), planRepo);
  group('BLOCKED', colors.yellow, roadmap.rows.filter(r => r.state === 'blocked'), planRepo);
  writeLine(`\n  ${dim}${counts.done} done · use --json for every row, blocker and note.${RESET}\n`);
}

function emitUnconfigured(json: boolean, error?: string): void {
  const payload: UnconfiguredPlan = {
    v: PLAN_ROADMAP_VERSION,
    configured: false,
    hint: PLAN_HINT,
    ...(error ? { error } : {}),
  };
  if (json) {
    writeLine(JSON.stringify(payload, null, 2));
    return;
  }
  writeLine('');
  if (error) writeLine(`  ${colors.red}${error}${RESET}`);
  writeLine(`  ${dim}${PLAN_HINT}${RESET}\n`);
}

// ── Command ──────────────────────────────────────────────────────────

/**
 * Returns the process exit code:
 *   0 — a roadmap was produced (live or stale), or no plan is configured;
 *   1 — the plan reference is malformed, or GitHub was unreachable and there
 *       is no cached roadmap to serve.
 */
export async function planCommand(
  options: PlanCommandOptions = {},
  deps: PlanCommandDeps = {},
): Promise<number> {
  const json = options.json === true;
  const env = deps.env ?? process.env;
  const configPlanIssue =
    deps.configPlanIssue !== undefined ? deps.configPlanIssue : loadProjectConfig().plan_issue;

  const raw = resolvePlanRef(env.SQUADS_PLAN_ISSUE, configPlanIssue);
  if (!raw) {
    emitUnconfigured(json);
    return 0;
  }

  const plan = parsePlanRef(raw);
  if (!plan) {
    emitUnconfigured(json, `invalid plan reference "${raw}" — expected owner/repo#n`);
    return 1;
  }

  const cachePath = deps.cachePath === undefined ? planCachePath() : deps.cachePath;
  const now = deps.now ?? (() => new Date());

  try {
    const { roadmap } = await loadPlanRoadmap({ plan, runner: deps.runner, cachePath, now });
    if (json) writeLine(JSON.stringify(roadmap, null, 2));
    else renderPlanHuman(roadmap);
    return 0;
  } catch (err) {
    const message = errorMessage(err);
    if (json) {
      writeLine(JSON.stringify({ ...emptyRoadmap(plan, now().toISOString()), error: message }, null, 2));
    } else {
      writeLine('');
      writeLine(`  ${colors.red}Could not read ${plan.slug}:${RESET} ${message}`);
      writeLine(`  ${dim}No cached roadmap yet — retry when GitHub is reachable.${RESET}\n`);
    }
    return 1;
  }
}
