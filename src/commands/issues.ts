import { execSync } from 'child_process';
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

interface Label {
  name: string;
  color?: string;
  description?: string;
}

interface Issue {
  number: number;
  title: string;
  state: string;
  labels: Label[];
  createdAt: string;
}

function getLabelName(label: Label | string): string {
  return typeof label === 'string' ? label : label.name;
}

interface RepoIssues {
  repo: string;
  issues: Issue[];
  error?: string;
}

interface IssuesOptions {
  org?: string;
  repos?: string;
}

const DEFAULT_ORG = 'agents-squads';
const DEFAULT_REPOS = ['hq', 'agents-squads-web', 'squads-cli'];

export async function issuesCommand(options: IssuesOptions = {}): Promise<void> {
  const org = options.org || DEFAULT_ORG;
  const repos = options.repos ? options.repos.split(',') : DEFAULT_REPOS;

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}issues${RESET}`);
  writeLine();

  // Check if gh is available
  try {
    execSync('gh --version', { stdio: 'pipe' });
  } catch {
    writeLine(`  ${colors.red}GitHub CLI (gh) not found${RESET}`);
    writeLine(`  ${colors.dim}Install: brew install gh${RESET}`);
    writeLine();
    return;
  }

  // Fetch issues for each repo
  const repoData: RepoIssues[] = [];
  let totalOpen = 0;

  for (const repo of repos) {
    try {
      const result = execSync(
        `gh issue list -R ${org}/${repo} --state open --json number,title,state,labels,createdAt --limit 50`,
        { stdio: 'pipe', encoding: 'utf-8' }
      );
      const issues: Issue[] = JSON.parse(result);
      repoData.push({ repo, issues });
      totalOpen += issues.length;
    } catch {
      repoData.push({ repo, issues: [], error: 'not found or no access' });
    }
  }

  // Stats row
  const reposWithIssues = repoData.filter(r => r.issues.length > 0).length;
  writeLine(`  ${colors.cyan}${totalOpen}${RESET} open issues  ${colors.dim}│${RESET}  ${reposWithIssues}/${repos.length} repos`);
  writeLine();

  // Table
  const w = { repo: 20, open: 6, latest: 40 };
  const tableWidth = w.repo + w.open + w.latest + 4;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  const header = `  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('REPO', w.repo)}${RESET}` +
    `${bold}${padEnd('OPEN', w.open)}${RESET}` +
    `${bold}LATEST${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`;
  writeLine(header);

  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const { repo, issues, error } of repoData) {
    const count = issues.length;
    const countColor = count > 5 ? colors.red : count > 0 ? colors.yellow : colors.green;

    let latest = `${colors.dim}—${RESET}`;
    if (error) {
      latest = `${colors.dim}${error}${RESET}`;
    } else if (issues.length > 0) {
      latest = truncate(issues[0].title, w.latest - 2);
    }

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(repo, w.repo)}${RESET}` +
      `${countColor}${padEnd(String(count), w.open)}${RESET}` +
      `${padEnd(latest, w.latest + 10)}` + // extra for color codes
      `${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Show recent issues
  const allIssues = repoData
    .flatMap(r => r.issues.map(i => ({ ...i, repo: r.repo })))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 6);

  if (allIssues.length > 0) {
    writeLine(`  ${bold}Recent${RESET}`);
    writeLine();

    for (const issue of allIssues) {
      const labelStr = issue.labels.length > 0
        ? `${colors.dim}[${issue.labels.map(getLabelName).join(', ')}]${RESET}`
        : '';

      writeLine(`  ${icons.empty} ${colors.dim}#${issue.number}${RESET} ${truncate(issue.title, 50)} ${labelStr}`);
      writeLine(`    ${colors.dim}└ ${issue.repo}${RESET}`);
    }
    writeLine();
  }

  // Commands
  writeLine(`  ${colors.dim}$${RESET} gh issue list -R ${colors.cyan}${org}/<repo>${RESET}   ${colors.dim}View repo issues${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} gh issue create -R ${colors.cyan}${org}/<repo>${RESET}  ${colors.dim}Create issue${RESET}`);
  writeLine();
}
