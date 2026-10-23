/**
 * Multi-LLM CLI Support
 *
 * Enables squads to use different LLM providers by delegating to their native CLIs.
 * Unix-style composition: each provider maintains their own CLI, we orchestrate.
 *
 * @see specs/multi-llm.md
 */

import { execSync } from 'child_process';
import { accessSync, readFileSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { computeBilling } from './billing.js';
import { parseStreamJson, parseOpencodeJson } from './stream-json.js';
import { parseKimiUsage } from './kimi-code.js';
import { kimiSpawnEnv } from './kimi-code-governance.js';
import { loadProviderRegistry, anthropicCompatEnv, readProviderSecret, type ProviderEntry } from './provider-registry.js';

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
   * `model` is the lane's effective model (see resolveModel), for lanes that
   * price tokens themselves.
   */
  parseUsage?: (output: string, model?: string) => ProviderUsage | null;

  /**
   * The model the lane will actually run with, for attribution. When set, the
   * runner records this instead of the caller's model — which may be a Claude
   * name leaked from frontmatter that the lane ignored (#937). Undefined means
   * unknown, never the leaked name.
   */
  resolveModel?: (options?: RunOptions) => string | undefined;

  /**
   * Foreground rendering for JSONL lanes without an exec-event adapter: maps
   * one stdout line to the text shown live (null hides the line).
   */
  renderLine?: (line: string) => string | null;

  /**
   * The CLI emits Claude Code stream-json (JSONL events), not prose (#1077).
   * The foreground runner renders assistant text live instead of echoing raw
   * JSONL, and parses outcomes from the same stream.
   */
  streamJson?: boolean;

  /**
   * The CLI emits opencode `--format json` JSONL events (#1177) — a different
   * shape from Claude stream-json, normalized by its own adapter
   * (createOpencodeStreamJsonAdapter) and parser (parseOpencodeJson).
   * Mutually exclusive with `streamJson`.
   */
  opencodeJson?: boolean;

  /**
   * The CLI is the Kimi Code harness (#1309): OpenAI-chat-shaped stream-json on
   * stdout, usage in the session wire log (kimi-code.ts), governance from the
   * OS sandbox rather than kimi's own permissions (kimi-code-governance.ts).
   */
  kimiCodeJson?: boolean;

  /**
   * Spawn with stdin `'ignore'` (#1307): CLIs that read piped stdin hang when
   * it is inherited from a detached/non-TTY parent.
   */
  stdinIgnore?: boolean;

  /**
   * Extra environment for the spawned CLI (e.g. pointing the claude CLI at an
   * Anthropic-compatible endpoint). A key set to undefined is REMOVED from the
   * child env — needed when an inherited variable would shadow the injected one.
   */
  env?: () => Record<string, string | undefined>;

  /**
   * Native-harness lane (#1227): the engine writes its own PersistedExecEvent
   * v2 stream. The runner hands it the canonical events file, the execution id
   * and a per-run task store via argv, and must NOT also run its own event
   * writer for the lane — two writers on one file is how a ledger splits a
   * run in two.
   */
  nativeEvents?: boolean;
}

export interface RunOptions {
  /** Model override (for providers that support it) */
  model?: string;

  /** Working directory */
  cwd?: string;

  /** Dry run - just show what would execute */
  dryRun?: boolean;

