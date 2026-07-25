/**
 * `squads report` — generate an evidence pack from local observability.
 *
 * `--for auditor` (the first report audience) renders everything agents did in
 * a project over a period — actions, human-gate decisions, merged diffs, and
 * model cost — into one auditor/CFO-readable document. All data is read
 * locally (executions.jsonl, reviewed.jsonl, git log); no network calls.
 *
 * See `src/lib/report.ts` for the gather + render logic (pure, tested).
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { version } from '../version.js';
import { getProjectRoot } from '../lib/run-utils.js';
import {
  parsePeriod,
  gatherReportData,
  renderAuditorMarkdown,
  renderAuditorHtml,
  type ReportFormat,
} from '../lib/report.js';
import { colors, bold, RESET, writeLine } from '../lib/terminal.js';

export interface ReportOptions {
  for?: string;
  period?: string;
  format?: string;
  out?: string;
}

const SUPPORTED_AUDIENCES = ['auditor'] as const;
type Audience = (typeof SUPPORTED_AUDIENCES)[number];

function periodFileLabel(period: string): string {
  // `30d` / `7d` are already path-safe; a range's `..` is too.
  return (period || '30d').replace(/[^\w.-]/g, '_');
}

/** Default output path for html (and explicit md --out writes a file too). */
function defaultOutPath(projectRoot: string, audience: Audience, format: ReportFormat, period: string): string {
  const ext = format === 'html' ? 'html' : 'md';
  return join(projectRoot, '.agents', 'reports', `${audience}-${periodFileLabel(period)}.${ext}`);
}

export async function reportCommand(options: ReportOptions = {}): Promise<void> {
  const audience = (options.for ?? '').trim();
  if (!SUPPORTED_AUDIENCES.includes(audience as Audience)) {
    writeLine(`  ${colors.red}✗${RESET} Unsupported report audience '${audience || '<none>'}'. Supported: ${SUPPORTED_AUDIENCES.join(', ')}.`);
    writeLine(`  ${colors.dim}Example: squads report --for auditor --period 30d${RESET}`);
    process.exitCode = 1;
    return;
  }

  const projectRoot = getProjectRoot();
  const periodRaw = options.period ?? '30d';
  let period;
  try {
    period = parsePeriod(periodRaw, new Date());
  } catch (e) {
    writeLine(`  ${colors.red}✗${RESET} ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  const format: ReportFormat = options.format === 'html' ? 'html' : 'md';

  const data = gatherReportData({
    projectRoot,
    cliVersion: version,
    generatedAt: new Date().toISOString(),
    period,
  });

  const content = format === 'html' ? renderAuditorHtml(data) : renderAuditorMarkdown(data);

  // `--out -` → stdout for either format.
  if (options.out === '-') {
    process.stdout.write(content);
    return;
  }

  // md defaults to stdout; html defaults to a file under .agents/reports/.
  const toFile = options.out != null || format === 'html';
  if (!toFile) {
    process.stdout.write(content);
    return;
  }

  const outPath = options.out ?? defaultOutPath(projectRoot, audience as Audience, format, periodRaw);
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content, 'utf8');
  } catch (e) {
    writeLine(`  ${colors.red}✗${RESET} Could not write report to ${outPath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  writeLine(`  ${colors.green}✓${RESET} ${bold}${auditorLabel(audience as Audience)}${RESET} report written (${format.toUpperCase()}, ${period.label})`);
  writeLine(`  ${colors.dim}${outPath}${RESET}`);
  const populated = data.runs.length + data.decisions.length + data.commits.length;
  if (populated === 0) {
    writeLine(`  ${colors.dim}No data recorded for this period — report shows empty sections (exit 0).${RESET}`);
  }
}

function auditorLabel(a: Audience): string {
  return a === 'auditor' ? 'Auditor evidence pack' : a;
}
