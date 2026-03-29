/**
 * Agent runner: the core function that prepares and dispatches a single agent.
 * Extracted from commands/run.ts to reduce its size.
 */

import ora from 'ora';
import { join, basename, extname } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
  findSquadsDir,
  loadSquad,
  loadAgentDefinition,
  parseAgentProvider,
} from './squad-parser.js';
import {
  type RunOptions,
  DEFAULT_TIMEOUT_MINUTES,
  SOFT_DEADLINE_RATIO,
} from './run-types.js';
import {
  generateExecutionId,
  detectTaskType,
  formatDuration,
  checkClaudeCliAvailable,
} from './run-utils.js';
import {
  logExecution,
  updateExecutionStatus,
  checkPreflightGates,
  fetchLearnings,
  checkLocalCooldown,
  emitExecutionEvent,
  DEFAULT_SCHEDULED_COOLDOWN_MS,
} from './execution-log.js';
import {
  executeWithClaude,
  executeWithProvider,
  verifyExecution,
  preflightExecutorCheck,
} from './execution-engine.js';
import {
  type ContextRole,
  parseAgentFrontmatter,
  extractMcpServersFromDefinition,
  loadSystemProtocol,
  gatherSquadContext,
  resolveContextRoleFromAgent,
} from './run-context.js';
import {
  buildContextFromSquad,
  validateExecution,
  formatViolations,
  ExecutionRequest,
} from './permissions.js';
import { parseCooldown } from './cron.js';
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
} from './llm-clis.js';
import { loadSession } from './auth.js';
import { getApiUrl } from './env-config.js';
import { pushCognitionSignal } from './api-client.js';
import { findMemoryDir } from './memory.js';

// ── Operational constants (no magic numbers) ──────────────────────────
export const DRYRUN_DEF_MAX_CHARS = 500;
export const DRYRUN_CONTEXT_MAX_CHARS = parseInt(process.env.SQUADS_DRYRUN_MAX_CHARS || '800', 10);

