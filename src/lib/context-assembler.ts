/**
 * context-assembler.ts — Context manifest assembly (#1049).
 *
 * Produces a deterministic ContextManifest by walking the L0–L6 layer
 * taxonomy from context-policy.ts. This is the "read-only" assembly view
 * used by `squads context --for <run|tick|session> [--json]`.
 *
 * Three design properties:
 *   1. FIXED cache-stable ordering — layers always emit in L0→L6 order,
 *      never in assembly-time insertion order.
 *   2. Required-layers fail loud — L0 (SYSTEM.md) and L1 (Company) throw
 *      when missing; the caller captures these as `failedRequired`.
 *   3. Archive-blind path resolver — every path goes through
 *      `resolveLayerPath()` which works with live files or archived content
 *      (the chokepoint is one function).
 *
 * Determinism guarantee: same inputs + same policy hash → identical manifest.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { dirname } from 'path';
import {
  loadContextPolicy,
  policyHash,
  resolveLayerPath,
  resolveSupportingPath,
  type ContextPolicy,
  type ContextLayerDef,
} from './context-policy.js';
import { findSquadsDir } from './squad-parser.js';
import { findMemoryDir } from './memory.js';
import { parseAgentFrontmatter } from './run-context.js';

// ── Types ──────────────────────────────────────────────────────────────

export type ManifestScope = 'run' | 'tick' | 'session';
export type ContextRole = 'scanner' | 'worker' | 'lead' | 'coo' | 'verifier';

/** Detailed layer entry in the manifest. */
export interface LayerManifest {
  id: number;
  key: string;
  name: string;
  description: string;
  /** Resolved absolute path, or null if the layer has no backing file. */
  path: string | null;
  /** Chars read from the file (0 if unresolved or evicted). */
  chars: number;
  /** Estimated tokens from chars (chars / 4). */
  tokensEst: number;
  /** True when the layer had content but the budget refused it entirely. */
  evicted: boolean;
  /** True when at least one candidate path resolved to a readable file. */
  resolved: boolean;
  /** True when this layer is required and no file was found. */
  failed: boolean;
  /** True when the file was last modified before the decay threshold. */
  stale: boolean;
  /** Days since last modification when stale; 0 when fresh or unresolvable. */
  stalenessDays: number;
  /** True when this layer's chars don't count toward the budget. */
  outsideBudget: boolean;
  /** Required by policy — manifests MUST include L0 and L1. */
  required: boolean;
  /** Sub-entries for the rollup layer (L6 supporting). */
  supportingSources?: SupportingSource[];
}

/** Sub-entry within the L6 supporting rollup. */
export interface SupportingSource {
  key: string;
  path: string;
  chars: number;
  tokensEst: number;
  stale: boolean;
  stalenessDays: number;
}

/** Full context manifest — the output of `squads context --for <type>`. */
export interface ContextManifest {
  format: 'context-manifest-v1';
  scope: ManifestScope;
  policyHash: string;
  squad: string;
  agent: string;
  role: ContextRole;
  budget: { chars: number; tokensEst: number };
  layers: LayerManifest[];
  totals: { chars: number; tokensEst: number; outsideBudgetChars: number };
  failedRequired: string[];
}

// ── Assembly ───────────────────────────────────────────────────────────

const TRUNCATION_SUFFIX = '\n...';

/**
 * Assemble a read-only context manifest for the given scope/squad/agent.
 *
 * Unlike `gatherSquadContext()`, this function does NOT build a prompt —
 * it produces a structured manifest of what WOULD be assembled, with
 * per-layer details for inspection.
 */
