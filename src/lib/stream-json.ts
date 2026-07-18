/**
 * stream-json parser — turns the JSONL event stream emitted by
 * `claude --print --output-format stream-json --verbose` into (a) the agent's
 * text response and (b) real usage/cost numbers.
 *
 * The stream is one JSON object per line:
 *   {"type":"system","subtype":"init",...}                                 — session init
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}} — 1+ chunks
 *   {"type":"result","subtype":"success","result":"…",
 *     "total_cost_usd":0.12,"usage":{input_tokens,output_tokens,
 *     cache_read_input_tokens,cache_creation_input_tokens},
 *     "num_turns":3,"is_error":false}                                      — final
 *
 * NOTE: stream-json REQUIRES the `--verbose` flag on the claude invocation to
 * emit events. That is separate from our user-facing `config.verbose`, which
 * only controls whether we DISPLAY the assistant text live.
 *
 * No external dependencies. Pure functions so the parser is unit-testable
 * against a fixture of JSONL events (see test/stream-json-parser.test.ts).
 */

/** Canonical usage/cost captured from the terminal `result` event. */
export interface StreamUsage {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  num_turns: number;
  /**
   * Model id seen on the stream (assistant/result events). Carried so callers
   * can derive cost from tokens × pricing when cost_usd is 0 (cut-off runs).
   * Empty string when unknown.
   */
  model?: string;
}

export function emptyUsage(): StreamUsage {
  return {
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    num_turns: 0,
    model: '',
  };
}

/** Add two usage records (used to total a multi-agent conversation). */
export function addUsage(a: StreamUsage, b: StreamUsage): StreamUsage {
  return {
    cost_usd: a.cost_usd + b.cost_usd,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    num_turns: a.num_turns + b.num_turns,
    // Keep the first known model id (agents in one run share a model).
    model: a.model || b.model || '',
  };
}

/**
 * What an agent actually DID during a run. Two kinds, kept honest separately:
 *
 *  - `actions` / `files_edited` count tool_use INVOCATIONS — the agent called
 *    a tool. These are activity proxies, legitimately counted at call time.
 *  - `commits` / `prs_created` / `issues_created` count VERIFIED artifacts —
 *    a real commit SHA / PR URL / issue URL in the paired tool_result. A Bash
 *    command that merely mentions `gh pr create` (a grep, an echo, a commit
 *    message documenting the pattern) or a `gh pr create` that FAILED creates
 *    nothing, so it contributes 0. This is the cli#1134 fix — counting the
 *    command text fabricated PRs that were never created (the board's "PRs
 *    created" tile is the sum of these). Mirrors squads-api#207 / PR #220.
 */
export interface RunOutcomes {
  actions: number;        // total tool_use calls — activity proxy (0 ≈ noise)
  files_edited: number;   // Edit / Write / NotebookEdit calls
  commits: number;        // `git commit` calls whose result echoed `[<branch> <sha>]`
  prs_created: number;    // `gh pr create` calls whose result carried a verified /pull/N URL
  issues_created: number; // `gh issue create` calls whose result carried a verified /issues/N URL
}

export function emptyOutcomes(): RunOutcomes {
  return { actions: 0, files_edited: 0, commits: 0, prs_created: 0, issues_created: 0 };
}

export function addOutcomes(a: RunOutcomes, b: RunOutcomes): RunOutcomes {
  return {
    actions: a.actions + b.actions,
    files_edited: a.files_edited + b.files_edited,
    commits: a.commits + b.commits,
    prs_created: a.prs_created + b.prs_created,
    issues_created: a.issues_created + b.issues_created,
  };
}

