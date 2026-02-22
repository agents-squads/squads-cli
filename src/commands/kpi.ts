import { Command } from 'commander';
/**
 * KPI Command
 *
 * Track and analyze squad KPIs defined in SQUAD.md frontmatter.
 * Commands: define, record, show, trend, insights
 */

import {
  loadSquad,
  findSquadsDir,
  listSquads,
} from '../lib/squad-parser.js';
import {
  KpiDefinition,
  Kpi,
  recordKpiValue,
  getKpiState,
  generateKpiInsight,
  parseKpiDefinitions,
  getValuesForPeriod,
} from '../lib/kpi.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine,
} from '../lib/terminal.js';
import { track, Events } from '../lib/telemetry.js';

/**
 * Show KPI status for a squad
 */
export async function kpiShowCommand(
  squadName: string,
  options: { json?: boolean } = {}
): Promise<void> {
  await track(Events.CLI_KPI_SHOW, { squad: squadName });

  const squad = loadSquad(squadName);
  if (!squad) {
    writeLine(`  ${colors.red}Squad "${squadName}" not found${RESET}`);
    return;
  }

  const definitions = parseKpiDefinitions(squad.frontmatter);

  if (definitions.length === 0) {
    writeLine();
    writeLine(`  ${colors.yellow}No KPIs defined for ${squadName}${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Define KPIs in SQUAD.md frontmatter:${RESET}`);
    writeLine(`  ${colors.dim}---${RESET}`);
    writeLine(`  ${colors.dim}kpis:${RESET}`);
    writeLine(`  ${colors.dim}  - name: "leads_generated"${RESET}`);
    writeLine(`  ${colors.dim}    target: 10${RESET}`);
    writeLine(`  ${colors.dim}    unit: "leads"${RESET}`);
    writeLine(`  ${colors.dim}    period: weekly${RESET}`);
    writeLine(`  ${colors.dim}---${RESET}`);
    writeLine();
    return;
  }

  const kpis: Kpi[] = definitions.map(def => getKpiState(def, squadName));

  if (options.json) {
    console.log(JSON.stringify(kpis, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}kpi show${RESET} ${colors.cyan}${squadName}${RESET}`);
  writeLine();

  for (const kpi of kpis) {
    const insight = generateKpiInsight(kpi);

    if (insight) {
      writeLine(`  ${insight}`);
    } else {
      writeLine(`  ${colors.dim}○${RESET} ${kpi.name}: ${colors.dim}No data recorded${RESET}`);
    }

    if (kpi.description) {
      writeLine(`    ${colors.dim}${kpi.description}${RESET}`);
    }
  }

  writeLine();
}

/**
 * Record a KPI value
 */
export async function kpiRecordCommand(
  squadName: string,
  kpiName: string,
  value: string,
  options: { note?: string; json?: boolean } = {}
): Promise<void> {
  await track(Events.CLI_KPI_RECORD, { squad: squadName, kpi: kpiName });

  const squad = loadSquad(squadName);
  if (!squad) {
    writeLine(`  ${colors.red}Squad "${squadName}" not found${RESET}`);
    return;
  }

  const definitions = parseKpiDefinitions(squad.frontmatter);
  const definition = definitions.find(d => d.name === kpiName);

  if (!definition) {
    writeLine(`  ${colors.red}KPI "${kpiName}" not defined in ${squadName}${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Available KPIs:${RESET}`);
    for (const def of definitions) {
      writeLine(`  ${colors.dim}  - ${def.name}${RESET}`);
    }
    return;
  }

  const numValue = parseFloat(value);
  if (isNaN(numValue)) {
    writeLine(`  ${colors.red}Invalid value: ${value}${RESET}`);
    return;
  }

  const record = recordKpiValue(squadName, kpiName, numValue, options.note);

  if (options.json) {
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${icons.success} Recorded ${colors.cyan}${kpiName}${RESET}: ${bold}${numValue}${RESET} ${definition.unit}`);
  if (options.note) {
    writeLine(`  ${colors.dim}Note: ${options.note}${RESET}`);
  }

  // Show progress toward target
  const percentOfTarget = Math.round((numValue / definition.target) * 100);
  const statusEmoji = percentOfTarget >= 100 ? '✅' : percentOfTarget >= 70 ? '🟡' : '🔴';
  writeLine(`  ${statusEmoji} ${percentOfTarget}% of target (${definition.target} ${definition.unit}/${definition.period})`);
  writeLine();
}

/**
 * Show KPI trend over time
 */
export async function kpiTrendCommand(
  squadName: string,
  kpiName: string,
  options: { periods?: string; json?: boolean } = {}
): Promise<void> {
  await track(Events.CLI_KPI_TREND, { squad: squadName, kpi: kpiName });

  const squad = loadSquad(squadName);
  if (!squad) {
    writeLine(`  ${colors.red}Squad "${squadName}" not found${RESET}`);
    return;
  }

  const definitions = parseKpiDefinitions(squad.frontmatter);
  const definition = definitions.find(d => d.name === kpiName);

  if (!definition) {
    writeLine(`  ${colors.red}KPI "${kpiName}" not defined in ${squadName}${RESET}`);
    return;
  }

  const kpi = getKpiState(definition, squadName);
  const periods = parseInt(options.periods || '7', 10);
  const values = getValuesForPeriod(kpi.history, definition.period, periods);

  if (options.json) {
    console.log(JSON.stringify({
      kpi: kpiName,
      definition,
      trend: kpi.trend,
      values,
    }, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}kpi trend${RESET} ${colors.cyan}${squadName}/${kpiName}${RESET}`);
  writeLine();

  const trendEmoji = kpi.trend === 'up' ? '📈' : kpi.trend === 'down' ? '📉' : '➡️';
  writeLine(`  ${bold}${kpiName}${RESET} ${trendEmoji} ${kpi.trend}`);
  writeLine(`  ${colors.dim}Target: ${definition.target} ${definition.unit}/${definition.period}${RESET}`);
  writeLine();

  if (values.length === 0) {
    writeLine(`  ${colors.dim}No data for the last ${periods} ${definition.period} periods${RESET}`);
  } else {
    // Simple ASCII chart
    const maxValue = Math.max(...values.map(v => v.value), definition.target);

    for (const v of values.slice(-10)) {
      const barLength = Math.round((v.value / maxValue) * 30);
      const bar = '█'.repeat(barLength);
      const targetMark = v.value >= definition.target ? colors.green : colors.red;

      const date = new Date(v.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      writeLine(`  ${colors.dim}${date}${RESET} ${targetMark}${bar}${RESET} ${v.value}`);
    }

    writeLine();
    writeLine(`  ${colors.dim}Target line: ${definition.target} ${'─'.repeat(20)}${RESET}`);
  }

  writeLine();
}

/**
 * Generate insights for all KPIs
 */
export async function kpiInsightsCommand(
  squadName?: string,
  options: { json?: boolean } = {}
): Promise<void> {
  await track(Events.CLI_KPI_INSIGHTS, { squad: squadName || 'all' });

  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`  ${colors.red}No .agents/squads directory found${RESET}`);
    return;
  }

  const squadsToCheck = squadName ? [squadName] : listSquads(squadsDir);
  const allInsights: { squad: string; kpi: string; insight: string; percentOfTarget: number }[] = [];

  for (const name of squadsToCheck) {
    const squad = loadSquad(name);
    if (!squad) continue;

    const definitions = parseKpiDefinitions(squad.frontmatter);

    for (const def of definitions) {
      const kpi = getKpiState(def, name);
      const insight = generateKpiInsight(kpi);

      if (insight && kpi.percentOfTarget !== undefined) {
        allInsights.push({
          squad: name,
          kpi: def.name,
          insight,
          percentOfTarget: kpi.percentOfTarget,
        });
      }
    }
  }

  if (options.json) {
    console.log(JSON.stringify(allInsights, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}kpi insights${RESET}`);
  writeLine();

  if (allInsights.length === 0) {
    writeLine(`  ${colors.dim}No KPI data recorded yet${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Record KPI values:${RESET}`);
    writeLine(`  ${colors.dim}$ squads kpi record <squad> <kpi> <value>${RESET}`);
    writeLine();
    return;
  }

  // Sort by percentage (lowest first - needs attention)
  allInsights.sort((a, b) => a.percentOfTarget - b.percentOfTarget);

  // Group by status
  const needsAttention = allInsights.filter(i => i.percentOfTarget < 70);
  const onTrack = allInsights.filter(i => i.percentOfTarget >= 70 && i.percentOfTarget < 100);
  const achieved = allInsights.filter(i => i.percentOfTarget >= 100);

  if (needsAttention.length > 0) {
    writeLine(`  ${colors.red}${bold}Needs Attention${RESET}`);
    for (const item of needsAttention) {
      writeLine(`  ${item.insight}`);
      writeLine(`    ${colors.dim}Squad: ${item.squad}${RESET}`);
    }
    writeLine();
  }

  if (onTrack.length > 0) {
    writeLine(`  ${colors.yellow}${bold}On Track${RESET}`);
    for (const item of onTrack) {
      writeLine(`  ${item.insight}`);
    }
    writeLine();
  }

  if (achieved.length > 0) {
    writeLine(`  ${colors.green}${bold}Target Achieved${RESET}`);
    for (const item of achieved) {
      writeLine(`  ${item.insight}`);
    }
    writeLine();
  }

  // Summary
  writeLine(`  ${colors.dim}─────────────────────────────────────${RESET}`);
  writeLine(`  ${colors.red}${needsAttention.length}${RESET} needs attention  ${colors.yellow}${onTrack.length}${RESET} on track  ${colors.green}${achieved.length}${RESET} achieved`);
  writeLine();
}

/**
 * List all KPIs across squads
 */
export async function kpiListCommand(
  options: { json?: boolean } = {}
): Promise<void> {
  await track(Events.CLI_KPI_LIST, {});

  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`  ${colors.red}No .agents/squads directory found${RESET}`);
    return;
  }

  const squads = listSquads(squadsDir);
  const allKpis: { squad: string; kpis: KpiDefinition[] }[] = [];

  for (const name of squads) {
    const squad = loadSquad(name);
    if (!squad) continue;

    const definitions = parseKpiDefinitions(squad.frontmatter);
    if (definitions.length > 0) {
      allKpis.push({ squad: name, kpis: definitions });
    }
  }

  if (options.json) {
    console.log(JSON.stringify(allKpis, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}kpi list${RESET}`);
  writeLine();

  if (allKpis.length === 0) {
    writeLine(`  ${colors.dim}No KPIs defined in any squad${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Define KPIs in SQUAD.md frontmatter:${RESET}`);
    writeLine(`  ${colors.dim}---${RESET}`);
    writeLine(`  ${colors.dim}kpis:${RESET}`);
    writeLine(`  ${colors.dim}  - name: "metric_name"${RESET}`);
    writeLine(`  ${colors.dim}    target: 100${RESET}`);
    writeLine(`  ${colors.dim}    unit: "items"${RESET}`);
    writeLine(`  ${colors.dim}    period: weekly${RESET}`);
    writeLine(`  ${colors.dim}---${RESET}`);
    writeLine();
    return;
  }

  for (const { squad, kpis } of allKpis) {
    writeLine(`  ${colors.cyan}${squad}${RESET}`);

    for (const kpi of kpis) {
      const periodIcon = kpi.period === 'daily' ? '📅' : kpi.period === 'weekly' ? '📆' : '🗓️';
      writeLine(`    ${periodIcon} ${bold}${kpi.name}${RESET}: ${kpi.target} ${kpi.unit}/${kpi.period}`);
      if (kpi.description) {
        writeLine(`       ${colors.dim}${kpi.description}${RESET}`);
      }
    }
    writeLine();
  }

  const total = allKpis.reduce((sum, s) => sum + s.kpis.length, 0);
  writeLine(`  ${colors.dim}${total} KPIs across ${allKpis.length} squads${RESET}`);
  writeLine();
}

export function registerKpiCommand(program: Command): void {
  const kpi = program
    .command('kpi')
    .description('Track and analyze squad KPIs (defined in SQUAD.md frontmatter)')
    .addHelpText('after', `
Examples:
  $ squads kpi list                       List all defined KPIs
  $ squads kpi show engineering           Show KPI status for a squad
  $ squads kpi record engineering leads_generated 15
  $ squads kpi trend engineering leads_generated
  $ squads kpi insights                   Show insights across all squads
`);

  kpi
    .command('list')
    .description('List all KPIs across squads')
    .option('-j, --json', 'Output as JSON')
    .action(kpiListCommand);

  kpi
    .command('show <squad>')
    .description('Show KPI status for a squad')
    .option('-j, --json', 'Output as JSON')
    .action(kpiShowCommand);

  kpi
    .command('record <squad> <kpi> <value>')
    .description('Record a KPI value')
    .option('-n, --note <note>', 'Add a note to the record')
    .option('-j, --json', 'Output as JSON')
    .action(kpiRecordCommand);

  kpi
    .command('trend <squad> <kpi>')
    .description('Show KPI trend over time')
    .option('-p, --periods <n>', 'Number of periods to show', '7')
    .option('-j, --json', 'Output as JSON')
    .action(kpiTrendCommand);

  kpi
    .command('insights [squad]')
    .description('Generate insights from KPI data')
    .option('-j, --json', 'Output as JSON')
    .action(kpiInsightsCommand);
}
