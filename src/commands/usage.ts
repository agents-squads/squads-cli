/**
 * `squads usage` — local-first cost/token view straight from
 * .agents/observability/executions.jsonl. No Bridge / Postgres needed.
 *
 * Shows: today's total cost + tokens, a rolling-window total (default 5h), and
 * a per-squad breakdown. Complements `squads cost`, which reads the Bridge.
 */

import { localUsageSummary, type UsageBucket } from '../lib/observability.js';
import { reconcileDetachedRuns } from '../lib/spool.js';
import { readClaudeSessions, totalTokens, type SessionBucket } from '../lib/claude-sessions.js';
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
  allClaude?: boolean;
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

/** One line of the Total section: `interactive $X · squads $Y · total $Z`. */
function splitLine(label: string, split: { interactive: SessionBucket; squad: SessionBucket; total: SessionBucket }): void {
  writeLine(`  ${bold}${label}${RESET}`);
  writeLine(
    `  ${colors.dim}interactive${RESET} ${colors.cyan}$${split.interactive.cost_usd.toFixed(2)}${RESET} ` +
    `${colors.dim}(${formatTokens(totalTokens(split.interactive))})${RESET} ${colors.dim}·${RESET} ` +
    `${colors.dim}squads${RESET} ${colors.purple}$${split.squad.cost_usd.toFixed(2)}${RESET} ` +
    `${colors.dim}(${formatTokens(totalTokens(split.squad))})${RESET} ${colors.dim}·${RESET} ` +
    `${colors.dim}total${RESET} ${bold}$${split.total.cost_usd.toFixed(2)}${RESET} ` +
    `${colors.dim}(${formatTokens(totalTokens(split.total))} tokens)${RESET}`
  );
}

export async function usageCommand(options: UsageOptions = {}): Promise<void> {
  // hq#450 D2: ingest done-files from detached runs before reading any ledger.
  try {
    const { getProjectRoot } = await import('../lib/run-utils.js');
    const n = reconcileDetachedRuns(getProjectRoot());
    if (n > 0) console.log(`  reconciled ${n} detached run(s) into observability`);
  } catch { /* read paths never break on spool issues */ }

  const windowHours = Math.max(1, parseInt(String(options.window ?? 5), 10) || 5);
  const summary = localUsageSummary(windowHours);
  // The REAL window: ALL Claude Code sessions (interactive + squad), read
  // straight from ~/.claude/projects. Graceful if the dir is missing/empty.
  const sessions = await readClaudeSessions(windowHours, { scope: options.allClaude ? 'all' : 'project' });

  if (options.json) {
    console.log(JSON.stringify({ executions: summary, claudeSessions: sessions }, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}usage${RESET} ${colors.dim}(local · executions.jsonl)${RESET}`);
  writeLine();

  // ── Total Claude usage (interactive + squad), from ~/.claude/projects ──
  if (sessions.available && sessions.filesScanned > 0) {
    writeLine(`  ${bold}Total Claude usage${RESET} ${colors.dim}(all sessions · ~/.claude/projects)${RESET}`);
    writeLine();
    splitLine('Today', sessions.today);
    writeLine();
    splitLine(`Last ${sessions.windowHours}h`, sessions.window);
    writeLine();
    writeLine(`  ${colors.dim}$ figures are NOTIONAL — list-price token proxy on a Max plan, not billing.${RESET}`);
    writeLine();
  }

  // ── Squad runs only (source: executions.jsonl) ──────────────────────
  writeLine(`  ${bold}Squad runs${RESET} ${colors.dim}(squads-cli spawns · executions.jsonl)${RESET}`);
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
