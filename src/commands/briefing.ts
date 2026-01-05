/**
 * Briefing command - Context injection for agents
 *
 * Aggregates squad state, goals, memory, costs, and git activity
 * into a single consumable output for human review or agent context.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import {
  findSquadsDir,
  loadSquad,
  listSquads,
  listAgents,
} from '../lib/squad-parser.js';
import { findMemoryDir, searchMemory, getSquadState } from '../lib/memory.js';
import {
  fetchBridgeStats,
  fetchRateLimits,
  BridgeStats,
  RateLimits,
} from '../lib/costs.js';
import { getMultiRepoGitStats, GitPerformanceStats } from '../lib/git.js';
import { getLiveSessionSummaryAsync, SessionSummary } from '../lib/sessions.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  icons,
  writeLine,
} from '../lib/terminal.js';

// ============================================================================
// Types
// ============================================================================

interface SquadBriefing {
  name: string;
  mission?: string;
  agentCount: number;
  activeGoals: { description: string; progress?: string }[];
  memoryEntries: number;
  recentMemory: string[];
  lastActivity?: string;
}

interface BriefingData {
  timestamp: string;
  squads: SquadBriefing[];
  goals: {
    active: number;
    completed: number;
    bySquad: { squad: string; goals: string[] }[];
  };
  costs?: {
    today: { generations: number; cost: number };
    budget: { daily: number; used: number; remaining: number; usedPct: number };
    bySquad: { squad: string; cost: number; generations: number }[];
  };
  rateLimits?: {
    models: { model: string; requestsRemaining: number; tokensRemaining: number }[];
  };
  git?: {
    commits: number;
    activeDays: number;
    avgPerDay: number;
    byRepo: { repo: string; commits: number }[];
  };
  sessions: {
    active: number;
    bySquad: number;
  };
  relevantMemory?: { squad: string; agent: string; snippet: string }[];
}

interface BriefingOptions {
  squad?: string;
  topic?: string;
  json?: boolean;
  agent?: boolean;
  verbose?: boolean;
}

// ============================================================================
// Data Collection
// ============================================================================

async function collectBriefingData(options: BriefingOptions): Promise<BriefingData> {
  const squadsDir = findSquadsDir();
  const memoryDir = findMemoryDir();
  const baseDir = squadsDir ? join(squadsDir, '..', '..', '..') : null;

  // Determine which squads to include
  const squadNames = squadsDir
    ? options.squad
      ? [options.squad]
      : listSquads(squadsDir)
    : [];

  // Collect data in parallel for performance
  const [bridgeStats, rateLimits, sessions, gitStats] = await Promise.all([
    fetchBridgeStats(),
    fetchRateLimits(),
    getLiveSessionSummaryAsync(),
    baseDir ? Promise.resolve(getMultiRepoGitStats(baseDir, 7)) : Promise.resolve(null),
  ]);

  // Build squad briefings
  const squadBriefings: SquadBriefing[] = [];
  const goalsBySquad: { squad: string; goals: string[] }[] = [];
  let totalActive = 0;
  let totalCompleted = 0;

  for (const squadName of squadNames) {
    const squad = loadSquad(squadName);
    if (!squad) continue;

    const agents = squadsDir ? listAgents(squadsDir, squadName) : [];
    const activeGoals = squad.goals.filter(g => !g.completed);
    const completedGoals = squad.goals.filter(g => g.completed);

    totalActive += activeGoals.length;
    totalCompleted += completedGoals.length;

    // Get memory state
    const states = getSquadState(squadName);
    const recentMemory: string[] = [];

    // Extract recent insights from memory
    for (const state of states.slice(0, 3)) {
      const lines = state.content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      if (lines.length > 0) {
        recentMemory.push(lines[0].substring(0, 100));
      }
    }

    // Determine last activity
    let lastActivity: string | undefined;
    if (memoryDir) {
      const squadMemoryPath = join(memoryDir, squadName);
      if (existsSync(squadMemoryPath)) {
        const { statSync, readdirSync } = await import('fs');
        let mostRecent = 0;
        try {
          const walkDir = (dir: string) => {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = join(dir, entry.name);
              if (entry.isDirectory()) {
                walkDir(fullPath);
              } else if (entry.name.endsWith('.md')) {
                const stat = statSync(fullPath);
                if (stat.mtimeMs > mostRecent) {
                  mostRecent = stat.mtimeMs;
                }
              }
            }
          };
          walkDir(squadMemoryPath);
        } catch {
          // Ignore errors
        }

        if (mostRecent > 0) {
          const daysAgo = Math.floor((Date.now() - mostRecent) / (1000 * 60 * 60 * 24));
          if (daysAgo === 0) lastActivity = 'today';
          else if (daysAgo === 1) lastActivity = 'yesterday';
          else lastActivity = `${daysAgo}d ago`;
        }
      }
    }

    squadBriefings.push({
      name: squadName,
      mission: squad.mission,
      agentCount: agents.length,
      activeGoals: activeGoals.map(g => ({
        description: g.description,
        progress: g.progress,
      })),
      memoryEntries: states.length,
      recentMemory,
      lastActivity,
    });

    if (activeGoals.length > 0) {
      goalsBySquad.push({
        squad: squadName,
        goals: activeGoals.map(g => g.description),
      });
    }
  }

  // Build costs data
  const costs = bridgeStats ? {
    today: {
      generations: bridgeStats.today.generations,
      cost: bridgeStats.today.costUsd,
    },
    budget: bridgeStats.budget,
    bySquad: bridgeStats.bySquad.map(s => ({
      squad: s.squad,
      cost: s.costUsd,
      generations: s.generations,
    })),
  } : undefined;

  // Build rate limits data
  const rateLimitsData = rateLimits.source !== 'none' ? {
    models: Object.values(rateLimits.limits).map(l => ({
      model: l.model,
      requestsRemaining: l.requestsRemaining,
      tokensRemaining: l.tokensRemaining,
    })),
  } : undefined;

  // Build git data
  const git = gitStats ? {
    commits: gitStats.totalCommits,
    activeDays: gitStats.activeDays,
    avgPerDay: gitStats.avgCommitsPerDay,
    byRepo: Array.from(gitStats.commitsByRepo.entries()).map(([repo, commits]) => ({
      repo,
      commits,
    })),
  } : undefined;

  // Search for topic-relevant memory if provided
  let relevantMemory: { squad: string; agent: string; snippet: string }[] | undefined;
  if (options.topic) {
    const results = searchMemory(options.topic);
    relevantMemory = results.slice(0, 5).map(r => ({
      squad: r.entry.squad,
      agent: r.entry.agent,
      snippet: r.matches[0]?.substring(0, 150) || '',
    }));
  }

  return {
    timestamp: new Date().toISOString(),
    squads: squadBriefings,
    goals: {
      active: totalActive,
      completed: totalCompleted,
      bySquad: goalsBySquad,
    },
    costs,
    rateLimits: rateLimitsData,
    git,
    sessions: {
      active: sessions.totalSessions,
      bySquad: sessions.squadCount,
    },
    relevantMemory,
  };
}

// ============================================================================
// Human Output
// ============================================================================

function renderHumanBriefing(data: BriefingData, options: BriefingOptions): void {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}briefing${RESET}`);
  writeLine();

  // Sessions indicator
  if (data.sessions.active > 0) {
    writeLine(`  ${colors.green}${icons.active}${RESET} ${data.sessions.active} active sessions across ${data.sessions.bySquad} squads`);
    writeLine();
  }

  // Goals summary
  if (data.goals.active > 0) {
    writeLine(`  ${bold}Active Goals${RESET} ${colors.dim}(${data.goals.active})${RESET}`);
    writeLine();
    for (const sq of data.goals.bySquad) {
      writeLine(`  ${colors.cyan}${sq.squad}${RESET}`);
      for (const goal of sq.goals.slice(0, 2)) {
        writeLine(`    ${icons.active} ${goal}`);
      }
      if (sq.goals.length > 2) {
        writeLine(`    ${colors.dim}+${sq.goals.length - 2} more${RESET}`);
      }
    }
    writeLine();
  }

  // Costs snapshot
  if (data.costs) {
    const { budget } = data.costs;
    const usedBar = '█'.repeat(Math.min(Math.round(budget.usedPct / 5), 20));
    const emptyBar = '░'.repeat(20 - usedBar.length);

    writeLine(`  ${bold}Budget${RESET}`);
    writeLine(`  ${colors.dim}$${budget.used.toFixed(2)}/${budget.daily} today${RESET} ${usedBar}${emptyBar} ${budget.usedPct.toFixed(0)}%`);
    writeLine();
  }

  // Rate limits (if available and verbose)
  if (data.rateLimits && options.verbose) {
    writeLine(`  ${bold}Rate Limits${RESET}`);
    for (const model of data.rateLimits.models.slice(0, 3)) {
      const shortName = model.model.replace('claude-', '').replace(/-\d+$/, '');
      writeLine(`  ${colors.dim}${shortName}:${RESET} ${model.requestsRemaining} req, ${Math.round(model.tokensRemaining / 1000)}k tok`);
    }
    writeLine();
  }

  // Git activity (last 7 days)
  if (data.git && data.git.commits > 0) {
    writeLine(`  ${bold}Git Activity${RESET} ${colors.dim}(7d)${RESET}`);
    writeLine(`  ${data.git.commits} commits, ${data.git.avgPerDay}/day avg`);
    writeLine();
  }

  // Squads with activity
  const activeSquads = data.squads.filter(s => s.activeGoals.length > 0 || s.memoryEntries > 0);
  if (activeSquads.length > 0 && options.verbose) {
    const w = { name: 14, agents: 8, memory: 10, activity: 10 };
    const tableWidth = w.name + w.agents + w.memory + w.activity + 4;

    writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
    writeLine(`  ${colors.purple}${box.vertical}${RESET} ${bold}${padEnd('SQUAD', w.name)}${RESET}${bold}${padEnd('AGENTS', w.agents)}${RESET}${bold}${padEnd('MEMORY', w.memory)}${RESET}${bold}ACTIVITY${RESET} ${colors.purple}${box.vertical}${RESET}`);
    writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

    for (const sq of activeSquads.slice(0, 8)) {
      const row = `  ${colors.purple}${box.vertical}${RESET} ` +
        `${colors.cyan}${padEnd(sq.name, w.name)}${RESET}` +
        `${padEnd(String(sq.agentCount), w.agents)}` +
        `${padEnd(String(sq.memoryEntries), w.memory)}` +
        `${padEnd(sq.lastActivity || '—', w.activity - 2)}` +
        `${colors.purple}${box.vertical}${RESET}`;
      writeLine(row);
    }

    writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
    writeLine();
  }

  // Topic-relevant memory
  if (data.relevantMemory && data.relevantMemory.length > 0) {
    writeLine(`  ${bold}Relevant Memory${RESET} ${colors.dim}("${options.topic}")${RESET}`);
    for (const mem of data.relevantMemory) {
      writeLine(`  ${colors.cyan}${mem.squad}/${mem.agent}${RESET}`);
      writeLine(`    ${colors.dim}${mem.snippet}${RESET}`);
    }
    writeLine();
  }

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads briefing ${colors.cyan}--topic "pricing"${RESET}    ${colors.dim}Topic-focused${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads briefing ${colors.cyan}--squad website${RESET}     ${colors.dim}Single squad${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads briefing ${colors.cyan}--agent${RESET}             ${colors.dim}JSON for agents${RESET}`);
  writeLine();
}

// ============================================================================
// Agent Output (JSON)
// ============================================================================

function renderAgentBriefing(data: BriefingData): void {
  // Clean output for agent consumption
  console.log(JSON.stringify(data, null, 2));
}

// ============================================================================
// Command Export
// ============================================================================

export async function briefingCommand(options: BriefingOptions = {}): Promise<void> {
  const squadsDir = findSquadsDir();

  if (!squadsDir) {
    if (options.json || options.agent) {
      console.log(JSON.stringify({ error: 'No .agents/squads directory found' }));
    } else {
      writeLine(`${colors.red}No .agents/squads directory found${RESET}`);
      writeLine(`${colors.dim}Run \`squads init\` to create one.${RESET}`);
    }
    process.exit(1);
  }

  const data = await collectBriefingData(options);

  if (options.json || options.agent) {
    renderAgentBriefing(data);
  } else {
    renderHumanBriefing(data, options);
  }
}
