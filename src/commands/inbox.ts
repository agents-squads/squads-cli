/**
 * `squads inbox` — everything waiting on a human, in one screen (#924), and
 * the three decision verbs (#933, review-queue Child A):
 *
 *   squads inbox                       list what's waiting
 *   squads inbox approve <id>          execute the item's approve semantics
 *   squads inbox reject <id> --reason  close/archive + write-through to feedback
 *   squads inbox defer <id> [--days N] snooze; resurfaces automatically
 */
import { getProjectRoot } from '../lib/run-utils.js';
import { buildInbox, type InboxItem } from '../lib/inbox.js';
import { approveItem, rejectItem, deferItem, type DecisionOutcome } from '../lib/inbox-decisions.js';
import { colors, RESET, bold, writeLine } from '../lib/terminal.js';

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  pr: 'PR',
  run_branch: 'BRANCH',
  run_artifacts: 'RUN',
};

const VERBS = new Set(['approve', 'reject', 'defer']);

export interface InboxOptions {
  json?: boolean;
  reason?: string;
  days?: string;
}

export async function inboxCommand(action?: string, id?: string, options: InboxOptions = {}): Promise<void> {
  const projectRoot = getProjectRoot();

  if (!action) {
    return listInbox(projectRoot, options);
  }
  if (!VERBS.has(action)) {
    writeLine(`  ${colors.red}Unknown inbox action '${action}'${RESET} ${colors.dim}— use approve | reject | defer (or no action to list)${RESET}`);
    process.exitCode = 1;
    return;
  }
  if (!id) {
    writeLine(`  ${colors.red}Missing item id${RESET} ${colors.dim}— run 'squads inbox' to see ids (pr-12, branch-…, run-…)${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Verbs must see deferred items too (so a snoozed item can be decided early).
  const items = buildInbox(projectRoot, projectRoot, { includeDeferred: true });
  const item = items.find((i) => i.id === id);
  if (!item) {
    writeLine(`  ${colors.red}No inbox item '${id}'${RESET}`);
    if (items.length > 0) {
      writeLine(`  ${colors.dim}available: ${items.map((i) => i.id).join(', ')}${RESET}`);
    }
    process.exitCode = 1;
    return;
  }

  const ctx = { repoRoot: projectRoot, obsRoot: projectRoot };
  let outcome: DecisionOutcome;
  if (action === 'approve') {
    outcome = approveItem(item, ctx);
  } else if (action === 'reject') {
    if (!options.reason) {
      writeLine(`  ${colors.red}reject needs --reason${RESET} ${colors.dim}— the reason writes through to squads feedback so the squad learns from it${RESET}`);
      process.exitCode = 1;
      return;
    }
    outcome = rejectItem(item, options.reason, ctx);
  } else {
    outcome = deferItem(item, parseInt(options.days ?? '7', 10), ctx);
  }

  if (options.json) {
    writeLine(JSON.stringify({ id: item.id, action, ...outcome }, null, 2));
  } else {
    const mark = outcome.ok ? `${colors.green}✓${RESET}` : `${colors.red}✗${RESET}`;
    writeLine(`  ${mark} ${action} ${colors.cyan}${item.id}${RESET} ${colors.dim}— ${outcome.message}${RESET}`);
  }
  if (!outcome.ok) process.exitCode = 1;
}

function listInbox(projectRoot: string, options: InboxOptions): void {
  const items = buildInbox(projectRoot, projectRoot);

  if (options.json) {
    writeLine(JSON.stringify({ count: items.length, items }, null, 2));
    return;
  }

  writeLine();
  if (items.length === 0) {
    writeLine(`  ${colors.green}Inbox zero${RESET} ${colors.dim}— nothing is waiting on a human decision.${RESET}`);
    writeLine();
    return;
  }

  writeLine(`  ${bold}Inbox${RESET} ${colors.dim}— ${items.length} item${items.length > 1 ? 's' : ''} waiting · squads inbox approve|reject|defer <id>${RESET}`);
  writeLine();
  for (const item of items) {
    const age = item.ageDays === 0 ? 'today' : `${item.ageDays}d`;
    const ageColor = item.ageDays >= 7 ? colors.red : item.ageDays >= 2 ? colors.yellow : colors.dim;
    writeLine(`  ${colors.cyan}${KIND_LABEL[item.kind].padEnd(6)}${RESET} ${ageColor}${age.padStart(5)}${RESET}  ${colors.dim}${item.id}${RESET}  ${item.title}`);
    writeLine(`         ${colors.dim}yes = ${item.approveSemantics}${item.detail ? ` · ${item.detail}` : ''}${RESET}`);
  }
  writeLine();
}
