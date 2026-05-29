/**
 * Agent Contract — the typed, git-versioned definition of what one agent may do.
 *
 * P0 of the "Chief = governed Claude-with-the-CLI" plan (hq spec
 * chief-cli-runtime-2026-05-29.md, tracker hq#418, squads-cli#777). This is the
 * LookML-for-agent-operations artifact: it *formalizes* what SQUAD.md + agent
 * frontmatter + the 7-layer run-context already imply, and adds the governance
 * fields that are missing today (tool grants with sensitivity, autonomy, the
 * human-in-the-loop gate, write/credential scope, resource ceilings) with a
 * hard `default: deny`.
 *
 * P0 is SCHEMA + DERIVATION + VALIDATION ONLY — it changes no runtime behavior.
 * Enforcement (compiling `tool_grants` into the Agent SDK permission callback,
 * removing `--dangerously-skip-permissions`) is P1; the OS sandbox is P2.
 *
 * `tool_grants` use the Claude Code `--allowedTools` vocabulary (tool names +
 * `Bash(<cmd>:*)` prefixes + `mcp__<server>__<tool>`) precisely so a contract is
 * *enforceable* by that allowlist in P1 — a grant the runtime can't express is
 * rejected at validation time (no unenforceable documentation).
 */

import matter from 'gray-matter';
import { existsSync, readFileSync } from 'fs';
import {
  ROLE_BUDGETS,
  ROLE_SECTIONS,
  resolveContextRoleFromAgent,
  type ContextRole,
} from './run-context.js';

export type ToolSensitivity = 'read' | 'write' | 'consequential';
export type Autonomy = 'suggest' | 'execute_with_gate' | 'autonomous';
export type HitlGate = 'none' | 'consequential' | 'required';

export interface ToolGrant {
  /** Claude Code allowed-tool token, e.g. "Read", "Bash(git:*)", "mcp__erp__list_overdue". */
  tool: string;
  sensitivity: ToolSensitivity;
}

export interface AgentContract {
  schema_version: 1;
  /** Tenant key — "local" for now. Present from commit one so hosting is a toggle, not a rewrite. */
  workspace_id: string;
  agent: string;
  squad: string;
  role: ContextRole;
  /** Derived from role (run-context layers + budget) + the agent's cross-squad `context_from`. */
  scoped_context: { layers: number[]; token_budget: number; context_from: string[] };
  tool_grants: ToolGrant[];
  /** Anything not granted is denied. Always "deny" — present to make the posture explicit. */
  default: 'deny';
  /** Path/branch globs the agent may write. Required if it holds any write/consequential grant. */
  write_scope: string[];
  /** Secret/token names that may be injected for this agent. Default none. */
  credential_scope: string[];
  autonomy: Autonomy;
  /** When a consequential action requires dispatch-boundary human approval (P3). */
  hitl_gate: HitlGate;
  resource_ceiling: {
    per_run_usd?: number;
    daily_usd?: number;
    monthly_usd?: number;
    max_runtime_s?: number;
    max_turns?: number;
  };
  /** Post-hoc quality scoring only — NOT a safety gate. */
  evaluator?: string;
  source: { agent_file: string; squad_file: string };
}

// ── Tool-grant vocabulary (what the Claude Code allowlist can enforce) ───────
const TOOL_NAME =
  /^(Read|Write|Edit|MultiEdit|Grep|Glob|Bash|Agent|Task|WebFetch|WebSearch|TodoWrite|NotebookEdit)$/;
const BASH_SCOPED = /^Bash\([A-Za-z0-9_./-]+(:\*)?\)$/; // Bash(git:*) | Bash(ls)
const MCP_TOOL = /^mcp__[a-z0-9_]+__([a-z0-9_]+|\*)$/;

export function isEnforceableTool(tool: string): boolean {
  return TOOL_NAME.test(tool) || BASH_SCOPED.test(tool) || MCP_TOOL.test(tool);
}

