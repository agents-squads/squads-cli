/**
 * `squads inbox` — everything waiting on a human, in one screen (#924).
 * Review-queue Child 0: list only; approve/reject/defer land in Child A.
 */
import { getProjectRoot } from '../lib/run-utils.js';
import { buildInbox, type InboxItem } from '../lib/inbox.js';
import { colors, RESET, bold, writeLine } from '../lib/terminal.js';

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  pr: 'PR',
  run_branch: 'BRANCH',
  run_artifacts: 'RUN',
};

export async function inboxCommand(options: { json?: boolean }): Promise<void> {
  const projectRoot = getProjectRoot();
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

  writeLine(`  ${bold}Inbox${RESET} ${colors.dim}— ${items.length} item${items.length > 1 ? 's' : ''} waiting on a human · approve verbs land in the next release${RESET}`);
  writeLine();
  for (const item of items) {
    const age = item.ageDays === 0 ? 'today' : `${item.ageDays}d`;
    const ageColor = item.ageDays >= 7 ? colors.red : item.ageDays >= 2 ? colors.yellow : colors.dim;
    writeLine(`  ${colors.cyan}${KIND_LABEL[item.kind].padEnd(6)}${RESET} ${ageColor}${age.padStart(5)}${RESET}  ${item.title}`);
    writeLine(`         ${colors.dim}yes = ${item.approveSemantics}${item.detail ? ` · ${item.detail}` : ''}${RESET}`);
  }
  writeLine();
}
