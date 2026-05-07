import { Command } from 'commander';
import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { findProjectRoot } from '../lib/squad-parser.js';
import { getSquadRepos } from '../lib/squad-loop.js';
import { bold, colors, dim, RESET, writeLine } from '../lib/terminal.js';

interface BriefTask {
  squad: string;
  repo?: string;
  title: string;
  body: string;
}

interface BriefResult {
  focus: string;
  tasks: BriefTask[];
}

const EXTRACTION_PROMPT = `You are reading recent Claude Code session transcripts between a founder and their AI cofounder.

Extract actionable GitHub issues from these sessions. Look for:
- Things the founder explicitly asked for ("build X", "fix Y", "we need Z")
- Frustrations about current system behavior
- Decisions made that require implementation work
- Features discussed and approved

For each task identify the owning squad (intelligence, engineering, cli, product, finance, etc.), a clear imperative title under 72 chars, and a body with context + acceptance criteria (3-5 sentences).

Respond with ONLY valid JSON — no markdown, no explanation:
{
  "focus": "one sentence: what is the founder currently most focused on?",
  "tasks": [
    {
      "squad": "intelligence",
      "title": "Build buyer shortlist from GPS and MP databases",
      "body": "Query GPS (610 companies) and MP tender database to identify Chilean companies with AI budget and buying intent. Profile two buyer types: solo founders needing retainer support, and industrial CTOs in mining/water/energy. Cross-reference MP tender spend with GPS decision makers. Output: ranked shortlist with company, decision maker, budget signals, and reason to buy. Research only — no outreach."
    }
  ]
}

Only include clearly actionable tasks. Skip vague intentions. Max 8 tasks.`;

async function briefCommand(options: { sessions: number; dryRun: boolean; coo: boolean }): Promise<void> {
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    writeLine(`  ${colors.red}Not in a squads project.${RESET} Run from a directory with .agents/`);
    return;
  }

  const convDir = join(projectRoot, '.agents', 'conversations', 'cli');
  if (!existsSync(convDir)) {
    writeLine(`  ${colors.yellow}No CLI sessions found${RESET} at ${dim}${convDir}${RESET}`);
    return;
  }

  const files = readdirSync(convDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, path: join(convDir, f), mtime: statSync(join(convDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, options.sessions);

  if (files.length === 0) {
    writeLine(`  ${colors.yellow}No session files found.${RESET}`);
    return;
  }

  writeLine();
  writeLine(`  ${bold}squads brief${RESET}  ${dim}reading ${files.length} session(s)...${RESET}`);
  writeLine();

  const transcripts = files
    .map(f => `=== Session: ${f.name} ===\n${readFileSync(f.path, 'utf-8')}`)
    .join('\n\n');

  let result: BriefResult;
  try {
    const { CLAUDECODE: _cc, ANTHROPIC_API_KEY: _ak, ...cleanEnv } = process.env;
    const prompt = `${EXTRACTION_PROMPT}\n\n${transcripts}`;
    const proc = spawnSync('claude', ['--print', '--model', 'haiku'], {
      input: prompt,
      encoding: 'utf-8',
      timeout: 60_000,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (proc.status !== 0 || !proc.stdout) {
      writeLine(`  ${colors.red}Extraction failed.${RESET} Is ${dim}claude${RESET} installed and logged in?`);
      return;
    }

    const jsonMatch = proc.stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    result = JSON.parse(jsonMatch[0]) as BriefResult;
  } catch (err) {
    writeLine(`  ${colors.red}Extraction failed:${RESET} ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const squadRepos = getSquadRepos();

  writeLine(`  ${bold}Founder focus:${RESET} ${result.focus}`);
  writeLine();
  writeLine(`  ${colors.cyan}${result.tasks.length} issue(s) proposed:${RESET}`);
  writeLine();

  for (const task of result.tasks) {
    const repo = task.repo ?? squadRepos[task.squad];
    writeLine(`  ${bold}[${task.squad}]${RESET} ${task.title}`);
    writeLine(`  ${dim}${task.body.length > 120 ? task.body.slice(0, 120) + '...' : task.body}${RESET}`);
    if (repo) writeLine(`  ${dim}→ ${repo}${RESET}`);
    writeLine();
  }

  if (options.dryRun) {
    writeLine(`  ${dim}--dry-run: no issues created.${RESET}`);
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const task of result.tasks) {
    const repo = task.repo ?? squadRepos[task.squad];
    if (!repo) {
      writeLine(`  ${colors.yellow}skip${RESET} [${task.squad}] — no repo: field in SQUAD.md`);
      skipped++;
      continue;
    }

    try {
      const proc = spawnSync('gh', ['issue', 'create', '-R', repo, '--title', task.title, '--body', task.body], { encoding: 'utf-8' });
      if (proc.status !== 0) throw new Error(proc.stderr);
      const url = proc.stdout.trim();
      writeLine(`  ${colors.green}created${RESET} ${url}`);
      created++;
    } catch {
      writeLine(`  ${colors.red}failed${RESET}  [${task.squad}] ${task.title}`);
      skipped++;
    }
  }

  writeLine();
  writeLine(
    `  ${bold}${created} created${RESET}${skipped > 0 ? `  ${dim}${skipped} skipped${RESET}` : ''}`
  );

  if (options.coo) {
    const focusPath = join(projectRoot, '.agents', 'memory', 'company', 'founder-focus.md');
    const date = new Date().toISOString().split('T')[0];
    const content = `# Founder Focus — ${date}\n\n${result.focus}\n\n## Issues created\n\n${result.tasks.map(t => `- [${t.squad}] ${t.title}`).join('\n')}\n`;
    writeFileSync(focusPath, content);
    writeLine(`  ${dim}founder-focus.md written → ${focusPath}${RESET}`);
  }
}

export function registerBriefCommand(program: Command): void {
  program
    .command('brief')
    .description('Read recent sessions, extract founder intentions, create GitHub issues')
    .option('-n, --sessions <n>', 'Number of recent sessions to read', '5')
    .option('--dry-run', 'Show proposed issues without creating them')
    .option('--coo', 'Write founder-focus.md for COO context')
    .action(async (options) => {
      await briefCommand({
        sessions: parseInt(options.sessions, 10),
        dryRun: !!options.dryRun,
        coo: !!options.coo,
      });
    });
}
