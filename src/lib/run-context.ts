/**
 * run-context.ts
 *
 * Squad Context System — context assembly for agent execution.
 *
 * Layers flow from general to particular (no overrides, each answers a different question):
 *   L0:  SYSTEM.md             — How    (system, tools, principles — immutable, outside budget)
 *   L1:  company.md            — Why    (company identity, alignment)
 *   L2:  priorities.md         — Where  (current focus, urgency)
 *   L3:  goals.md              — What   (measurable targets)
 *   L4:  agent.md              — You    (agent role, specific instructions)
 *   L5:  state.md              — Memory (continuity from last run)
 *   L6+: Supporting            — feedback, daily-briefing, cross-squad learnings
 *   L9:  founder-context.md    — Live strategic state (universal, all squads see)
 *   L10: founder-alignment.md  — Per-squad contribution to founder's current pipeline
 *
 * L9 + L10 are auto-generated (e.g. by hq/.claude/hooks/founder-context-digest.py) from
 * interactive sessions, git activity, and open PRs/issues. They translate the
 * founder's live strategic context into per-squad, named contributions so each
 * squad shows up aligned with current priorities rather than inventing generic work.
 *
 * Business-specific structural reference (Drive folder map, ERP architecture,
 * canonical sheet schemas) can be embedded inline into founder-context.md by
 * the digest script. The CLI loader stays generic; users decide what to embed.
 *
 * SQUAD.md is metadata only (repo, agents, config) — NOT injected into prompt.
 * Each layer adds a unique dimension. No layer contradicts another.
 * Role determines which layers are included and the total token budget.
 */

import { join, dirname } from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { findSquadsDir } from './squad-parser.js';
import { findMemoryDir } from './memory.js';
import { colors, RESET, writeLine } from './terminal.js';

// ── Types ────────────────────────────────────────────────────────────

export type ContextRole = 'scanner' | 'worker' | 'lead' | 'coo' | 'verifier';

// ── Token Budgets (chars, ~4 chars/token) ────────────────────────────

export const ROLE_BUDGETS: Record<ContextRole, number> = {
  scanner: 50000,  // ~12500 tokens — full founder ctx (incl. embedded Drive structure) + identity layers
  worker: 60000,   // ~15000 tokens — + feedback + alignment
  lead: 80000,     // ~20000 tokens — all layers + founder ctx + alignment
  coo: 100000,     // ~25000 tokens — all layers + expanded + founder ctx
  verifier: 60000, // similar needs to worker
};

/**
 * Which layers each role gets access to.
 * Numbers correspond to layer order in the Squad Context System:
 *   1=company, 2=priorities, 3=goals, 4=agent, 5=state, 6=feedback,
 *   7=daily-briefing, 8=cross-squad, 9=founder-context, 10=founder-alignment
 *
 * Layers 9 and 10 are visible to ALL roles (including scanners): live strategic
 * context is always relevant, regardless of role. Without it, agents invent
 * generic work disconnected from the founder's current pipeline.
 */
export const ROLE_SECTIONS: Record<ContextRole, Set<number>> = {
  scanner:  new Set([1, 2, 3, 4, 5,             9, 10]),   // identity + focus + role + memory + founder ctx
  worker:   new Set([1, 2, 3, 4, 5, 6,          9, 10]),   // + feedback + founder ctx
  lead:     new Set([1, 2, 3, 4, 5, 6, 7, 8,    9, 10]),   // all layers + founder ctx
  coo:      new Set([1, 2, 3, 4, 5, 6, 7, 8,    9, 10]),   // all layers + founder ctx + expanded budget
  verifier: new Set([1, 2, 3, 4, 5, 6,          9, 10]),   // same as worker + founder ctx
};

// ── Agent Frontmatter ─────────────────────────────────────────────────

/**
 * Parsed fields from an agent definition's YAML frontmatter.
 */
export interface AgentFrontmatter {
  context_from?: string[];
  acceptance_criteria?: string;
  max_retries?: number;
  cooldown?: string;
  model?: string;
  /**
   * `role:` field from agent YAML frontmatter (free text).
   * Used as the primary signal for context-role selection.
   */
  agent_role?: string;
}

/**
 * Parse frontmatter fields from an agent definition file.
 * Handles non-standard format where frontmatter appears after a heading.
 */
