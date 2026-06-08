/**
 * `squads usage` — local-first cost/token view straight from
 * .agents/observability/executions.jsonl. No Bridge / Postgres needed.
 *
 * Shows: today's total cost + tokens, a rolling-window total (default 5h), and
 * a per-squad breakdown. Complements `squads cost`, which reads the Bridge.
 */

import { localUsageSummary, type UsageBucket } from '../lib/observability.js';
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

interface UsageOptions {
  window?: number | string;
  json?: boolean;
}

function tokensOf(b: UsageBucket): number {
  return b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_write_tokens;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
  return tokens.toString();
}

export async function usageCommand(options: UsageOptions = {}): Promise<void> {
  await track(Events.CLI_COST, { action: 'usage' });

  const windowHours = Math.max(1, parseInt(String(options.window ?? 5), 10) || 5);
  const summary = localUsageSummary(windowHours);

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}usage${RESET} ${colors.dim}(local · executions.jsonl)${RESET}`);
  writeLine();

  // Today
  writeLine(`  ${bold}Today${RESET}`);
  writeLine(
    `  ${colors.cyan}$${summary.today.cost_usd.toFixed(2)}${RESET} ${colors.dim}|${RESET} ` +
    `${summary.today.runs.toLocaleString()} runs ${colors.dim}|${RESET} ` +
    `${formatTokens(tokensOf(summary.today))} tokens`
  );
  writeLine();

  // Rolling window
  writeLine(`  ${bold}Last ${summary.windowHours}h${RESET}`);
  writeLine(
    `  ${colors.purple}$${summary.window.cost_usd.toFixed(2)}${RESET} ${colors.dim}|${RESET} ` +
    `${summary.window.runs.toLocaleString()} runs ${colors.dim}|${RESET} ` +
    `${formatTokens(tokensOf(summary.window))} tokens`
  );
  writeLine();

  // Per-squad breakdown
  if (summary.bySquad.length > 0) {
    writeLine(`  ${bold}By Squad${RESET}`);
    writeLine();

    const w = { name: 16, spent: 12, runs: 8 };
    // border width = leading space (1) + sum of column widths
    const tableWidth = 1 + w.name + w.spent + w.runs;
    writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
    writeLine(
      `  ${colors.purple}${box.vertical}${RESET} ` +
      `${bold}${padEnd('SQUAD', w.name)}${RESET}` +
      `${bold}${padEnd('COST', w.spent)}${RESET}` +
      `${bold}${padEnd('RUNS', w.runs)}${RESET}` +
      `${colors.purple}${box.vertical}${RESET}`
    );
    writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

    for (const sq of summary.bySquad) {
      writeLine(
        `  ${colors.purple}${box.vertical}${RESET} ` +
        `${colors.cyan}${padEnd(sq.squad, w.name)}${RESET}` +
        `${padEnd(`$${sq.cost_usd.toFixed(2)}`, w.spent)}` +
        `${padEnd(String(sq.runs), w.runs)}` +
        `${colors.purple}${box.vertical}${RESET}`
      );
    }
    writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
    writeLine();
  } else {
    writeLine(`  ${colors.dim}No execution history yet. Run \`squads run --org\` to generate cost data.${RESET}`);
    writeLine();
  }
}