export function assembleContextManifest(
  squadName: string,
  agentName: string,
  scope: ManifestScope,
  role: ContextRole = 'worker',
  options?: { agentPath?: string },
): ContextManifest {
  const policy = loadContextPolicy();
  const hash = policyHash(policy);
  const squadsDir = findSquadsDir();
  const agentRoot = squadsDir ? dirname(squadsDir) : process.cwd();
  const memoryDir = findMemoryDir();
  const rolePolicy = policy.roles[role] ?? policy.roles.worker;
  const budget = rolePolicy.budgetChars;
  const allowedLayerIds = new Set(rolePolicy.layers);

  // Resolve L0–L6 in FIXED cache-stable order
  const layerDefs = [...policy.layers].sort((a, b) => a.id - b.id);
  const layers: LayerManifest[] = [];
  const failedRequired: string[] = [];
  let usedChars = 0;
  let outsideBudgetChars = 0;

  for (const def of layerDefs) {
    if (!allowedLayerIds.has(def.id)) {
      // Layer not in this role's allowed set — skip without recording.
      // (The role definition is the inclusion gate, not per-layer eligibility.)
      continue;
    }

    const includeResult = includeLayer(def, squadName, agentName, agentRoot, memoryDir, budget, usedChars, options?.agentPath);
    const included = includeResult ?? emptyLayerResult(def);
    layers.push(included.manifest);
    usedChars += included.manifest.outsideBudget ? 0 : included.manifest.chars;
    if (included.manifest.outsideBudget) {
      outsideBudgetChars += included.manifest.chars;
    }

    if (included.manifest.failed) {
      failedRequired.push(def.key);
    }
  }

  const totalTokensEst = Math.ceil(usedChars / 4);

  return {
    format: 'context-manifest-v1',
    scope,
    policyHash: hash,
    squad: squadName,
    agent: agentName,
    role,
    budget: { chars: budget, tokensEst: Math.ceil(budget / 4) },
    layers,
    totals: { chars: usedChars, tokensEst: totalTokensEst, outsideBudgetChars },
    failedRequired,
  };
}

// ── Per-layer inclusion logic ──────────────────────────────────────────

interface LayerResult {
  manifest: LayerManifest;
}

function emptyLayerResult(def: ContextLayerDef): LayerResult {
  return {
    manifest: {
      id: def.id,
      key: def.key,
      name: def.name,
      description: def.description,
      path: null,
      chars: 0,
      tokensEst: 0,
      evicted: false,
      resolved: false,
      failed: false,
      stale: false,
      stalenessDays: 0,
      outsideBudget: def.outsideBudget,
      required: def.required,
    },
  };
}

function includeLayer(
  def: ContextLayerDef,
  squadName: string,
  agentName: string,
  agentRoot: string,
  memoryDir: string | null,
  budget: number,
  usedChars: number,
  agentPath?: string,
): LayerResult | null {
  // ── L6 supporting layer — special: rollup of multiple sources ──
  if (def.id === 6) {
    return includeSupportingLayer(def, squadName, agentName, agentRoot, memoryDir, budget, usedChars, agentPath);
  }

  // Standard layer: resolve path, read content, measure.
  const absPath = resolveLayerPath(def.paths, agentRoot, squadName, agentName);
  if (!absPath) {
    return {
      manifest: {
        ...emptyLayerResult(def).manifest,
        failed: def.required,
      },
    };
  }

  if (!existsSync(absPath)) {
    return {
      manifest: {
        ...emptyLayerResult(def).manifest,
        failed: def.required,
      },
    };
  }

  let content: string;
  try {
    content = readFileSync(absPath, 'utf-8').trim();
  } catch {
    return {
      manifest: {
        ...emptyLayerResult(def).manifest,
        failed: def.required,
      },
    };
  }

  if (!content) {
    return {
      manifest: {
        ...emptyLayerResult(def).manifest,
        path: absPath,
        resolved: true,
        failed: def.required,
      },
    };
  }

  // Budget check — can we fit this layer?
  const { stale, stalenessDays } = computeStaleness(absPath, def.decayDays);
  let chars = content.length;
  let evicted = false;

  if (!def.outsideBudget) {
    const remaining = Math.max(0, budget - usedChars);
    if (remaining <= TRUNCATION_SUFFIX.length) {
      // Budget has no room — record eviction.
      evicted = true;
      chars = 0;
    } else if (chars > remaining) {
      chars = Math.min(chars, remaining);
    }
  }

  return {
    manifest: {
      id: def.id,
      key: def.key,
      name: def.name,
      description: def.description,
      path: absPath,
      chars,
      tokensEst: Math.ceil(chars / 4),
      evicted,
      resolved: true,
      failed: false,
      stale,
      stalenessDays,
      outsideBudget: def.outsideBudget,
      required: def.required,
    },
  };
}

