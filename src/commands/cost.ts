import {
  fetchBridgeStats,
  BridgeStats,
  detectPlan,
  PlanDetection,
} from '../lib/costs.js';
import {
  findSquadsDir,
  loadSquad,
  listSquads,
} from '../lib/squad-parser.js';
import { track, Events } from '../lib/telemetry.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  writeLine,
} from '../lib/terminal.js';

interface CostOptions {
  squad?: string;
  json?: boolean;
}

interface BudgetStatus {
  squad: string;
  spent: number;
  dailyBudget: number | null;
  weeklyBudget: number | null;
  dailyPercent: number | null;
  weeklyPercent: number | null;
  status: 'ok' | 'warning' | 'over' | 'no-budget';
}

function getBudgetStatus(
  squadName: string,
  spent: number,
  dailyBudget: number | null,
  weeklyBudget: number | null
): BudgetStatus {
  let status: BudgetStatus['status'] = 'no-budget';
  let dailyPercent: number | null = null;
  let weeklyPercent: number | null = null;

  if (dailyBudget !== null) {
    dailyPercent = (spent / dailyBudget) * 100;
    if (dailyPercent >= 100) {
      status = 'over';
    } else if (dailyPercent >= 80) {
      status = 'warning';
    } else {
      status = 'ok';
    }
  }

  if (weeklyBudget !== null) {
    weeklyPercent = (spent / weeklyBudget) * 100;
  }

  return {
    squad: squadName,
    spent,
    dailyBudget,
    weeklyBudget,
    dailyPercent,
    weeklyPercent,
    status,
  };
}

