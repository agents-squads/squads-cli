import { execSync, spawn } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';
import ora from 'ora';
import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine,
} from '../lib/terminal.js';
import { findSquadsDir } from '../lib/squad-parser.js';

interface OpenOptions {
  squad?: string;
  agent?: string;
  dryRun?: boolean;
  execute?: boolean;
}

interface EvalAgent {
  name: string;
  squad: string;
  path: string;
}

// Agents that find issues (evaluators, critics, auditors)
const ISSUE_FINDER_PATTERNS = [
  '*-eval.md',
  '*-critic.md',
  '*-auditor.md',
  'site-tester.md',
];

export async function openIssuesCommand(options: OpenOptions = {}): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}open-issues${RESET}`);
  writeLine();

  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`  ${colors.red}No .agents/squads directory found${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    return;
  }

  // Find evaluator/critic agents
  const evalAgents = findEvalAgents(squadsDir, options.squad);

  if (evalAgents.length === 0) {
    writeLine(`  ${colors.yellow}No evaluator agents found${RESET}`);
    writeLine(`  ${colors.dim}Evaluators match: *-eval.md, *-critic.md, *-auditor.md${RESET}`);
    return;
  }

  // Filter by specific agent if requested
  const agents = options.agent
    ? evalAgents.filter(a => a.name === options.agent || a.name === `${options.agent}.md`)
    : evalAgents;

  if (agents.length === 0) {
    writeLine(`  ${colors.red}Agent '${options.agent}' not found${RESET}`);
    writeLine(`  ${colors.dim}Available: ${evalAgents.map(a => a.name).join(', ')}${RESET}`);
    return;
  }

  // Group by squad
  const bySquad = agents.reduce((acc, agent) => {
    if (!acc[agent.squad]) acc[agent.squad] = [];
    acc[agent.squad].push(agent);
    return acc;
  }, {} as Record<string, EvalAgent[]>);

  writeLine(`  ${colors.cyan}${agents.length}${RESET} evaluator${agents.length > 1 ? 's' : ''} ready`);
  writeLine();

  for (const [squad, squadAgents] of Object.entries(bySquad)) {
    writeLine(`  ${bold}${squad}${RESET}`);
    for (const agent of squadAgents) {
      writeLine(`    ${icons.empty} ${colors.cyan}${agent.name.replace('.md', '')}${RESET}`);
    }
  }
  writeLine();

  if (options.dryRun) {
    writeLine(`  ${colors.yellow}[DRY RUN] Would run ${agents.length} evaluators${RESET}`);
    return;
  }

  if (options.execute) {
    await runEvaluators(agents);
  } else {
    showRunInstructions(agents);
  }
}

function findEvalAgents(squadsDir: string, filterSquad?: string): EvalAgent[] {
  const agents: EvalAgent[] = [];
  const squads = readdirSync(squadsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => !filterSquad || d.name === filterSquad)
    .map(d => d.name);

  for (const squad of squads) {
    const squadPath = join(squadsDir, squad);
    const files = readdirSync(squadPath).filter(f => f.endsWith('.md'));

    for (const file of files) {
      // Check if matches evaluator patterns
      const isEval = ISSUE_FINDER_PATTERNS.some(pattern => {
        const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
        return regex.test(file);
      });

      if (isEval) {
        agents.push({
          name: file,
          squad,
          path: join(squadPath, file),
        });
      }
    }
  }

  return agents;
}

function showRunInstructions(agents: EvalAgent[]): void {
  writeLine(`  ${bold}To run evaluators:${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}Option 1: In Claude Code session${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} /website-eval`);
  writeLine();
  writeLine(`  ${colors.dim}Option 2: Execute with Claude CLI${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads open-issues --execute`);
  writeLine();
  writeLine(`  ${colors.dim}Option 3: Run specific evaluator${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads open-issues --squad ${colors.cyan}${agents[0].squad}${RESET} --agent ${colors.cyan}${agents[0].name.replace('.md', '')}${RESET} --execute`);
  writeLine();
  writeLine(`  ${colors.dim}Option 4: Via squads run${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${agents[0].squad}/${agents[0].name.replace('.md', '')}${RESET} --execute`);
  writeLine();
}

async function runEvaluators(agents: EvalAgent[]): Promise<void> {
  const spinner = ora('Starting evaluators...').start();

  // Check if claude is available
  try {
    execSync('which claude', { stdio: 'pipe' });
  } catch {
    spinner.fail('Claude CLI not found');
    writeLine(`  ${colors.dim}Install: npm install -g @anthropic-ai/claude-code${RESET}`);
    return;
  }

  let issuesCreated = 0;

  for (const agent of agents) {
    spinner.text = `Running ${agent.squad}/${agent.name.replace('.md', '')}...`;

    const prompt = buildEvalPrompt(agent);

    try {
      const result = await executeClaudePrompt(prompt);
      spinner.succeed(`${agent.name.replace('.md', '')}`);

      // Count issues created
      const issueMatches = result.match(/Created issue #\d+/g) || [];
      issuesCreated += issueMatches.length;

      if (issueMatches.length > 0) {
        writeLine(`    ${colors.green}Created ${issueMatches.length} issue(s)${RESET}`);
      } else {
        writeLine(`    ${colors.dim}No issues found${RESET}`);
      }
    } catch (error) {
      spinner.fail(`${agent.name.replace('.md', '')}: ${error}`);
    }
  }

  writeLine();
  writeLine(`  ${bold}Summary${RESET}`);
  writeLine(`  ${colors.cyan}${issuesCreated}${RESET} new issues created`);
  writeLine();
  writeLine(`  ${colors.dim}View issues:${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads issues`);
  writeLine();
  writeLine(`  ${colors.dim}Solve them:${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads solve-issues`);
  writeLine();
}

function buildEvalPrompt(agent: EvalAgent): string {
  return `Execute the ${agent.name.replace('.md', '')} evaluator from squad ${agent.squad}.

Read the agent definition at ${agent.path} and follow its instructions exactly.

## CRITICAL: Work Decisively

- Evaluate the target (website, code, etc.)
- For each finding, create a GitHub issue
- Use: gh issue create --repo agents-squads/{repo} --title "..." --body "..." --label "type:...,priority:P1/P2/P3,squad:${agent.squad}"
- Report how many issues were created

Do NOT get stuck re-reading files. Evaluate, report findings, create issues, done.`;
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

    // 5 minute timeout per evaluator
    setTimeout(() => {
      claude.kill();
      reject(new Error('Timeout after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}
