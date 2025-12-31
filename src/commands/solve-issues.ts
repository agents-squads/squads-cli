import { execSync, spawn } from 'child_process';
import ora from 'ora';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  truncate,
  icons,
  writeLine,
} from '../lib/terminal.js';

interface Issue {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  body?: string;
}

interface SolveOptions {
  repo?: string;
  issue?: number;
  dryRun?: boolean;
  execute?: boolean;
}

const DEFAULT_ORG = 'agents-squads';
const DEFAULT_REPOS = ['hq', 'agents-squads-web'];

export async function solveIssuesCommand(options: SolveOptions = {}): Promise<void> {
  const repos = options.repo ? [options.repo] : DEFAULT_REPOS;

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}solve-issues${RESET}`);
  writeLine();

  // Check if gh is available
  try {
    execSync('gh --version', { stdio: 'pipe' });
  } catch {
    writeLine(`  ${colors.red}GitHub CLI (gh) not found${RESET}`);
    writeLine(`  ${colors.dim}Install: brew install gh${RESET}`);
    return;
  }

  // Collect issues to solve
  const issuesToSolve: Array<Issue & { repo: string }> = [];

  if (options.issue) {
    // Specific issue
    const repo = options.repo || 'hq';
    try {
      const result = execSync(
        `gh issue view ${options.issue} -R ${DEFAULT_ORG}/${repo} --json number,title,labels,body`,
        { stdio: 'pipe', encoding: 'utf-8' }
      );
      const issue = JSON.parse(result);
      issuesToSolve.push({ ...issue, repo });
    } catch {
      writeLine(`  ${colors.red}Issue #${options.issue} not found in ${repo}${RESET}`);
      return;
    }
  } else {
    // All ready-to-fix issues
    for (const repo of repos) {
      try {
        const result = execSync(
          `gh issue list -R ${DEFAULT_ORG}/${repo} --label "ready-to-fix" --state open --json number,title,labels --limit 20`,
          { stdio: 'pipe', encoding: 'utf-8' }
        );
        const issues: Issue[] = JSON.parse(result);
        for (const issue of issues) {
          issuesToSolve.push({ ...issue, repo });
        }
      } catch {
        // Repo might not exist or no access
      }
    }
  }

  if (issuesToSolve.length === 0) {
    writeLine(`  ${colors.yellow}No issues with 'ready-to-fix' label found${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Label an issue to make it solvable:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} gh issue edit ${colors.cyan}<number>${RESET} -R ${colors.cyan}${DEFAULT_ORG}/<repo>${RESET} --add-label ready-to-fix`);
    writeLine();
    return;
  }

  // Show issues to solve
  writeLine(`  ${colors.cyan}${issuesToSolve.length}${RESET} issue${issuesToSolve.length > 1 ? 's' : ''} to solve`);
  writeLine();

  for (const issue of issuesToSolve) {
    const labels = issue.labels.map(l => l.name).join(', ');
    writeLine(`  ${icons.empty} ${colors.dim}#${issue.number}${RESET} ${truncate(issue.title, 50)}`);
    writeLine(`    ${colors.dim}└ ${issue.repo} [${labels}]${RESET}`);
  }
  writeLine();

  if (options.dryRun) {
    writeLine(`  ${colors.yellow}[DRY RUN] Would solve ${issuesToSolve.length} issues${RESET}`);
    return;
  }

  // Solve issues
  if (options.execute) {
    await solveWithClaude(issuesToSolve);
  } else {
    showSolveInstructions(issuesToSolve);
  }
}

function showSolveInstructions(issues: Array<Issue & { repo: string }>): void {
  writeLine(`  ${bold}To solve these issues:${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}Option 1: In Claude Code session${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} /solve-issue ${colors.cyan}${issues[0].repo}${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}Option 2: Execute with Claude CLI${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads solve-issues --execute`);
  writeLine();
  writeLine(`  ${colors.dim}Option 3: Solve specific issue${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads solve-issues --repo ${colors.cyan}${issues[0].repo}${RESET} --issue ${colors.cyan}${issues[0].number}${RESET} --execute`);
  writeLine();
}

async function solveWithClaude(issues: Array<Issue & { repo: string }>): Promise<void> {
  const spinner = ora('Starting issue solver...').start();

  // Check if claude is available
  try {
    execSync('which claude', { stdio: 'pipe' });
  } catch {
    spinner.fail('Claude CLI not found');
    writeLine(`  ${colors.dim}Install: npm install -g @anthropic-ai/claude-code${RESET}`);
    return;
  }

  for (const issue of issues) {
    spinner.text = `Solving #${issue.number}: ${truncate(issue.title, 40)}`;

    const prompt = buildSolvePrompt(issue);

    try {
      const result = await executeClaudePrompt(prompt);
      spinner.succeed(`Solved #${issue.number}`);

      // Extract PR URL if present
      const prMatch = result.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
      if (prMatch) {
        writeLine(`    ${colors.green}PR: ${prMatch[0]}${RESET}`);
      }
    } catch (error) {
      spinner.fail(`Failed #${issue.number}: ${error}`);
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}View results:${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} gh pr list -R ${colors.cyan}${DEFAULT_ORG}/<repo>${RESET}`);
  writeLine();
}

function buildSolvePrompt(issue: Issue & { repo: string }): string {
  return `Solve GitHub issue #${issue.number} in ${DEFAULT_ORG}/${issue.repo}.

Issue: ${issue.title}

## CRITICAL: Work Decisively (No Verification Loops!)

Read each file ONCE, edit ONCE, commit IMMEDIATELY.
Verify with git diff, NOT by re-reading files.
If reading the same file twice, STOP and move forward.

## Instructions

1. Read the issue: gh issue view ${issue.number} --repo ${DEFAULT_ORG}/${issue.repo}

2. Set up worktree:
   git fetch origin main
   git worktree add ../.worktrees/issue-${issue.number} -b solve/issue-${issue.number} origin/main
   cd ../.worktrees/issue-${issue.number}

3. Find and fix the problem (minimal changes)

4. Commit: git add -A && git commit -m "fix: ..."

5. Push and create PR:
   git push -u origin solve/issue-${issue.number}
   gh pr create --title "fix: ..." --body "Fixes #${issue.number}" --repo ${DEFAULT_ORG}/${issue.repo}

6. Clean up: git worktree remove ../.worktrees/issue-${issue.number} --force

Return the PR URL when done.`;
}

function executeClaudePrompt(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const claude = spawn('claude', ['--print', prompt], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let error = '';

    claude.stdout?.on('data', (data) => {
      output += data.toString();
    });

    claude.stderr?.on('data', (data) => {
      error += data.toString();
    });

    claude.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(error || `Exited with code ${code}`));
      }
    });

    claude.on('error', reject);

    // 10 minute timeout
    setTimeout(() => {
      claude.kill();
      reject(new Error('Timeout after 10 minutes'));
    }, 10 * 60 * 1000);
  });
}
