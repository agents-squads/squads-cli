/**
 * squads obs — observability commands
 *
 * squads obs history     Execution history with tokens/cost
 * squads obs cost        Spend summary by squad and model
 */

import { Command } from 'commander';
import { queryExecutions, calculateCostSummary } from '../lib/observability.js';
import { colors, bold, RESET, writeLine } from '../lib/terminal.js';

export function registerObservabilityCommands(program: Command): void {
  const obs = program
    .command('obs')
    .description('Observability — execution history, token costs, and trends');

  obs
    .command('history')
    .description('Show execution history with tokens and cost')
    .option('-s, --squad <squad>', 'Filter by squad')
    .option('-a, --agent <agent>', 'Filter by agent')
    .option('-n, --limit <n>', 'Number of records', '20')
    .option('--since <date>', 'Since date (ISO or relative: 1d, 7d, 30d)')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      let since = opts.since;
      if (since && /^\d+d$/.test(since)) {
        const days = parseInt(since, 10);
        since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      }

      const records = queryExecutions({
        squad: opts.squad, agent: opts.agent, since, limit: parseInt(opts.limit, 10),
      });

      if (records.length === 0) {
        writeLine(`\n  ${colors.dim}No executions found. Run \`squads run <squad>\` to generate data.${RESET}\n`);
        return;
      }

      if (opts.json) { console.log(JSON.stringify(records, null, 2)); return; }

      writeLine(`\n  ${bold}Execution History${RESET} (${records.length} records)\n`);

      for (const r of records) {
        const icon = r.status === 'completed' ? `${colors.green}pass${RESET}`
          : r.status === 'failed' ? `${colors.red}fail${RESET}` : `${colors.yellow}timeout${RESET}`;
        const dur = r.duration_ms > 60000 ? `${Math.round(r.duration_ms / 60000)}m` : `${Math.round(r.duration_ms / 1000)}s`;
        const cost = r.cost_usd > 0 ? `$${r.cost_usd.toFixed(3)}` : '$—';
        const tok = (r.input_tokens + r.output_tokens) > 0 ? `${(r.input_tokens + r.output_tokens).toLocaleString()} tok` : '— tok';
        const date = r.ts.slice(0, 16).replace('T', ' ');

        const grade = r.grade ? ` ${r.grade}` : '';
        writeLine(`  ${icon}  ${bold}${r.squad}/${r.agent}${RESET}  ${colors.dim}${date}  ${dur}  ${tok}  ${cost}  ${r.model}${grade}${RESET}`);
        if (r.error) writeLine(`       ${colors.red}${r.error.slice(0, 80)}${RESET}`);
        if (r.goals_changed && r.goals_changed.length > 0) {
          for (const g of r.goals_changed) {
            writeLine(`       ${colors.green}goal: ${g.name} ${g.before} → ${g.after}${RESET}`);
          }
        }
      }
      writeLine();
    });

  obs
    .command('cost')
    .description('Show token spend summary')
    .option('-p, --period <period>', 'Time period: today, 7d, 30d, all', '7d')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const summary = calculateCostSummary(opts.period);

      if (summary.total_runs === 0) {
        writeLine(`\n  ${colors.dim}No executions in the last ${opts.period}.${RESET}\n`);
        return;
      }

      if (opts.json) { console.log(JSON.stringify(summary, null, 2)); return; }

      writeLine(`\n  ${bold}Cost Summary${RESET} (${summary.period})`);
      writeLine(`\n  Total:  ${bold}$${summary.total_cost.toFixed(2)}${RESET} across ${summary.total_runs} runs`);
      writeLine(`  Tokens: ${summary.total_input_tokens.toLocaleString()} in / ${summary.total_output_tokens.toLocaleString()} out\n`);

      const squads = Object.entries(summary.by_squad).sort((a, b) => b[1].cost - a[1].cost);
      if (squads.length > 0) {
        writeLine(`  ${colors.cyan}By Squad${RESET}`);
        for (const [name, data] of squads) {
          const bar = '█'.repeat(Math.max(1, Math.round(data.cost / (summary.total_cost || 1) * 20)));
          writeLine(`    ${name.padEnd(20)} ${colors.dim}${bar}${RESET} $${data.cost.toFixed(2)} (${data.runs} runs, avg $${data.avg_cost.toFixed(3)})`);
        }
        writeLine();
      }

      const models = Object.entries(summary.by_model).sort((a, b) => b[1].cost - a[1].cost);
      if (models.length > 0) {
        writeLine(`  ${colors.cyan}By Model${RESET}`);
        for (const [name, data] of models) {
          writeLine(`    ${name.padEnd(30)} $${data.cost.toFixed(2)} (${data.runs} runs)`);
        }
        writeLine();
      }
    });

  // ── obs sync ──
  obs
    .command('sync')
    .description('Backfill JSONL execution data to Postgres (Tier 2)')
    .option('--dry-run', 'Show what would be synced without sending')
    .action(async (opts) => {
      const { detectTier } = await import('../lib/tier-detect.js');
      const { queryExecutions } = await import('../lib/observability.js');
      const info = await detectTier();

      if (info.tier < 2 || !info.urls.api) {
        writeLine(`\n  ${colors.dim}Tier 2 not available. Run 'squads services up' first.${RESET}\n`);
        return;
      }

      const records = queryExecutions({ limit: 10000 });
      if (records.length === 0) {
        writeLine(`\n  ${colors.dim}No JSONL records to sync.${RESET}\n`);
        return;
      }

      writeLine(`\n  ${bold}Syncing ${records.length} records to Postgres...${RESET}\n`);

      let synced = 0;
      let skipped = 0;
      let errors = 0;

      for (const record of records) {
        if (opts.dryRun) {
          writeLine(`  ${colors.dim}[dry-run] ${record.ts} ${record.squad}/${record.agent} $${record.cost_usd.toFixed(3)}${RESET}`);
          synced++;
          continue;
        }

        try {
          const res = await fetch(`${info.urls.api}/agent-executions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              execution_id: record.id,
              squad: record.squad,
              agent: record.agent,
              model: record.model,
              status: record.status,
              input_tokens: record.input_tokens,
              output_tokens: record.output_tokens,
              cache_read_tokens: record.cache_read_tokens,
              cache_write_tokens: record.cache_write_tokens,
              cost_usd: record.cost_usd,
              duration_seconds: Math.round(record.duration_ms / 1000),
              error_message: record.error || null,
              metadata: { trigger: record.trigger, provider: record.provider },
            }),
            signal: AbortSignal.timeout(5000),
          });

          if (res.ok) {
            synced++;
          } else if (res.status === 409) {
            skipped++; // Already exists (dedup)
          } else {
            errors++;
          }
        } catch {
          errors++;
        }
      }

      writeLine(`  ${colors.green}Synced: ${synced}${RESET}  ${colors.dim}Skipped: ${skipped}  Errors: ${errors}${RESET}\n`);
    });
}
