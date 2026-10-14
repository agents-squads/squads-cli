/**
 * `squads domains` (#1280) — per-domain (squad) business scorecard.
 *
 * One row per domain: what it set out to do (goals), what it delivered
 * (git-derived merged PRs + closed issues over --days), and what's in flight
 * (live runs + inbox items waiting on a human). The data is assembled by
 * `lib/domains.ts`; this command renders it — a table for a human, versioned
 * JSON (`--json`) for the console home screen and Slack digests.
 *
 * `--json` carries `v: 1`, `days`, `fetchedAt`, `stale`, and `domains` sorted
 * by last activity (newest first).
 */

import { getProjectRoot } from '../lib/run-utils.js';
import { buildDomains, type DomainRow, type DomainsReport } from '../lib/domains.js';
import {
  colors,
  bold,
  RESET,
  dim,
  padEnd,
  truncate,
  writeLine,
} from '../lib/terminal.js';

export interface DomainsCommandOptions {
  /** Delivery window, in days (string from Commander). Default 7. */
  days?: string;
  json?: boolean;
}

const DEFAULT_DAYS = 7;

/** "3/5 · 1 late", or "3/5" when nothing is overdue; "—" with no goals. */
export function goalsCell(row: DomainRow): string {
  const { done, active, overdue } = row.goals;
  const total = done + active;
  if (total === 0) return '—';
  const base = `${done}/${total}`;
  return overdue > 0 ? `${base} · ${overdue} late` : base;
}

/** "4 PR · 2 issues", with a stale marker; "n/a" when GitHub was unreachable. */
export function deliveredCell(row: DomainRow): string {
  if (!row.delivered) return 'n/a';
  const parts: string[] = [];
  if (row.delivered.prsMerged > 0) parts.push(`${row.delivered.prsMerged} PR`);
  if (row.delivered.issuesClosed > 0) parts.push(`${row.delivered.issuesClosed} issues`);
  const body = parts.length ? parts.join(' · ') : 'nothing';
  return row.delivered.stale ? `${body} (stale)` : body;
}

/** "1 run · 2 to review"; "—" when there is nothing live or waiting. */
export function nowCell(row: DomainRow): string {
  const parts: string[] = [];
  if (row.now.running > 0) parts.push(`${row.now.running} run${row.now.running > 1 ? 's' : ''}`);
  if (row.now.needsYou > 0) parts.push(`${row.now.needsYou} to review`);
  return parts.length ? parts.join(' · ') : '—';
}

/** Relative age of an ISO timestamp ("just now", "3d ago"); "—" when null. */
export function relativeAge(iso: string | null, now: string): string {
  if (!iso) return '—';
  const ms = Date.parse(now) - Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function renderDomainsTable(report: DomainsReport): void {
  const t = {
    domain: 'DOMAIN',
    repo: 'REPO',
    goals: 'GOALS',
    delivered: 'DELIVERED',
    now: 'NOW',
    last: 'LAST',
  };

  const rows = report.domains.map((row) => ({
    domain: row.domain,
    repo: row.repo ? (row.sharedWith.length ? `${row.repo} (shared: ${row.sharedWith.join(', ')})` : row.repo) : '—',
    goals: goalsCell(row),
    delivered: deliveredCell(row),
    now: nowCell(row),
    last: relativeAge(row.lastActivityAt, report.fetchedAt),
  }));

  const w = {
    domain: Math.max(t.domain.length, ...rows.map((r) => r.domain.length)),
    repo: Math.max(t.repo.length, ...rows.map((r) => r.repo.length)),
    goals: Math.max(t.goals.length, ...rows.map((r) => r.goals.length)),
    delivered: Math.max(t.delivered.length, ...rows.map((r) => r.delivered.length)),
    now: Math.max(t.now.length, ...rows.map((r) => r.now.length)),
  };

  writeLine();
  writeLine(`${bold}${padEnd(t.domain, w.domain)}  ${padEnd(t.repo, w.repo)}  ${padEnd(t.goals, w.goals)}  ${padEnd(t.delivered, w.delivered)}  ${padEnd(t.now, w.now)}  ${t.last}${RESET}`);
  writeLine(`${dim}${'─'.repeat(w.domain + w.repo + w.goals + w.delivered + w.now + t.last.length + 12)}${RESET}`);

  for (const r of rows) {
    writeLine(
      `${padEnd(r.domain, w.domain)}  ` +
      `${dim}${padEnd(truncate(r.repo, 32), w.repo)}${RESET}  ` +
      `${padEnd(r.goals, w.goals)}  ` +
      `${padEnd(r.delivered, w.delivered)}  ` +
      `${padEnd(r.now, w.now)}  ` +
      `${dim}${r.last}${RESET}`,
    );
  }

  const note = report.stale
    ? `${colors.yellow}delivered figures served from cache — GitHub was unreachable${RESET}`
    : `${dim}delivered = merged PRs + closed issues in the last ${report.days} day${report.days === 1 ? '' : 's'} (git-derived)${RESET}`;
  writeLine();
  writeLine(note);
  writeLine();
}

export async function domainsCommand(options: DomainsCommandOptions = {}): Promise<void> {
  const days = options.days === undefined ? DEFAULT_DAYS : parseInt(options.days, 10);
  if (!Number.isInteger(days) || days <= 0) {
    const msg = `Invalid --days "${options.days}" — expected a positive integer`;
    if (options.json) writeLine(JSON.stringify({ ok: false, command: 'domains', error: msg }));
    else writeLine(`${colors.red}${msg}${RESET}`);
    process.exitCode = 1;
    return;
  }

  const projectRoot = getProjectRoot();
  const report = buildDomains({ projectRoot, days });

  if (options.json) {
    writeLine(JSON.stringify(report, null, 2));
    return;
  }
  if (report.domains.length === 0) {
    writeLine();
    writeLine(`${dim}No domains found — run ${RESET}squads init${dim} to scaffold squads.${RESET}`);
    writeLine();
    return;
  }
  renderDomainsTable(report);
}