// ── Role-based default grants ────────────────────────────────────────────────
// So every existing agent derives a *valid, conservative* contract without
// hand-editing 100+ files. Frontmatter may override (broaden/narrow) later.
const g = (tool: string, sensitivity: ToolSensitivity): ToolGrant => ({ tool, sensitivity });

const READ_ONLY: ToolGrant[] = [
  g('Read', 'read'),
  g('Grep', 'read'),
  g('Glob', 'read'),
  g('WebFetch', 'read'),
  g('WebSearch', 'read'),
];
const WORKER_GRANTS: ToolGrant[] = [
  ...READ_ONLY,
  g('Write', 'write'),
  g('Edit', 'write'),
  g('Bash(git:*)', 'write'),
  g('Bash(gh:*)', 'consequential'),
];
const LEAD_GRANTS: ToolGrant[] = [
  ...WORKER_GRANTS,
  g('Agent', 'consequential'),
  g('Bash(squads:*)', 'consequential'), // can dispatch squad runs
];

const ROLE_GRANTS: Record<ContextRole, ToolGrant[]> = {
  scanner: READ_ONLY,
  verifier: READ_ONLY,
  worker: WORKER_GRANTS,
  lead: LEAD_GRANTS,
  coo: LEAD_GRANTS,
};

/** Raw contract-relevant frontmatter (parsed by gray-matter; all optional). */
export interface ContractFrontmatter {
  context_from?: string[];
  max_context_tokens?: number;
  timeout?: number; // seconds
  budget?: { per_run?: number; daily?: number; monthly?: number };
  max_turns?: number;
  evaluator?: string;
  workspace_id?: string;
  // explicit governance overrides (config-as-code)
  tool_grants?: ToolGrant[];
  autonomy?: Autonomy;
  hitl_gate?: HitlGate;
  write_scope?: string[];
  credential_scope?: string[];
}

const DEFAULT_MAX_RUNTIME_S = 900; // no unbounded runs
// Conservative per-run cost ceiling by role when an agent declares no budget,
// so every agent has a bound (no unbounded spend). Explicit `budget:` overrides.
const ROLE_PER_RUN_USD: Record<ContextRole, number> = {
  scanner: 0.5, verifier: 1, worker: 2, lead: 4, coo: 8,
};

/**
 * Derive an agent's contract from its role + frontmatter, applying role defaults
 * for anything the frontmatter doesn't declare. Pure — no IO — so it's directly
 * unit-testable.
 */
export function deriveContract(input: {
  agent: string;
  squad: string;
  role: ContextRole;
  frontmatter: ContractFrontmatter;
  agentFile: string;
  squadFile: string;
}): AgentContract {
  const { agent, squad, role, frontmatter: fm } = input;
  const grants = fm.tool_grants ?? ROLE_GRANTS[role];
  const hasWriteOrWorse = grants.some((t) => t.sensitivity !== 'read');

  return {
    schema_version: 1,
    workspace_id: fm.workspace_id ?? 'local',
    agent,
    squad,
    role,
    scoped_context: {
      layers: [...ROLE_SECTIONS[role]].sort((a, b) => a - b),
      token_budget: fm.max_context_tokens ?? ROLE_BUDGETS[role],
      context_from: fm.context_from ?? [],
    },
    tool_grants: grants,
    default: 'deny',
    // Default writers to their own squad's memory; explicit override for code agents.
    write_scope: fm.write_scope ?? (hasWriteOrWorse ? [`.agents/memory/${squad}/**`] : []),
    credential_scope: fm.credential_scope ?? [],
    autonomy: fm.autonomy ?? 'suggest',
    // Default: any consequential action is gated unless explicitly relaxed.
    hitl_gate: fm.hitl_gate ?? 'consequential',
    resource_ceiling: {
      per_run_usd: fm.budget?.per_run ?? ROLE_PER_RUN_USD[role],
      daily_usd: fm.budget?.daily,
      monthly_usd: fm.budget?.monthly,
      max_runtime_s: fm.timeout ?? DEFAULT_MAX_RUNTIME_S,
      max_turns: fm.max_turns,
    },
    evaluator: fm.evaluator,
    source: { agent_file: input.agentFile, squad_file: input.squadFile },
  };
}

