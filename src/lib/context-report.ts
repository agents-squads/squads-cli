/**
 * context-report.ts — per-run context economy report (#904).
 *
 * Child B of the observable-execution RFC (#898): aggregate a run's persisted
 * event stream into "where did tokens/context go?" — the data basis for the
 * isolate-vs-inline decision, budget caps (#702), cache-friendly layout
 * (#703), and spotting context bloat (#889).
 *
 * Honest v1 (per the spec): two attribution qualities, labeled as such —
 * - EXACT from the provider stream: per-agent tokens/cost (each agent spawn
 *   has its own terminal result → token_usage event) and cache-hit ratio.
 * - ESTIMATED at assembly time: per-layer chars/tokensEst from the
 *   context_assembled event. No provider exposes per-layer billing; this is
 *   the only per-layer truth that exists.
 * Per-tool attribution is ACTIVITY counts (calls), not tokens — the provider
 * stream does not attribute tokens to individual tool calls.
 */

import type { PersistedExecEvent, ContextLayerStat } from './exec-events.js';
import { colors, RESET, bold } from './terminal.js';

// ── Aggregation (pure, testable) ──────────────────────────────────────

export interface AgentUsageRow {
  agent: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costEst: number;
  /** cacheRead / (input + cacheRead) — how much of the prompt was cache-served. */
  cacheHitPct: number;
  /** tool_call count attributed to this agent (activity, not tokens). */
  toolCalls: number;
}

export interface ContextReport {
  runId: string;
  /** Per-agent usage from token_usage events (EXACT — provider-reported). */
  agents: AgentUsageRow[];
  /** Per-tool call counts across the run (activity proxy). */
  toolCounts: Array<{ tool: string; calls: number }>;
  /** Per-layer assembly stats from context_assembled (ESTIMATED at assembly). */
  layers: ContextLayerStat[];
  /** Budget the layers were assembled under (tokens, estimated). */
  budgetTokens: number;
  totals: { input: number; output: number; cacheRead: number; cacheWrite: number; costEst: number; cacheHitPct: number };
  /** Events dropped by the writer cap, if any — the report is then partial. */
  droppedEvents: number;
}

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

