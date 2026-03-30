/**
 * squads review — post-cycle evaluation dashboard.
 *
 * Replaces the manual process of reading 14 state files, checking goals,
 * cross-referencing PRs/issues, and evaluating squad output.
 */

import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { findSquadsDir } from '../lib/squad-parser.js';
import { findMemoryDir } from '../lib/memory.js';
import { queryExecutions, calculateCostSummary, type ObservabilityRecord } from '../lib/observability.js';
import { colors, bold, RESET, writeLine } from '../lib/terminal.js';

// ── Helpers ─────────────────────────────────────────────────────────────

interface GoalInfo {
  name: string;
  status: string;
  section: 'active' | 'achieved' | 'abandoned' | 'proposed';
  deadline?: string;
  blocker?: string;
}

function parseGoalsDetailed(filePath: string): GoalInfo[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const goals: GoalInfo[] = [];
  let currentSection: GoalInfo['section'] = 'active';

  for (const line of content.split('\n')) {
    if (line.startsWith('## Active')) currentSection = 'active';
    else if (line.startsWith('## Achieved')) currentSection = 'achieved';
    else if (line.startsWith('## Abandoned')) currentSection = 'abandoned';
    else if (line.startsWith('## Proposed')) currentSection = 'proposed';

    const match = line.match(/\*\*([^*]+)\*\*/);
    if (!match) continue;

    const name = match[1].trim();
    const statusMatch = line.match(/status:\s*(\S+)/);
    const deadlineMatch = line.match(/deadline:\s*(\S+)/);
    const blockerMatch = line.match(/blocker:\s*([^|]+)/);

    if (statusMatch || (currentSection === 'achieved' && line.includes('achieved:'))) {
      goals.push({
        name,
        status: statusMatch ? statusMatch[1].trim() : 'achieved',
        section: currentSection,
        deadline: deadlineMatch ? deadlineMatch[1].trim() : undefined,
        blocker: blockerMatch ? blockerMatch[1].trim() : undefined,
      });
    }
  }
  return goals;
}

function readStateSnippet(memoryDir: string, squad: string): { status: string; summary: string; blockers: string[] } | null {
  // Find the lead's state file
  const squadMemDir = join(memoryDir, squad);
  if (!existsSync(squadMemDir)) return null;

  let stateFile: string | null = null;
  try {
    const dirs = readdirSync(squadMemDir).filter(d => {
      const p = join(squadMemDir, d, 'state.md');
      return d.endsWith('-lead') && existsSync(p);
    });
    if (dirs.length > 0) {
      stateFile = join(squadMemDir, dirs[0], 'state.md');
    }
  } catch { return null; }

  if (!stateFile || !existsSync(stateFile)) return null;

  const content = readFileSync(stateFile, 'utf-8');

  // Extract status from frontmatter
  const statusMatch = content.match(/status:\s*"?(\w+)"?/);
  const status = statusMatch ? statusMatch[1] : 'unknown';

  // Extract first meaningful paragraph as summary
  const lines = content.split('\n');
  let summary = '';
  let inCurrent = false;
  for (const line of lines) {
    if (line.startsWith('## Current') || line.startsWith('## This Run') || line.startsWith('## What was done')) {
      inCurrent = true;
      continue;
    }
    if (inCurrent && line.startsWith('## ')) break;
    if (inCurrent && line.trim() && !line.startsWith('---') && !line.startsWith('#')) {
      summary = line.replace(/\*\*/g, '').replace(/[🔴🟡🟢✅❌]/g, '').trim();
      if (summary.length > 10) break;
    }
  }

  // Extract blockers
  const blockers: string[] = [];
  let inBlockers = false;
  for (const line of lines) {
    if (line.startsWith('## Blocker')) { inBlockers = true; continue; }
    if (inBlockers && line.startsWith('## ')) break;
    if (inBlockers && line.trim().startsWith('-')) {
      blockers.push(line.replace(/^-\s*/, '').replace(/\*\*/g, '').trim().slice(0, 80));
    }
  }

  return { status, summary: summary.slice(0, 100), blockers };
}

function statusIcon(status: string): string {
  switch (status) {
    case 'achieved':
    case 'complete': return `${colors.green}done${RESET}`;
    case 'in-progress':
    case 'improving': return `${colors.cyan}prog${RESET}`;
    case 'not-started': return `${colors.dim}todo${RESET}`;
    case 'blocked':
    case 'AT-RISK': return `${colors.red}risk${RESET}`;
    default: return `${colors.dim}${status.slice(0, 4)}${RESET}`;
  }
}