export async function runAgent(
  agentName: string,
  agentPath: string,
  squadName: string,
  options: RunOptions & { execute?: boolean }
): Promise<void> {
  // Normalize: strip path prefix and extension if a full file path was passed
  if (agentName.includes('/') || agentName.includes('\\')) {
    agentName = basename(agentName, extname(agentName));
  }
  const spinner = ora(`Running agent: ${agentName}`).start();
  const startMs = Date.now();
  const startTime = new Date(startMs).toISOString();
  const executionId = generateExecutionId();
  const taskType = detectTaskType(agentName);

  const definition = loadAgentDefinition(agentPath);

  // Enforce repo layout before execution
  const { checkAndReport } = await import('./repo-enforcement.js');
  if (!checkAndReport(squadName, { verbose: options.verbose })) {
    spinner.fail(`Repo enforcement failed for ${squadName} — fix errors above before running`);
    return;
  }

  // Fetch learnings from bridge (needed for both dry-run preview and real execution)
  const learnings = await fetchLearnings(squadName);
  const learningContext = learnings.length > 0
    ? `\n## Learnings from Previous Runs\n${learnings.map(l => `- ${l.content}`).join('\n')}\n`
    : '';

  if (options.dryRun) {
    spinner.info(`[DRY RUN] Would run ${agentName}`);
    // Show context that would be injected (with role-based gating)
    const dryRunContextRole: ContextRole = agentName.includes('company-lead')
      ? 'coo'
      : resolveContextRoleFromAgent(agentPath, agentName);
    const dryRunContext = gatherSquadContext(squadName, agentName, {
      verbose: options.verbose, agentPath, role: dryRunContextRole
    });
    if (options.verbose) {
      writeLine(`  ${colors.dim}Agent definition:${RESET}`);
      writeLine(`  ${colors.dim}${definition.slice(0, DRYRUN_DEF_MAX_CHARS)}...${RESET}`);
      if (learnings.length > 0) {
        writeLine(`  ${colors.dim}Learnings: ${learnings.length} from bridge${RESET}`);
      }
      if (dryRunContext || learningContext) {
        const fullContext = `${dryRunContext}${learningContext}`;
        writeLine();
        writeLine(`  ${colors.cyan}Context to inject (${Math.ceil(fullContext.length / 4)} tokens):${RESET}`);
        writeLine(`  ${colors.dim}${fullContext.slice(0, DRYRUN_CONTEXT_MAX_CHARS)}...${RESET}`);
      }
    }
    return;
  }

  // Pre-execution permission validation (Phase 3)
  const squadsDir = findSquadsDir();
  if (squadsDir) {
    const squadFilePath = join(squadsDir, squadName, 'SQUAD.md');
    if (existsSync(squadFilePath)) {
      const squadContent = readFileSync(squadFilePath, 'utf-8');
      const permContext = buildContextFromSquad(squadName, squadContent, agentName);

      // Build execution request from agent definition
      // For now, we validate MCP servers mentioned in the agent definition
      const mcpServers = extractMcpServersFromDefinition(definition);
      const execRequest: ExecutionRequest = {
        mcpServers
      };

      const permResult = validateExecution(permContext, execRequest);

      if (permResult.violations.length > 0) {
        spinner.stop();
        const violationLines = formatViolations(permResult);
        for (const line of violationLines) {
          writeLine(`  ${line}`);
        }
        writeLine();

        if (!permResult.allowed) {
          writeLine(`  ${colors.red}Execution blocked due to permission violations.${RESET}`);
          writeLine(`  ${colors.dim}Configure permissions in ${squadFilePath}${RESET}`);
          return;
        }
      }
    }
  }

  // Preflight gate check (quota, cooldown) via bridge API
  const preflight = await checkPreflightGates(squadName, agentName);

  if (!preflight.allowed) {
    spinner.stop();
    writeLine();
    writeLine(`  ${colors.red}${icons.error} Execution blocked by preflight gates${RESET}`);

    if (preflight.gates.quota && !preflight.gates.quota.ok) {
      writeLine(`  ${colors.dim}Quota: $${preflight.gates.quota.used.toFixed(2)}/$${preflight.gates.quota.limit}/mo limit exceeded${RESET}`);
    }

    if (preflight.gates.cooldown && !preflight.gates.cooldown.ok) {
      const elapsed = preflight.gates.cooldown.elapsed_sec;
      const minGap = preflight.gates.cooldown.min_gap_sec;
      writeLine(`  ${colors.dim}Cooldown: ${elapsed}s since last run (min: ${minGap}s)${RESET}`);
    }

    writeLine();
    return;
  }

  // Show preflight status in verbose mode
  if (options.verbose && Object.keys(preflight.gates).length > 0) {
    writeLine(`  ${colors.dim}Preflight: quota ${preflight.gates.quota?.ok ? '✓' : '✗'} cooldown ${preflight.gates.cooldown?.ok ? '✓' : '✗'}${RESET}`);
  }

  // Local cooldown check (when bridge is unavailable or has no execution history)
  // Skip for manual triggers - only enforce for scheduled/cron runs
  const isScheduledRun = options.trigger === 'scheduled' || options.trigger === 'smart';
  const bridgeHasNoHistory = preflight.gates.cooldown?.elapsed_sec === null;
  if (isScheduledRun && (!preflight.gates.cooldown || bridgeHasNoHistory)) {
    // Read cooldown from agent frontmatter, fall back to default
    const frontmatterForCooldown = parseAgentFrontmatter(agentPath);
    const cooldownMs = frontmatterForCooldown.cooldown
      ? (parseCooldown(frontmatterForCooldown.cooldown) || DEFAULT_SCHEDULED_COOLDOWN_MS)
      : DEFAULT_SCHEDULED_COOLDOWN_MS;
    const localCooldown = checkLocalCooldown(squadName, agentName, cooldownMs);

    if (!localCooldown.ok) {
      spinner.stop();
      writeLine();
      writeLine(`  ${colors.yellow}${icons.warning} Skipping: cooldown not elapsed${RESET}`);
      writeLine(`  ${colors.dim}Last run: ${formatDuration(localCooldown.elapsedMs!)} ago (cooldown: ${formatDuration(localCooldown.cooldownMs)})${RESET}`);
      writeLine();
      return;
    }

    if (options.verbose) {
      writeLine(`  ${colors.dim}Local cooldown: ✓ (${formatDuration(localCooldown.elapsedMs || 0)} since last run)${RESET}`);
    }
  }

  // Log execution start
  logExecution({
    squadName,
    agentName,
    executionId,
    startTime,
    status: 'running',
    trigger: options.trigger || 'manual',
    taskType,
  });

  if (options.verbose && learnings.length > 0) {
    writeLine(`  ${colors.dim}Injecting ${learnings.length} learnings${RESET}`);
  }

  // Load system protocol (SYSTEM.md, replaces legacy approval + post-execution)
  const systemProtocol = loadSystemProtocol();
  const systemContext = systemProtocol ? `\n${systemProtocol}\n` : '';

  // Derive context role from the agent's own YAML frontmatter `role:` free-text.
  // Company COO override remains explicit.
  const contextRole: ContextRole = agentName.includes('company-lead')
    ? 'coo'
    : resolveContextRoleFromAgent(agentPath, agentName);

  // Gather squad context (role-based: scanners get minimal, leads get everything)
  const squadContext = gatherSquadContext(squadName, agentName, {
    verbose: options.verbose, agentPath, role: contextRole
  });

  // Fetch cognition beliefs for prompt injection (Reflexion pattern)
  // Only attempts when API is available (Tier 2). Silent skip in Tier 1.
  let cognitionContext = '';
  const apiUrl = getApiUrl();
  if (apiUrl) {
    try {
      const session = loadSession();
      if (session?.accessToken && session.status === 'active') {
        const safeSquadName = encodeURIComponent(squadName);
        const res = await fetch(`${apiUrl}/cognition/context/squad:${safeSquadName}`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = await res.json() as { markdown: string };
          if (data.markdown && !data.markdown.includes('No cognition data')) {
            cognitionContext = `\n${data.markdown}\n`;
            if (options.verbose) {
              writeLine(`  ${colors.dim}Injecting cognition beliefs${RESET}`);
            }
          }
        }
      }
    } catch {
      // Silent — API not available or auth not configured
    }
  }

  // Generate the Claude Code prompt with timeout awareness
  const timeoutMins = options.timeout || DEFAULT_TIMEOUT_MINUTES;
  const taskDirective = options.task
    ? `\n## TASK DIRECTIVE (overrides default behavior)\n${options.task}\n`
    : '';
  const prompt = `You are ${agentName} from squad ${squadName}.
${taskDirective}
Your full context follows — read it top-to-bottom:
${systemContext}${squadContext}${cognitionContext}${learningContext}`;

  // Resolve provider with full chain:
  // 1. Agent config (from agent file frontmatter/header)
  // 2. CLI option (--provider flag)
  // 3. Squad default (from SQUAD.md providers.default)
  // 4. Fallback to 'anthropic'
  const agentProvider = parseAgentProvider(agentPath);
  const squad = loadSquad(squadName);
  const squadDefaultProvider = squad?.providers?.default;

  const provider = agentProvider || options.provider || squadDefaultProvider || 'anthropic';
  const isAnthropic = provider === 'anthropic';

  if (options.verbose && (agentProvider || squadDefaultProvider)) {
    writeLine(`  ${colors.dim}Provider resolution:${RESET}`);
    if (agentProvider) writeLine(`    ${colors.dim}Agent: ${agentProvider}${RESET}`);
    if (options.provider) writeLine(`    ${colors.dim}CLI: ${options.provider}${RESET}`);
    if (squadDefaultProvider) writeLine(`    ${colors.dim}Squad: ${squadDefaultProvider}${RESET}`);
    writeLine(`    ${colors.dim}→ Using: ${provider}${RESET}`);
  }

  // Check CLI availability
  const cliAvailable = isAnthropic
    ? await checkClaudeCliAvailable()
    : isProviderCLIAvailable(provider);

  if (options.execute && cliAvailable) {
    const cliConfig = getCLIConfig(provider);
    const cliName = cliConfig?.displayName || provider;

    // Determine execution mode (foreground is default, background is opt-in)
    const isBackground = options.background === true && !options.watch;
    const isWatch = options.watch === true;
    const isForeground = !isBackground && !isWatch;

    spinner.text = isBackground
      ? `Launching ${agentName} with ${cliName} in background...`
      : isWatch
        ? `Starting ${agentName} with ${cliName} (watch mode)...`
        : `Running ${agentName} with ${cliName}...`;

    // Parse frontmatter for verification criteria (Ralph loop)
    const frontmatter = parseAgentFrontmatter(agentPath);
    const hasCriteria = !!frontmatter.acceptance_criteria && options.verify !== false;
    const maxRetries = frontmatter.max_retries ?? 2;
    let currentPrompt = prompt;

    for (let attempt = 0; attempt <= (hasCriteria ? maxRetries : 0); attempt++) {
      try {
        let result: string;

        if (isAnthropic) {
          result = await executeWithClaude(currentPrompt, {
            verbose: options.verbose,
            timeoutMinutes: options.timeout || 30,
            foreground: options.foreground,
            background: options.background,
            watch: options.watch,
            useApi: options.useApi,
            effort: options.effort,
            skills: options.skills,
            trigger: options.trigger || 'manual',
            squadName,
            agentName,
            model: options.model,
          });
        } else {
          result = await executeWithProvider(provider, currentPrompt, {
            verbose: options.verbose,
            foreground: !isBackground,
            squadName,
            agentName,
          });
        }

        // Ralph loop: verify foreground execution against acceptance criteria
        if (hasCriteria && (isForeground || isWatch)) {
          const verification = await verifyExecution(
            squadName, agentName, frontmatter.acceptance_criteria!, { verbose: options.verbose }
          );
          if (!verification.passed && attempt < maxRetries) {
            writeLine(`  ${colors.yellow}Verification: FAIL - ${verification.reason}${RESET}`);
            writeLine(`  ${colors.dim}Retrying (${attempt + 1}/${maxRetries})...${RESET}`);
            currentPrompt = `${prompt}\n\n## PREVIOUS ATTEMPT FAILED\nVerification found: ${verification.reason}\nPlease address this issue and try again.`;
            continue;
          }
          if (verification.passed) {
            writeLine(`  ${colors.green}Verification: PASS - ${verification.reason}${RESET}`);
          }
        }

        // Emit completion event (non-blocking)
        emitExecutionEvent('agent.completed', {
          squad: squadName, agent: agentName, executionId,
        }).catch(() => {});

        if (isForeground || isWatch) {
          spinner.succeed(`Agent ${agentName} completed (${cliName})`);
        } else {
          spinner.succeed(`Agent ${agentName} launched in background (${cliName})`);
          writeLine(`  ${colors.dim}${result}${RESET}`);
          writeLine();
          writeLine(`  ${colors.dim}Monitor:${RESET} squads workers`);
          writeLine(`  ${colors.dim}Memory:${RESET}  squads memory show ${squadName}`);
        }
        break; // Success — exit retry loop
      } catch (error) {
        // Emit failure event (non-blocking)
        emitExecutionEvent('agent.failed', {
          squad: squadName, agent: agentName, executionId, error: String(error),
        }).catch(() => {});

        spinner.fail(`Agent ${agentName} failed to launch`);
        updateExecutionStatus(squadName, agentName, executionId, 'failed', {
          error: String(error),
          durationMs: Date.now() - startMs,
        });
        const msg = error instanceof Error ? error.message : String(error);
        const isLikelyBug = error instanceof ReferenceError || error instanceof TypeError || error instanceof SyntaxError;
        writeLine(`  ${colors.red}${msg}${RESET}`);
        writeLine();
        if (isLikelyBug) {
          writeLine(`  ${colors.yellow}This looks like a bug. Please try:${RESET}`);
          writeLine(`  ${colors.dim}$${RESET} squads doctor          ${colors.dim}— check your setup${RESET}`);
          writeLine(`  ${colors.dim}$${RESET} squads update           ${colors.dim}— get the latest fixes${RESET}`);
          writeLine();
          writeLine(`  ${colors.dim}If the problem persists, file an issue:${RESET}`);
          writeLine(`  ${colors.dim}https://github.com/agents-squads/squads-cli/issues${RESET}`);
        } else {
          writeLine(`  ${colors.dim}Run \`squads doctor\` to check your setup, or \`squads run ${agentName} --verbose\` for details.${RESET}`);
        }
        break; // Error — exit retry loop
      }
    }
  } else {
    // Show instructions for manual execution
    spinner.succeed(`Agent ${agentName} ready`);
    writeLine(`  ${colors.dim}Execution logged: ${startTime}${RESET}`);

    if (!cliAvailable) {
      const cliConfig = getCLIConfig(provider);
      writeLine();
      writeLine(`  ${colors.yellow}${cliConfig?.command || provider} CLI not found${RESET}`);
      writeLine(`  ${colors.dim}Install: ${cliConfig?.install || 'squads providers'}${RESET}`);
    }

    writeLine();
    writeLine(`  ${colors.dim}To launch as background task:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squadName}${RESET} -a ${colors.cyan}${agentName}${RESET}`);
    if (provider !== 'anthropic') {
      writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squadName}${RESET} -a ${colors.cyan}${agentName}${RESET} --provider=${provider}`);
    }
    writeLine();
    writeLine(`  ${colors.dim}Or run interactively:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} Run the ${colors.cyan}${agentName}${RESET} agent from ${agentPath}`);
  }
}
