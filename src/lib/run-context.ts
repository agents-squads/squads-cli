/**
 * run-context.ts
 *
 * Helpers for building agent execution context and parsing agent definitions.
 * Extracted from src/commands/run.ts to reduce its size.
 *
 * Context cascade (role-based, priority-ordered):
 *   SYSTEM.md (immutable, outside budget)
 *   1. SQUAD.md — mission + goals + output format
 *   2. priorities.md — current operational priorities
 *   3. directives.md — company-wide strategic overlay
 *   4. feedback.md — last cycle evaluation
 *   5. state.md — agent's memory from last execution
 *   6. active-work.md — open PRs and issues
 *   7. Agent briefs — agent-level briefing files
 *   8. Squad briefs — squad-level briefing files
 *   9. Daily briefing — org-wide daily briefing
 *  10. Cross-squad learnings — shared learnings from other squads
 *
 * Sections load in priority order. When budget is exhausted, later sections drop.
 * Role determines which sections are included and the total token budget.
 */

import { join, dirname } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { findSquadsDir } from './squad-parser.js';
import { findMemoryDir } from './memory.js';
import { colors, RESET, writeLine } from './terminal.js';

// ── Types ────────────────────────────────────────────────────────────

export type ContextRole = 'scanner' | 'worker' | 'lead' | 'coo';

// ── Token Budgets (chars, ~4 chars/token) ────────────────────────────

const ROLE_BUDGETS: Record<ContextRole, number> = {
  scanner: 4000,   // ~1000 tokens — identity + priorities + state
  worker: 12000,   // ~3000 tokens — + directives, feedback, active-work
  lead: 24000,     // ~6000 tokens — all sections
  coo: 32000,      // ~8000 tokens — all sections + expanded
};

/**
 * Which sections each role gets access to.
 * Numbers correspond to section order in the cascade.
 */
const ROLE_SECTIONS: Record<ContextRole, Set<number>> = {
  scanner: new Set([1, 2, 5]),                        // SQUAD.md, priorities, state
  worker:  new Set([1, 2, 3, 4, 5, 6]),               // + directives, feedback, active-work
  lead:    new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),  // all sections
  coo:     new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),  // all sections + expanded budget
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

// ── System Protocol ───────────────────────────────────────────────────

/**
 * Load SYSTEM.md — the single base protocol for all agents.
 * Replaces the old approval-instructions.md + post-execution.md split.
 * Falls back to legacy approval-instructions.md if SYSTEM.md doesn't exist.
 */
export function loadSystemProtocol(): string {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return '';

  const systemPath = join(dirname(squadsDir), 'config', 'SYSTEM.md');
  if (existsSync(systemPath)) {
    try {
      return readFileSync(systemPath, 'utf-8');
    } catch (e) {
      writeLine(`  ${colors.dim}warn: failed reading SYSTEM.md: ${e instanceof Error ? e.message : String(e)}${RESET}`);
    }
  }

  // Fallback to legacy approval-instructions.md
  return loadApprovalInstructions();
}

/**
 * Legacy: load approval instructions. Kept for backward compat — prefer SYSTEM.md.
 */
export function loadApprovalInstructions(): string {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return '';
  const p = join(dirname(squadsDir), 'config', 'approval-instructions.md');
  if (existsSync(p)) {
    try { return readFileSync(p, 'utf-8'); } catch { return ''; }
  }
  return '';
}

/**
 * Legacy: load post-execution instructions. Kept for backward compat — prefer SYSTEM.md.
 */
export function loadPostExecution(squadName: string, agentName: string): string {
  const squadsDir = findSquadsDir();
  if (squadsDir) {
    const p = join(dirname(squadsDir), 'config', 'post-execution.md');
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf-8')
          .replace(/\{\{squadName\}\}/g, squadName)
          .replace(/\{\{agentName\}\}/g, agentName);
      } catch { /* fall through */ }
    }
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

