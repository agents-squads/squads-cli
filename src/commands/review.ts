/**
 * squads review — post-cycle evaluation dashboard.
 *
 * Optimized for founder + COO:
 * - Overview: scan all squads in 10 seconds
 * - Founder actions: what needs human input (separated from agent blockers)
 * - Goal progress: only meaningful changes (achieved, blocked, new — not churn)
 * - Cost efficiency: cost per goal change
 * - Detail: drill into any squad
 */

import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { findSquadsDir } from '../lib/squad-parser.js';
import { findMemoryDir } from '../lib/memory.js';
import { queryExecutions, calculateCostSummary, type ObservabilityRecord } from '../lib/observability.js';
import { colors, bold, RESET, writeLine } from '../lib/terminal.js';

// ── Types ───────────────────────────────────────────────────────────────

interface GoalInfo {
  name: string;
  status: string;
  section: 'active' | 'achieved' | 'abandoned' | 'proposed';
  deadline?: string;
  blocker?: string;
}

interface GoalChange {
  name: string;
  before: string;
  after: string;
}

interface SquadRow {
  squad: string;
  exec: ObservabilityRecord | null;
  goals: GoalInfo[];
  status: string;
  topAction: string;
  founderBlockers: string[];
  agentBlockers: string[];
}

// ── Parsers ─────────────────────────────────────────────────────────────

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

