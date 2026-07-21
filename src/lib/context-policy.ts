/**
 * context-policy.ts — Context assembly policy loader (#1049).
 *
 * Externalises ROLE_BUDGETS / ROLE_SECTIONS into `.agents/context-policy.yml`
 * with built-in defaults. The policy file is optional — when absent the
 * compiled defaults apply.
 *
 * Three responsibilities:
 *   1. Define the L0–L6 seven-layer taxonomy with path patterns, required-ness,
 *      decay intervals, and budget-exclusion flags.
 *   2. Define per-role layer inclusion sets and character budgets.
 *   3. Produce a content-hash of the resolved policy for determinism
 *      verification (same inputs + same policy hash → identical manifest).
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { findSquadsDir } from './squad-parser.js';

/**
 * Minimal YAML loader for context-policy.yml.
 *
 * js-yaml (already a transitive dep via gray-matter) has no TS declarations.
 * Rather than add @types/js-yaml or a `.d.ts` shim, we parse the simple
 * structured YAML that context-policy.yml uses inline — it's a small,
 * well-defined schema with no arbitrary nesting.
 */
function loadSimpleYaml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = raw.split('\n');
  const stack: Array<{ key: string; obj: Record<string, unknown>; indent: number }> = [];
  let current: Record<string, unknown> = result;
  let currentIndent = 0;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const indent = line.length - trimmed.length;
    const match = trimmed.match(/^(\w[\w-]*):\s*(.*)/);
    if (!match) continue;

    const key = match[1];
    const value = match[2].trim();

    // Adjust indent-based nesting
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      const frame = stack.pop()!;
      current = frame.obj;
      currentIndent = frame.indent;
    }

    if (value === '' || value === '|') {
      // Object or block scalar start
      if (value === '|') {
        // Block scalar — collect following indented lines
        const blockLines: string[] = [];
        let i = lines.indexOf(line) + 1;
        while (i < lines.length) {
          const bl = lines[i];
          if (bl.trimEnd() === '' || bl.startsWith('#')) { i++; continue; }
          const bi = bl.length - bl.trimEnd().length;
          if (bi <= indent) break;
          blockLines.push(bl.trim());
          i++;
        }
        setNested(result, key, blockLines.join('\n'));
      } else {
        const newObj: Record<string, unknown> = {};
        setNested(result, key, newObj);
        stack.push({ key, obj: current, indent: currentIndent });
        current = newObj;
        currentIndent = indent;
      }
    } else {
      // Scalar value
      setNested(result, key, parseYamlValue(value));
    }
  }

  return result;
}

function setNested(obj: Record<string, unknown>, key: string, value: unknown): void {
  obj[key] = value;
}

function parseYamlValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;
  // Number
  const num = Number(raw);
  if (!isNaN(num) && raw !== '' && raw !== 'true' && raw !== 'false') return num;
  // Array: [item1, item2]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map(s => parseYamlValue(s.trim())).filter(v => v !== null);
  }
  // String — strip quotes
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

// ── Types ──────────────────────────────────────────────────────────────

/** One layer in the L0–L6 taxonomy. */
export interface ContextLayerDef {
  id: number;
  key: string;
  name: string;
  description: string;
  /** One or more candidate paths relative to the .agents root; first found wins. */
  paths: string[];
  /**
   * When true, assembly FAILS LOUD if none of `paths` resolve to a readable file.
   * L0 (SYSTEM.md) and L1 (Company strategy) are required.
   */
  required: boolean;
  /** When true, the layer's characters do not count toward the role budget. */
  outsideBudget: boolean;
  /**
   * Days after which a staleness note is appended to the layer content.
   * 0 = never stale. Applied to memory layers the agent acts on.
   */
  decayDays: number;
}

/** Per-role policy: which layers and what character budget. */
export interface RolePolicy {
  /** Layer IDs (0–6) this role receives. */
  layers: number[];
  /** Character budget cap for this role. ~4 chars/token. */
  budgetChars: number;
}

/** The full context-assembly policy, loaded from file or defaults. */
export interface ContextPolicy {
  version: string;
  roles: Record<string, RolePolicy>;
  layers: ContextLayerDef[];
}

// ── Built-in Defaults (L0–L6 Taxonomy) ─────────────────────────────────