/** What a single parsed line yields, if anything actionable. */
export interface ParsedLine {
  /** Assistant text emitted by this line (to stream live + accumulate). */
  text?: string;
  /** Outcomes from this event's `tool_use` blocks (accumulated across the run). */
  outcomes?: RunOutcomes;
  /**
   * Per-message usage from an `assistant` event (`message.usage`). Accumulated
   * across the stream so a cut-off run (no terminal `result` event) still has
   * real token counts. `cost_usd`/`num_turns` are not present on assistant
   * events, so this carries only token fields + the model id.
   */
  assistantUsage?: StreamUsage;
  /** Set on the terminal `result` event. */
  result?: {
    /** Canonical full response text. */
    text: string;
    usage: StreamUsage;
    isError: boolean;
  };
  /**
   * tool_use ids for Agent/Task blocks on this `assistant` event — subagent
   * spawns to track for open-background-subagent detection (#1130).
   */
  subagentToolUseIds?: string[];
  /**
   * Bash tool_use blocks whose command marks them as PR/issue/commit
   * candidates (cli#1134) — pending until their paired tool_result resolves.
   */
  bashCandidates?: BashCandidate[];
  /** tool_result blocks on a `user` event, with their result text + error flag. */
  toolResults?: ToolResultInfo[];
}

export interface AssistantContentBlock {
  type?: string;
  text?: string;
  id?: string;                       // tool_use id (correlates to a later tool_result)
  name?: string;                     // tool name on `tool_use` blocks
  input?: Record<string, unknown>;   // tool input (e.g. Bash `command`)
}

/** A `tool_result` block from a `user` event, correlated back to its tool_use id. */
export interface ToolResultBlock {
  type?: string;
  tool_use_id?: string;
  /** True when the tool call errored (gh/git failed) — an error created nothing. */
  is_error?: boolean;
  /** Result body: a plain string, or a list of content blocks (Claude Code shape). */
  content?: unknown;
}

/** True for the built-in subagent-spawning tool, under either name Claude Code has used. */
function isSubagentTool(name: string | undefined): boolean {
  const lower = (name || '').toLowerCase();
  return lower === 'agent' || lower === 'task';
}

// ── cli#1134: result-derived outcome helpers ──────────────────────────
//
// Command-text regexes only flag a Bash tool_use as a CANDIDATE; the count
// comes from the paired tool_result. A mention (grep/echo), a commit message
// that documents the pattern, or a failed invocation all have no verified
// URL/SHA in the result and so contribute 0. Mirrors squads-api#207 / PR #220.

/** Bash command looks like a PR creation (whitespace-separated, like `gh pr create`). */
const PR_CREATE_RE = /\bgh\s+pr\s+create\b/;
/** Bash command looks like an issue creation (like `gh issue create`). */
const ISSUE_CREATE_RE = /\bgh\s+issue\s+create\b/;
/** Bash command looks like a git commit (like `git commit`). */
const GIT_COMMIT_RE = /\bgit\s+commit\b/;

/** `gh pr create` prints the PR URL only on success. findall → count every one. */
const PR_URL_RE = /\/pull\/(\d+)\b/g;
/** `gh issue create` prints the issue URL only on success. */
const ISSUE_URL_RE = /\/issues\/(\d+)\b/g;
/** `git commit` echoes `[<branch> <sha>]` on success. */
const COMMIT_SHA_RE = /\[\S+\s+([0-9a-f]{7,40})\]/g;

/** Which verified artifact(s) a Bash candidate might produce. */
export type BashOutcomeKind = 'pr' | 'issue' | 'commit';

/** A Bash tool_use whose command text marks it as a creation candidate. */
export interface BashCandidate {
  id: string;
  kinds: BashOutcomeKind[];
}

/** A resolved tool_result with the fields the outcome resolver needs. */
export interface ToolResultInfo {
  toolUseId: string;
  isError: boolean;
  text: string;
}

/** Verified PR numbers in a result body (each `/pull/N` URL = one PR created). */
export function extractPrNumbers(text: string): number[] {
  return [...text.matchAll(PR_URL_RE)].map((m) => parseInt(m[1], 10));
}

/** Verified issue numbers in a result body. */
export function extractIssueNumbers(text: string): number[] {
  return [...text.matchAll(ISSUE_URL_RE)].map((m) => parseInt(m[1], 10));
}

/** Verified commit SHAs in a result body (each `[branch sha]` line = one commit). */
export function extractCommitShas(text: string): string[] {
  return [...text.matchAll(COMMIT_SHA_RE)].map((m) => m[1]);
}