export interface ContractViolation {
  field: string;
  message: string;
}

const KNOWN_SECRETS = new Set([
  'ANTHROPIC_API_KEY', 'SLACK_BOT_TOKEN', 'GH_TOKEN', 'MERCADOPUBLICO_API_KEY',
  'STRIPE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'DATABASE_URL',
]);

/**
 * Validate a contract. Returns the (possibly empty) list of violations; the CI
 * gate fails the build if any contract has violations.
 */
export function validateContract(c: AgentContract): ContractViolation[] {
  const v: ContractViolation[] = [];
  const fail = (field: string, message: string) => v.push({ field, message });

  if (c.default !== 'deny') fail('default', 'must be "deny" (deny-by-omission posture)');
  if (!c.workspace_id) fail('workspace_id', 'required (tenant key; "local" if single-tenant)');

  const validRoles: ContextRole[] = ['scanner', 'worker', 'lead', 'coo', 'verifier'];
  if (!validRoles.includes(c.role)) fail('role', `unknown role "${c.role}"`);

  if (c.tool_grants.length === 0) fail('tool_grants', 'empty — an agent with no grants cannot act');
  for (const t of c.tool_grants) {
    if (!isEnforceableTool(t.tool)) {
      fail('tool_grants', `"${t.tool}" is not expressible in the allowedTools vocabulary (tool name | Bash(cmd:*) | mcp__server__tool) — unenforceable`);
    }
  }

  const writers = c.tool_grants.filter((t) => t.sensitivity !== 'read');
  if (writers.length > 0 && c.write_scope.length === 0) {
    fail('write_scope', `has ${writers.length} write/consequential grant(s) but no write_scope (unjailed write)`);
  }

  const consequential = c.tool_grants.filter((t) => t.sensitivity === 'consequential');
  if (consequential.length > 0 && c.hitl_gate === 'none') {
    fail('hitl_gate', `has consequential grant(s) (${consequential.map((t) => t.tool).join(', ')}) but hitl_gate is "none"`);
  }

  if (!c.resource_ceiling.max_runtime_s) {
    fail('resource_ceiling.max_runtime_s', 'required — no unbounded runs');
  }
  if (c.resource_ceiling.per_run_usd == null && c.resource_ceiling.daily_usd == null) {
    fail('resource_ceiling', 'needs a cost ceiling (per_run_usd or daily_usd)');
  }

  for (const s of c.credential_scope) {
    if (!KNOWN_SECRETS.has(s)) fail('credential_scope', `unknown secret "${s}"`);
  }

  if (c.autonomy === 'autonomous' && c.hitl_gate !== 'none') {
    // autonomous + a gate is contradictory; flag so it's an explicit choice.
    fail('autonomy', 'autonomy="autonomous" with a hitl_gate is contradictory — pick one');
  }

  return v;
}

/** IO seam: build a contract from an on-disk agent file (+ its squad). */
export function contractFromAgentFile(
  agentFile: string,
  squad: string,
  agentName: string,
  squadFile: string,
): AgentContract {
  let fm: ContractFrontmatter = {};
  let role: ContextRole = 'worker';
  if (existsSync(agentFile)) {
    try {
      fm = (matter(readFileSync(agentFile, 'utf-8')).data ?? {}) as ContractFrontmatter;
    } catch {
      fm = {};
    }
    role = resolveContextRoleFromAgent(agentFile, agentName);
  }
  return deriveContract({ agent: agentName, squad, role, frontmatter: fm, agentFile, squadFile });
}