const DEFAULT_LAYERS: ContextLayerDef[] = [
  {
    id: 0,
    key: 'system',
    name: 'SYSTEM.md',
    description: 'System protocol (immutable base)',
    paths: ['SYSTEM.md', 'config/SYSTEM.md', 'config/approval-instructions.md'],
    required: true,
    outsideBudget: true,
    decayDays: 0,
  },
  {
    id: 1,
    key: 'company',
    name: 'Company',
    description: 'Company strategy and direction',
    paths: ['memory/company/strategy.md', 'company.md', 'memory/company/directives.md'],
    required: true,
    outsideBudget: false,
    decayDays: 14,
  },
  {
    id: 2,
    key: 'goals',
    name: 'Goals',
    description: 'Measurable targets',
    paths: ['memory/{squad}/goals.md'],
    required: true,
    outsideBudget: false,
    decayDays: 14,
  },
  {
    id: 3,
    key: 'agent',
    name: 'Agent',
    description: 'Agent role and instructions',
    paths: ['squads/{squad}/{agent}.md'],
    required: false,
    outsideBudget: false,
    decayDays: 0,
  },
  {
    id: 4,
    key: 'state',
    name: 'State',
    description: 'Continuity from last run',
    paths: ['memory/{squad}/{agent}/state.md'],
    required: false,
    outsideBudget: false,
    decayDays: 7,
  },
  {
    id: 5,
    key: 'feedback',
    name: 'Feedback',
    description: 'Corrections from last cycle',
    paths: ['memory/{squad}/feedback.md'],
    required: false,
    outsideBudget: false,
    decayDays: 30,
  },
  {
    id: 6,
    key: 'supporting',
    name: 'Supporting',
    description: 'Briefing, cross-squad learnings (deterministic rollup)',
    paths: ['memory/daily-briefing.md', 'memory/{ctx}/shared/learnings.md'],
    required: false,
    outsideBudget: false,
    decayDays: 1,
  },
];

/**
 * Default per-role layer sets and budgets.
 *
 * L0–L4: identity layers (everyone gets the "who / why / what / you / memory" base).
 * L5:    feedback (workers, leads, verifiers act on it; scanners are detection-only).
 * L6:    supporting material (leads/coo only — they coordinate cross-squad).
 */
const DEFAULT_ROLES: Record<string, RolePolicy> = {
  scanner:  { layers: [0, 1, 2, 3, 4], budgetChars: 50000 },
  worker:   { layers: [0, 1, 2, 3, 4, 5], budgetChars: 60000 },
  lead:     { layers: [0, 1, 2, 3, 4, 5, 6], budgetChars: 80000 },
  coo:      { layers: [0, 1, 2, 3, 4, 5, 6], budgetChars: 100000 },
  verifier: { layers: [0, 1, 2, 3, 4, 5], budgetChars: 60000 },
};

const POLICY_VERSION = '1.0';

// ── Policy Loading ─────────────────────────────────────────────────────

/**
 * Read .agents/context-policy.yml and merge with defaults.
 *
 * The YAML file is OPTIONAL. When missing, compiled defaults apply.
 * When present, each key overrides the built-in default for that key,
 * but missing keys remain at their default values (deep merge).
 *
 * Returns a fully resolved ContextPolicy.
 */
export function loadContextPolicy(): ContextPolicy {
  const squadsDir = findSquadsDir();
  let filePolicy: Partial<ContextPolicy> = {};

  if (squadsDir) {
    const policyPath = join(dirname(squadsDir), 'context-policy.yml');
    if (existsSync(policyPath)) {
      try {
        const raw = readFileSync(policyPath, 'utf-8');
        const parsed = loadSimpleYaml(raw);
        if (parsed && typeof parsed === 'object') {
          filePolicy = normalizeFilePolicy(parsed as Record<string, unknown>);
        }
      } catch {
        // Malformed file — fall through to defaults silently
      }
    }
  }

  return {
    version: POLICY_VERSION,
    roles: mergeRoles(DEFAULT_ROLES, filePolicy.roles),
    layers: filePolicy.layers ?? DEFAULT_LAYERS,
  };
}

/**
 * Compute a deterministic hash of the resolved policy.
 *
 * Same policy content + same ordering = same hash. Used so consumers can
 * assert "same inputs → same manifest" without diffing the full policy.
 */
