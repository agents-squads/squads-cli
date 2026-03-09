/**
 * squads cognition — business cognition engine.
 *
 * Subcommands:
 *   squads cognition brief      — executive summary
 *   squads cognition beliefs    — world model
 *   squads cognition decisions  — decision log with scores
 *   squads cognition reflect    — trigger and display a reflection
 */

import { Command } from 'commander';
import {
  colors,
  bold,
  RESET,
  writeLine,
} from '../lib/terminal.js';

interface Belief {
  belief_key: string;
  domain: string;
  statement: string;
  confidence: number;
  temperature: string;
  revision: number;
}

interface CognitionSignal {
  source: string;
}

interface CognitionDecision {
  id: number;
  title: string;
}

interface CognitionReflectionSummary {
  created_at: string;
  assessment: string;
}

interface CognitionBrief {
  generated_at: string;
  hot_beliefs?: Belief[];
  recent_signals?: CognitionSignal[];
  pending_decisions?: CognitionDecision[];
  latest_reflection?: CognitionReflectionSummary;
}

interface Decision {
  id: number;
  title: string;
  reasoning: string;
  outcome_score: number | null;
  decided_at: string;
  decided_by: string;
}

interface Insight {
  type: string;
  message: string;
}

interface PriorityAdjustment {
  description?: string;
}

interface Reflection {
  created_at: string;
  assessment: string;
  insights?: Insight[];
  priority_adjustments?: (string | PriorityAdjustment)[];
}

async function apiFetch<T = unknown>(path: string, options?: RequestInit): Promise<T | null> {
  const { loadSession } = await import('../lib/auth.js');
  const { getApiUrl } = await import('../lib/env-config.js');
  const session = loadSession();
  if (!session?.accessToken || session.status !== 'active') {
    writeLine(`  ${colors.red}Not logged in.${RESET} Run ${colors.cyan}squads login${RESET} first.`);
    return null;
  }
  const apiUrl = getApiUrl();
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.accessToken}`,
        ...(options?.headers || {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      writeLine(`  ${colors.red}API error:${RESET} ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    const msg = error instanceof Error && error.name === 'TimeoutError'
      ? 'Request timed out.'
      : 'API unavailable.';
    writeLine(`  ${colors.yellow}${msg}${RESET}`);
    return null;
  }
}

async function briefCommand(): Promise<void> {
  const data = await apiFetch<CognitionBrief>('/cognition/brief');
  if (!data) return;

  writeLine();
  writeLine(`  ${bold}Executive Brief${RESET}  ${colors.dim}${data.generated_at}${RESET}`);
  writeLine();

  // Hot beliefs
  if (data.hot_beliefs && data.hot_beliefs.length > 0) {
    writeLine(`  ${colors.red}Hot Beliefs${RESET}`);
    for (const b of data.hot_beliefs) {
      const conf = Math.round(b.confidence * 100);
      const color = conf >= 70 ? colors.green : conf >= 40 ? colors.yellow : colors.red;
      writeLine(`  ${color}${conf}%${RESET} ${bold}${b.belief_key}${RESET}  ${b.statement}`);
    }
    writeLine();
  }

  // Recent signals
  if (data.recent_signals && data.recent_signals.length > 0) {
    writeLine(`  ${colors.cyan}Signals (24h)${RESET}  ${colors.dim}${data.recent_signals.length} total${RESET}`);
    const bySource: Record<string, number> = {};
    for (const s of data.recent_signals) {
      bySource[s.source] = (bySource[s.source] || 0) + 1;
    }
    for (const [source, count] of Object.entries(bySource)) {
      writeLine(`  ${colors.dim}${source}:${RESET} ${count}`);
    }
    writeLine();
  }

  // Pending decisions
  if (data.pending_decisions && data.pending_decisions.length > 0) {
    writeLine(`  ${colors.yellow}Pending Decisions${RESET}`);
    for (const d of data.pending_decisions) {
      writeLine(`  ${colors.dim}#${d.id}${RESET} ${d.title}`);
    }
    writeLine();
  }

  // Latest reflection
  if (data.latest_reflection) {
    writeLine(`  ${colors.purple}Latest Reflection${RESET}  ${colors.dim}${data.latest_reflection.created_at}${RESET}`);
    writeLine(`  ${data.latest_reflection.assessment}`);
    writeLine();
  }

  if (!data.hot_beliefs?.length && !data.recent_signals?.length && !data.pending_decisions?.length && !data.latest_reflection) {
    writeLine(`  ${colors.dim}No cognition data yet. Seed beliefs with:${RESET}`);
    writeLine(`  ${colors.cyan}$ squads cognition beliefs${RESET}`);
    writeLine();
  }
}

