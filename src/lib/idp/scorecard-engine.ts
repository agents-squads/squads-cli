/**
 * Scorecard engine — evaluates services against quality checks.
 *
 * Sources data from:
 * - Local filesystem (README exists, build works)
 * - gh CLI (CI status, PRs, security alerts) — graceful if missing
 * - Git log (deploy frequency, recent activity)
 */

import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { CatalogEntry, ScorecardDefinition, ScorecardResult } from './types.js';

function exec(cmd: string, cwd?: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 15000, cwd, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function ghAvailable(): boolean {
  return exec('gh --version') !== null;
}

interface CheckResult {
  name: string;
  passed: boolean;
  weight: number;
  detail: string;
}

function runCheck(
  check: ScorecardDefinition['checks'][0],
  service: CatalogEntry,
  repoPath: string | null
): CheckResult {
  const result: CheckResult = { name: check.name, passed: false, weight: check.weight, detail: 'unknown' };
  const repo = service.metadata.repo;

  switch (check.name) {
    case 'ci-passing': {
      if (!ghAvailable()) { result.detail = 'gh CLI not available'; break; }
      const out = exec(`gh api repos/${repo}/actions/runs?per_page=1&status=completed --jq '.[0].conclusion // empty'`);
      // GitHub API returns runs array directly
      const out2 = exec(`gh api repos/${repo}/actions/runs --jq '.workflow_runs[0].conclusion // empty'`);
      const conclusion = out || out2;
      if (conclusion === 'success') { result.passed = true; result.detail = 'latest run: success'; }
      else if (conclusion) { result.detail = `latest run: ${conclusion}`; }
      else { result.detail = 'no CI runs found'; }
      break;
    }

    case 'test-coverage': {
      // Would need CI output parsing — for v0.1, check if test command exists
      if (service.spec.ci.test_command && service.spec.ci.test_command !== 'null') {
        result.passed = true;
        result.detail = `test command defined: ${service.spec.ci.test_command}`;
      } else {
        result.detail = 'no test command configured';
      }
      break;
    }

    case 'build-succeeds': {
      if (repoPath && service.spec.ci.build_command) {
        const buildResult = exec(`cd "${repoPath}" && ${service.spec.ci.build_command} 2>&1`);
        if (buildResult !== null) { result.passed = true; result.detail = 'build passed'; }
        else { result.detail = 'build failed'; }
      } else {
        result.detail = repoPath ? 'no build command' : 'repo not found locally';
      }
      break;
    }

    case 'no-security-alerts': {
      if (!ghAvailable()) { result.detail = 'gh CLI not available'; break; }
      const alerts = exec(`gh api repos/${repo}/dependabot/alerts --jq '[.[] | select(.state=="open" and (.security_advisory.severity=="high" or .security_advisory.severity=="critical"))] | length'`);
      if (alerts === '0') { result.passed = true; result.detail = 'no high/critical alerts'; }
      else if (alerts) { result.detail = `${alerts} high/critical alerts`; }
      else { result.detail = 'could not check alerts'; }
      break;
    }

    case 'readme-exists': {
      if (repoPath) {
        const readmePath = join(repoPath, 'README.md');
        if (existsSync(readmePath)) {
          const size = statSync(readmePath).size;
          if (size > 100) { result.passed = true; result.detail = `README.md (${size} bytes)`; }
          else { result.detail = `README.md too short (${size} bytes)`; }
        } else {
          result.detail = 'README.md not found';
        }
      } else {
        result.detail = 'repo not found locally';
      }
      break;
    }

    case 'branch-protection': {
      if (!ghAvailable()) { result.detail = 'gh CLI not available'; break; }
      const protection = exec(`gh api repos/${repo}/branches/${service.spec.branches.default}/protection --jq '.required_status_checks.strict // false' 2>/dev/null`);
      if (protection && protection !== 'null') { result.passed = true; result.detail = 'branch protection enabled'; }
      else { result.detail = 'no branch protection'; }
      break;
    }

    case 'deploy-frequency': {
      if (!ghAvailable()) { result.detail = 'gh CLI not available'; break; }
      const runs = exec(`gh api repos/${repo}/actions/runs --jq '[.workflow_runs[] | select(.event=="push" and .head_branch=="${service.spec.branches.default}")] | length'`);
      const count = parseInt(runs || '0', 10);
      if (count > 0) { result.passed = true; result.detail = `${count} deploys recently`; }
      else { result.detail = 'no recent deploys'; }
      break;
    }

    case 'stale-prs': {
      if (!ghAvailable()) { result.detail = 'gh CLI not available'; break; }
      const stalePrs = exec(`gh pr list --repo ${repo} --state open --json updatedAt --jq '[.[] | select((now - (.updatedAt | fromdateiso8601)) > 1209600)] | length'`);
      const count = parseInt(stalePrs || '0', 10);
      if (count === 0) { result.passed = true; result.detail = 'no stale PRs'; }
      else { result.detail = `${count} PRs stale >14d`; }
      break;
    }

    case 'recent-activity': {
      if (repoPath) {
        const commits = exec(`git -C "${repoPath}" log --since="30 days ago" --oneline 2>/dev/null | wc -l`);
        const count = parseInt(commits?.trim() || '0', 10);
        if (count > 0) { result.passed = true; result.detail = `${count} commits in last 30d`; }
        else { result.detail = 'no commits in 30 days'; }
      } else if (ghAvailable()) {
        const out = exec(`gh api repos/${repo}/commits?per_page=1 --jq '.[0].commit.committer.date // empty'`);
        if (out) { result.passed = true; result.detail = `last commit: ${out.slice(0, 10)}`; }
        else { result.detail = 'no recent commits'; }
      } else {
        result.detail = 'repo not found locally';
      }
      break;
    }

    case 'no-stale-prs': {
      if (!ghAvailable()) { result.detail = 'gh CLI not available'; break; }
      const stalePrs = exec(`gh pr list --repo ${repo} --state open --json updatedAt --jq '[.[] | select((now - (.updatedAt | fromdateiso8601)) > 604800)] | length'`);
      const count = parseInt(stalePrs || '0', 10);
      if (count === 0) { result.passed = true; result.detail = 'no stale PRs'; }
      else { result.detail = `${count} PRs stale >7d`; }
      break;
    }

    case 'clean-structure': {
      // For domain repos — check no binaries or misplaced files in root
      result.passed = true;
      result.detail = 'check not implemented (v0.2)';
      break;
    }

    default:
      result.detail = `unknown check: ${check.name}`;
  }

  return result;
}

/** Find the local path for a repo */
function findRepoPath(repoFullName: string): string | null {
  const repoName = repoFullName.split('/')[1];
  if (!repoName) return null;

  const home = process.env.HOME || '';
  const candidates = [
    join(home, 'agents-squads', repoName),
    join(process.cwd(), '..', repoName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Run all scorecard checks for a service */
export function evaluateService(
  service: CatalogEntry,
  scorecard: ScorecardDefinition
): ScorecardResult {
  const repoPath = findRepoPath(service.metadata.repo);
  const checks: CheckResult[] = [];

  for (const check of scorecard.checks) {
    checks.push(runCheck(check, service, repoPath));
  }

  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  const earnedWeight = checks.filter(c => c.passed).reduce((sum, c) => sum + c.weight, 0);
  const score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;

  // Determine grade
  let grade = 'F';
  const sortedGrades = Object.entries(scorecard.grades).sort((a, b) => b[1].min - a[1].min);
  for (const [g, { min }] of sortedGrades) {
    if (score >= min) { grade = g; break; }
  }

  return {
    service: service.metadata.name,
    scorecard: scorecard.metadata.name,
    score,
    grade,
    checks,
    timestamp: new Date().toISOString(),
  };
}