function daysUntil(dateStr: string): number | null {
  if (!dateStr || dateStr === 'ongoing') return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

// ── Main views ──────────────────────────────────────────────────────────

function parseSinceToISO(since: string): string {
  const match = since.match(/^(\d+)(h|d|w)$/);
  if (!match) return since; // assume ISO already
  const val = parseInt(match[1]);
  const unit = match[2];
  const ms = unit === 'h' ? val * 3600000 : unit === 'd' ? val * 86400000 : val * 604800000;
  return new Date(Date.now() - ms).toISOString();
}

function showOverview(squadsDir: string, memoryDir: string, since: string): void {
  const squadDirs = readdirSync(squadsDir).filter(d =>
    existsSync(join(squadsDir, d, 'SQUAD.md'))
  ).sort();

  // Get executions
  const sinceISO = parseSinceToISO(since);
  const execs = queryExecutions({ since: sinceISO, limit: 200 });
  const costSummary = calculateCostSummary('7d');

  // Group last execution per squad
  const lastExec = new Map<string, ObservabilityRecord>();
  for (const e of execs) {
    if (!lastExec.has(e.squad) || e.ts > lastExec.get(e.squad)!.ts) {
      lastExec.set(e.squad, e);
    }
  }

  // Collect all data
  const rows: Array<{
    squad: string;
    exec: ObservabilityRecord | null;
    goals: GoalInfo[];
    state: ReturnType<typeof readStateSnippet>;
  }> = [];

  for (const squad of squadDirs) {
    const goalsPath = join(memoryDir, squad, 'goals.md');
    const goals = parseGoalsDetailed(goalsPath);
    const state = readStateSnippet(memoryDir, squad);
    const exec = lastExec.get(squad) || null;

    // Skip frozen squads (no goals, no recent execution)
    if (goals.length === 0 && !exec) continue;

    rows.push({ squad, exec, goals, state });
  }

  // ── Header ──
  const totalCost = costSummary.total_cost;
  const totalRuns = costSummary.total_runs;
  const totalActive = rows.reduce((s, r) => s + r.goals.filter(g => g.section === 'active').length, 0);
  const totalAchieved = rows.reduce((s, r) => s + r.goals.filter(g => g.section === 'achieved').length, 0);
  const totalBlocked = rows.reduce((s, r) => s + r.goals.filter(g => g.status === 'blocked' || g.status === 'AT-RISK').length, 0);

  writeLine();
  writeLine(`  ${bold}Cycle Review${RESET}  ${totalRuns} runs | $${totalCost.toFixed(2)} (7d) | ${totalActive} active | ${colors.green}${totalAchieved} achieved${RESET} | ${totalBlocked > 0 ? colors.red : colors.dim}${totalBlocked} blocked${RESET}`);
  writeLine();

  // ── Table ──
  writeLine(`  ${'Squad'.padEnd(15)} ${'Last Run'.padEnd(10)} ${'Cost'.padStart(6)} ${'Goals'.padStart(5)} ${'Status'.padEnd(6)} Summary`);
  writeLine(`  ${'-'.repeat(90)}`);

  for (const r of rows) {
    const active = r.goals.filter(g => g.section === 'active').length;
    const achieved = r.goals.filter(g => g.section === 'achieved').length;
    const goalsStr = achieved > 0 ? `${active}/${active + achieved}` : `${active}`;

    let lastRunStr = '';
    let costStr = '';
    let statusStr = '';

    if (r.exec) {
      const d = new Date(r.exec.ts);
      lastRunStr = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      costStr = `$${r.exec.cost_usd.toFixed(2)}`;
      statusStr = r.exec.status === 'completed' ? `${colors.green}pass${RESET}` : `${colors.red}fail${RESET}`;
    } else {
      lastRunStr = `${colors.dim}none${RESET}    `;
      costStr = `${colors.dim}—${RESET}    `;
      statusStr = `${colors.dim}—${RESET}   `;
    }

    const summary = r.state?.summary || (r.exec?.goals_changed?.length
      ? r.exec.goals_changed.map(c => `${c.name}: ${c.before}→${c.after}`).join(', ')
      : '');

    writeLine(`  ${r.squad.padEnd(15)} ${lastRunStr.padEnd(10)} ${costStr.padStart(6)} ${goalsStr.padStart(5)} ${statusStr}  ${colors.dim}${summary.slice(0, 45)}${RESET}`);
  }

  // ── Attention needed ──
  const blocked = rows.flatMap(r =>
    r.goals.filter(g => g.status === 'blocked' || g.status === 'AT-RISK')
      .map(g => ({ squad: r.squad, ...g }))
  );

  const deadlines = rows.flatMap(r =>
    r.goals.filter(g => g.deadline && g.section === 'active')
      .map(g => ({ squad: r.squad, days: daysUntil(g.deadline!), ...g }))
      .filter(g => g.days !== null && g.days <= 14)
  ).sort((a, b) => (a.days || 99) - (b.days || 99));

  const allBlockers = rows.flatMap(r =>
    (r.state?.blockers || []).map(b => ({ squad: r.squad, blocker: b }))
  );

  if (blocked.length > 0 || deadlines.length > 0 || allBlockers.length > 0) {
    writeLine();
    writeLine(`  ${bold}Needs Attention${RESET}`);
  }

  if (deadlines.length > 0) {
    writeLine();
    for (const d of deadlines) {
      const urgency = (d.days || 0) <= 3 ? colors.red : colors.yellow;
      writeLine(`  ${urgency}${d.days}d${RESET}  ${d.squad}: ${d.name}`);
    }
  }

  if (blocked.length > 0) {
    writeLine();
    for (const b of blocked) {
      writeLine(`  ${colors.red}block${RESET}  ${b.squad}: ${b.name}${b.blocker ? ` — ${b.blocker.slice(0, 50)}` : ''}`);
    }
  }

  if (allBlockers.length > 0) {
    writeLine();
    for (const b of allBlockers) {
      writeLine(`  ${colors.yellow}wait${RESET}   ${b.squad}: ${b.blocker}`);
    }
  }

  // ── Goal changes ──
  const goalChanges = execs.filter(e => e.goals_changed && e.goals_changed.length > 0);
  if (goalChanges.length > 0) {
    writeLine();
    writeLine(`  ${bold}Goal Changes${RESET}`);
    writeLine();
    for (const e of goalChanges) {
      for (const c of e.goals_changed!) {
        writeLine(`  ${colors.green}${e.squad}${RESET}: ${c.name} ${colors.dim}${c.before} → ${c.after}${RESET}`);
      }
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}$ squads review --squad <name>    Detail view${RESET}`);
  writeLine(`  ${colors.dim}$ squads feedback <squad> "msg"   Add feedback${RESET}`);
  writeLine();
}

function showSquadDetail(squad: string, memoryDir: string): void {
  writeLine();
  writeLine(`  ${bold}${squad}${RESET}`);

  // ── Goals ──
  const goalsPath = join(memoryDir, squad, 'goals.md');
  const goals = parseGoalsDetailed(goalsPath);

  if (goals.length > 0) {
    writeLine();
    writeLine(`  ${bold}Goals${RESET}`);
    for (const section of ['active', 'achieved', 'abandoned', 'proposed'] as const) {
      const sectionGoals = goals.filter(g => g.section === section);
      if (sectionGoals.length === 0) continue;

      writeLine(`  ${colors.cyan}${section.toUpperCase()}${RESET}`);
      for (const g of sectionGoals) {
        const days = g.deadline ? daysUntil(g.deadline) : null;
        const deadlineStr = days !== null ? ` ${days <= 7 ? colors.red : colors.dim}(${days}d)${RESET}` : '';
        const blockerStr = g.blocker ? ` ${colors.red}← ${g.blocker.slice(0, 40)}${RESET}` : '';
        writeLine(`    ${statusIcon(g.status)}  ${g.name}${deadlineStr}${blockerStr}`);
      }
    }
  }

  // ── Recent executions ──
  const execs = queryExecutions({ squad, limit: 5 });
  if (execs.length > 0) {
    writeLine();
    writeLine(`  ${bold}Recent Runs${RESET}`);
    for (const e of execs) {
      const d = new Date(e.ts);
      const dateStr = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      const statusIcon2 = e.status === 'completed' ? `${colors.green}pass${RESET}` : `${colors.red}fail${RESET}`;
      const dur = Math.round(e.duration_ms / 60000);
      const changes = e.goals_changed?.length || 0;
      writeLine(`    ${statusIcon2}  ${dateStr}  ${dur}m  $${e.cost_usd.toFixed(2)}  ${e.agent}${changes > 0 ? `  ${colors.green}${changes} goal changes${RESET}` : ''}`);
    }
  }

  // ── State ──
  const state = readStateSnippet(memoryDir, squad);
  if (state) {
    writeLine();
    writeLine(`  ${bold}Lead State${RESET}  ${state.status}`);
    if (state.summary) writeLine(`    ${state.summary}`);
    if (state.blockers.length > 0) {
      writeLine(`  ${bold}Blockers${RESET}`);
      for (const b of state.blockers) {
        writeLine(`    ${colors.red}-${RESET} ${b}`);
      }
    }
  }

  writeLine();
}

// ── Register ────────────────────────────────────────────────────────────

export function registerReviewCommand(program: Command): void {
  program
    .command('review')
    .description('Post-cycle evaluation — goals, costs, blockers at a glance')
    .option('-s, --squad <squad>', 'Detail view for a specific squad')
    .option('--since <period>', 'Look back period (e.g. 24h, 7d, 30d)', '48h')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const squadsDir = findSquadsDir();
      const memoryDir = findMemoryDir();
      if (!squadsDir || !memoryDir) {
        writeLine(`\n  ${colors.dim}No squads found. Run squads init.${RESET}\n`);
        return;
      }

      if (opts.squad) {
        showSquadDetail(opts.squad, memoryDir);
      } else {
        showOverview(squadsDir, memoryDir, opts.since);
      }
    });
}
