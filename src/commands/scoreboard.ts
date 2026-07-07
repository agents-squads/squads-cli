/**
 * `squads scoreboard` — the executor referee (outcome-driven routing §3.2).
 * Read-only v1: quality-per-cost per (task class × provider × model) from the
 * execution ledger; --resolve checks recent artifacts live for landed-rate.
 */
import { join } from 'path';
import { getProjectRoot } from '../lib/run-utils.js';
import { findMemoryDir } from '../lib/memory.js';
import {
  readExecutionRecords,
  buildScoreboard,
  readSquadFeedback,
  renderScoreboard,
  modelFamily,
} from '../lib/scoreboard.js';
import { detectTaskType } from '../lib/run-utils.js';
import { existsSync, readFileSync } from 'fs';
import { execEventsFile } from '../lib/exec-events.js';
import { parsePersistedLine } from '../lib/event-render.js';
import { writeLine } from '../lib/terminal.js';

/** Cap on live gh resolutions per invocation — the board must stay fast. */
const RESOLVE_MAX_RUNS = 20;

export async function scoreboardCommand(options: { json?: boolean; days?: string; resolve?: boolean }): Promise<void> {
  const projectRoot = getProjectRoot();
  const windowDays = Math.max(1, parseInt(options.days || '30', 10) || 30);
  const records = readExecutionRecords(projectRoot, windowDays);
  const board = buildScoreboard(records, { windowDays, resolved: !!options.resolve });

  if (options.resolve) {
    // Live landed-rate for the most recent runs that recorded events (#909).
    // Capped so the board renders in seconds, not a rate-limit stall; the cap
    // is announced in the output (no silent truncation).
    const { resolveRunOutcome } = await import('../lib/outcome-resolve.js');
    const recent = [...records].reverse().slice(0, RESOLVE_MAX_RUNS * 3); // newest first, some won't have events
    let checkedRuns = 0;
    for (const r of recent) {
      if (checkedRuns >= RESOLVE_MAX_RUNS) break;
      const file = execEventsFile(projectRoot, r.id);
      if (!existsSync(file)) continue;
      let events;
      try {
        events = readFileSync(file, 'utf8').split('\n').map(parsePersistedLine).filter((l): l is NonNullable<typeof l> => l !== null);
      } catch { continue; }
      if (events.length === 0) continue;
      const outcome = resolveRunOutcome(events);
      const prs = outcome.artifacts.filter((a) => a.kind === 'pr');
      if (prs.length === 0) continue;
      checkedRuns++;
      const key = { provider: r.provider || 'unknown', model: modelFamily(r.model), taskClass: detectTaskType(r.agent) || 'execution' };
      const row = board.rows.find((x) => x.provider === key.provider && x.model === key.model && x.taskClass === key.taskClass);
      if (!row) continue;
      row.landed = row.landed ?? { checked: 0, merged: 0, rate: 0 };
      row.landed.checked += prs.length;
      row.landed.merged += prs.filter((a) => a.state === 'merged').length;
      row.landed.rate = row.landed.checked > 0 ? row.landed.merged / row.landed.checked : 0;
    }
  }

  const memoryDir = findMemoryDir() || join(projectRoot, '.agents', 'memory');
  board.feedback = readSquadFeedback(memoryDir);

  if (options.json) {
    writeLine(JSON.stringify(board, null, 2));
    return;
  }
  for (const line of renderScoreboard(board)) writeLine(line);
}
