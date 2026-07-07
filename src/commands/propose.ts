/**
 * `squads propose` — the ambient core (#983).
 *
 * Deterministically assembles product intent (BUSINESS_BRIEF.md, README.md,
 * package.json, product-intent.md, recent commit subjects — no LLM call for
 * the reading), picks the most relevant squad by keyword overlap (or honors
 * `--squad`), and dispatches exactly ONE bounded run whose directive is to
 * draft a single complementary deliverable as repo artifacts. The run lands
 * on a `squads/proposal-<squad>-<id>` branch (never a PR, never an external
 * send — local-first per #979) and surfaces in `squads inbox` for a human to
 * approve, reject, or defer.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import {
  findSquadsDir,
  findProjectRoot,
  loadSquad,
  listSquads,
  findSimilarSquads,
} from '../lib/squad-parser.js';
import { findMemoryDir } from '../lib/memory.js';
import { preflightExecutorCheck } from '../lib/execution-engine.js';
import { normalizeProviderName } from '../lib/llm-clis.js';
import { runConversation, saveTranscript, type ConversationOptions } from '../lib/workflow.js';
import { colors, RESET, icons, gradient, writeLine } from '../lib/terminal.js';

export interface ProposeOptions {
  squad?: string;
  costCeiling?: string | number;
  json?: boolean;
}

/** Lower than the run-command default (25, run-types.ts) — an unattended, ambient dispatch gets a tighter leash (#983). */
export const DEFAULT_PROPOSE_COST_CEILING = 5;

/** Branch namespace `scanStrandedBranches` (inbox.ts) matches to classify items as PROPOSAL. */
export const PROPOSAL_BRANCH_PREFIX = 'squads/proposal-';

const STOPWORDS = new Set([
  'this', 'that', 'these', 'those', 'with', 'from', 'your', 'their', 'about',
  'have', 'will', 'been', 'were', 'they', 'them', 'when', 'what', 'which',
  'into', 'onto', 'over', 'under', 'more', 'most', 'some', 'such', 'than',
  'then', 'also', 'each', 'every', 'here', 'there', 'where', 'while', 'once',
  'agents', 'agent', 'squad', 'squads', 'markdown', 'https', 'github',
]);

