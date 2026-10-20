/**
 * squads audit - Inventory the org root: what isn't in git, declared, measured, or true (#1327)
 *
 * Read-only. Walks the org root (see org-root.ts) and classifies every unit:
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

export async function auditCommand(options: AuditCommandOptions = {}): Promise<void> {
  const org = findOrgRoot();

  if (!org) {
    const empty = {
      error: 'no-org-root',
      hint: 'No org root found. Set SQUADS_ORG_ROOT, run from a workspace containing the control repo (default: hq), or from a squads project.',
    };
    if (options.json) {
      writeLine(JSON.stringify(empty, null, 2));
    } else {
      writeLine(empty.hint);
    }
    return;
  }

  const report = auditOrg(org.root, {
    staleDays: parseDays(options.staleDays, 14),
    idleDays: parseDays(options.idleDays, 30),
    propose: options.propose,
    controlRepo: org.controlRepo,
  });

  if (options.json) {
    writeLine(JSON.stringify(report, null, 2));
    return;
  }
  printReport(report);
}
