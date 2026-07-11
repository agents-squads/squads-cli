/**
 * Multi-LLM CLI Support
 *
 * Enables squads to use different LLM providers by delegating to their native CLIs.
 * Unix-style composition: each provider maintains their own CLI, we orchestrate.
 *
 * @see specs/multi-llm.md
 */

import { execSync } from 'child_process';

export interface CLIConfig {
  /** Provider identifier (matches provider field in SQUAD.md/agent.md) */
  provider: string;

  /** Display name for UI */
  displayName: string;

  /** CLI command name */
  command: string;

  /** Install instructions */
  install: string;

  /** Build non-interactive args for execution */
  buildArgs: (prompt: string, options?: RunOptions) => string[];

  /** If true, pipe prompt via stdin instead of CLI arg (avoids shell arg length limits) */
  stdinPrompt?: boolean;

  /**
   * Extract token/cost usage from the CLI's captured output, if the provider
   * prints it. Enables observability records for non-anthropic runs (#824).
   */
  parseUsage?: (output: string) => ProviderUsage | null;

  /**
   * Extra environment for the spawned CLI (e.g. pointing the claude CLI at an
   * Anthropic-compatible endpoint). A key set to undefined is REMOVED from the
   * child env — needed when an inherited variable would shadow the injected one.
   */
  env?: () => Record<string, string | undefined>;
}

export interface RunOptions {
  /** Model override (for providers that support it) */
  model?: string;

  /** Working directory */
  cwd?: string;

  /** Dry run - just show what would execute */
  dryRun?: boolean;
}

export interface ProviderUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/** Parse "57k" / "2.3k" / "1,234" / "1.2M" style counts into integers */
function parseTokenCount(raw: string): number {
  const cleaned = raw.replace(/,/g, '');
  const match = cleaned.match(/^([\d.]+)([kM]?)$/);
  if (!match) return 0;
  const base = parseFloat(match[1]);
  const mult = match[2] === 'k' ? 1_000 : match[2] === 'M' ? 1_000_000 : 1;
  return Math.round(base * mult);
}

/**
 * Parse aider's usage lines, e.g.:
 *   "Tokens: 57k sent, 1.7k received. Cost: $0.02 message, $0.02 session."
 * Multi-message sessions print one line per message — token counts are summed,
 * cost uses the last (cumulative) session figure. Cost may be absent.
 */
export function parseAiderUsage(output: string): ProviderUsage | null {
  const re = /Tokens:\s*([\d.,]+[kM]?)\s*sent,\s*([\d.,]+[kM]?)\s*received\.(?:\s*Cost:\s*\$([\d.]+)\s*message,\s*\$([\d.]+)\s*session\.)?/g;
  let input = 0;
  let output_ = 0;
  let sessionCost = 0;
  let found = false;
  for (const m of output.matchAll(re)) {
    found = true;
    input += parseTokenCount(m[1]);
    output_ += parseTokenCount(m[2]);
    if (m[4] !== undefined) sessionCost = parseFloat(m[4]);
  }
  return found ? { input_tokens: input, output_tokens: output_, cost_usd: sessionCost } : null;
}

/**
 * Fatal provider-API failure signatures (#936). Providers like aider exit 0
 * after printing an API error, so the run was reported \u2713 completed with an
 * empty harvest. Output-based detection is the only reliable signal. These are
 * NON-transient failures — config/credit problems that must fail LOUD, never
 * retried (the transient class is handled per-turn in workflow.ts, #944).
 */
const PROVIDER_FATAL = [
  /litellm\.\w*Error/i,
  /BadRequestError|AuthenticationError|PermissionDeniedError|NotFoundError/,
  /invalid_request_error|authentication_error/,
  /insufficient balance|please recharge|insufficient_quota|exceeded your current quota/i,
  /The supported API model names are/,
  /invalid api key|incorrect api key/i,
];

/** Returns the matched failure line for logging, or null when output looks healthy. */
export function detectProviderFatalError(output: string): string | null {
  for (const re of PROVIDER_FATAL) {
    const m = output.match(re);
    if (m) {
      const line = output.split('\n').find((l) => re.test(l)) ?? m[0];
      return line.trim().slice(0, 300);
    }
  }
  return null;
}

/**
 * Check if a command exists in PATH
 */
