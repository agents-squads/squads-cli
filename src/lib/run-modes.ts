/**
 * Squad execution modes: autopilot, squad loop, lead mode, and post-evaluation.
 * Extracted from commands/run.ts to reduce its size.
 */

import { join, dirname } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import {
  type RunOptions,
  defaultTimeoutForRole,
  TOOL_USE_PROVIDERS,
} from './run-types.js';
import {
  checkClaudeCliAvailable,
} from './run-utils.js';
import {
  executeWithClaude,
  executeWithProvider,
} from './execution-engine.js';
import { runAgent } from './agent-runner.js';
import {
  findSquadsDir,
  findProjectRoot,
  loadSquad,
} from './squad-parser.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine,
} from './terminal.js';
import {
  getCLIConfig,
  isProviderCLIAvailable,
  normalizeProviderName,
} from './llm-clis.js';
import { parseAgentFrontmatter } from './run-context.js';

// ── Post-run evaluation ─────────────────────────────────────────────
// After any squad run, dispatch the COO (company-lead) to evaluate outputs.
// This is the feedback loop that makes the system learn.

const EVAL_TIMEOUT_MINUTES = 15;

/**
 * Find an agent with `role: coo` or `role: company-lead` in its frontmatter,
 * searching across all squads. Returns null if none found.
 */