/** Read all .md files from a directory, concatenated */
function readDirMd(dirPath: string, maxChars: number): string {
  if (!existsSync(dirPath)) return '';
  try {
    const files = readdirSync(dirPath).filter(f => f.endsWith('.md')).sort();
    const parts: string[] = [];
    let totalChars = 0;
    for (const file of files) {
      const content = safeRead(join(dirPath, file));
      if (!content) continue;
      if (totalChars + content.length > maxChars) break;
      parts.push(content);
      totalChars += content.length;
    }
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

// ── Squad Context Assembly ────────────────────────────────────────────

/**
 * Gather squad context for prompt injection.
 *
 * Role-based context cascade (10 sections, priority-ordered):
 * Sections load in order until the token budget is exhausted.
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
  const budget = options.maxTokens ? options.maxTokens * 4 : ROLE_BUDGETS[role];
  const allowedSections = ROLE_SECTIONS[role];
  const sections: string[] = [];
  let usedChars = 0;

  /** Try to add a section. Returns true if added, false if budget exceeded or not allowed. */
  function addSection(sectionNum: number, header: string, content: string, maxChars?: number): boolean {
    if (!allowedSections.has(sectionNum)) return false;
    if (!content) return false;

    let text = content;
    const cap = maxChars || (budget - usedChars);
    if (text.length > cap) {
      text = text.substring(0, cap) + '\n...';
    }

    if (usedChars + text.length > budget) {
      // Budget exhausted — drop this and all later sections
      if (options.verbose) {
        writeLine(`  ${colors.dim}Context budget exhausted at section ${sectionNum} (${header})${RESET}`);
      }
      return false;
    }

    sections.push(`## ${header}\n${text}`);
    usedChars += text.length;
    return true;
  }

  // ── Section 1: SQUAD.md ──
  const squadFile = join(squadsDir, squadName, 'SQUAD.md');
  if (existsSync(squadFile)) {
    try {
      const content = readFileSync(squadFile, 'utf-8');
      // Extract mission section; fall back to first N chars
      const missionMatch = content.match(/## Mission[\s\S]*?(?=\n## |$)/i);
      const squad = missionMatch ? missionMatch[0] : content.substring(0, 2000);
      addSection(1, `Squad: ${squadName}`, squad.trim());
    } catch (e) {
      if (options.verbose) writeLine(`  ${colors.dim}warn: failed reading SQUAD.md: ${e instanceof Error ? e.message : String(e)}${RESET}`);
    }
  }

  // ── Section 2: priorities.md (fallback to goals.md for backward compat) ──
  if (memoryDir) {
    const prioritiesFile = join(memoryDir, squadName, 'priorities.md');
    const goalsFile = join(memoryDir, squadName, 'goals.md');
    const file = existsSync(prioritiesFile) ? prioritiesFile : goalsFile;
    const content = safeRead(file);
    if (content) {
      addSection(2, 'Priorities', content);
    }
  }

  // ── Section 3: directives.md ──
  if (memoryDir) {
    const directivesFile = join(memoryDir, 'company', 'directives.md');
    const content = safeRead(directivesFile);
    if (content) {
      addSection(3, 'Directives', content);
    }
  }

  // ── Section 4: feedback.md ──
  if (memoryDir) {
    const feedbackFile = join(memoryDir, squadName, 'feedback.md');
    const content = safeRead(feedbackFile);
    if (content) {
      addSection(4, 'Feedback', content);
    }
  }

  // ── Section 5: state.md ──
  if (memoryDir) {
    const stateFile = join(memoryDir, squadName, agentName, 'state.md');
    const content = safeRead(stateFile);
    if (content) {
      // Scanner gets capped state, lead/coo get full
      const stateCap = role === 'scanner' ? 2000 : undefined;
      addSection(5, 'Previous State', content, stateCap);
    }
  }

  // ── Section 6: active-work.md ──
  if (memoryDir) {
    const activeWorkFile = join(memoryDir, squadName, 'active-work.md');
    const content = safeRead(activeWorkFile);
    if (content) {
      addSection(6, 'Active Work', content);
    }
  }

  // ── Section 7: Agent briefs ──
  if (memoryDir) {
    const briefsDir = join(memoryDir, squadName, agentName, 'briefs');
    const content = readDirMd(briefsDir, 3000);
    if (content) {
      addSection(7, 'Agent Briefs', content);
    }
  }

  // ── Section 8: Squad briefs ──
  if (memoryDir) {
    const briefsDir = join(memoryDir, squadName, '_briefs');
    const content = readDirMd(briefsDir, 3000);
    if (content) {
      addSection(8, 'Squad Briefs', content);
    }
  }

  // ── Section 9: Daily briefing ──
  if (memoryDir) {
    const dailyFile = join(memoryDir, 'daily-briefing.md');
    const content = safeRead(dailyFile);
    if (content) {
      addSection(9, 'Daily Briefing', content);
    }
  }

  // ── Section 10: Cross-squad learnings ──
  if (memoryDir) {
    // Load from context_from squads if defined in agent frontmatter
    const frontmatter = options.agentPath ? parseAgentFrontmatter(options.agentPath) : {};
    const contextSquads = frontmatter.context_from || [];
    const learningParts: string[] = [];
    for (const ctx of contextSquads) {
      const learningsFile = join(memoryDir, ctx, 'shared', 'learnings.md');
      const content = safeRead(learningsFile);
      if (content) {
        learningParts.push(`### ${ctx}\n${content}`);
      }
    }
    if (learningParts.length > 0) {
      addSection(10, 'Cross-Squad Learnings', learningParts.join('\n\n'));
    }
  }

  if (sections.length === 0) return '';

  if (options.verbose) {
    writeLine(`  ${colors.dim}Context: ${sections.length} sections, ~${Math.ceil(usedChars / 4)} tokens (${role} role, budget: ~${Math.ceil(budget / 4)})${RESET}`);
  }

  return `\n# CONTEXT\n${sections.join('\n\n')}\n`;
}