/**
 * L6 supporting layer: assemble a deterministic rollup of daily-briefing.md
 * and cross-squad learnings. Each source is measured independently; the
 * layer's total is the sum, and sub-entries appear in `supportingSources`.
 */
function includeSupportingLayer(
  def: ContextLayerDef,
  squadName: string,
  agentName: string,
  agentRoot: string,
  memoryDir: string | null,
  budget: number,
  usedChars: number,
  agentPath?: string,
): LayerResult {
  const sources: SupportingSource[] = [];

  // 1. Daily briefing — resolve via standard layer path patterns
  //    (pattern: 'memory/daily-briefing.md' from the layer def).
  const briefingPath = resolveLayerPath(def.paths.filter(p => !p.includes('{ctx}')), agentRoot, squadName, agentName);
  if (briefingPath) {
    sources.push(readSupportingSource('daily-briefing', briefingPath, def.decayDays));
  }

  // 2. Cross-squad learnings (deterministic: sorted by squad key)
  if (memoryDir && agentPath) {
    const fm = parseAgentFrontmatter(agentPath);
    const contextSquads = fm.context_from || [];
    const sortedSquads = [...contextSquads].sort();
    for (const ctx of sortedSquads) {
      const learningsPath = resolveSupportingPath(`memory/${ctx}/shared/learnings.md`, agentRoot, ctx);
      if (learningsPath) {
        sources.push(readSupportingSource(`learnings:${ctx}`, learningsPath, def.decayDays));
      }
    }
  }

  const totalChars = sources.reduce((s, src) => s + src.chars, 0);
  const totalTokens = sources.reduce((s, src) => s + src.tokensEst, 0);

  // Budget check
  const remaining = Math.max(0, budget - usedChars);
  const evicted = !def.outsideBudget && remaining <= TRUNCATION_SUFFIX.length;

  return {
    manifest: {
      id: def.id,
      key: def.key,
      name: def.name,
      description: def.description,
      path: memoryDir ?? null,
      chars: evicted ? 0 : totalChars,
      tokensEst: evicted ? 0 : totalTokens,
      evicted,
      resolved: sources.length > 0,
      failed: false,
      stale: sources.some(s => s.stale),
      stalenessDays: Math.max(...sources.map(s => s.stalenessDays), 0),
      outsideBudget: def.outsideBudget,
      required: def.required,
      supportingSources: sources,
    },
  };
}

function readSupportingSource(key: string, path: string, decayDays: number): SupportingSource {
  let content = '';
  try {
    content = readFileSync(path, 'utf-8').trim();
  } catch {
    // fall through with empty content
  }
  const chars = content.length;
  const { stale, stalenessDays } = computeStaleness(path, decayDays);
  return { key, path, chars, tokensEst: Math.ceil(chars / 4), stale, stalenessDays };
}

// ── Staleness computation ──────────────────────────────────────────────

function computeStaleness(filePath: string, decayDays: number): { stale: boolean; stalenessDays: number } {
  if (decayDays <= 0) return { stale: false, stalenessDays: 0 };
  try {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const mtime = statSync(filePath).mtimeMs;
    const daysAgo = Math.floor((Date.now() - mtime) / MS_PER_DAY);
    return { stale: daysAgo > decayDays, stalenessDays: daysAgo };
  } catch {
    return { stale: false, stalenessDays: 0 };
  }
}