async function beliefsCommand(options: { domain?: string; json?: boolean }): Promise<void> {
  const params = new URLSearchParams();
  if (options.domain) params.set('domain', options.domain);
  const path = `/cognition/beliefs${params.toString() ? '?' + params.toString() : ''}`;
  const data = await apiFetch<Belief[]>(path);
  if (!data) return;

  if (options.json) {
    writeLine(JSON.stringify(data, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${bold}World Model${RESET}  ${colors.dim}${data.length} beliefs${RESET}`);
  writeLine();

  // Group by domain
  const byDomain: Record<string, Belief[]> = {};
  for (const b of data) {
    const d = b.domain || 'other';
    if (!byDomain[d]) byDomain[d] = [];
    byDomain[d].push(b);
  }

  for (const [domain, beliefs] of Object.entries(byDomain)) {
    writeLine(`  ${colors.cyan}${domain}${RESET}`);
    for (const b of beliefs) {
      const conf = Math.round(b.confidence * 100);
      const tempIcon = b.temperature === 'hot' ? `${colors.red}*${RESET}` : b.temperature === 'cold' ? `${colors.dim}~${RESET}` : ' ';
      const confColor = conf >= 70 ? colors.green : conf >= 40 ? colors.yellow : colors.red;
      writeLine(`  ${tempIcon} ${confColor}${conf}%${RESET} ${bold}${b.belief_key}${RESET}  ${colors.dim}r${b.revision}${RESET}`);
      writeLine(`    ${b.statement}`);
    }
    writeLine();
  }
}

async function decisionsCommand(options: { evaluated?: boolean; json?: boolean }): Promise<void> {
  const params = new URLSearchParams();
  if (options.evaluated !== undefined) params.set('evaluated', String(options.evaluated));
  const path = `/cognition/decisions${params.toString() ? '?' + params.toString() : ''}`;
  const data = await apiFetch<Decision[]>(path);
  if (!data) return;

  if (options.json) {
    writeLine(JSON.stringify(data, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${bold}Decision Journal${RESET}  ${colors.dim}${data.length} decisions${RESET}`);
  writeLine();

  for (const d of data) {
    const score = d.outcome_score !== null && d.outcome_score !== undefined
      ? `${d.outcome_score > 0 ? colors.green : d.outcome_score < 0 ? colors.red : colors.yellow}${d.outcome_score.toFixed(1)}${RESET}`
      : `${colors.dim}pending${RESET}`;
    writeLine(`  ${colors.dim}#${d.id}${RESET} ${bold}${d.title}${RESET}  score: ${score}`);
    writeLine(`    ${colors.dim}${d.reasoning}${RESET}`);
    writeLine(`    ${colors.dim}decided: ${d.decided_at} by ${d.decided_by}${RESET}`);
    writeLine();
  }
}

async function reflectCommand(options: { scope?: string }): Promise<void> {
  const scope = options.scope || 'business';
  writeLine();
  writeLine(`  ${colors.purple}Reflecting...${RESET} scope: ${scope}`);

  const data = await apiFetch<Reflection>('/cognition/reflect', {
    method: 'POST',
    body: JSON.stringify({ scope }),
  });
  if (!data) return;

  writeLine();
  writeLine(`  ${bold}Reflection${RESET}  ${colors.dim}${data.created_at}${RESET}`);
  writeLine();
  writeLine(`  ${data.assessment}`);
  writeLine();

  if (data.insights && data.insights.length > 0) {
    writeLine(`  ${colors.cyan}Insights${RESET}`);
    for (const i of data.insights) {
      const icon = i.type === 'warning' ? `${colors.yellow}!${RESET}` : `${colors.cyan}>${RESET}`;
      writeLine(`  ${icon} ${i.message}`);
    }
    writeLine();
  }

  if (data.priority_adjustments && data.priority_adjustments.length > 0) {
    writeLine(`  ${colors.yellow}Priority Adjustments${RESET}`);
    for (const a of data.priority_adjustments) {
      writeLine(`  - ${typeof a === 'string' ? a : a.description || JSON.stringify(a)}`);
    }
    writeLine();
  }
}

export function registerCognitionCommand(program: Command): void {
  const cmd = program
    .command('cognition')
    .description('Business cognition engine — beliefs, decisions, reflections')
    .addHelpText('after', `
Examples:
  $ squads cognition brief       Executive summary (hot beliefs + signals + decisions)
  $ squads cognition beliefs     World model with confidence scores
  $ squads cognition decisions   Decision journal with outcome scores
  $ squads cognition reflect     Trigger meta-cognition analysis
`)
    .action(() => {
      cmd.outputHelp();
    });

  cmd
    .command('brief')
    .description('Executive summary: hot beliefs + recent signals + pending decisions')
    .action(async () => briefCommand());

  cmd
    .command('beliefs')
    .description('Display world model beliefs')
    .option('-d, --domain <domain>', 'Filter by domain (revenue/product/operations/market/team)')
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => beliefsCommand(options));

  cmd
    .command('decisions')
    .description('Decision journal with outcome scores')
    .option('-e, --evaluated', 'Only show evaluated decisions')
    .option('-j, --json', 'Output as JSON')
    .action(async (options) => decisionsCommand(options));

  cmd
    .command('reflect')
    .description('Trigger meta-cognition reflection')
    .option('-s, --scope <scope>', 'Reflection scope (business, squad:X, agent:X)', 'business')
    .action(async (options) => reflectCommand(options));
}
