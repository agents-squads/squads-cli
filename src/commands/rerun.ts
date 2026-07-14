import { execSync } from 'child_process';
import {
  colors,
  bold,
  RESET,
  icons,
  writeLine,
} from '../lib/terminal.js';

interface Run {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  headBranch: string;
  event: string;
  createdAt: string;
  workflowId: number;
  url: string;
}

/**
 * Detect the current PR from git branch
 */
function detectPR(): { number: number; repo: string } | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (branch === 'HEAD' || branch === 'main' || branch === 'master' || branch === 'develop') {
      return null;
    }

    const repo = execSync('gh repo view --json owner,name --jq \'"\\(.owner.login)/\\(.name)"\' 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!repo) {
      return null;
    }

    const prOutput = execSync(
      `gh pr list --head ${branch} --json number --jq '.[0].number' 2>/dev/null`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    const prNumber = parseInt(prOutput, 10);
    if (!prNumber || isNaN(prNumber)) {
      return null;
    }

    return { number: prNumber, repo };
  } catch {
    return null;
  }
}

/**
 * Get failed CI runs for a PR
 */
function getFailedRuns(prNumber: number, _repo: string): Run[] {
  try {
    const branchOutput = execSync(
      `gh pr view ${prNumber} --json headRefName --jq '.headRefName' 2>/dev/null`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!branchOutput) {
      return [];
    }

    const branch = branchOutput;

    const runsOutput = execSync(
      `gh run list --branch ${branch} --json databaseId,name,status,conclusion,headBranch,event,createdAt,workflowId,url --limit 20 2>/dev/null`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const runs = JSON.parse(runsOutput || '[]') as Array<{
      databaseId: number;
      name: string;
      status: string;
      conclusion: string | null;
      headBranch: string;
      event: string;
      createdAt: string;
      workflowId: number;
      url: string;
    }>;
    return runs
      .filter(run => run.status === 'completed' && run.conclusion === 'failure')
      .map(run => ({ id: run.databaseId, ...run }));
  } catch {
    return [];
  }
}

/**
 * Re-run a specific workflow run
 */
function rerunRun(runId: number): boolean {
  try {
    execSync(`gh run rerun ${runId} 2>/dev/null`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Main command handler
 */
export async function rerunCommand(options: {
  pr?: string;
  failed?: boolean;
  json?: boolean;
} = {}): Promise<void> {
  // Detect or parse PR number
  let prNumber: number | null = null;
  let repo = '';

  if (options.pr) {
    prNumber = parseInt(options.pr, 10);
    if (isNaN(prNumber)) {
      if (options.json) {
        console.log(JSON.stringify({ error: 'Invalid PR number' }));
        return;
      }
      writeLine(`${colors.red}${icons.error} Invalid PR number: ${options.pr}${RESET}`);
      return;
    }

    try {
      repo = execSync('gh repo view --json owner,name --jq \'"\\(.owner.login)/\\(.name)"\' 2>/dev/null', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      if (options.json) {
        console.log(JSON.stringify({ error: 'Failed to detect repository' }));
        return;
      }
      writeLine(`${colors.red}${icons.error} Failed to detect repository${RESET}`);
      writeLine(`${colors.dim}Are you in a GitHub repository?${RESET}`);
      return;
    }
  } else {
    const detected = detectPR();
    if (!detected) {
      if (options.json) {
        console.log(JSON.stringify({ error: 'No PR found for current branch' }));
        return;
      }
      writeLine(`${colors.yellow}${icons.warning} No PR found for current branch${RESET}`);
      writeLine(`${colors.dim}Specify a PR number: squads rerun --pr <number>${RESET}`);
      return;
    }
    prNumber = detected.number;
    repo = detected.repo;
  }

  if (!prNumber) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'No PR number provided or detected' }));
      return;
    }
    writeLine(`${colors.red}${icons.error} No PR number provided or detected${RESET}`);
    return;
  }

  if (options.json) {
    const failedRuns = getFailedRuns(prNumber, repo);
    console.log(JSON.stringify({
      pr: prNumber,
      repo,
      failedRuns: failedRuns.length,
      runs: failedRuns,
    }, null, 2));
    return;
  }

  // Get failed runs
  const failedRuns = getFailedRuns(prNumber, repo);

  writeLine();
  writeLine(`  ${colors.cyan}●${RESET} PR #${prNumber}${RESET} ${colors.dim}(${repo})${RESET}`);
  writeLine();

  if (failedRuns.length === 0) {
    writeLine(`  ${colors.green}${icons.success} No failed CI runs found${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}All checks may be passing, or no runs have completed yet.${RESET}`);
    writeLine(`  ${colors.dim}Run 'gh pr checks ${prNumber}' to see current status.${RESET}`);
    return;
  }

  writeLine(`  ${colors.yellow}${icons.warning} ${failedRuns.length} failed run(s) found${RESET}`);
  writeLine();

  for (const run of failedRuns) {
    const time = new Date(run.createdAt).toLocaleTimeString();
    writeLine(`  ${colors.red}✗${RESET} ${bold}${run.name}${RESET} ${colors.dim}(${run.event}, ${time})${RESET}`);
    writeLine(`    ${colors.dim}${run.url}${RESET}`);
    writeLine();
  }

  // Re-run failed runs
  if (options.failed !== false) {
    writeLine(`  ${colors.cyan}${icons.running} Re-running failed checks...${RESET}`);
    writeLine();

    let successCount = 0;
    let failCount = 0;

    for (const run of failedRuns) {
      if (rerunRun(run.id)) {
        successCount++;
        writeLine(`  ${colors.green}${icons.success} Re-run triggered: ${run.name}${RESET}`);
      } else {
        failCount++;
        writeLine(`  ${colors.red}${icons.error} Failed to re-run: ${run.name}${RESET}`);
      }
    }

    writeLine();
    writeLine(`  ${colors.dim}${successCount} re-run(s) triggered${RESET}`);
    if (failCount > 0) {
      writeLine(`  ${colors.red}${failCount} failed${RESET}`);
    }
    writeLine();
    writeLine(`  ${colors.dim}View status: gh pr checks ${prNumber}${RESET}`);
  }
}
