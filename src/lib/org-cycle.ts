/**
 * Org cycle — run the whole organization as a coordinated system.
 *
 * squads run --org [--dry-run]
 *
 * Steps:
 * 1. SCAN:    Check all squads — goal progress, scorecard grades
 * 2. PLAN:    Decide what to run — skip frozen, prioritize by staleness + score
 * 3. EXECUTE: Run leads in dependency order (phased)
 * 4. EVALUATE: COO reviews all outputs
 * 5. REPORT:  Org-level summary to observability
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { findSquadsDir, loadSquad } from './squad-parser.js';
import { findMemoryDir } from './memory.js';
import { colors, bold, RESET, writeLine } from './terminal.js';

export interface OrgScanResult {
  squad: string;
  status: 'active' | 'frozen' | 'stale' | 'healthy';
  goalsActive: number;
  lastExecution: string | null;
  lead: string | null;
  repo: string | null;
  reason: string;
}

/**
 * Scan all squads and return their health status.
 */
export function scanOrg(): OrgScanResult[] {
  const squadsDir = findSquadsDir();
  const memoryDir = findMemoryDir();
  if (!squadsDir || !memoryDir) return [];

  const results: OrgScanResult[] = [];

  for (const squadName of readdirSync(squadsDir).sort()) {
    const squadPath = join(squadsDir, squadName);
    if (!statSync(squadPath).isDirectory()) continue;
    if (!existsSync(join(squadPath, 'SQUAD.md'))) continue;

    const squad = loadSquad(squadName);
    const result: OrgScanResult = {
      squad: squadName,
      status: 'healthy',
      goalsActive: 0,
      lastExecution: null,
      lead: null,
      repo: squad?.repo || null,
      reason: '',
    };

    // Find lead agent
    for (const file of readdirSync(squadPath)) {
      if (file.endsWith('-lead.md') || file === 'coo.md' || file.startsWith('web-lead') || file.startsWith('intel-lead') || file.startsWith('eng-lead')) {
        result.lead = file.replace('.md', '');
        break;
      }
    }

    // Check if the squad is explicitly paused via SQUAD.md frontmatter
    if (squad?.status === 'paused') {
      result.status = 'frozen';
      const pauseReason = squad.paused_reason ? `: ${squad.paused_reason}` : '';
      const since = squad.paused_since ? ` since ${squad.paused_since.slice(0, 10)}` : '';
      result.reason = `Paused${since}${pauseReason}`;
      results.push(result);
      continue;
    }

    // Check goals
    const goalsPath = join(memoryDir, squadName, 'goals.md');
    if (existsSync(goalsPath)) {
      const content = readFileSync(goalsPath, 'utf-8');
      // Check if frozen
      if (content.includes('frozen')) {
        result.status = 'frozen';
        result.reason = 'Squad frozen — no work until trigger';
        results.push(result);
        continue;
      }
      const activeMatches = content.match(/status: (in-progress|not-started)/g);
      result.goalsActive = activeMatches?.length || 0;
    }

    // Determine status
    if (result.goalsActive === 0) {
      result.status = 'stale';
      result.reason = 'No active goals';
    } else {
      result.reason = `${result.goalsActive} active goals`;
    }

    results.push(result);
  }

  return results;
}

/**
 * Plan which squads to run based on scan results.
 * Returns squads ordered by priority (most needy first).
 */
export function planOrgCycle(scan: OrgScanResult[]): OrgScanResult[] {
  return scan
    .filter(s => s.status !== 'frozen') // Skip frozen
    .filter(s => s.lead !== null)       // Must have a lead
    .sort((a, b) => {
      // Stale squads first
      if (a.status === 'stale' && b.status !== 'stale') return -1;
      if (b.status === 'stale' && a.status !== 'stale') return 1;
      // Then by goals count (more goals = more work to do)
      return b.goalsActive - a.goalsActive;
    });
}

/**
 * Display org scan results.
 */
export function displayOrgScan(scan: OrgScanResult[]): void {
  writeLine();
  writeLine(`  ${bold}Org Scan${RESET} (${scan.length} squads)\n`);

  const frozen = scan.filter(s => s.status === 'frozen');
  const stale = scan.filter(s => s.status === 'stale');
  const healthy = scan.filter(s => s.status === 'healthy');

  if (healthy.length > 0) {
    writeLine(`  ${colors.green}Healthy (${healthy.length})${RESET}`);
    for (const s of healthy) {
      writeLine(`    ${s.squad.padEnd(22)} ${colors.dim}${s.reason}${RESET}`);
    }
    writeLine();
  }

  if (stale.length > 0) {
    writeLine(`  ${colors.yellow}Stale (${stale.length})${RESET}`);
    for (const s of stale) {
      writeLine(`    ${s.squad.padEnd(22)} ${colors.yellow}${s.reason}${RESET}`);
    }
    writeLine();
  }

  if (frozen.length > 0) {
    writeLine(`  ${colors.dim}Frozen (${frozen.length}): ${frozen.map(s => s.squad).join(', ')}${RESET}`);
    writeLine();
  }
}

/**
 * Display execution plan.
 */
export function displayPlan(plan: OrgScanResult[]): void {
  writeLine(`  ${bold}Execution Plan${RESET} (${plan.length} squads)\n`);
  for (let i = 0; i < plan.length; i++) {
    const s = plan[i];
    const statusIcon = s.status === 'stale' ? `${colors.yellow}stale${RESET}` : `${colors.green}ready${RESET}`;
    writeLine(`  ${i + 1}. ${bold}${s.squad}${RESET} → ${s.lead} ${colors.dim}(${statusIcon}, ${s.goalsActive} goals)${RESET}`);
  }
  writeLine();
}
