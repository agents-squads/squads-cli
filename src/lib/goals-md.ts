/**
 * Parser for a squad's `.agents/memory/<squad>/goals.md` — the goal list
 * `squads goals` shows and `squads domains` counts. Sections: `## Active`,
 * `## Achieved`, `## Abandoned`, `## Proposed`. A goal is a line with a bold
 * name and `| status: X |`; achieved goals carry `achieved:` instead.
 */
import { existsSync, readFileSync } from 'fs';

export interface GoalInfo {
  name: string;
  status: string;
  section: 'active' | 'achieved' | 'abandoned' | 'proposed';
  /** First `YYYY-MM-DD` in the goal's `deadline:` field, local midnight. */
  deadline?: Date;
}

const DEADLINE_RE = /deadline:\s*[^|]*?(\d{4})-(\d{2})-(\d{2})/;

function deadlineOf(line: string): Date | undefined {
  const m = line.match(DEADLINE_RE);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function parseGoalsMd(filePath: string): GoalInfo[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const goals: GoalInfo[] = [];
  let currentSection: GoalInfo['section'] = 'active';

  for (const line of content.split('\n')) {
    if (line.startsWith('## Active')) currentSection = 'active';
    else if (line.startsWith('## Achieved')) currentSection = 'achieved';
    else if (line.startsWith('## Abandoned')) currentSection = 'abandoned';
    else if (line.startsWith('## Proposed')) currentSection = 'proposed';

    const match = line.match(/\*\*([^*]+)\*\*.*status:\s*(\S+)/);
    if (match) {
      const deadline = deadlineOf(line);
      goals.push({ name: match[1].trim(), status: match[2].trim(), section: currentSection, ...(deadline ? { deadline } : {}) });
      continue;
    }
    // Achieved goals don't have a status field — detect by section
    if (currentSection === 'achieved' && line.match(/\*\*([^*]+)\*\*.*achieved:/)) {
      const nameMatch = line.match(/\*\*([^*]+)\*\*/);
      if (nameMatch) goals.push({ name: nameMatch[1].trim(), status: 'achieved', section: 'achieved' });
    }
  }
  return goals;
}

const DONE_STATUSES = new Set(['achieved', 'complete', 'completed', 'done']);

/** active / done / overdue, as `squads domains` reports them. */
export function goalCounts(goals: GoalInfo[], todayStart: number): { active: number; done: number; overdue: number } {
  const active = goals.filter((g) => g.section === 'active' && !DONE_STATUSES.has(g.status.toLowerCase()));
  return {
    active: active.length,
    done: goals.filter((g) => g.section === 'achieved' || (g.section === 'active' && DONE_STATUSES.has(g.status.toLowerCase()))).length,
    overdue: active.filter((g) => g.deadline !== undefined && g.deadline.getTime() < todayStart).length,
  };
}
