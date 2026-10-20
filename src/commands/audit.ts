/**
 * squads audit - Inventory the org root: what isn't in git, declared, measured, or true (#1327)
 *
 * Read-only by default (--run-metrics executes repo code and needs --yes). Walks the org root (see org-root.ts) and classifies every unit:
 * git state, self-description, runnable metric, delivery basics, activity vs
 * lifecycle, docs facts, retired names. Prints a dated report; --propose
 * drafts one issue per gap (draft only, never filed).
 */

import { colors, RESET, bold, dim, writeLine, padEnd } from '../lib/terminal.js';
import { findOrgRoot } from '../lib/org-root.js';
import { auditOrg, type OrgAuditReport, type UnitAudit } from '../lib/org-audit.js';

interface AuditCommandOptions {
  json?: boolean;
  propose?: boolean;
  staleDays?: string;
  runMetrics?: boolean;
  /** Confirm --run-metrics: run the listed commands without a prompt. */
  yes?: boolean;
  idleDays?: string;
}

function parseDays(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function classifyLabel(unit: UnitAudit): string {
  if (unit.unclassified) return 'unclassified';
  const classes = [unit.kind ?? '?', unit.lifecycle ?? 'active'];
  return classes.join('/');
}

function metricColor(status: UnitAudit['metric']): string {
  switch (status) {
    case 'ok': return colors.green;
    case 'undeclared': return colors.dim;
    default: return colors.yellow;
  }
}

function printUnit(unit: UnitAudit): void {
  const name = padEnd(unit.name, 24);
  const cls = padEnd(classifyLabel(unit), 20);
  const git = unit.inGit ? (unit.hasRemote ? 'git+remote' : `${colors.yellow}no-remote${RESET}`) : `${colors.yellow}not-in-git${RESET}`;
  const metric = `${metricColor(unit.metric)}${unit.metric}${RESET}`;
  writeLine(`  ${name} ${cls} ${padEnd(git, 18)} ${metric}`);
  for (const f of unit.findings) {
    const gap = unit.countsAsGap ? `${colors.red}gap${RESET}` : `${dim}info${RESET}`;
    writeLine(`    ${gap} [${f.check}] ${f.code} — ${f.message}`);
  }
  for (const hint of unit.hints) {
    writeLine(`    ${dim}hint: ${hint}${RESET}`);
  }
}

function printReport(report: OrgAuditReport): void {
  writeLine();
  writeLine(`${bold}Org audit — ${report.date}${RESET}`);
  writeLine(`${dim}${report.orgRoot}${RESET}`);
  writeLine();

  if (report.units.length === 0) {
    writeLine('No units found in the org root.');
    return;
  }

  for (const unit of report.units) {
    printUnit(unit);
  }

  if (report.orgFindings.length > 0) {
    writeLine();
    writeLine(`${bold}Org-level findings${RESET}`);
    for (const f of report.orgFindings) {
      writeLine(`  ${colors.red}gap${RESET} [${f.check}] ${f.code} — ${f.message}`);
    }
  }

  writeLine();
  const { units, gaps, parkedOrArchived } = report.summary;
  writeLine(`${bold}${units}${RESET} units · ${gaps === 0 ? colors.green : colors.red}${gaps} gaps${RESET} · ${dim}${parkedOrArchived} parked/archived (listed, not counted)${RESET}`);

  if (report.proposals) {
    writeLine();
    writeLine(`${bold}Proposed issues (drafts — not filed)${RESET}`);
    if (report.proposals.length === 0) {
      writeLine(`  ${dim}no gaps to propose for${RESET}`);
    }
    for (const p of report.proposals) {
      writeLine(`  ${colors.cyan}${p.repo}${RESET}: ${p.title}`);
    }
    writeLine(`  ${dim}review and file with: gh issue create --repo <unit-repo> --title "..."${RESET}`);
  }
  writeLine();
}

/** Print a structured error (JSON or text) and exit non-zero so CI wrappers can tell "nothing audited" from success. */
function fail(options: AuditCommandOptions, error: string, hint: string): void {
  if (options.json) {
    writeLine(JSON.stringify({ error, hint }, null, 2));
  } else {
    writeLine(hint);
  }
  process.exitCode = 2;
}

export async function auditCommand(options: AuditCommandOptions = {}): Promise<void> {
  let org: ReturnType<typeof findOrgRoot>;
  try {
    org = findOrgRoot();
  } catch (e) {
    fail(options, 'invalid-org-root', e instanceof Error ? e.message : String(e));
    return;
  }

  if (!org) {
    fail(options, 'no-org-root', 'No org root found. Set SQUADS_ORG_ROOT, run from a workspace containing the control repo (default: hq), or from a squads project.');
    return;
  }

  const baseOptions = {
    staleDays: parseDays(options.staleDays, 14),
    idleDays: parseDays(options.idleDays, 30),
    propose: options.propose,
    controlRepo: org.controlRepo,
  };

  let runMetrics = false;
  if (options.runMetrics) {
    // Metric commands are code from the audited repos: show exactly what would run, and require --yes.
    const preview = auditOrg(org.root, baseOptions);
    const pending = preview.units.filter((u) => u.metricCommand && u.metric === 'declared' && u.lifecycle !== 'parked' && u.lifecycle !== 'archived');
    for (const u of pending) {
      process.stderr.write(`metric to run [${u.name}]: ${u.metricCommand}\n`);
    }
    if (pending.length > 0 && !options.yes) {
      process.stderr.write('--run-metrics executes the commands above with a scrubbed environment. Re-run with --yes to confirm.\n');
      process.exitCode = 2;
      return;
    }
    runMetrics = true;
  }

  const report = auditOrg(org.root, { ...baseOptions, runMetrics });

  if (options.json) {
    writeLine(JSON.stringify(report, null, 2));
    return;
  }
  printReport(report);
}