export function parseAgentFrontmatter(agentPath: string): AgentFrontmatter {
  if (!agentPath || !existsSync(agentPath)) return {};

  let content: string;
  try {
    content = readFileSync(agentPath, 'utf-8');
  } catch {
    return {};
  }
  if (!content) return {};
  const lines = content.split('\n');
  let inFrontmatter = false;
  const yamlLines: string[] = [];

  for (const line of lines) {
    if (line.trim() === '---') {
      if (inFrontmatter) break;
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      yamlLines.push(line);
    }
  }

  if (yamlLines.length === 0) return {};

  const yaml = yamlLines.join('\n');
  const result: AgentFrontmatter = {};

  // context_from: [operations, finance, product, growth]
  const contextMatch = yaml.match(/context_from:\s*\[([^\]]+)\]/);
  if (contextMatch) {
    result.context_from = contextMatch[1].split(',').map(s => s.trim());
  }

  // acceptance_criteria: |\n  - criteria1\n  - criteria2
  const criteriaMatch = yaml.match(/acceptance_criteria:\s*\|\n((?:\s+.+\n?)*)/);
  if (criteriaMatch) {
    result.acceptance_criteria = criteriaMatch[1].replace(/^ {2}/gm, '').trim();
  }

  // max_retries: 2
  const retriesMatch = yaml.match(/max_retries:\s*(\d+)/);
  if (retriesMatch) {
    result.max_retries = parseInt(retriesMatch[1], 10);
  }

  // cooldown: "30m" or "6h" or "2 hours"
  const cooldownMatch = yaml.match(/cooldown:\s*["']?([^"'\n]+)["']?/);
  if (cooldownMatch) {
    result.cooldown = cooldownMatch[1].trim();
  }

  // role: <free-text>
  // Primary signal for mapping to context role (scanner/worker/lead/verifier).
  for (const line of yamlLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('role:')) continue;
    let value = trimmed.slice('role:'.length).trim();
    // Strip wrapping quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1).trim();
    }
    if (value) {
      result.agent_role = value;
    }
    break;
  }

  return result;
}

// ── MCP Server Discovery ──────────────────────────────────────────────

/**
 * Extract MCP servers mentioned in an agent definition.
 * Looks for patterns like: mcp-server-name, chrome-devtools, firecrawl, etc.
 */
export function extractMcpServersFromDefinition(definition: string): string[] {
  const servers: Set<string> = new Set();

  // Common MCP server patterns
  const knownServers = [
    'chrome-devtools',
    'firecrawl',
    'context7',
    'huggingface',
  ];

  // Check for known servers in the definition
  for (const server of knownServers) {
    if (definition.toLowerCase().includes(server)) {
      servers.add(server);
    }
  }

  // Look for mcp: blocks in YAML
  const mcpMatch = definition.match(/mcp:\s*\n((?:\s*-\s*\S+\s*\n?)+)/i);
  if (mcpMatch) {
    const lines = mcpMatch[1].split('\n');
    for (const line of lines) {
      const serverMatch = line.match(/^\s*-\s*(\S+)/);
      if (serverMatch) {
        servers.add(serverMatch[1]);
      }
    }
  }

  return Array.from(servers);
}

// ── Shared Config File Reader ─────────────────────────────────────────

/**
 * Read a config file relative to the .agents directory.
 * Returns file content trimmed, or empty string if missing/unreadable.
 */
function readAgentsFile(relativePath: string, warnLabel: string): string {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return '';

  const filePath = join(dirname(squadsDir), relativePath);
  if (!existsSync(filePath)) return '';

  try {
    return readFileSync(filePath, 'utf-8').trim();
  } catch (e) {
    writeLine(`  ${colors.dim}warn: failed reading ${warnLabel}: ${e instanceof Error ? e.message : String(e)}${RESET}`);
    return '';
  }
}

// ── System Protocol ───────────────────────────────────────────────────

/**
 * Load SYSTEM.md (L0) — the immutable base protocol for all agents.
 * Path: .agents/SYSTEM.md (top-level, next to squads/ and memory/)
 * Falls back to legacy config/SYSTEM.md, then approval-instructions.md.
 */
export function loadSystemProtocol(): string {
  // Primary: .agents/SYSTEM.md
  const systemMd = readAgentsFile('SYSTEM.md', 'SYSTEM.md');
  if (systemMd) return systemMd;

  // Fallback: legacy path
  const legacyMd = readAgentsFile('config/SYSTEM.md', 'SYSTEM.md (legacy)');
  if (legacyMd) return legacyMd;

  return loadApprovalInstructions();
}

/**
 * Load company.md (L1) — company context and strategic direction.
 * Path: .agents/company.md
 * This is the "why" layer — frames everything that follows.
 */