/** Lowercase word tokens, length >= 4, common stopwords stripped. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

export interface ProposeContext {
  businessBrief: string;
  readme: string;
  packageDescriptor: string;
  productIntent: string;
  recentCommits: string;
}

/** Deterministic, no-LLM context assembly (#983): read the repo's own evidence of product intent. */
export function assembleProposeContext(projectRoot: string, squadsDir: string): ProposeContext {
  const briefPath = join(squadsDir, '..', 'BUSINESS_BRIEF.md');
  const businessBrief = existsSync(briefPath) ? readFileSync(briefPath, 'utf-8') : '';

  const readmePath = join(projectRoot, 'README.md');
  const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf-8') : '';

  const pkgPath = join(projectRoot, 'package.json');
  let packageDescriptor = '';
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; description?: string };
      packageDescriptor = [pkg.name, pkg.description].filter(Boolean).join(' — ');
    } catch {
      // malformed package.json — skip, the rest of the context still assembles
    }
  }

  const memoryDir = findMemoryDir();
  const intentPath = memoryDir ? join(memoryDir, 'company', 'product-intent.md') : null;
  const productIntent = intentPath && existsSync(intentPath) ? readFileSync(intentPath, 'utf-8') : '';

  let recentCommits = '';
  try {
    recentCommits = execSync('git log --oneline -20', {
      cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // not a git repo, or no commits yet — the rest of the context still assembles
  }

  return { businessBrief, readme, packageDescriptor, productIntent, recentCommits };
}

/**
 * Deterministic keyword-overlap squad selection — no second LLM call (#983).
 * Scores each squad's SQUAD.md by how many of ITS unique tokens appear in the
 * assembled product-intent signal (weighted by the signal's own token
 * frequency), then picks the highest score. Ties break alphabetically.
 */
export function selectSquad(ctx: ProposeContext, squadsDir: string, squadNames: string[]): string | null {
  if (squadNames.length === 0) return null;

  const signalText = [ctx.businessBrief, ctx.readme, ctx.packageDescriptor, ctx.productIntent, ctx.recentCommits].join('\n');
  const freq = new Map<string, number>();
  for (const t of tokenize(signalText)) freq.set(t, (freq.get(t) || 0) + 1);

  let best: { name: string; score: number } | null = null;
  for (const name of [...squadNames].sort()) {
    const squadFile = join(squadsDir, name, 'SQUAD.md');
    if (!existsSync(squadFile)) continue;
    const uniqueTokens = new Set(tokenize(readFileSync(squadFile, 'utf-8')));
    let score = 0;
    for (const t of uniqueTokens) score += freq.get(t) || 0;
    if (!best || score > best.score) best = { name, score };
  }
  return best?.name ?? null;
}

function buildTaskDirective(ctx: ProposeContext): string {
  const briefSnippet = ctx.businessBrief ? ctx.businessBrief.slice(0, 1500) : '(no BUSINESS_BRIEF.md found)';
  const readmeSnippet = ctx.readme ? ctx.readme.slice(0, 1000) : '(no README.md found)';
  const pkgLine = ctx.packageDescriptor || '(no package.json found)';
  const commitsSnippet = ctx.recentCommits || '(no commit history)';
  const intentSection = ctx.productIntent ? `\n### product-intent.md\n${ctx.productIntent.slice(0, 1500)}\n` : '';

  return `Draft ONE complementary deliverable for this product as repo artifacts (e.g. a copy update, an instrumentation plan, a small doc or config change) and commit it to THIS branch.

Do NOT open a pull request, do NOT create GitHub issues, and do NOT send any external communication (email, Slack, etc.) — the branch itself is the proposal artifact. A human reviews and lands it via \`squads inbox\`.

## Product Context (assembled deterministically — no LLM read yet)

### BUSINESS_BRIEF.md
${briefSnippet}

### README.md
${readmeSnippet}

### package.json
${pkgLine}
${intentSection}
### Recent commits
${commitsSnippet}`;
}

export async function proposeCommand(options: ProposeOptions): Promise<void> {
  const squadsDir = findSquadsDir();
  const projectRoot = findProjectRoot();

  if (!squadsDir || !projectRoot) {
    writeLine(`  ${colors.red}No .agents/squads directory found${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    process.exit(1);
  }

  const squadNames = listSquads(squadsDir);
  if (squadNames.length === 0) {
    writeLine(`  ${colors.red}No squads configured${RESET}`);
    process.exit(1);
  }

  let squadName: string;
  if (options.squad) {
    if (!squadNames.includes(options.squad)) {
      writeLine(`  ${colors.red}Squad "${options.squad}" not found${RESET}`);
      const similar = findSimilarSquads(options.squad, squadNames);
      if (similar.length > 0) {
        writeLine(`  ${colors.dim}Did you mean: ${similar.join(', ')}?${RESET}`);
      }
      process.exit(1);
    }
    squadName = options.squad;
  } else {
    const ctx = assembleProposeContext(projectRoot, squadsDir);
    const picked = selectSquad(ctx, squadsDir, squadNames);
    if (!picked) {
      writeLine(`  ${colors.red}Could not select a squad to propose for${RESET}`);
      process.exit(1);
    }
    squadName = picked;
  }

  const squad = loadSquad(squadName);
  if (!squad) {
    writeLine(`  ${colors.red}Squad "${squadName}" failed to load${RESET}`);
    process.exit(1);
  }

  // Fail loud on provider preflight failure (#956/#957 semantics) — never a
  // silent exit-0 that looks like "nothing to propose".
  const provider = normalizeProviderName(squad.providers?.default || 'anthropic');
  const checksOk = await preflightExecutorCheck(provider);
  if (!checksOk) {
    process.exit(1);
  }

  const ctx = assembleProposeContext(projectRoot, squadsDir);
  const costCeiling = options.costCeiling !== undefined
    ? parseFloat(String(options.costCeiling))
    : DEFAULT_PROPOSE_COST_CEILING;
  const task = buildTaskDirective(ctx);

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}propose${RESET} ${colors.cyan}${squadName}${RESET}`);
  writeLine(`  ${colors.dim}cost ceiling: $${costCeiling.toFixed(2)}${RESET}`);
  writeLine();

  const convOptions: ConversationOptions = {
    task,
    costCeiling,
    branchPrefix: PROPOSAL_BRANCH_PREFIX,
  };

  const result = await runConversation(squad, convOptions);
  const transcriptPath = saveTranscript(result.transcript);

  if (options.json) {
    writeLine(JSON.stringify({
      squad: squadName,
      costCeiling,
      converged: result.converged,
      reason: result.reason,
      turnCount: result.turnCount,
      totalCost: result.totalCost,
      transcriptPath,
    }, null, 2));
    return;
  }

  writeLine(`  ${result.converged ? icons.success : icons.warning} ${result.reason}`);
  writeLine(`  ${colors.dim}Turns: ${result.turnCount} | Cost: ~$${result.totalCost.toFixed(2)}${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}Review the proposal: squads inbox${RESET}`);
  writeLine();
}
