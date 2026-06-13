/**
 * Org cycle — run the whole organization as a coordinated system.
 *
 * squads run --org [--dry-run]
 *
 * Steps:
 * 1. SCAN:    Check all squads — priorities freshness, goal progress, scorecard grades
 * 2. PLAN:    Decide what to run — skip frozen, prioritize by staleness + score
 * 3. EXECUTE: Run leads in dependency order (phased)
 * 4. EVALUATE: COO reviews all outputs
 * 5. REPORT:  Org-level summary to observability
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { spawnSync, spawn } from 'child_process';
import { join } from 'path';
import { findSquadsDir, loadSquad, findProjectRoot } from './squad-parser.js';
import { findMemoryDir } from './memory.js';
import { colors, bold, RESET, writeLine } from './terminal.js';

export interface OrgScanResult {
  squad: string;
  status: 'active' | 'frozen' | 'stale' | 'healthy';
  prioritiesAge: number; // days since last update
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
  const now = Date.now();

  for (const squadName of readdirSync(squadsDir).sort()) {
    const squadPath = join(squadsDir, squadName);
    if (!statSync(squadPath).isDirectory()) continue;
    if (!existsSync(join(squadPath, 'SQUAD.md'))) continue;

    const squad = loadSquad(squadName);
    const result: OrgScanResult = {
      squad: squadName,
      status: 'healthy',
      prioritiesAge: 999,
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

    // Check if frozen
    const prioritiesPath = join(memoryDir, squadName, 'priorities.md');
    if (existsSync(prioritiesPath)) {
      const content = readFileSync(prioritiesPath, 'utf-8');
      if (content.includes('frozen')) {
        result.status = 'frozen';
        result.reason = 'Squad frozen — no work until trigger';
        results.push(result);
        continue;
      }

      // Check freshness from frontmatter
      const updatedMatch = content.match(/updated:\s*"?(\d{4}-\d{2}-\d{2})"?/);
      if (updatedMatch) {
        const updated = new Date(updatedMatch[1]).getTime();
        result.prioritiesAge = Math.round((now - updated) / (24 * 60 * 60 * 1000));
      }
    }

    // Check goals
    const goalsPath = join(memoryDir, squadName, 'goals.md');
    if (existsSync(goalsPath)) {
      const content = readFileSync(goalsPath, 'utf-8');
      const activeMatches = content.match(/status: (in-progress|not-started)/g);
      result.goalsActive = activeMatches?.length || 0;
    }

    // Determine status
    if (result.prioritiesAge > 14) {
      result.status = 'stale';
      result.reason = `Priorities ${result.prioritiesAge}d old`;
    } else if (result.goalsActive === 0) {
      result.status = 'stale';
      result.reason = 'No active goals';
    } else {
      result.reason = `${result.goalsActive} active goals, priorities ${result.prioritiesAge}d old`;
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
 * Refresh founder context before an org cycle.
 *
 * Looks for the digest script at one of two paths (in order):
 *   - .claude/hooks/founder-context-digest.py   (preferred — version-controlled hook)
 *   - scripts/founder-context-digest.py         (fallback — for projects with a scripts/ dir)
 *
 * Runs the script when `.agents/memory/company/founder-context.md` is missing
 * or older than `staleHours` (default 2h). On success, the digest writes:
 *   - .agents/memory/company/founder-context.md  (universal)
 *   - .agents/memory/{squad}/founder-alignment.md  (per-squad)
 * which `gatherSquadContext` then injects into every agent's prompt.
 *
 * Returns:
 *   'refreshed' — digest ran successfully and produced fresh files
 *   'fresh'     — existing context is recent enough, no refresh needed
 *   'skipped'   — no digest script found at expected paths; nothing to do
 *   'failed'    — digest exited non-zero; org cycle should NOT proceed
 */
export function refreshFounderContext(
  options: { staleHours?: number; force?: boolean } = {}
): 'refreshed' | 'fresh' | 'skipped' | 'failed' | 'refreshing' {
  const projectRoot = findProjectRoot();
  if (!projectRoot) return 'skipped';

  const candidatePaths = [
    join(projectRoot, '.claude', 'hooks', 'founder-context-digest.py'),
    join(projectRoot, 'scripts', 'founder-context-digest.py'),
  ];
  const digestScript = candidatePaths.find(p => existsSync(p));
  if (!digestScript) return 'skipped';

  const memoryDir = findMemoryDir();
  const contextFile = memoryDir
    ? join(memoryDir, 'company', 'founder-context.md')
    : null;

  const staleHours = options.staleHours ?? 2;
  const MS_PER_HOUR = 60 * 60 * 1000;

  let isStale = true;
  if (!options.force && contextFile && existsSync(contextFile)) {
    try {
      const ageHours = (Date.now() - statSync(contextFile).mtimeMs) / MS_PER_HOUR;
      if (ageHours < staleHours) {
        isStale = false;
        writeLine(
          `  ${colors.dim}founder-context: fresh (${ageHours.toFixed(1)}h old, threshold ${staleHours}h)${RESET}`
        );
      }
    } catch { /* */ }
  }

  if (!isStale) return 'fresh';

  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const hasExisting = !!(contextFile && existsSync(contextFile));
  const syncForced = process.env.SQUADS_DIGEST_SYNC === '1' || !!options.force;

  // #447: don't block the run on the multi-minute digest. If a (stale) context
  // file already exists, refresh it in the BACKGROUND (detached) and proceed now
  // with the current copy — the refresh lands for the next run. Block (bounded)
  // only on first-ever generation or when explicitly forced (--force / SQUADS_DIGEST_SYNC=1).
  if (hasExisting && !syncForced) {
    writeLine(`  ${colors.dim}founder-context: stale — refreshing in background; this run uses the current copy${RESET}`);
    try {
      const child = spawn(pythonCmd, [digestScript], { cwd: projectRoot, detached: true, stdio: 'ignore' });
      child.unref();
    } catch { /* best-effort — the run proceeds with the stale copy regardless */ }
    return 'refreshing';
  }

  writeLine(`  ${colors.dim}founder-context: ${hasExisting ? 'refreshing (forced)' : 'generating (first run)'} — CC sessions + git activity...${RESET}`);
  // Two Claude calls (universal + per-squad) can take 5-8 min on large inputs. Cap at 12 min.
  const result = spawnSync(pythonCmd, [digestScript], {
    cwd: projectRoot,
    stdio: 'inherit',
    timeout: 12 * 60 * 1000,
  });

  if (result.error) {
    const isTimeout = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    writeLine(
      `  ${colors.yellow}founder-context: digest ${isTimeout ? 'timed out' : 'failed to start'}: ${result.error.message}${RESET}`
    );
    return 'failed';
  }

  if (result.status === 0) {
    writeLine(`  ${colors.green}founder-context: refreshed${RESET}\n`);
    return 'refreshed';
  }
  writeLine(
    `  ${colors.yellow}founder-context: digest failed (exit ${result.status ?? '?'}). ` +
    `Org cycle blocked — agents would run without strategic alignment.${RESET}\n`
  );
  return 'failed';
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