function readLeadState(memoryDir: string, squad: string): {
  status: string;
  topAction: string;
  founderBlockers: string[];
  agentBlockers: string[];
} {
  const squadMemDir = join(memoryDir, squad);
  if (!existsSync(squadMemDir)) return { status: 'unknown', topAction: '', founderBlockers: [], agentBlockers: [] };

  let stateFile: string | null = null;
  try {
    const dirs = readdirSync(squadMemDir).filter(d =>
      d.endsWith('-lead') && existsSync(join(squadMemDir, d, 'state.md'))
    );
    if (dirs.length > 0) stateFile = join(squadMemDir, dirs[0], 'state.md');
  } catch { /* */ }

  if (!stateFile) return { status: 'unknown', topAction: '', founderBlockers: [], agentBlockers: [] };

  const content = readFileSync(stateFile, 'utf-8');
  const lines = content.split('\n');

  // Status from frontmatter
  const statusMatch = content.match(/status:\s*"?(\w+)"?/);
  const status = statusMatch ? statusMatch[1] : 'unknown';

  // Top action: first completed item (✅, [x], Done, DONE) or first bullet under ## Current / ## Actions
  let topAction = '';
  let inActions = false;
  for (const line of lines) {
    if (/^## (Current|Actions|This Run|What was done|Done|Completed)/i.test(line)) {
      inActions = true;
      continue;
    }
    if (inActions && line.startsWith('## ')) break;
    if (inActions && line.trim()) {
      // Look for completed items first
      const cleaned = line.replace(/\*\*/g, '').replace(/[\u{1F534}\u{1F7E1}\u{1F7E2}\u{2705}\u{274C}\u2713]/gu, '').replace(/^[-*]\s*/, '').replace(/^\[x\]\s*/i, '').trim();
      if (cleaned.length > 10 && !cleaned.startsWith('---')) {
        topAction = cleaned.slice(0, 60);
        break;
      }
    }
  }

  // Blockers: split by founder-needing vs agent-resolvable
  const founderBlockers: string[] = [];
  const agentBlockers: string[] = [];
  let inBlockers = false;

  for (const line of lines) {
    if (/^## Blocker/i.test(line)) { inBlockers = true; continue; }
    if (inBlockers && line.startsWith('## ')) break;
    if (inBlockers && line.trim().startsWith('-')) {
      const text = line.replace(/^-\s*/, '').replace(/\*\*/g, '').trim();
      if (!text || text.toLowerCase() === 'none' || text === '(none)') continue;

      const link = extractLink(text);
      const entry = link ? `${text.slice(0, 65)}\n         ${colors.dim}${link}${RESET}` : text.slice(0, 80);

      // Founder blockers: mention founder, kokevidaurre, needs:human, "enable", "login", "auth"
      const isFounder = /founder|kokevidaurre|needs:human|needs founder|assigned to founder|enable at|auth login|bank cartola|CPA/i.test(text);
      if (isFounder) {
        founderBlockers.push(entry);
      } else {
        agentBlockers.push(entry);
      }
    }
  }

  return { status, topAction, founderBlockers, agentBlockers };
}

function statusIcon(status: string): string {
  switch (status) {
    case 'achieved': case 'complete': return `${colors.green}done${RESET}`;
    case 'in-progress': case 'improving': return `${colors.cyan}prog${RESET}`;
    case 'not-started': return `${colors.dim}todo${RESET}`;
    case 'blocked': case 'AT-RISK': return `${colors.red}risk${RESET}`;
    default: return `${colors.dim}${status.slice(0, 4)}${RESET}`;
  }
}

function daysUntil(dateStr: string): number | null {
  if (!dateStr || dateStr === 'ongoing') return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

/** Extract a URL or GitHub issue link from text */
function extractLink(text: string): string {
  // Direct URL
  const urlMatch = text.match(/(https?:\/\/[^\s)]+)/);
  if (urlMatch) return urlMatch[1];

  // Issue reference: "repo#N" or "#N" with repo context
  const repoIssue = text.match(/([a-z][\w-]*)#(\d+)/i);
  if (repoIssue) {
    const repo = repoIssue[1];
    const num = repoIssue[2];
    return `https://github.com/agents-squads/${repo}/issues/${num}`;
  }

  // Bare #N — can't resolve without repo context
  return '';
}

function parseSinceToISO(since: string): string {
  const match = since.match(/^(\d+)(h|d|w)$/);
  if (!match) return since;
  const val = parseInt(match[1]);
  const unit = match[2];
  const ms = unit === 'h' ? val * 3600000 : unit === 'd' ? val * 86400000 : val * 604800000;
  return new Date(Date.now() - ms).toISOString();
}

// ── Overview ────────────────────────────────────────────────────────────

function showOverview(squadsDir: string, memoryDir: string, since: string): void {
  const squadDirs = readdirSync(squadsDir).filter(d =>
    existsSync(join(squadsDir, d, 'SQUAD.md'))
  ).sort();

  const sinceISO = parseSinceToISO(since);
  const execs = queryExecutions({ since: sinceISO, limit: 500 });
  const costSummary = calculateCostSummary('7d');

  // Last execution per squad
  const lastExec = new Map<string, ObservabilityRecord>();
  for (const e of execs) {
    if (!lastExec.has(e.squad) || e.ts > lastExec.get(e.squad)!.ts) {
      lastExec.set(e.squad, e);
    }
  }

  // Build rows
  const rows: SquadRow[] = [];
  for (const squad of squadDirs) {
    const goals = parseGoalsDetailed(join(memoryDir, squad, 'goals.md'));
    const exec = lastExec.get(squad) || null;
    if (goals.length === 0 && !exec) continue; // frozen

    const state = readLeadState(memoryDir, squad);
    rows.push({ squad, exec, goals, ...state });
  }

  // ── Metrics ──
  const totalActive = rows.reduce((s, r) => s + r.goals.filter(g => g.section === 'active').length, 0);
  const totalAchieved = rows.reduce((s, r) => s + r.goals.filter(g => g.section === 'achieved').length, 0);
  const totalBlocked = rows.reduce((s, r) => s + r.goals.filter(g => g.status === 'blocked' || g.status === 'AT-RISK').length, 0);
  const meaningfulChanges = execs.reduce((s, e) => s + (e.goals_changed?.filter(c =>
    c.after === 'achieved' || c.after === 'blocked' || c.before === 'not-started'
  ).length || 0), 0);
  const costPerChange = meaningfulChanges > 0 ? costSummary.total_cost / meaningfulChanges : 0;

  writeLine();
  writeLine(`  ${bold}Cycle Review${RESET}`);
  writeLine(`  ${costSummary.total_runs} runs  $${costSummary.total_cost.toFixed(0)} (7d)  ${costPerChange > 0 ? `$${costPerChange.toFixed(1)}/goal-change` : ''}  ${totalActive} active  ${colors.green}${totalAchieved} achieved${RESET}  ${totalBlocked > 0 ? `${colors.red}${totalBlocked} blocked${RESET}` : ''}`);
  writeLine();

  // ── Squad table ──
  writeLine(`  ${'Squad'.padEnd(15)} ${'Run'.padEnd(8)} ${'$'.padStart(5)} ${'G'.padStart(4)} Top Action`);
  writeLine(`  ${'-'.repeat(80)}`);

  for (const r of rows) {
    const active = r.goals.filter(g => g.section === 'active').length;
    const achieved = r.goals.filter(g => g.section === 'achieved').length;
    const goalStr = achieved > 0 ? `${colors.green}${achieved}${RESET}/${active + achieved}` : `${active}`;

    let runStr: string;
    let costStr: string;
    if (r.exec) {
      const d = new Date(r.exec.ts);
      const ago = Math.round((Date.now() - d.getTime()) / 3600000);
      runStr = ago < 24 ? `${ago}h ago` : `${Math.round(ago / 24)}d ago`;
      costStr = `$${r.exec.cost_usd.toFixed(1)}`;
      if (r.exec.status !== 'completed') {
        runStr = `${colors.red}${runStr}${RESET}`;
      }
    } else {
      runStr = `${colors.dim}—${RESET}      `;
      costStr = `${colors.dim}—${RESET}   `;
    }

    const action = r.topAction || `${colors.dim}(no state)${RESET}`;
    writeLine(`  ${r.squad.padEnd(15)} ${runStr.padEnd(8)} ${costStr.padStart(5)} ${goalStr.padStart(4)}  ${action}`);
  }

  // ── Founder Action Required ──
  const founderItems = rows.flatMap(r =>
    r.founderBlockers.map(b => ({ squad: r.squad, text: b }))
  );

  // Add deadline-driven items
  const urgentDeadlines = rows.flatMap(r =>
    r.goals.filter(g => g.deadline && g.section === 'active')
      .map(g => ({ squad: r.squad, days: daysUntil(g.deadline!), name: g.name }))
      .filter(g => g.days !== null && g.days <= 14)
  ).sort((a, b) => (a.days || 99) - (b.days || 99));

  if (founderItems.length > 0 || urgentDeadlines.length > 0) {
    writeLine();
    writeLine(`  ${bold}Founder Action${RESET}`);

    for (const d of urgentDeadlines) {
      const color = (d.days || 0) <= 3 ? colors.red : colors.yellow;
      writeLine(`  ${color}${String(d.days).padStart(2)}d${RESET}  ${d.squad}: ${d.name}`);
    }

    for (const f of founderItems) {
      writeLine(`  ${colors.yellow}>>>${RESET}  ${f.squad}: ${f.text.slice(0, 70)}`);
    }
  }

  // ── Blocked goals (agent-resolvable) ──
  const blockedGoals = rows.flatMap(r =>
    r.goals.filter(g => g.status === 'blocked' || g.status === 'AT-RISK')
      .map(g => ({ squad: r.squad, name: g.name, blocker: g.blocker }))
  );

  if (blockedGoals.length > 0) {
    writeLine();
    writeLine(`  ${bold}Blocked Goals${RESET}`);
    for (const b of blockedGoals) {
      const link = b.blocker ? extractLink(b.blocker) : '';
      writeLine(`  ${colors.red}block${RESET}  ${b.squad}: ${b.name}${b.blocker ? ` ${colors.dim}← ${b.blocker.slice(0, 45)}${RESET}` : ''}`);
      if (link) writeLine(`         ${colors.dim}${link}${RESET}`);
    }
  }

  // ── Goal changes: only meaningful (achieved, blocked, new starts) ──
  const allChanges: Array<{ squad: string; change: GoalChange }> = [];
  for (const e of execs) {
    if (!e.goals_changed) continue;
    for (const c of e.goals_changed) {
      // Skip noise: in-progress→in-progress, status churn
      if (c.before === c.after) continue;
      // Only show: achieved, blocked, removed, or first start
      const isMeaningful =
        c.after === 'achieved' || c.after === 'blocked' || c.after === 'removed' ||
        c.before === 'not-started' || c.before === 'new' ||
        c.after === 'AT-RISK';
      if (isMeaningful) {
        // Deduplicate: keep only latest change per goal per squad
        const existing = allChanges.findIndex(x => x.squad === e.squad && x.change.name === c.name);
        if (existing >= 0) {
          allChanges[existing] = { squad: e.squad, change: c };
        } else {
          allChanges.push({ squad: e.squad, change: c });
        }
      }
    }
  }

  // Group by type for readability
  const achieved = allChanges.filter(c => c.change.after === 'achieved');
  const blocked = allChanges.filter(c => c.change.after === 'blocked' || c.change.after === 'AT-RISK');
  const started = allChanges.filter(c => c.change.before === 'not-started' || c.change.before === 'new');
  const removed = allChanges.filter(c => c.change.after === 'removed');

  if (allChanges.length > 0) {
    writeLine();
    writeLine(`  ${bold}Goal Changes${RESET}  ${achieved.length} achieved  ${started.length} started  ${blocked.length} blocked  ${removed.length} removed`);

    if (achieved.length > 0) {
      for (const c of achieved) {
        writeLine(`  ${colors.green}achieved${RESET}  ${c.squad}: ${c.change.name}`);
      }
    }
    if (blocked.length > 0) {
      for (const c of blocked) {
        writeLine(`  ${colors.red}blocked${RESET}   ${c.squad}: ${c.change.name}`);
      }
    }
    if (started.length > 0 && started.length <= 8) {
      for (const c of started) {
        writeLine(`  ${colors.cyan}started${RESET}   ${c.squad}: ${c.change.name}`);
      }
    } else if (started.length > 8) {
      writeLine(`  ${colors.cyan}started${RESET}   ${started.length} goals across ${new Set(started.map(s => s.squad)).size} squads`);
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}squads review --squad <name>   drill into squad${RESET}`);
  writeLine();
}

// ── Squad Detail ────────────────────────────────────────────────────────

function showSquadDetail(squad: string, memoryDir: string): void {
  writeLine();
  writeLine(`  ${bold}${squad}${RESET}`);

  // Goals
  const goals = parseGoalsDetailed(join(memoryDir, squad, 'goals.md'));
  if (goals.length > 0) {
    writeLine();
    for (const section of ['active', 'achieved', 'abandoned', 'proposed'] as const) {
      const sg = goals.filter(g => g.section === section);
      if (sg.length === 0) continue;
      writeLine(`  ${colors.cyan}${section.toUpperCase()}${RESET}`);
      for (const g of sg) {
        const days = g.deadline ? daysUntil(g.deadline) : null;
        const dl = days !== null ? ` ${days <= 7 ? colors.red : colors.dim}(${days}d)${RESET}` : '';
        const bl = g.blocker ? ` ${colors.red}← ${g.blocker.slice(0, 45)}${RESET}` : '';
        writeLine(`    ${statusIcon(g.status)}  ${g.name}${dl}${bl}`);
      }
    }
  }

  // Runs
  const execs = queryExecutions({ squad, limit: 5 });
  if (execs.length > 0) {
    writeLine();
    writeLine(`  ${bold}Runs${RESET}`);
    for (const e of execs) {
      const d = new Date(e.ts);
      const date = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      const icon = e.status === 'completed' ? `${colors.green}pass${RESET}` : `${colors.red}fail${RESET}`;
      const dur = Math.round(e.duration_ms / 60000);
      const gc = e.goals_changed?.length || 0;
      writeLine(`    ${icon}  ${date}  ${dur}m  $${e.cost_usd.toFixed(2)}  ${e.agent}${gc > 0 ? `  ${colors.green}+${gc} goals${RESET}` : ''}`);
    }

    // Cost trend
    const totalCost = execs.reduce((s, e) => s + e.cost_usd, 0);
    const totalGoalChanges = execs.reduce((s, e) => s + (e.goals_changed?.length || 0), 0);
    writeLine(`    ${colors.dim}total: $${totalCost.toFixed(2)} / ${totalGoalChanges} goal changes${RESET}`);
  }

  // State + blockers
  const state = readLeadState(memoryDir, squad);
  if (state.topAction) {
    writeLine();
    writeLine(`  ${bold}Last Action${RESET}  ${state.topAction}`);
  }

  if (state.founderBlockers.length > 0) {
    writeLine();
    writeLine(`  ${bold}${colors.yellow}Founder Action${RESET}`);
    for (const b of state.founderBlockers) writeLine(`    ${colors.yellow}>>>${RESET} ${b}`);
  }

  if (state.agentBlockers.length > 0) {
    writeLine();
    writeLine(`  ${bold}Agent Blockers${RESET}`);
    for (const b of state.agentBlockers) writeLine(`    ${colors.dim}-${RESET} ${b}`);
  }

  writeLine();
}

// ── Register ────────────────────────────────────────────────────────────

export function registerReviewCommand(program: Command): void {
  program
    .command('review')
    .description('Post-cycle evaluation — goals, costs, blockers, founder actions')
    .option('-s, --squad <squad>', 'Detail view for a specific squad')
    .option('--since <period>', 'Look back period (e.g. 24h, 7d, 30d)', '7d')
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