export function policyHash(policy: ContextPolicy): string {
  const canonical = JSON.stringify(policy, Object.keys(policy).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ── Helpers ────────────────────────────────────────────────────────────

function normalizeFilePolicy(parsed: Record<string, unknown>): Partial<ContextPolicy> {
  const result: Partial<ContextPolicy> = {};
  if (typeof parsed.version === 'string') result.version = parsed.version;

  if (parsed.roles && typeof parsed.roles === 'object') {
    const roles: Record<string, RolePolicy> = {};
    for (const [key, val] of Object.entries(parsed.roles)) {
      if (val && typeof val === 'object') {
        const r = val as Record<string, unknown>;
        const layers = Array.isArray(r.layers) ? r.layers.map(Number).filter(n => !isNaN(n)) : [];
        const budgetChars = typeof r.budget_chars === 'number' ? r.budget_chars :
                            typeof r.budgetChars === 'number' ? r.budgetChars :
                            DEFAULT_ROLES[key]?.budgetChars ?? 60000;
        roles[key] = { layers, budgetChars };
      }
    }
    if (Object.keys(roles).length > 0) result.roles = roles;
  }

  if (Array.isArray(parsed.layers)) {
    result.layers = parsed.layers
      .filter((l: unknown): l is Record<string, unknown> => l !== null && typeof l === 'object')
      .map((l: Record<string, unknown>) => {
        const id = typeof l.id === 'number' ? l.id : -1;
        const match = DEFAULT_LAYERS.find(d => d.id === id) ?? DEFAULT_LAYERS[0];
        return {
          id,
          key: String(l.key ?? match.key),
          name: String(l.name ?? match.name),
          description: String(l.description ?? match.description),
          paths: Array.isArray(l.paths) ? l.paths.map(String) : match.paths,
          required: typeof l.required === 'boolean' ? l.required : match.required,
          outsideBudget: typeof l.outside_budget === 'boolean' ? l.outside_budget :
                         typeof l.outsideBudget === 'boolean' ? l.outsideBudget : match.outsideBudget,
          decayDays: typeof l.decay_days === 'number' ? l.decay_days :
                     typeof l.decayDays === 'number' ? l.decayDays : match.decayDays,
        };
      });
  }

  return result;
}

function mergeRoles(
  defaults: Record<string, RolePolicy>,
  overrides?: Record<string, RolePolicy>,
): Record<string, RolePolicy> {
  if (!overrides) return { ...defaults };
  const merged: Record<string, RolePolicy> = {};
  const allKeys = new Set([...Object.keys(defaults), ...Object.keys(overrides)]);
  for (const key of allKeys) {
    const def = defaults[key];
    const ovr = overrides[key];
    if (!ovr) {
      if (def) merged[key] = def;
    } else if (!def) {
      merged[key] = ovr;
    } else {
      merged[key] = {
        layers: ovr.layers.length > 0 ? ovr.layers : def.layers,
        budgetChars: ovr.budgetChars > 0 ? ovr.budgetChars : def.budgetChars,
      };
    }
  }
  return merged;
}

/**
 * Resolve a pattern path to an absolute path relative to the .agents root.
 *
 * Patterns may contain template variables:
 *   {squad}  — replaced with the squad name
 *   {agent}  — replaced with the agent name
 *   {ctx}    — a cross-squad context source name (used during iteration)
 *
 * Returns the first existing absolute path, or null if none resolve.
 */
export function resolveLayerPath(
  candidates: string[],
  agentRoot: string,
  squadName: string,
  agentName: string,
): string | null {
  for (const candidate of candidates) {
    const resolved = candidate
      .replace(/\{squad\}/g, squadName)
      .replace(/\{agent\}/g, agentName);
    const absPath = join(agentRoot, resolved);
    if (existsSync(absPath)) return absPath;
  }
  return null;
}

/**
 * Resolve an L6 supporting-content path template.
 * For patterns containing {ctx}, the caller iterates over contextSquads.
 */
export function resolveSupportingPath(
  candidate: string,
  agentRoot: string,
  ctxSquad?: string,
): string | null {
  const resolved = ctxSquad ? candidate.replace(/\{ctx\}/g, ctxSquad) : candidate;
  const absPath = join(agentRoot, resolved);
  return existsSync(absPath) ? absPath : null;
}