export function commandExists(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * LLM CLI registry
 * Maps provider IDs to their CLI configurations
 */

// Repo-map budget for aider-backed executors. The map is what lets a
// file-based agent see the repo's file structure, but it scales with repo
// size (measured: ~4.6k tokens on a small repo, tens of k on a monorepo —
// #845). SQUADS_AIDER_MAP_TOKENS caps it; unset keeps aider's default.
function aiderMapTokensArgs(): string[] {
  const v = process.env.SQUADS_AIDER_MAP_TOKENS;
  if (v === undefined || v === '') return [];
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return [];
  return ['--map-tokens', String(n)];
}

export const LLM_CLIS: Record<string, CLIConfig> = {
  anthropic: {
    provider: 'anthropic',
    displayName: 'Anthropic',
    command: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code',
    buildArgs: (prompt) => ['--print', prompt],
  },

  google: {
    provider: 'google',
    displayName: 'Google',
    command: 'gemini',
    install: 'npm i -g @google/gemini-cli',
    buildArgs: (prompt) => ['--yolo', '--prompt', prompt],
  },

  openai: {
    provider: 'openai',
    displayName: 'OpenAI',
    command: 'codex',
    install: 'npm i -g @openai/codex',
    buildArgs: (prompt) => ['exec', prompt],
  },

  // DeepSeek has no first-party agentic CLI; delegate to aider, which speaks
  // DeepSeek's chat-completions API natively via DEEPSEEK_API_KEY. (codex was
  // considered but recent versions dropped chat-completions wire support, and
  // DeepSeek does not implement the Responses API.)
  deepseek: {
    provider: 'deepseek',
    displayName: 'DeepSeek (via aider)',
    command: 'aider',
    install: 'pip install aider-install && aider-install, then set DEEPSEEK_API_KEY',
    buildArgs: (prompt, opts) => {
      // Agents re-laned to deepseek keep their anthropic `model:` frontmatter,
      // and DeepSeek's API rejects foreign names (#937) — only honor a model
      // override that is actually a deepseek model; else the lane default.
      const requested = opts?.model?.replace(/^deepseek\//, '');
      const model = requested && /^deepseek/.test(requested)
        ? requested
        : process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
      return [
        '--model',
        `deepseek/${model}`,
        '--message',
        prompt,
        '--yes',
        '--no-auto-commits',
        ...aiderMapTokensArgs(),
      ];
    },
    parseUsage: parseAiderUsage,
  },

  // GLM (z.ai) serves an Anthropic-compatible endpoint, so the claude CLI is
  // the agentic harness: point it at z.ai and auth with GLM_API_KEY.
  // ANTHROPIC_API_KEY is removed so an inherited key can't shadow the token.
  glm: {
    provider: 'glm',
    displayName: 'GLM (z.ai via claude)',
    command: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code, then set GLM_API_KEY',
    buildArgs: (prompt, opts) => [
      '--print',
      '--model',
      opts?.model || process.env.GLM_MODEL || 'glm-4.7',
      // In --print mode permission prompts can't be answered, so without an
      // allowlist every Edit/Write is denied and the lane is read-only (#1073).
      ...(opts?.allowedTools?.length ? ['--allowedTools', ...opts.allowedTools] : []),
      '--disable-slash-commands',
      prompt,
    ],
    env: () => ({
      ANTHROPIC_BASE_URL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: process.env.GLM_API_KEY,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: undefined,
    }),
  },

  mistral: {
    provider: 'mistral',
    displayName: 'Mistral',
    command: 'vibe',
    install: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
    buildArgs: (prompt) => ['--prompt', prompt, '--auto-approve'],
  },

  xai: {
    provider: 'xai',
    displayName: 'xAI',
    command: 'grok',
    install: 'bun add -g @vibe-kit/grok-cli',
    buildArgs: (prompt) => ['--prompt', prompt],
  },

  aider: {
    provider: 'aider',
    displayName: 'Aider (Multi)',
    command: 'aider',
    install: 'pip install aider-install && aider-install',
    buildArgs: (prompt) => ['--message', prompt, '--yes', ...aiderMapTokensArgs()],
    parseUsage: parseAiderUsage,
  },

  ollama: {
    provider: 'ollama',
    displayName: 'Ollama (Local)',
    command: 'ollama',
    install: 'brew install ollama',
    buildArgs: (_prompt, opts) => ['run', opts?.model || 'llama3.1'],
    stdinPrompt: true,
  },
};

export interface CLIStatus {
  provider: string;
  displayName: string;
  command: string;
  available: boolean;
  install: string;
}

/**
 * Get status of all LLM CLIs
 */
export function getAllCLIStatus(): CLIStatus[] {
  return Object.values(LLM_CLIS).map((cli) => ({
    provider: cli.provider,
    displayName: cli.displayName,
    command: cli.command,
    available: commandExists(cli.command),
    install: cli.install,
  }));
}

/**
 * `squads init` uses its own provider-selection vocabulary (setup-checks.ts
 * PROVIDERS — 'claude', 'gemini', ...) and stamps it into every scaffolded
 * agent's frontmatter and SQUAD.md `providers.default`. That vocabulary
 * doesn't always match the runtime keys here in LLM_CLIS (#955): init writes
 * 'claude' but the runner needs 'anthropic'; init writes 'gemini' but the
 * runner needs 'google'. Maps init vocabulary to runtime keys; anything
 * already a runtime key (or unrecognized, e.g. 'cursor'/'none', which have
 * no dispatched CLI) passes through unchanged. Read-time only — existing
 * scaffolds on disk keep the old vocabulary; init still writes it as-is.
 */
const PROVIDER_NAME_ALIASES: Record<string, string> = {
  claude: 'anthropic',
  gemini: 'google',
};

export function normalizeProviderName(provider: string): string {
  const key = provider.trim().toLowerCase();
  return PROVIDER_NAME_ALIASES[key] ?? key;
}

/**
 * Get CLI config for a provider
 */
export function getCLIConfig(provider: string): CLIConfig | undefined {
  return LLM_CLIS[normalizeProviderName(provider)];
}

/**
 * Check if a provider's CLI is available
 */
export function isProviderCLIAvailable(provider: string): boolean {
  const config = getCLIConfig(provider);
  if (!config) return false;
  return commandExists(config.command);
}