function findCooAgent(squadsDir: string): { agentName: string; agentPath: string; squadName: string } | null {
  let squadDirs: string[];
  try {
    squadDirs = readdirSync(squadsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return null; }

  for (const squadName of squadDirs) {
    const squadPath = join(squadsDir, squadName);
    let files: string[];
    try {
      files = readdirSync(squadPath).filter(f => f.endsWith('.md') && f !== 'SQUAD.md');
    } catch { continue; }

    for (const file of files) {
      const agentPath = join(squadPath, file);
      const fm = parseAgentFrontmatter(agentPath);
      const role = (fm.agent_role || '').trim().toLowerCase();
      if (role === 'coo' || role === 'company-lead') {
        return { agentName: file.replace(/\.md$/, ''), agentPath, squadName };
      }
    }
  }
  return null;
}

/**
 * Run the COO evaluation after squad execution.
 * Dispatches company-lead with a scoped evaluation task for the squads that just ran.
 * Generates feedback.md and active-work.md per squad.
 */
export async function runPostEvaluation(
  squadsRun: string[],
  options: RunOptions,
): Promise<void> {
  // Skip if running company squad itself (prevent recursion)
  if (squadsRun.length === 1 && squadsRun[0] === 'company') return;
  // Skip if evaluation disabled
  if (options.eval === false) return;
  // Skip dry-run
  if (options.dryRun) return;
  // Skip background runs — evaluation needs foreground context
  if (options.background) return;

  const squadsDir = findSquadsDir();
  if (!squadsDir) return;

  // Find any agent with role: coo in frontmatter across all squads
  const coo = findCooAgent(squadsDir);
  if (!coo) {
    if (options.verbose) {
      writeLine(`  ${colors.dim}Skipping evaluation: no agent with role: coo found${RESET}`);
    }
    return;
  }

  const squadList = squadsRun.join(', ');
  writeLine();
  writeLine(`  ${gradient('eval')} ${colors.dim}COO evaluating: ${squadList}${RESET}`);

  // Load evaluation protocol from markdown (single source of truth)
  const evalProtocolPath = join(findProjectRoot() || '', '.agents', 'config', 'coo-evaluation.md');
  const evalProtocol = existsSync(evalProtocolPath) ? readFileSync(evalProtocolPath, 'utf-8') : '';
  const evalTask = `Post-run evaluation for: ${squadList}.\n\n${evalProtocol}`;

  await runAgent(coo.agentName, coo.agentPath, coo.squadName, {
    ...options,
    task: evalTask,
    timeout: EVAL_TIMEOUT_MINUTES,
    eval: false, // prevent recursion
    trigger: 'manual',
  });
}

// ── Autopilot mode ──────────────────────────────────────────────────
// When `squads run` is called with no target, it becomes the daemon:
// score all squads, dispatch the full loop (scanner→lead→worker→verifier)
// for top-priority squads, push cognition signals, repeat.



/**
 * Lead mode: Single orchestrator session that uses Task tool for parallel work.
 * Benefits over --parallel:
 * - Single session overhead vs N sessions
 * - Lead coordinates and routes work intelligently
 * - Task agents share context when needed
 * - Better parallelization (Claude's native Task tool)
 */
export async function runLeadMode(
  squad: ReturnType<typeof loadSquad>,
  squadsDir: string,
  options: RunOptions
): Promise<void> {
  if (!squad) return;

  const agentFiles = squad.agents
    .map(a => ({
      name: a.name,
      path: join(squadsDir, squad.dir, `${a.name}.md`),
      role: a.role || '',
    }))
    .filter(a => existsSync(a.path));

  if (agentFiles.length === 0) {
    writeLine(`  ${icons.error} ${colors.red}No agent files found${RESET}`);
    return;
  }

  // Block lead mode for providers without tool use support
  const squadProvider = normalizeProviderName(options.provider || squad?.providers?.default || 'anthropic');
  if (!TOOL_USE_PROVIDERS.has(squadProvider)) {
    const cliConfig = getCLIConfig(squadProvider);
    const providerName = cliConfig?.displayName || squadProvider;
    writeLine(`  ${icons.warning} ${colors.yellow}Lead mode requires tool-use support (Claude, Gemini)${RESET}`);
    writeLine(`  ${colors.dim}${providerName} cannot spawn sub-agents via Task tool.${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Options:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --provider ${squadProvider}  ${colors.dim}← sequential mode (recommended)${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}/${agentFiles[0]?.name || 'agent'}${RESET} --provider ${squadProvider}  ${colors.dim}← single agent${RESET}`);
    writeLine();
    return;
  }

  writeLine(`  ${bold}Lead mode${RESET} ${colors.dim}orchestrating ${agentFiles.length} agents${RESET}`);
  writeLine();

  // List available agents
  for (const agent of agentFiles) {
    writeLine(`  ${icons.empty} ${colors.cyan}${agent.name}${RESET} ${colors.dim}${agent.role}${RESET}`);
  }
  writeLine();

  if (!options.execute) {
    writeLine(`  ${colors.dim}Launch lead session:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --lead`);
    writeLine();
    return;
  }

  // Build the lead prompt from template (no prompts in TypeScript — CLAUDE.md rule)
  const timeoutMins = options.timeout || defaultTimeoutForRole('lead');
  const agentList = agentFiles.map(a => `- ${a.name}: ${a.role}`).join('\n');
  const agentPaths = agentFiles.map(a => `- ${a.name}: ${a.path}`).join('\n');

  // Load lead mode protocol from markdown
  const leadProtocolPath = join(findProjectRoot() || '', '.agents', 'config', 'lead-mode.md');
  const leadProtocol = existsSync(leadProtocolPath) ? readFileSync(leadProtocolPath, 'utf-8') : '';

  // Template resolution: dist/templates (built) or repo-root/templates (dev/test)
  const leadDistPath = join(__dirname, '..', 'templates', 'prompts', 'lead-mode.md');
  const leadRootPath = join(__dirname, '..', '..', 'templates', 'prompts', 'lead-mode.md');
  const leadTemplatePath = existsSync(leadDistPath) ? leadDistPath : leadRootPath;
  const leadTemplate = existsSync(leadTemplatePath)
    ? readFileSync(leadTemplatePath, 'utf-8')
    : 'You are the Lead of the {{SQUAD_NAME}} squad. Plan and delegate work.';
  const prompt = leadTemplate
    .replaceAll('{{SQUAD_NAME}}', squad.name)
    .replaceAll('{{MISSION}}', squad.mission || 'Execute squad operations efficiently.')
    .replaceAll('{{AGENT_LIST}}', agentList)
    .replaceAll('{{AGENT_PATHS}}', agentPaths)
    .replaceAll('{{LEAD_PROTOCOL}}', leadProtocol);

  // Determine provider
  const provider = normalizeProviderName(options.provider || squad?.providers?.default || 'anthropic');
  const isAnthropic = provider === 'anthropic';

  if (isAnthropic) {
    const claudeAvailable = await checkClaudeCliAvailable();
    if (!claudeAvailable) {
      writeLine(`  ${colors.yellow}Claude CLI not found${RESET}`);
      writeLine(`  ${colors.dim}Install: npm install -g @anthropic-ai/claude-code${RESET}`);
      return;
    }
  } else {
    if (!isProviderCLIAvailable(provider)) {
      const cliConfig = getCLIConfig(provider);
      writeLine(`  ${colors.yellow}${cliConfig?.displayName || provider} CLI not found${RESET}`);
      if (cliConfig?.install) {
        writeLine(`  ${colors.dim}Install: ${cliConfig.install}${RESET}`);
      }
      return;
    }
  }

  // Determine execution mode (foreground is default, background is opt-in)
  const isBackground = options.background === true && !options.watch;
  const isWatch = options.watch === true;
  const isForeground = !isBackground && !isWatch;

  const modeText = isBackground ? ' (background)' : isWatch ? ' (watch)' : '';
  const providerDisplay = isAnthropic ? 'Claude' : (getCLIConfig(provider)?.displayName || provider);
  writeLine(`  ${gradient('Launching')} lead session${modeText} with ${providerDisplay}...`);
  writeLine();

  try {
    // Find lead agent name from agent files or use default
    const leadAgentName = agentFiles.find(a => a.name.includes('lead'))?.name || `${squad.dir}-lead`;

    let result: string;
    if (isAnthropic) {
      result = await executeWithClaude(prompt, {
        verbose: options.verbose,
        timeoutMinutes: timeoutMins,
        foreground: options.foreground,
        background: options.background,
        watch: options.watch,
        useApi: options.useApi,
        effort: options.effort,
        skills: options.skills,
        trigger: options.trigger || 'manual',
        squadName: squad.dir,
        agentName: leadAgentName,
        model: options.model,
      });
    } else {
      result = await executeWithProvider(provider, prompt, {
        verbose: options.verbose,
        foreground: isForeground || isWatch,
        squadName: squad.dir,
        agentName: leadAgentName,
      });
    }

    if (isForeground || isWatch) {
      writeLine();
      writeLine(`  ${icons.success} Lead session completed`);
    } else {
      writeLine(`  ${icons.success} Lead session launched in background`);
      writeLine(`  ${colors.dim}${result}${RESET}`);
      writeLine();
      writeLine(`  ${colors.dim}The lead will:${RESET}`);
      writeLine(`  ${colors.dim}  1. Assess pending work (issues, memory)${RESET}`);
      writeLine(`  ${colors.dim}  2. Spawn Task agents for parallel execution${RESET}`);
      writeLine(`  ${colors.dim}  3. Coordinate and report results${RESET}`);
      writeLine();
      writeLine(`  ${colors.dim}Monitor: squads workers${RESET}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    writeLine(`  ${icons.error} ${colors.red}Failed to launch agent${RESET}`);
    writeLine(`  ${colors.dim}${msg}${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads doctor\` to check your setup.${RESET}`);
  }
}

// ── Sequential mode ──────────────────────────────────────────────────
// For providers without tool-use (Ollama, Codex, etc.): run each agent
// one at a time. No output chaining — each agent reads its own context.

/**
 * Run all squad agents sequentially with a non-tool-use provider.
 * Each agent runs in foreground, one at a time (Ollama saturates hardware).
 */
export async function runSequentialMode(
  squad: NonNullable<ReturnType<typeof loadSquad>>,
  squadsDir: string,
  provider: string,
  options: RunOptions,
): Promise<void> {
  const cliConfig = getCLIConfig(provider);
  const providerName = cliConfig?.displayName || provider;

  const agentFiles = squad.agents
    .map(a => ({
      name: a.name,
      role: a.role || '',
      path: join(squadsDir, squad.dir, `${a.name}.md`),
    }))
    .filter(a => existsSync(a.path));

  if (agentFiles.length === 0) {
    writeLine(`  ${icons.error} ${colors.red}No agent files found${RESET}`);
    return;
  }

  writeLine(`  ${bold}Sequential mode${RESET} ${colors.dim}(${providerName} — agents run one at a time)${RESET}`);
  writeLine();

  for (const agent of agentFiles) {
    writeLine(`  ${icons.empty} ${colors.cyan}${agent.name}${RESET} ${colors.dim}${agent.role}${RESET}`);
  }
  writeLine();

  if (!options.execute) {
    writeLine(`  ${colors.dim}Run sequentially:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --provider ${provider}`);
    writeLine();
    return;
  }

  const startMs = Date.now();
  let completed = 0;
  let failed = 0;

  for (let i = 0; i < agentFiles.length; i++) {
    const agent = agentFiles[i];
    const label = `[${i + 1}/${agentFiles.length}]`;
    writeLine(`  ${colors.dim}${label}${RESET} Running ${colors.cyan}${agent.name}${RESET}...`);

    try {
      // Read agent definition for the prompt
      const definition = readFileSync(agent.path, 'utf-8');

      // Build prompt: agent definition + squad context
      const { gatherSquadContext } = await import('./run-context.js');
      const context = gatherSquadContext(squad.dir, agent.name, {
        verbose: options.verbose,
        agentPath: agent.path,
      });

      const prompt = `${definition}\n${context}`;

      await executeWithProvider(provider, prompt, {
        verbose: options.verbose,
        foreground: true,
        squadName: squad.dir,
        agentName: agent.name,
        model: options.model,
      });

      completed++;
      writeLine(`  ${icons.success} ${colors.dim}${label}${RESET} ${agent.name} ${colors.green}complete${RESET}`);
    } catch (err) {
      failed++;
      writeLine(`  ${icons.error} ${colors.dim}${label}${RESET} ${agent.name} ${colors.red}failed: ${err instanceof Error ? err.message : String(err)}${RESET}`);
    }

    writeLine();
  }

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  writeLine(`  ${gradient('Sequential run complete')} ${colors.dim}(${completed} ok, ${failed} failed, ${elapsed}s)${RESET}`);
  writeLine();
}