/**
 * Normalize a tool_result's `content` (plain string, or a list of content
 * blocks) into one text blob to pattern-match against. Mirrors the api's
 * `_tool_result_text`.
 */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
          return String((block as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

/** Count INVOCATIONS from a message's `tool_use` blocks (actions + files_edited only). */
export function parseOutcomes(blocks: AssistantContentBlock[]): RunOutcomes {
  const o = emptyOutcomes();
  for (const b of blocks) {
    if (!b || b.type !== 'tool_use') continue;
    o.actions += 1;
    const name = (b.name || '').toLowerCase();
    if (name === 'edit' || name === 'write' || name === 'notebookedit') o.files_edited += 1;
    // commits / prs_created / issues_created are NOT counted here — see
    // parseBashCandidates + resolveBashOutcome (cli#1134): they come from the
    // paired tool_result, never the command text.
  }
  return o;
}

/**
 * Bash tool_use blocks whose command marks them as a PR/issue/commit CANDIDATE
 * (cli#1134). Candidates are pending until their paired tool_result arrives —
 * only a verified URL/SHA in that result increments the count. Returns the
 * tool_use id + which kinds the command suggests, so the caller can correlate.
 */
export function parseBashCandidates(blocks: AssistantContentBlock[]): BashCandidate[] {
  const out: BashCandidate[] = [];
  for (const b of blocks) {
    if (!b || b.type !== 'tool_use' || !b.id) continue;
    const name = (b.name || '').toLowerCase();
    if (name !== 'bash') continue;
    const cmd = String((b.input as { command?: unknown } | undefined)?.command ?? '');
    const kinds: BashOutcomeKind[] = [];
    if (PR_CREATE_RE.test(cmd)) kinds.push('pr');
    if (ISSUE_CREATE_RE.test(cmd)) kinds.push('issue');
    if (GIT_COMMIT_RE.test(cmd)) kinds.push('commit');
    if (kinds.length > 0) out.push({ id: b.id, kinds });
  }
  return out;
}

/** Extract `{toolUseId, isError, text}` from a `user` event's tool_result blocks. */
export function parseToolResultBlocks(blocks: unknown): ToolResultInfo[] {
  if (!Array.isArray(blocks)) return [];
  const out: ToolResultInfo[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const block = b as ToolResultBlock;
    if (block.type !== 'tool_result') continue;
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
    if (!id) continue;
    out.push({
      toolUseId: id,
      isError: block.is_error === true,
      text: toolResultText(block.content),
    });
  }
  return out;
}

/**
 * Given a verified (non-error) tool_result body and the candidate's kinds,
 * return the incremental outcome counts (cli#1134). A result with no URL/SHA
 * (a grep mention, an echo, a failed create with no URL) contributes 0.
 */
export function resolveBashOutcome(
  text: string,
  kinds: BashOutcomeKind[],
): Pick<RunOutcomes, 'commits' | 'prs_created' | 'issues_created'> {
  const inc = { commits: 0, prs_created: 0, issues_created: 0 };
  if (kinds.includes('pr')) inc.prs_created += extractPrNumbers(text).length;
  if (kinds.includes('issue')) inc.issues_created += extractIssueNumbers(text).length;
  if (kinds.includes('commit')) inc.commits += extractCommitShas(text).length;
  return inc;
}

/** Tokens + model from a single `assistant` event's `message.usage`. */
function parseAssistantUsage(message: Record<string, unknown> | undefined): StreamUsage | undefined {
  if (!message) return undefined;
  const u = (message.usage as Record<string, number>) || {};
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  // No usage numbers on this event → nothing to accumulate.
  if (!input && !output && !cacheRead && !cacheWrite) return undefined;
  return {
    cost_usd: 0, // assistant events don't carry cost — derived later from tokens
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    num_turns: 0,
    model: typeof message.model === 'string' ? message.model : '',
  };
}

/**
 * Parse a single JSONL line from the stream. Returns the assistant text + per-
 * message usage on `assistant` events, and the canonical result (text + usage)
 * on the `result` event. Malformed / non-JSON / uninteresting lines return an
 * empty object.
 */
export function parseStreamJsonLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return {};

  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return {}; // not JSON (e.g. a stray warning line) — ignore
  }

  if (ev.type === 'assistant') {
    const message = ev.message as ({ content?: AssistantContentBlock[] } & Record<string, unknown>) | undefined;
    const out: ParsedLine = {};
    const blocks = message?.content;
    if (Array.isArray(blocks)) {
      const text = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('');
      if (text) out.text = text;
      const outcomes = parseOutcomes(blocks);
      if (outcomes.actions > 0) out.outcomes = outcomes;
      // cli#1134: flag Bash create candidates here; their counts resolve when
      // the paired tool_result lands on the next `user` event.
      const bashCandidates = parseBashCandidates(blocks);
      if (bashCandidates.length > 0) out.bashCandidates = bashCandidates;
      const subagentIds = blocks
        .filter((b) => b && b.type === 'tool_use' && typeof b.id === 'string' && isSubagentTool(b.name))
        .map((b) => b.id as string);
      if (subagentIds.length > 0) out.subagentToolUseIds = subagentIds;
    }
    const assistantUsage = parseAssistantUsage(message);
    if (assistantUsage) out.assistantUsage = assistantUsage;
    return out;
  }

  if (ev.type === 'user') {
    // Tool results arrive on `user` events, carrying the tool_use_id they
    // answer plus the result body. The ids let us tell "spawned a subagent
    // and got its result back" from "spawned one and moved on without it"
    // (#1130); the result body is what turns a Bash create candidate into a
    // verified PR/issue/commit count (cli#1134).
    const message = ev.message as ({ content?: unknown } & Record<string, unknown>) | undefined;
    const toolResults = parseToolResultBlocks(message?.content);
    if (toolResults.length > 0) return { toolResults };
    return {};
  }

  if (ev.type === 'result') {
    const u = (ev.usage as Record<string, number>) || {};
    return {
      result: {
        text: typeof ev.result === 'string' ? ev.result : '',
        isError: ev.is_error === true,
        usage: {
          cost_usd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : 0,
          input_tokens: u.input_tokens || 0,
          output_tokens: u.output_tokens || 0,
          cache_read_tokens: u.cache_read_input_tokens || 0,
          cache_write_tokens: u.cache_creation_input_tokens || 0,
          num_turns: typeof ev.num_turns === 'number' ? ev.num_turns : 0,
          model: typeof ev.model === 'string' ? ev.model : '',
        },
      },
    };
  }

  return {};
}