  /** Compiled tool allowlist for claude-harness lanes (#1073); others ignore it */
  allowedTools?: string[];
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
 * Usage from a claude-harness stream-json tail (#1077 — glm lane; #1159 —
 * every foreign lane on the claude harness). Token counts come from the
 * stream's events. The result event's cost_usd is DISCARDED: the claude CLI
 * prices foreign models at Claude rates (measured ~25× overstatement on
 * glm-4.7), which would corrupt every ROI comparison. Cost = tokens × env
 * rates (SQUADS_<PROVIDER>_COST_PER_MTOK_IN/OUT, $ per million tokens);
 * unset rates leave cost 0 — a visible gap, never a fabricated number.
 */
function makeClaudeHarnessStreamUsage(envPrefix: string): (output: string) => ProviderUsage | null {
  return (output) => {
    const stream = parseStreamJson(output);
    const u = stream.usage;
    if (!u.input_tokens && !u.output_tokens) return null;
    let cost = 0;
    const inRate = parseFloat(process.env[`SQUADS_${envPrefix}_COST_PER_MTOK_IN`] || '');
    const outRate = parseFloat(process.env[`SQUADS_${envPrefix}_COST_PER_MTOK_OUT`] || '');
    if (Number.isFinite(inRate) && Number.isFinite(outRate)) {
      cost = (u.input_tokens * inRate + u.output_tokens * outRate) / 1_000_000;
    }
    return { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cost_usd: cost };
  };
}

export const parseGlmStreamUsage = makeClaudeHarnessStreamUsage('GLM');
export const parseDeepseekStreamUsage = makeClaudeHarnessStreamUsage('DEEPSEEK');
export const parseKimiStreamUsage = makeClaudeHarnessStreamUsage('KIMI');

/**
 * Usage from an opencode `--format json` log (#1177). Unlike the claude
 * harness (which prices foreign models at Claude rates — discarded above),
 * opencode's step_finish cost is the provider's REAL price, so it's trusted.
 */
export function parseOpencodeUsage(output: string): ProviderUsage | null {
  const stream = parseOpencodeJson(output);
  const u = stream.usage;
  if (!u.input_tokens && !u.output_tokens) return null;
  return { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cost_usd: u.cost_usd };
}

/**
 * The model a codex lane runs with. Agents re-laned to openai keep their
 * anthropic `model:` frontmatter (`sonnet`, `claude-…`), which the OpenAI API
 * rejects (#937) — only an OpenAI model name is honored. Otherwise
 * OPENAI_MODEL, otherwise undefined (codex uses its own config default).
 */
export function resolveCodexModel(requested?: string): string | undefined {
  const name = requested?.replace(/^openai\//, '');
  if (name && /^(gpt|o\d|codex|chatgpt)/i.test(name)) return name;
  return process.env.OPENAI_MODEL || undefined;
}

/**
 * The default model in codex's own config ($CODEX_HOME/config.toml, top-level
 * `model = "…"`) — what `codex exec` runs when no `-m` is passed. Attribution
 * only; unreadable config is unknown, not an error.
 */
export function codexConfigModel(): string | undefined {
  try {
    const home = process.env.CODEX_HOME || join(homedir(), '.codex');
    const toml = readFileSync(join(home, 'config.toml'), 'utf-8');
    // Top-level keys only: stop at the first [table] header.
    const top = toml.split(/^\s*\[/m)[0];
    const m = top.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Usage from a `codex exec --json` stream: tokens from every `turn.completed`
 * event. Cost = tokens × SQUADS_OPENAI_COST_PER_MTOK_IN/OUT when both are set,
 * else the provider price table (billing.ts) for the lane's model. Codex's
 * input_tokens already include cached input, so cost is an upper bound when
 * the cache was hit.
 */
export function parseCodexUsage(output: string, model?: string): ProviderUsage | null {
  let input = 0;
  let output_ = 0;
  let found = false;
  for (const line of output.split('\n')) {
    if (!line.includes('"turn.completed"')) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      if (ev.type !== 'turn.completed' || !ev.usage) continue;
      found = true;
      input += ev.usage.input_tokens || 0;
      output_ += ev.usage.output_tokens || 0;
    } catch { /* partial line in the tail — skip */ }
  }
  if (!found) return null;
  const inRate = parseFloat(process.env.SQUADS_OPENAI_COST_PER_MTOK_IN || '');
  const outRate = parseFloat(process.env.SQUADS_OPENAI_COST_PER_MTOK_OUT || '');
  const cost = Number.isFinite(inRate) && Number.isFinite(outRate)
    ? (input * inRate + output_ * outRate) / 1_000_000
    : computeBilling({ provider: 'openai', model, harness: 'codex', input_tokens: input, output_tokens: output_ }).usd ?? 0;
  return { input_tokens: input, output_tokens: output_, cost_usd: cost };
}

/**
 * Codex sandbox for a lane's compiled tool grants. Codex cannot scope shell
 * commands the way --allowedTools does, so workspace-write is granted only to
 * an agent whose contract grants a file-write tool; anything else — including
 * no allowlist at all — stays read-only, the same fail-closed default as a
 * claude-harness lane without --allowedTools (#1073).
 */
export function codexSandboxMode(allowedTools?: string[]): 'workspace-write' | 'read-only' {
  const writes = allowedTools?.some((t) => /^(write|edit|multiedit|notebookedit)\b/i.test(t.trim()));
  return writes ? 'workspace-write' : 'read-only';
}

/** Live text for a `codex exec --json` line: agent messages only. */
export function renderCodexLine(line: string): string | null {
  if (!line.includes('"agent_message"')) return null;
  try {
    const ev = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
    return ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text
      ? ev.item.text
      : null;
  } catch {
    return null;
  }
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
  /AI_\w*Error/,  // opencode (Vercel AI SDK) — AI_APICallError, AI_LoadAPIKeyError, etc. (#978)
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
    // Absolute/relative paths bypass `which` — SQUADS_ENGINE_BIN points at a
    // built binary, not a PATH entry.
    if (command.includes('/')) {
      accessSync(command, fsConstants.X_OK);
      return true;
    }
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

/**
 * Fail fast on account-state 429s from foreign endpoints (#1298). The Claude
 * Code harness retries a provider 429 internally up to 10 times (~213 s)
 * before emitting its result, so an expired GLM plan took 213 s to fail
 * instead of < 10 s. CLAUDE_CODE_MAX_RETRIES caps those retries (verified
 * live: 0 → 3 s, 2 → 6 s, 3 → 8 s). Default 2 for every claude-harness lane
 * pointing at a non-Anthropic endpoint; an operator-set value always wins.
 */
export function harnessRetryEnv(): Record<string, string> {
  return { CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES ?? '2' };
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

  // codex exec defaults to a read-only sandbox, so the lane could not write
  // files: an agent granted file writes gets workspace-write, which confines
  // writes to the lane's worktree (-C); others stay read-only
  // (codexSandboxMode). approval_policy=never because nobody can answer a
  // prompt in exec mode.
  // --json gives a parseable event stream for usage; agent messages render
  // live via renderLine.
  openai: {
    provider: 'openai',
    displayName: 'OpenAI',
    command: 'codex',
    install: 'npm i -g @openai/codex',
    buildArgs: (prompt, opts) => {
      const model = resolveCodexModel(opts?.model);
      return [
        'exec',
        '--json',
        '--sandbox', codexSandboxMode(opts?.allowedTools),
        '-c', 'approval_policy="never"',
        '--skip-git-repo-check',
        ...(model ? ['-m', model] : []),
        ...(opts?.cwd ? ['-C', opts.cwd] : []),
        '--',
        prompt,
      ];
    },
    resolveModel: (opts) => resolveCodexModel(opts?.model) ?? codexConfigModel(),
    parseUsage: parseCodexUsage,
    renderLine: renderCodexLine,
    // codex exec appends piped stdin to the prompt and waits for its EOF.
    stdinIgnore: true,
  },

  // DeepSeek serves an Anthropic-compatible endpoint (api.deepseek.com/anthropic
  // — verified live 2026-07-17: proper Anthropic message shape + usage block),
  // so the claude CLI is the agentic harness, same pattern as glm below (#1159).
  // Replaces the aider delegation: one harness → one stream shape → the Claude
  // adapter emits exec-events for every lane, and deepseek lanes gain tool
  // allowlists, subagents, and artifact mining aider never had. (The earlier
  // aider rationale predated DeepSeek's Anthropic-format support.)
  deepseek: {
    provider: 'deepseek',
    displayName: 'DeepSeek (via claude)',
    command: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code, then set DEEPSEEK_API_KEY',
    buildArgs: (prompt, opts) => {
      // Agents re-laned to deepseek keep their anthropic `model:` frontmatter,
      // and DeepSeek's API rejects foreign names (#937) — only honor a model
      // override that is actually a deepseek model; else the lane default.
      const requested = opts?.model?.replace(/^deepseek\//, '');
      const model = requested && /^deepseek/.test(requested)
        ? requested
        : process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
      return [
        '--print',
        // Structured event stream so usage + outcomes are parseable (#1077);
        // --verbose is required by the claude CLI for stream-json in print mode.
        '--output-format', 'stream-json',
        '--verbose',
        '--model', model,
        // In --print mode permission prompts can't be answered (#1073).
        ...(opts?.allowedTools?.length ? ['--allowedTools', ...opts.allowedTools] : []),
        '--disable-slash-commands',
        prompt,
      ];
    },
    streamJson: true,
    parseUsage: parseDeepseekStreamUsage,
    env: () => ({
      ANTHROPIC_BASE_URL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: process.env.DEEPSEEK_API_KEY,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: undefined,
      ...harnessRetryEnv(),
    }),
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
      // Structured event stream so usage + outcomes are parseable (#1077);
      // --verbose is required by the claude CLI for stream-json in print mode.
      '--output-format', 'stream-json',
      '--verbose',
      '--model',
      opts?.model || process.env.GLM_MODEL || 'glm-4.7',
      // In --print mode permission prompts can't be answered, so without an
      // allowlist every Edit/Write is denied and the lane is read-only (#1073).
      ...(opts?.allowedTools?.length ? ['--allowedTools', ...opts.allowedTools] : []),
      '--disable-slash-commands',
      prompt,
    ],
    streamJson: true,
    parseUsage: parseGlmStreamUsage,
    env: () => ({
      ANTHROPIC_BASE_URL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: process.env.GLM_API_KEY,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: undefined,
      ...harnessRetryEnv(),
    }),
  },

  // Kimi (Moonshot) serves an Anthropic-compatible endpoint (verified live
  // 2026-07-24: proper Anthropic message shape + usage on /anthropic/v1/messages
  // for kimi-k3), so the claude CLI is the agentic harness, same pattern as
  // glm/deepseek. K3 is a reasoning model that emits `thinking` blocks — the
  // stream adapter already handles those (glm-4.7/5.2 do the same). Point it at
  // Moonshot and auth with KIMI_API_KEY; ANTHROPIC_API_KEY is removed so an
  // inherited key can't shadow the token.
  kimi: {
    provider: 'kimi',
    displayName: 'Kimi (Moonshot via claude)',
    command: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code, then set KIMI_API_KEY',
    buildArgs: (prompt, opts) => [
      '--print',
      // Structured event stream so usage + outcomes are parseable (#1077);
      // --verbose is required by the claude CLI for stream-json in print mode.
      '--output-format', 'stream-json',
      '--verbose',
      '--model',
      opts?.model || process.env.KIMI_MODEL || 'kimi-k3',
      // In --print mode permission prompts can't be answered, so without an
      // allowlist every Edit/Write is denied and the lane is read-only (#1073).
      ...(opts?.allowedTools?.length ? ['--allowedTools', ...opts.allowedTools] : []),
      '--disable-slash-commands',
      prompt,
    ],
    streamJson: true,
    parseUsage: parseKimiStreamUsage,
    env: () => ({
      ANTHROPIC_BASE_URL: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/anthropic',
      ANTHROPIC_AUTH_TOKEN: process.env.KIMI_API_KEY,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: undefined,
      ...harnessRetryEnv(),
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

  // opencode is the FALLBACK HARNESS (#1177, anti-lock-in): a second
  // multi-provider agentic executor so the fleet survives a broken/locked-out
  // claude CLI. `--format json` emits a structured event stream (normalized by
  // createOpencodeStreamJsonAdapter). Permissions are NOT auto-approved: the
  // runner writes a per-spawn permission config from the agent contract and
  // wraps the spawn in the OS sandbox (opencode-governance.ts, cli#1306) —
  // `--auto` must never come back. Cost in
  // its step_finish events is REAL provider pricing (models.dev rates), so no
  // env-rate table is needed.
  opencode: {
    provider: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    install: 'curl -fsSL https://opencode.ai/install.sh | bash',
    buildArgs: (prompt, opts) => {
      // --thinking: reasoning parts on the stream, kept as `reasoning` events (#1316).
      const args = ['run', '--format', 'json', '--thinking'];
      // opencode wants `provider/model` (e.g. deepseek/deepseek-chat,
      // anthropic/claude-sonnet-5); bare names pass through for its default.
      if (opts?.model) args.push('--model', opts.model);
      if (opts?.cwd) args.push('--dir', opts.cwd);
      args.push(prompt);
      return args;
    },
    opencodeJson: true,
    // `opencode run` reads piped stdin to EOF — inherited non-TTY stdin hung
    // foreground lanes forever (agent shells, cron, console spawns).
    stdinIgnore: true,
    parseUsage: parseOpencodeUsage,
  },

  // Kimi Code CLI (#1309): the user's Kimi For Coding SUBSCRIPTION (OAuth login
  // stored by `kimi`), not a metered key — distinct from the `kimi` provider
  // above, which routes the claude CLI at Moonshot's metered endpoint.
  // `-p` cannot be combined with `--auto` and auto-approves every tool, so
  // permissions are NOT kimi's job: the runner refuses un-honourable grants and
  // wraps the spawn in the OS sandbox (kimi-code-governance.ts). `--auto` and
  // kimi's permission modes must never appear here. stdin is 'ignore'd.
  'kimi-code': {
    provider: 'kimi-code',
    displayName: 'Kimi Code (subscription)',
    command: process.env.SQUADS_KIMI_BIN || 'kimi',
    install: 'install the Kimi Code CLI (kimi), then run `kimi` once and log in with your Kimi For Coding subscription',
    buildArgs: (prompt, opts) => {
      const args = ['-p', prompt, '--output-format', 'stream-json'];
      // Passed through as-is: kimi's own config names its aliases
      // `kimi-code/k3`, `kimi-code/kimi-for-coding`, … (verified 2.2.0 — a bare
      // `k3` is rejected: "Model \"k3\" is not configured"). A Claude model
      // leaked from frontmatter is not passed — kimi uses its default.
      const model = opts?.model;
      if (model && !/^claude/i.test(model)) args.push('-m', model);
      return args;
    },
    kimiCodeJson: true,
    stdinIgnore: true,
    parseUsage: parseKimiUsage,
    env: () => kimiSpawnEnv(),
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
 * Synthesize a CLIConfig from a user registry entry (#1156, spec
 * provider-registry-2026-08-13). Built-ins always win, so a registry file can
 * never change the behaviour of a shipped provider — this only ADDS providers,
 * which is what keeps the migration behaviour-preserving.
 *
 * Only the `claude` harness against an Anthropic-compatible endpoint is
 * synthesized: that is the proven GLM/DeepSeek pattern and the case #1156
 * exists for — a new Kimi-like provider becomes one YAML entry, zero
 * TypeScript. `native` entries synthesize through `nativeConfigFromRegistry`
 * (#1227); anything else returns undefined rather than silently falling back
 * to a third-party binary — a silent fallback is precisely the dependency
 * this work removes.
 */
function configFromRegistry(name: string): CLIConfig | undefined {
  const entry = loadProviderRegistry().providers[name];
  if (!entry) return undefined;
  if (entry.harness === 'native') return nativeConfigFromRegistry(entry);
  if (entry.harness !== 'claude' || !entry.base_url) return undefined;

  const defaultModel = entry.models?.[0];
  return {
    provider: entry.name,
    displayName: entry.display_name ?? `${entry.name} (via claude)`,
    command: 'claude',
    install: `npm i -g @anthropic-ai/claude-code, then add the credential at ~/.squads/secrets/${entry.key_ref ?? '<key_ref>'}`,
    buildArgs: (_prompt, opts) => {
      // Honour a model override only when it belongs to this provider: an
      // agent re-laned here keeps its previous `model:` frontmatter, and a
      // foreign model name is rejected by the endpoint (the #937 failure).
      const requested = opts?.model?.replace(new RegExp(`^${entry.name}/`), '');
      const model = requested && entry.models?.includes(requested) ? requested : defaultModel;
      return [
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        ...(model ? ['--model', model] : []),
      ];
    },
    stdinPrompt: true,
    streamJson: true,
    parseUsage: makeClaudeHarnessStreamUsage(entry.name.toUpperCase()),
    env: () => ({ ...anthropicCompatEnv(entry), ...harnessRetryEnv() }),
  };
}

/** claude-harness tool name → native engine permission rule (#1227). */
const NATIVE_TOOL_RULES: Record<string, string> = {
  read: 'read(*)', write: 'write(*)', edit: 'edit(*)',
  glob: 'glob(*)', grep: 'grep(*)', bash: 'bash(*)',
};

/**
 * Translate a lane's compiled tool allowlist into engine `--allow` rules.
 * Task tools are always granted — they are the run's own coordination
 * channel (#1218), and the gate's fallback deny would otherwise mute it.
 * A lane with no allowlist gets the standard surface including bash — the
 * same effective grant a claude-harness lane has without --allowedTools.
 */
export function nativeAllowRules(allowedTools?: string[]): string[] {
  const rules = ['task_create(*)', 'task_claim(*)', 'task_complete(*)', 'task_block(*)', 'task_list(*)'];
  if (!allowedTools) return [...rules, ...Object.values(NATIVE_TOOL_RULES)];
  for (const t of allowedTools) {
    const rule = NATIVE_TOOL_RULES[t.trim().toLowerCase()];
    if (rule && !rules.includes(rule)) rules.push(rule);
  }
  return rules;
}

/**
 * Usage from the engine's `--json` stdout result — the native lane's
 * equivalent of stream scraping. The result is the last top-level JSON
 * object on the stream; anything unparseable is no usage, not a wrong usage.
 */
export function parseNativeJsonUsage(output: string): ProviderUsage | null {
  // The result is a top-level pretty-printed JSON object: either the whole
  // output, or the last line that opens one (`\n{` — nested objects are
  // indented, so only the top level matches).
  const trimmed = output.trim();
  const nl = trimmed.lastIndexOf('\n{');
  const candidate = nl < 0 ? trimmed : trimmed.slice(nl + 1);
  if (!candidate.startsWith('{')) return null;
  try {
    const r = JSON.parse(candidate) as {
      usage?: { input?: number; output?: number };
      costEst?: number;
    };
    if (!r.usage || typeof r.usage.input !== 'number') return null;
    return {
      input_tokens: r.usage.input,
      output_tokens: r.usage.output ?? 0,
      cost_usd: typeof r.costEst === 'number' ? r.costEst : 0,
    };
  } catch {
    return null;
  }
}

/** Auth for a native lane: the key_ref secret rides the child env, never argv. */
function nativeEnv(entry: ProviderEntry): Record<string, string | undefined> {
  const token = (entry.key_ref && readProviderSecret(entry.key_ref))
    || (entry.required_env ?? []).map(v => process.env[v]).find(Boolean)
    || undefined;
  return { SQUADS_ENGINE_API_KEY: token };
}

/**
 * Synthesize a CLIConfig for a `harness: native` registry entry (#1227).
 *
 * The engine speaks the openai-chat wire today; an entry declaring
 * `api: anthropic-messages` gets NO runtime — undefined, loud, and no
 * fallback, exactly as before this synthesis existed.
 */
function nativeConfigFromRegistry(entry: ProviderEntry): CLIConfig | undefined {
  if (entry.api !== undefined && entry.api !== 'openai-chat') return undefined;

  const defaultModel = entry.models?.[0];
  return {
    provider: entry.name,
    displayName: entry.display_name ?? `${entry.name} (native)`,
    command: process.env.SQUADS_ENGINE_BIN ?? 'squads-engine',
    install: 'build squads-engine and link its bin (npm link in the engine repo), or point SQUADS_ENGINE_BIN at dist/cli/bin.js',
    nativeEvents: true,
    buildArgs: (prompt, opts) => {
      // Honour a model override only when it belongs to this provider — same
      // leak guard as the claude-harness lanes (#937).
      const requested = opts?.model?.replace(new RegExp(`^${entry.name}/`), '');
      const model = requested && entry.models?.includes(requested) ? requested : defaultModel;
      return [
        '-p', prompt,
        '--provider', entry.name,
        ...(entry.base_url ? ['--base-url', entry.base_url] : []),
        ...(model ? ['--model', model] : []),
        '--json', '--quiet',
        ...nativeAllowRules(opts?.allowedTools).flatMap(r => ['--allow', r]),
      ];
    },
    parseUsage: parseNativeJsonUsage,
    env: () => nativeEnv(entry),
  };
}

/**
 * Get CLI config for a provider — built-in first, then the user registry.
 */
export function getCLIConfig(provider: string): CLIConfig | undefined {
  const name = normalizeProviderName(provider);
  return LLM_CLIS[name] ?? configFromRegistry(name);
}

/**
 * Check if a provider's CLI is available
 */
export function isProviderCLIAvailable(provider: string): boolean {
  const config = getCLIConfig(provider);
  if (!config) return false;
  return commandExists(config.command);
}
