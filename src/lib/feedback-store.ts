/**
 * feedback-store.ts — append an entry to a squad's feedback log from library
 * code (no UI, no telemetry). Same file + format as `squads feedback add`
 * (src/commands/feedback.ts) so the context loader picks both up identically;
 * the command keeps its richer interactive flow.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { findMemoryDir } from './memory.js';
import { loadSquad } from './squad-parser.js';

export function feedbackPathFor(squadName: string): string | null {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return null;
  const squad = loadSquad(squadName);
  const agentName = squad?.agents[0]?.name || `${squadName}-lead`;
  return join(memoryDir, squadName, agentName, 'feedback.md');
}

/** Append one feedback entry; false when no memory dir / unknown squad. */
export function appendFeedbackEntry(squadName: string, rating: number, feedback: string): boolean {
  const path = feedbackPathFor(squadName);
  if (!path) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const clamped = Math.min(5, Math.max(1, Math.round(rating)));
    const date = new Date().toISOString().split('T')[0];
    const entry =
      `\n---\n_Date: ${date}_\n\n` +
      `**Execution**: squads inbox decision\n` +
      `**Rating**: ${clamped}/5 ${'★'.repeat(clamped)}${'☆'.repeat(5 - clamped)}\n` +
      `**Feedback**: ${feedback}\n`;
    const existing = existsSync(path)
      ? readFileSync(path, 'utf-8')
      : `# ${squadName} - Feedback Log\n\n> Execution feedback and learnings\n`;
    writeFileSync(path, existing + entry);
    return true;
  } catch {
    return false;
  }
}