/** Final outcome of consuming a complete stream. */
export interface StreamResult {
  /** Canonical response text: the `result` event's text, or accumulated assistant text as fallback. */
  text: string;
  usage: StreamUsage;
  /** True when the terminal result event reported `is_error: true`. */
  isError: boolean;
  /** True when a terminal `result` event was actually seen. */
  sawResult: boolean;
  /** What the agent did: tool actions / commits / PRs / issues / file edits. */
  outcomes: RunOutcomes;
  /**
   * Agent/Task subagent spawns whose `tool_use` never got a matching
   * `tool_result` before the stream ended (#1130). A synchronous subagent
   * call can't let the parent turn finish without first returning its
   * result, so a nonzero count here is structural evidence the run ended
   * its turn on a subagent it launched in the background and never awaited.
   */
  openBackgroundSubagents: number;
}

/**
 * Stateful, line-buffered accumulator over the JSONL stream. Feed it raw stdout
 * chunks (already decoded to strings); it tracks assistant text, invokes the
 * optional `onText` sink for live display, and captures the terminal result.
 *
 * Call `flush()` once the process closes to drain any partial trailing line.
 */
export class StreamJsonAccumulator {
  private buf = '';
  private assistantText = '';
  private usage: StreamUsage = emptyUsage();
  /**
   * Running token sum across `assistant` events. Used as the cut-off fallback:
   * if the run is killed (timeout / turn limit) before the terminal `result`
   * event, this still holds real per-message token counts so observability gets
   * non-zero usage. Each assistant event reports the cumulative tokens for that
   * turn; we sum them across the stream (matches the existing session-file
   * parser in observability.ts, which sums message.usage the same way).
   */
  private assistantUsage: StreamUsage = emptyUsage();
  private resultText: string | null = null;
  private isError = false;
  private sawResult = false;
  /** Running sum of what the agent did across the whole stream. */
  private outcomes: RunOutcomes = emptyOutcomes();
  /** tool_use ids of Agent/Task spawns awaiting a `tool_result` (#1130). */
  private pendingSubagents = new Set<string>();
  /**
   * Bash create candidates awaiting their paired tool_result (cli#1134). The
   * count is deferred: a candidate only increments once its result arrives
   * with a verified URL/SHA and no error flag.
   */
  private pendingBash = new Map<string, BashOutcomeKind[]>();

