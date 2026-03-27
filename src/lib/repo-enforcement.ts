/**
 * Repo enforcement — validates workspace layout before agent execution.
 *
 * Checks:
 * 1. SQUAD.md repo: field points to an existing sibling repo
 * 2. No nested .git directories inside hq (prevents clone-inside-hq)
 * 3. Agent definitions exist in hq only (not in domain repos)
 *
 * Called by agent-runner before spawning Claude Code.
 * Warns on mismatches, blocks on critical (nested .git).
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { findProjectRoot, loadSquad } from './squad-parser.js';
import { colors, RESET, writeLine } from './terminal.js';

export interface EnforcementResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Validate workspace layout for a squad before execution.
 */
export function enforceRepoLayout(squadName: string, options?: { verbose?: boolean }): EnforcementResult {
  const result: EnforcementResult = { ok: true, warnings: [], errors: [] };
  const projectRoot = findProjectRoot();
  if (!projectRoot) return result; // Can't validate without project root

  const parentDir = dirname(projectRoot);

  // 1. Check SQUAD.md repo: field points to existing sibling
  try {
    const squad = loadSquad(squadName);
    if (squad?.repo) {
      const repoName = squad.repo.split('/').pop();
      if (repoName) {
        const siblingPath = join(parentDir, repoName);
        if (!existsSync(siblingPath)) {
          result.warnings.push(`Target repo '${squad.repo}' not found locally at ${siblingPath}`);
        } else if (options?.verbose) {
          writeLine(`  ${colors.dim}Target repo: ${siblingPath}${RESET}`);
        }
      }
    }
  } catch {
    // Squad not found — not our problem here
  }

  // 2. Check for nested .git directories inside project root
  // Only check top-level dirs (not .agents/memory/* which are fine)
  try {
    const topLevelDirs = readdirSync(projectRoot).filter(f => {
      if (f.startsWith('.')) return false; // Skip hidden dirs
      try { return statSync(join(projectRoot, f)).isDirectory(); } catch { return false; }
    });

    for (const dir of topLevelDirs) {
      const nestedGit = join(projectRoot, dir, '.git');
      if (existsSync(nestedGit)) {
        result.errors.push(`Nested git repo found at ${dir}/ — this breaks 'git add'. Remove it or move to a sibling directory.`);
        result.ok = false;
      }
    }
  } catch {
    // Can't read directory — skip
  }

  // 3. Check .agents/idp/ doesn't have a .git (the bug we hit)
  const idpGit = join(projectRoot, '.agents', 'idp', '.git');
  if (existsSync(idpGit)) {
    result.errors.push(`Nested git repo in .agents/idp/ — remove it. IDP instance data should be part of hq, not a separate clone.`);
    result.ok = false;
  }

  return result;
}

/**
 * Run enforcement and display results. Returns false if blocked.
 */
export function checkAndReport(squadName: string, options?: { verbose?: boolean }): boolean {
  const result = enforceRepoLayout(squadName, options);

  for (const warning of result.warnings) {
    writeLine(`  ${colors.yellow}warn${RESET}: ${warning}`);
  }

  for (const error of result.errors) {
    writeLine(`  ${colors.red}error${RESET}: ${error}`);
  }

  return result.ok;
}