export async function costCommand(options: CostOptions = {}): Promise<void> {

  const stats = await fetchBridgeStats();
  const plan = detectPlan();

  if (options.json) {
    const result = buildJsonOutput(stats, plan, options.squad);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}cost${RESET}${options.squad ? ` ${colors.cyan}${options.squad}${RESET}` : ''}`);
  writeLine();

  if (!stats) {
    writeLine(`  ${colors.yellow}⚠ Bridge unavailable${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads login\` to connect to cloud services${RESET}`);
    writeLine();
    return;
  }

  // Today summary
  const todaySection = `  ${bold}Today${RESET}`;
  writeLine(todaySection);
  writeLine(`  ${colors.cyan}$${stats.today.costUsd.toFixed(2)}${RESET} ${colors.dim}|${RESET} ${stats.today.generations.toLocaleString()} calls ${colors.dim}|${RESET} ${formatTokens(stats.today.inputTokens + stats.today.outputTokens)} tokens`);

  // Model breakdown for today
  if (stats.byModel && stats.byModel.length > 0) {
    const modelParts = stats.byModel
      .filter(m => m.costUsd > 0)
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 4)
      .map(m => `${colors.dim}${shortModelName(m.model)}${RESET} $${m.costUsd.toFixed(0)}`);
    if (modelParts.length > 0) {
      writeLine(`  ${colors.dim}Models:${RESET} ${modelParts.join(' · ')}`);
    }
  }

  writeLine();

  // Week summary (if available)
  if (stats.week) {
    writeLine(`  ${bold}Week${RESET}`);
    writeLine(`  ${colors.purple}$${stats.week.costUsd.toFixed(2)}${RESET} ${colors.dim}|${RESET} ${stats.week.generations.toLocaleString()} calls ${colors.dim}|${RESET} ${formatTokens(stats.week.inputTokens + stats.week.outputTokens)} tokens`);
    writeLine();
  }

  // Budget status
  writeLine(`  ${bold}Budget${RESET} ${colors.dim}(daily)${RESET}`);
  const budgetBar = createBudgetBar(stats.budget.usedPct);
  const budgetColor = stats.budget.usedPct >= 100 ? colors.red :
                      stats.budget.usedPct >= 80 ? colors.yellow : colors.green;
  writeLine(`  ${budgetBar} ${budgetColor}$${stats.budget.used.toFixed(0)}${RESET}/${colors.dim}$${stats.budget.daily}${RESET} (${stats.budget.usedPct.toFixed(0)}%)`);
  writeLine();

  // Per-squad breakdown with budget comparison
  if (stats.bySquad && stats.bySquad.length > 0 && !options.squad) {
    writeLine(`  ${bold}By Squad${RESET}`);
    writeLine();

    const squadsDir = findSquadsDir();
    const squadBudgets = new Map<string, { daily: number | null; weekly: number | null }>();

    if (squadsDir) {
      for (const name of listSquads(squadsDir)) {
        const squad = loadSquad(name);
        if (squad?.context?.budget) {
          squadBudgets.set(name, {
            daily: squad.context.budget.daily || null,
            weekly: squad.context.budget.weekly || null,
          });
        }
      }
    }

    const tableWidth = 52;
    writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

    const w = { name: 14, spent: 10, budget: 12, status: 14 };
    const header = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${bold}${padEnd('SQUAD', w.name)}${RESET}` +
      `${bold}${padEnd('SPENT', w.spent)}${RESET}` +
      `${bold}${padEnd('BUDGET', w.budget)}${RESET}` +
      `${bold}STATUS${RESET}` +
      ` ${colors.purple}${box.vertical}${RESET}`;
    writeLine(header);

    writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

    for (const sq of stats.bySquad.sort((a, b) => b.costUsd - a.costUsd)) {
      const budgetInfo = squadBudgets.get(sq.squad);
      const dailyBudget = budgetInfo?.daily || null;

      const spentStr = `$${sq.costUsd.toFixed(2)}`;
      const budgetStr = dailyBudget ? `$${dailyBudget}/d` : `${colors.dim}—${RESET}`;

      let statusStr: string;
      if (dailyBudget) {
        const pct = (sq.costUsd / dailyBudget) * 100;
        if (pct >= 100) {
          statusStr = `${colors.red}● OVER${RESET}`;
        } else if (pct >= 80) {
          statusStr = `${colors.yellow}● ${pct.toFixed(0)}%${RESET}`;
        } else {
          statusStr = `${colors.green}✓ ${pct.toFixed(0)}%${RESET}`;
        }
      } else {
        statusStr = `${colors.dim}no budget${RESET}`;
      }

      const row = `  ${colors.purple}${box.vertical}${RESET} ` +
        `${colors.cyan}${padEnd(sq.squad, w.name)}${RESET}` +
        `${padEnd(spentStr, w.spent)}` +
        `${padEnd(budgetStr, w.budget)}` +
        `${padEnd(statusStr, w.status)}` +
        `${colors.purple}${box.vertical}${RESET}`;

      writeLine(row);
    }

    writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
    writeLine();
  }

  // Single squad detail
  if (options.squad) {
    const squadStats = stats.bySquad?.find(s => s.squad === options.squad);
    const squad = loadSquad(options.squad);

    if (squadStats) {
      writeLine(`  ${bold}Squad: ${options.squad}${RESET}`);
      writeLine(`  Spent today: ${colors.cyan}$${squadStats.costUsd.toFixed(2)}${RESET}`);
      writeLine(`  Calls: ${squadStats.generations.toLocaleString()}`);

      if (squad?.context?.budget) {
        const daily = squad.context.budget.daily;
        const weekly = squad.context.budget.weekly;

        if (daily) {
          const pct = (squadStats.costUsd / daily) * 100;
          const statusIcon = pct >= 100 ? `${colors.red}●${RESET}` :
                            pct >= 80 ? `${colors.yellow}●${RESET}` : `${colors.green}✓${RESET}`;
          writeLine(`  Daily budget: ${statusIcon} $${squadStats.costUsd.toFixed(2)}/$${daily} (${pct.toFixed(0)}%)`);
        }

        if (weekly) {
          writeLine(`  Weekly budget: $${weekly}/week`);
        }
      } else {
        writeLine(`  ${colors.dim}No budget defined in SQUAD.md frontmatter${RESET}`);
      }
    } else {
      writeLine(`  ${colors.dim}No cost data for squad "${options.squad}"${RESET}`);
    }
    writeLine();
  }

  // Plan info
  writeLine(`  ${colors.dim}Plan: ${plan.plan} (${plan.reason})${RESET}`);
  writeLine();
}

export async function budgetCheckCommand(
  squadName: string,
  options: { json?: boolean } = {}
): Promise<void> {

  const stats = await fetchBridgeStats();
  const squad = loadSquad(squadName);

  if (!stats) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'Bridge unavailable' }));
    } else {
      writeLine(`  ${colors.yellow}⚠ Bridge unavailable${RESET}`);
    }
    return;
  }

  const squadStats = stats.bySquad?.find(s => s.squad === squadName);
  const spent = squadStats?.costUsd || 0;
  const dailyBudget = squad?.context?.budget?.daily || null;
  const weeklyBudget = squad?.context?.budget?.weekly || null;

  const status = getBudgetStatus(squadName, spent, dailyBudget, weeklyBudget);

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  writeLine();

  if (status.status === 'no-budget') {
    writeLine(`  ${colors.dim}○${RESET} ${colors.cyan}${squadName}${RESET}: No budget defined`);
    writeLine(`  ${colors.dim}Add budget to SQUAD.md frontmatter:${RESET}`);
    writeLine(`  ${colors.dim}  context:${RESET}`);
    writeLine(`  ${colors.dim}    budget: { daily: 50 }${RESET}`);
  } else if (status.status === 'over') {
    writeLine(`  ${colors.red}●${RESET} ${colors.cyan}${squadName}${RESET}: ${colors.red}OVER BUDGET${RESET}`);
    writeLine(`  $${spent.toFixed(2)}/$${dailyBudget} daily (${status.dailyPercent?.toFixed(0)}%)`);
  } else if (status.status === 'warning') {
    writeLine(`  ${colors.yellow}●${RESET} ${colors.cyan}${squadName}${RESET}: ${colors.yellow}Approaching limit${RESET}`);
    writeLine(`  $${spent.toFixed(2)}/$${dailyBudget} daily (${status.dailyPercent?.toFixed(0)}%)`);
  } else {
    writeLine(`  ${colors.green}✓${RESET} ${colors.cyan}${squadName}${RESET}: OK to proceed`);
    writeLine(`  $${spent.toFixed(2)}/$${dailyBudget} daily (${status.dailyPercent?.toFixed(0)}%)`);
  }

  writeLine();
}

function buildJsonOutput(
  stats: BridgeStats | null,
  plan: PlanDetection,
  squadFilter?: string
): object {
  if (!stats) {
    return { error: 'Bridge unavailable', plan };
  }

  const squadsDir = findSquadsDir();
  const squadBudgets: Record<string, { daily: number | null; weekly: number | null }> = {};

  if (squadsDir) {
    for (const name of listSquads(squadsDir)) {
      const squad = loadSquad(name);
      if (squad?.context?.budget) {
        squadBudgets[name] = {
          daily: squad.context.budget.daily || null,
          weekly: squad.context.budget.weekly || null,
        };
      }
    }
  }

  const bySquadWithBudget = stats.bySquad?.map(sq => ({
    ...sq,
    budget: squadBudgets[sq.squad] || null,
    budgetStatus: squadBudgets[sq.squad]?.daily
      ? getBudgetStatus(sq.squad, sq.costUsd, squadBudgets[sq.squad].daily, squadBudgets[sq.squad].weekly)
      : null,
  }));

  if (squadFilter) {
    const filtered = bySquadWithBudget?.find(s => s.squad === squadFilter);
    return {
      squad: squadFilter,
      ...filtered,
      plan,
    };
  }

  return {
    today: stats.today,
    week: stats.week,
    budget: stats.budget,
    bySquad: bySquadWithBudget,
    byModel: stats.byModel,
    plan,
    source: stats.source,
  };
}

function shortModelName(model: string): string {
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return model.split('-')[0];
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(0)}k`;
  }
  return tokens.toString();
}

function createBudgetBar(percent: number, width = 10): string {
  const filled = Math.min(Math.round((percent / 100) * width), width);
  const empty = width - filled;

  const filledChar = '━';
  const emptyChar = '━';

  const color = percent >= 100 ? colors.red :
                percent >= 80 ? colors.yellow : colors.green;

  return `${color}${filledChar.repeat(filled)}${colors.dim}${emptyChar.repeat(empty)}${RESET}`;
}