/** Aggregate a run's persisted events into the context-economy report. */
export function buildContextReport(events: PersistedExecEvent[]): ContextReport {
  const agents = new Map<string, AgentUsageRow>();
  const tools = new Map<string, number>();
  let layers: ContextLayerStat[] = [];
  let budgetTokens = 0;
  let droppedEvents = 0;
  const runId = events[0]?.runId ?? '';

  const agentRow = (name: string): AgentUsageRow => {
    let row = agents.get(name);
    if (!row) {
      row = { agent: name, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEst: 0, cacheHitPct: 0, toolCalls: 0 };
      agents.set(name, row);
    }
    return row;
  };

  for (const line of events) {
    const ev = line.event;
    const agent = line.agent || '(run)';
    switch (ev.type) {
      case 'token_usage': {
        const row = agentRow(agent);
        row.input += ev.input;
        row.output += ev.output;
        row.cacheRead += ev.cacheRead;
        row.cacheWrite += ev.cacheWrite;
        row.costEst += ev.costEst;
        break;
      }
      case 'tool_call': {
        agentRow(agent).toolCalls += 1;
        tools.set(ev.tool, (tools.get(ev.tool) ?? 0) + 1);
        break;
      }
      case 'context_assembled':
        // Last one wins (single-assembly runs have exactly one).
        layers = ev.layers;
        budgetTokens = ev.budgetTokens;
        break;
      case 'truncated':
        droppedEvents += ev.droppedCount;
        break;
      default:
        break;
    }
  }

  const rows = [...agents.values()]
    .map((r) => ({ ...r, cacheHitPct: pct(r.cacheRead, r.input + r.cacheRead) }))
    // Biggest spender first — the report is about finding where context goes.
    .sort((a, b) => (b.costEst - a.costEst) || (b.output - a.output));

  const totals = rows.reduce(
    (t, r) => ({
      input: t.input + r.input,
      output: t.output + r.output,
      cacheRead: t.cacheRead + r.cacheRead,
      cacheWrite: t.cacheWrite + r.cacheWrite,
      costEst: t.costEst + r.costEst,
      cacheHitPct: 0,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEst: 0, cacheHitPct: 0 },
  );
  totals.cacheHitPct = pct(totals.cacheRead, totals.input + totals.cacheRead);

  return {
    runId,
    agents: rows,
    toolCounts: [...tools.entries()].map(([tool, calls]) => ({ tool, calls })).sort((a, b) => b.calls - a.calls),
    layers,
    budgetTokens,
    totals,
    droppedEvents,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Render the report as terminal lines (caller writes them). */
export function renderContextReport(report: ContextReport): string[] {
  const out: string[] = [];
  const dim = (s: string) => `${colors.dim}${s}${RESET}`;

  out.push('');
  out.push(`  ${bold}Context economy — ${report.runId}${RESET}`);
  out.push('');

  // Per-agent (exact)
  out.push(`  ${bold}Per agent${RESET} ${dim('(provider-reported — exact)')}`);
  if (report.agents.length === 0) {
    out.push(dim('    no token_usage events recorded'));
  }
  for (const a of report.agents) {
    out.push(
      `    ${colors.cyan}${a.agent}${RESET}  ` +
      dim(`${fmtTokens(a.input)} in / ${fmtTokens(a.output)} out · cache ${fmtTokens(a.cacheRead)}r (${a.cacheHitPct}% hit) / ${fmtTokens(a.cacheWrite)}w`) +
      (a.costEst ? ` ${colors.green}$${a.costEst.toFixed(4)}${RESET}` : '') +
      (a.toolCalls ? dim(` · ${a.toolCalls} tool calls`) : ''),
    );
  }
  out.push(
    `    ${bold}total${RESET}  ` +
    dim(`${fmtTokens(report.totals.input)} in / ${fmtTokens(report.totals.output)} out · cache hit ${report.totals.cacheHitPct}%`) +
    (report.totals.costEst ? ` ${colors.green}$${report.totals.costEst.toFixed(4)}${RESET}` : ''),
  );
  out.push('');

  // Per-tool activity
  if (report.toolCounts.length > 0) {
    out.push(`  ${bold}Tool activity${RESET} ${dim('(call counts — tokens are not tool-attributable)')}`);
    for (const t of report.toolCounts.slice(0, 10)) {
      out.push(`    ${t.tool.padEnd(14)} ${dim(`${t.calls} call${t.calls > 1 ? 's' : ''}`)}`);
    }
    out.push('');
  }

  // Per-layer (estimated)
  if (report.layers.length > 0) {
    out.push(`  ${bold}Context layers${RESET} ${dim(`(assembly-time estimate · budget ~${fmtTokens(report.budgetTokens)} tokens)`)}`);
    const injected = report.layers.filter((l) => !l.evicted);
    const totalTokens = injected.reduce((s, l) => s + l.tokensEst, 0);
    for (const l of report.layers) {
      if (l.evicted) {
        out.push(`    ${colors.yellow}L${l.layer} ${l.name}${RESET} ${dim('— EVICTED (budget)')}`);
      } else {
        const share = pct(l.tokensEst, totalTokens);
        const bar = '█'.repeat(Math.max(1, Math.round(share / 5)));
        out.push(`    L${l.layer} ${l.name.padEnd(28).slice(0, 28)} ${dim(`~${fmtTokens(l.tokensEst).padStart(6)} tok ${String(share).padStart(3)}%`)} ${colors.purple}${bar}${RESET}`);
      }
    }
    out.push('');
  }

  if (report.droppedEvents > 0) {
    out.push(`  ${colors.yellow}⚠ ${report.droppedEvents} events were dropped by the size cap — this report is partial.${RESET}`);
    out.push('');
  }

  return out;
}