export function loadCompanyContext(): string {
  // Primary: .agents/company.md
  const companyMd = readAgentsFile('company.md', 'company.md');
  if (companyMd) return companyMd;

  // Fallback: legacy directives.md (for backward compat during migration)
  const memoryDir = findMemoryDir();
  if (memoryDir) {
    const directivesFile = join(memoryDir, 'company', 'directives.md');
    const content = safeRead(directivesFile);
    if (content) return content;
  }

  return '';
}

/**
 * Legacy: load approval instructions. Kept for backward compat — prefer SYSTEM.md.
 * @deprecated Absorbed into SYSTEM.md. Used as fallback when SYSTEM.md absent.
 */
export function loadApprovalInstructions(): string {
  return readAgentsFile('config/approval-instructions.md', 'approval instructions');
}

/**
 * Legacy: load post-execution instructions.
 * @deprecated Absorbed into SYSTEM.md. Used as fallback when SYSTEM.md absent.
 */
export function loadPostExecution(squadName: string, agentName: string): string {
  const template = readAgentsFile('config/post-execution.md', 'post-execution template');
  if (template) {
    return template
      .replace(/\{\{squadName\}\}/g, squadName)
      .replace(/\{\{agentName\}\}/g, agentName);
  }
  return '';
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Safely read a file, returning empty string on failure */
function safeRead(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8').trim() : '';
  } catch {
    return '';
  }
}

function stripYamlFrontmatter(markdown: string): string {
  const lines = markdown.split('\n');
  let dashCount = 0;
  let endIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      dashCount++;
      if (dashCount === 2) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx >= 0) return lines.slice(endIdx + 1).join('\n').trim();
  return markdown.trim();
}

function scoreByTokens(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (!t) continue;
    if (lower.includes(t)) score += 1;
  }
  return score;
}

/**
 * Primary context-role resolver.
 *
 * Uses the agent YAML frontmatter `role:` free-text as the signal.
 * Only when ambiguous and enabled (env var) will it ask an LLM to pick
 * one of: scanner | worker | lead | verifier.
 */