  /**
   * @param onText optional sink for live display of assistant text chunks.
   * @param onRawLine optional tee of every complete raw JSONL line — used to
   *   feed a ProviderEventAdapter (exec-events.ts, #902) without a second
   *   line-buffering layer. Called before the line is parsed here.
   */
  constructor(
    private readonly onText?: (text: string) => void,
    private readonly onRawLine?: (raw: string) => void,
  ) {}

  /** Feed a decoded stdout chunk; processes all complete lines within it. */
  push(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    for (const line of lines) this.consume(line);
  }

  /** Drain the final partial line (call on process close). */
  flush(): void {
    if (this.buf) {
      this.consume(this.buf);
      this.buf = '';
    }
  }

  private consume(line: string): void {
    this.onRawLine?.(line);
    const parsed = parseStreamJsonLine(line);
    if (parsed.text) {
      this.assistantText += this.assistantText ? '\n' + parsed.text : parsed.text;
      this.onText?.(parsed.text);
    }
    if (parsed.assistantUsage) {
      this.assistantUsage = addUsage(this.assistantUsage, parsed.assistantUsage);
    }
    if (parsed.outcomes) {
      this.outcomes = addOutcomes(this.outcomes, parsed.outcomes);
    }
    if (parsed.bashCandidates) {
      // cli#1134: register candidates pending their tool_result. Merge kinds if
      // the same id is somehow seen twice (defensive — ids are unique per run).
      for (const c of parsed.bashCandidates) {
        const existing = this.pendingBash.get(c.id);
        if (existing) {
          for (const k of c.kinds) if (!existing.includes(k)) existing.push(k);
        } else {
          this.pendingBash.set(c.id, [...c.kinds]);
        }
      }
    }
    if (parsed.subagentToolUseIds) {
      for (const id of parsed.subagentToolUseIds) this.pendingSubagents.add(id);
    }
    if (parsed.toolResults) {
      for (const r of parsed.toolResults) {
        // #1130: a result resolves a pending subagent spawn.
        this.pendingSubagents.delete(r.toolUseId);
        // cli#1134: a result resolves a pending Bash create candidate — count
        // only verified artifacts from a non-error result.
        const kinds = this.pendingBash.get(r.toolUseId);
        if (kinds && !r.isError) {
          const inc = resolveBashOutcome(r.text, kinds);
          this.outcomes.commits += inc.commits;
          this.outcomes.prs_created += inc.prs_created;
          this.outcomes.issues_created += inc.issues_created;
        }
        this.pendingBash.delete(r.toolUseId);
      }
    }
    if (parsed.result) {
      this.sawResult = true;
      this.resultText = parsed.result.text;
      this.isError = parsed.result.isError;
      this.usage = parsed.result.usage;
    }
  }

  /** The canonical result after the stream is fully consumed. */
  getResult(): StreamResult {
    // Prefer the result event's text (canonical full response); fall back to
    // accumulated assistant chunks when no result text was emitted.
    const text = this.resultText && this.resultText.length > 0
      ? this.resultText
      : this.assistantText;
    // Usage: the terminal `result` event is canonical (a single aggregate over
    // the whole run, incl. cost). When it's absent (cut off mid-response), fall
    // back to the summed assistant-event tokens so the record still carries real
    // quota numbers — cost_usd may be 0 here (assistant events don't report it),
    // which is fine: the caller derives cost from tokens × pricing.
    const usage = this.sawResult ? this.usage : this.assistantUsage;
    return {
      text, usage, isError: this.isError, sawResult: this.sawResult, outcomes: this.outcomes,
      openBackgroundSubagents: this.pendingSubagents.size,
    };
  }
}

/**
 * One-shot helper: parse a complete JSONL string. Convenience for tests and
 * non-streaming callers.
 */
export function parseStreamJson(jsonl: string, onText?: (t: string) => void): StreamResult {
  const acc = new StreamJsonAccumulator(onText);
  acc.push(jsonl);
  acc.flush();
  return acc.getResult();
}