// ── Reporting ──────────────────────────────────────────────────────────

/**
 * Format the manifest as a human-readable terminal string.
 */
export function renderContextManifest(manifest: ContextManifest): string {
  const lines: string[] = [];
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

  lines.push('');
  lines.push(`  Context manifest — ${manifest.squad}/${manifest.agent}`);
  lines.push(dim(`  scope: ${manifest.scope} · role: ${manifest.role} · policy: ${manifest.policyHash}`));
  lines.push('');

  for (const layer of manifest.layers) {
    const layerLabel = `L${layer.id} ${layer.name}`;
    const status = layer.evicted ? '\x1b[33mEVICTED\x1b[0m' :
                   layer.failed ? '\x1b[31mMISSING\x1b[0m' :
                   layer.resolved ? '\x1b[32mOK\x1b[0m' : '\x1b[2mskip\x1b[0m';

    lines.push(`  ${layerLabel.padEnd(28)} ${status}`);

    if (layer.path) {
      lines.push(dim(`    path: ${layer.path}`));
    }

    if (layer.failed && layer.required) {
      lines.push(`    \x1b[31mFAIL LOUD\x1b[0m — required layer "${layer.key}" has no readable source`);
    }

    if (layer.stale) {
      lines.push(dim(`    stale: ${layer.stalenessDays} days since last update`));
    }

    if (layer.evicted) {
      lines.push(dim(`    chars: EVICTED (budget)`));
    } else if (layer.outsideBudget) {
      lines.push(dim(`    chars: ${layer.chars} (outside budget)`));
    } else if (layer.chars > 0) {
      lines.push(dim(`    chars: ${layer.chars} · ~${layer.tokensEst} tok`));
    }

    if (layer.supportingSources && layer.supportingSources.length > 0) {
      for (const src of layer.supportingSources) {
        const staleMark = src.stale ? ' \x1b[33m(stale)\x1b[0m' : '';
        lines.push(dim(`    ∟ ${src.key}: ${src.chars} chars @ ${src.path}${staleMark}`));
      }
    }
  }

  lines.push('');
  const budgetStr = manifest.totals.outsideBudgetChars > 0
    ? `${manifest.totals.chars} chars (+${manifest.totals.outsideBudgetChars} outside budget)`
    : `${manifest.totals.chars} chars`;
  lines.push(`  Totals: ${budgetStr} · ~${manifest.totals.tokensEst} tok`);
  lines.push(dim(`  Budget: ${manifest.budget.chars} chars (~${manifest.budget.tokensEst} tok)`));

  if (manifest.failedRequired.length > 0) {
    lines.push('');
    lines.push(`  \x1b[31mRequired layers failed: ${manifest.failedRequired.join(', ')}\x1b[0m`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Format the manifest as JSON object for --json mode.
 * Strips terminal color codes from descriptions.
 */
export function formatManifestJson(manifest: ContextManifest): string {
  return JSON.stringify({
    format: manifest.format,
    scope: manifest.scope,
    policy_hash: manifest.policyHash,
    squad: manifest.squad,
    agent: manifest.agent,
    role: manifest.role,
    budget: manifest.budget,
    layers: manifest.layers.map(l => ({
      id: l.id,
      key: l.key,
      name: l.name,
      description: l.description,
      path: l.path,
      chars: l.chars,
      tokens_est: l.tokensEst,
      evicted: l.evicted,
      resolved: l.resolved,
      failed: l.failed,
      stale: l.stale,
      staleness_days: l.stalenessDays,
      outside_budget: l.outsideBudget,
      required: l.required,
      supporting_sources: l.supportingSources?.map(s => ({
        key: s.key,
        path: s.path,
        chars: s.chars,
        tokens_est: s.tokensEst,
        stale: s.stale,
        staleness_days: s.stalenessDays,
      })) ?? [],
    })),
    totals: manifest.totals,
    failed_required: manifest.failedRequired,
  }, null, 2);
}