export function resolveContextRoleFromAgent(agentPath: string, agentName: string): ContextRole {
  const fm = parseAgentFrontmatter(agentPath);
  const roleText = fm.agent_role || '';
  const normalized = roleText.trim().toLowerCase();

  // Direct match — new structured schema uses exact role values
  const directRoles: ContextRole[] = ['scanner', 'worker', 'lead', 'verifier'];
  for (const r of directRoles) {
    if (normalized === r) return r;
  }
  // COO is a lead with expanded budget
  if (normalized === 'coo' || normalized === 'company-lead') return 'coo';

  // Deterministic mapping from role text. Avoids brittle regex coupling.
  const scannerTokens = ['scan', 'monitor', 'detect', 'find', 'opportun', 'scout', 'gap', 'bottleneck'];
  const workerTokens = ['execute', 'implement', 'write', 'create', 'build', 'prototype', 'file', 'issue', 'worker'];
  const leadTokens = ['lead', 'orchestrate', 'own', 'strategy', 'roadmap', 'coordinate', 'triage', 'review', 'mvp'];
  const verifierTokens = ['verify', 'validation', 'compliance', 'audit', 'approve', 'reject', 'check', 'test', 'critic', 'verifier'];

  const scored: Array<[ContextRole, number]> = [
    ['scanner', scoreByTokens(normalized, scannerTokens)],
    ['worker', scoreByTokens(normalized, workerTokens)],
    ['lead', scoreByTokens(normalized, leadTokens)],
    ['verifier', scoreByTokens(normalized, verifierTokens)],
  ];

  scored.sort((a, b) => b[1] - a[1]);
  const best = scored[0];
  const second = scored[1];

  // Clean mapping => unique non-zero best score.
  const clean = best[1] > 0 && (!second || second[1] === 0);
  if (clean) return best[0];

  const llmEnabled = process.env.SQUADS_CONTEXT_ROLE_LLM === '1';
  if (!llmEnabled) return 'worker';

  // LLM fallback: best-effort classification. If it fails, return worker.
  try {
    const raw = safeRead(agentPath);
    const body = stripYamlFrontmatter(raw);
    const excerpt = body.slice(0, 1600);

    const prompt = [
      'Classify the agent into exactly ONE Agents Squads context role.',
      'Return EXACTLY one token from: scanner, worker, lead, verifier.',
      '',
      `Agent name: ${agentName}`,
      `Agent frontmatter role: ${roleText || '(missing)'}`,
      '',
      'Agent definition excerpt:',
      excerpt,
    ].join('\n');

    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const model = process.env.SQUADS_CONTEXT_ROLE_LLM_MODEL || 'claude-haiku-4-5';
    const out = execSync(
      `claude --print --dangerously-skip-permissions --disable-slash-commands --model ${model} -- '${escapedPrompt}'`,
      { encoding: 'utf-8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }
    ).trim().toLowerCase();

    const tokens: ContextRole[] = ['scanner', 'worker', 'lead', 'verifier'];
    for (const t of tokens) {
      if (out === t || out.includes(t)) return t;
    }

    return 'worker';
  } catch {
    return 'worker';
  }
}


// ── Squad Context System Assembly ─────────────────────────────────────

/**
 * Gather context for agent execution.
 *
 * Layers flow general → particular (each adds a unique dimension):
 *    1. company.md             — Why    (company identity, alignment)
 *    2. priorities.md          — Where  (current focus, urgency)
 *    3. goals.md               — What   (measurable targets)
 *    4. agent.md               — You    (agent role, instructions)
 *    5. state.md               — Memory (continuity from last run)
 *    6. feedback.md            — Supporting (squad feedback)
 *    7. daily-briefing         — Supporting (org pulse, leads+coo only)
 *    8. cross-squad            — Supporting (learnings from other squads)
 *    9. founder-context.md     — Live strategic state (universal, all roles)
 *   10. founder-alignment.md   — Per-squad contribution to current pipeline
 *
 * Layers 9 and 10 are injected FIRST in the prompt (LLMs pay most attention
 * to the beginning of context) so squads align with the founder's live
 * pipeline before processing any other layer. Both are auto-generated
 * (e.g. by hq/.claude/hooks/founder-context-digest.py) which can also
 * embed business-specific structural reference (Drive map, ERP architecture)
 * directly into founder-context.md when relevant.
 *
 * SQUAD.md is NOT injected — it's metadata for the CLI (repo, agents, config).
 * Missing files are skipped gracefully — no crashes on first run or new squads.
 */
export function gatherSquadContext(
  squadName: string,
  agentName: string,
  options: { verbose?: boolean; maxTokens?: number; agentPath?: string; role?: ContextRole } = {}
): string {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return '';

  const memoryDir = findMemoryDir();
  const role = options.role || 'worker';
  const budget = options.maxTokens ? options.maxTokens * 4 : (ROLE_BUDGETS[role] ?? ROLE_BUDGETS.worker);
  const allowedSections = ROLE_SECTIONS[role] ?? ROLE_SECTIONS.worker;
  const sections: string[] = [];
  let usedChars = 0;

  /** Try to add a layer. Returns true if added (possibly truncated), false if no budget left. */
  function addLayer(layerNum: number, header: string, content: string, maxChars?: number): boolean {
    if (!allowedSections.has(layerNum)) return false;
    if (!content) return false;

    const TRUNCATION_SUFFIX = '\n...';
    const remaining = Math.max(0, budget - usedChars);
    if (remaining <= TRUNCATION_SUFFIX.length) {
      // No room left for even a meaningful truncation
      if (options.verbose) {
        writeLine(`  ${colors.dim}Context budget exhausted at layer ${layerNum} (${header})${RESET}`);
      }
      return false;
    }

    const cap = maxChars !== undefined ? Math.min(maxChars, remaining) : remaining;
    let text = content;
    if (text.length > cap) {
      // Reserve TRUNCATION_SUFFIX bytes for the suffix so total fits exactly within cap
      text = text.substring(0, cap - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
      if (options.verbose) {
        writeLine(`  ${colors.dim}Layer ${layerNum} truncated to ${text.length}/${content.length} chars${RESET}`);
      }
    }

    sections.push(`## ${header}\n${text}`);
    usedChars += text.length;
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Context injection order: ACTION-FIRST, REFERENCE-LAST
  //
  // LLMs pay most attention to the beginning and end of context.
  // Put what the agent should ACT ON first (feedback, goals, state).
  // Put reference material last (company, agent definition).
  // ═══════════════════════════════════════════════════════════════════

  // ── L9: founder-context.md — Live strategic state (ACT-ALIGNED) ──
  // Injected FIRST so agents see the founder's current pipeline before
  // any squad-internal context. Auto-generated from interactive sessions,
  // git activity, and open PRs/issues. Universal — all squads see this.
  if (memoryDir) {
    const founderContextFile = join(memoryDir, 'company', 'founder-context.md');
    const content = safeRead(founderContextFile);
    if (content) {
      addLayer(9, 'Founder Context (live strategic state — read first)', content);
    }
  }

  // ── L10: founder-alignment.md — How THIS squad contributes this cycle ──
  // Per-squad translation of founder context into named, domain-specific
  // contributions. Auto-generated alongside L9. Specific to this squadName.
  if (memoryDir) {
    const alignmentFile = join(memoryDir, squadName, 'founder-alignment.md');
    const content = safeRead(alignmentFile);
    if (content) {
      addLayer(10, `Founder Alignment — ${squadName} (your contribution this cycle)`, content);
    }
  }

  // ── L6: feedback.md — ACT ON THIS (corrections from last cycle) ──
  // Injected after founder context so corrections shape interpretation
  // of the strategic state.
  if (memoryDir) {
    const feedbackFile = join(memoryDir, squadName, 'feedback.md');
    const content = safeRead(feedbackFile);
    if (content) {
      addLayer(6, 'Feedback (act on this first)', content);
    }
  }

  // ── L3: goals.md — What to achieve this cycle ──
  if (memoryDir) {
    const goalsFile = join(memoryDir, squadName, 'goals.md');
    const content = safeRead(goalsFile);
    if (content) {
      addLayer(3, 'Goals', stripYamlFrontmatter(content));
    }
  }

  // ── L5: state.md — Where we left off ──
  if (memoryDir) {
    const stateFile = join(memoryDir, squadName, agentName, 'state.md');
    const content = safeRead(stateFile);
    if (content) {
      const body = stripYamlFrontmatter(content);
      const stateCap = (role === 'scanner' || role === 'verifier') ? 2000 : undefined;
      // Add staleness caveat (#721) so agents know if their memory is outdated
      let staleNote = '';
      try {
        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        const mtime = statSync(stateFile).mtimeMs;
        const daysAgo = Math.floor((Date.now() - mtime) / MS_PER_DAY);
        if (daysAgo > 0) staleNote = `*(Last updated ${daysAgo} day${daysAgo > 1 ? 's' : ''} ago — verify before relying on this)*\n\n`;
      } catch { /* */ }
      addLayer(5, 'Previous State', staleNote + body, stateCap);
    }
  }

  // ── L2: priorities.md — Where to focus ──
  if (memoryDir) {
    const prioritiesFile = join(memoryDir, squadName, 'priorities.md');
    const content = safeRead(prioritiesFile);
    if (content) {
      addLayer(2, 'Priorities', stripYamlFrontmatter(content));
    }
  }

  // ── L4: agent.md — Your role and instructions ──
  if (options.agentPath) {
    const agentContent = safeRead(options.agentPath);
    if (agentContent) {
      const body = stripYamlFrontmatter(agentContent);
      addLayer(4, `Agent: ${agentName}`, body);
    }
  }

  // ── L1: company.md — Who we are (reference) ──
  const companyContext = loadCompanyContext();
  if (companyContext) {
    addLayer(1, 'Company', stripYamlFrontmatter(companyContext));
  }

  // ── L7: Daily briefing — Org pulse (leads+coo only, reference) ──
  if (memoryDir) {
    const dailyFile = join(memoryDir, 'daily-briefing.md');
    const content = safeRead(dailyFile);
    if (content) {
      addLayer(7, 'Daily Briefing', content);
    }
  }

  // ── L8: Cross-squad learnings (leads+coo only, reference) ──
  if (memoryDir) {
    const frontmatter = options.agentPath ? parseAgentFrontmatter(options.agentPath) : {};
    const contextSquads = frontmatter.context_from || [];
    const learningParts: string[] = [];
    for (const ctx of contextSquads) {
      const learningsFile = join(memoryDir, ctx, 'shared', 'learnings.md');
      const content = safeRead(learningsFile);
      if (content) {
        learningParts.push(`### ${ctx}\n${content}`);
      } else if (options.verbose) {
        writeLine(`  ${colors.dim}context_from: no learnings found for squad '${ctx}'${RESET}`);
      }
    }
    if (learningParts.length > 0) {
      addLayer(8, 'Cross-Squad Learnings', learningParts.join('\n\n'));
    }
  }

  if (sections.length === 0) return '';

  if (options.verbose) {
    writeLine(`  ${colors.dim}Context: ${sections.length} layers, ~${Math.ceil(usedChars / 4)} tokens (${role} role, budget: ~${Math.ceil(budget / 4)})${RESET}`);
  }

  return `\n# CONTEXT\n${sections.join('\n\n')}\n`;
}
