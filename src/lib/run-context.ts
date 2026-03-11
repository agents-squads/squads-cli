/**
 * run-context.ts
 *
 * Helpers for building agent execution context and parsing agent definitions.
 * Extracted from src/commands/run.ts to reduce its size.
 *
 * Responsibilities:
 * - Agent frontmatter parsing (acceptance_criteria, cooldown, max_retries, context_from)
 * - MCP server discovery from agent definitions
 * - Squad context assembly (SQUAD.md, goals, directives, state, briefs, learnings)
 * - Approval and post-execution instruction loading
 */

import { join, dirname } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { findSquadsDir } from './squad-parser.js';
import { findMemoryDir } from './memory.js';
import { colors, RESET, writeLine } from './terminal.js';

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_CONTEXT_TOKENS = 8000;
const DEFAULT_FALLBACK_CHARS = 2000;
const MAX_AGENT_BRIEFS = 3;
const MAX_SQUAD_BRIEFS = 2;
const MAX_LEARNINGS_CHARS = 1500;
const MAX_LEAD_STATE_CHARS = 1000;

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
  if (!existsSync(agentPath)) return {};

  const content = readFileSync(agentPath, 'utf-8');
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

// ── System Protocol (Layer 1) ─────────────────────────────────────────

/**
 * Load SYSTEM.md — the immutable Layer 1 of the agent prompt cascade.
 * Reads from .agents/SYSTEM.md relative to the squads directory.
 * Returns raw file content, or empty string if not found.
 * Caller is responsible for wrapping with immutability markers.
 */
export function loadSystemProtocol(): string {
  return readAgentsFile('SYSTEM.md', 'SYSTEM.md');
}

// ── Approval and Post-Execution Instructions ──────────────────────────

/**
 * Load approval/escalation instructions from config file.
 * Returns the instructions content or empty string if not found.
 * @deprecated Absorbed into SYSTEM.md (Layer 1). Used as fallback when SYSTEM.md absent.
 */
export function loadApprovalInstructions(): string {
  return readAgentsFile('config/approval-instructions.md', 'approval instructions');
}

/**
 * Load post-execution instructions from .agents/config/post-execution.md.
 * Substitutes {{squadName}} and {{agentName}} placeholders.
 * Falls back to a minimal inline default if file not found.
 * @deprecated Absorbed into SYSTEM.md (Layer 1). Used as fallback when SYSTEM.md absent.
 */
export function loadPostExecution(squadName: string, agentName: string): string {
  const template = readAgentsFile('config/post-execution.md', 'post-execution template');
  if (template) {
    return template
      .replace(/\{\{squadName\}\}/g, squadName)
      .replace(/\{\{agentName\}\}/g, agentName);
  }
  // Minimal fallback if template file missing
  return `After completion:
- Create a branch, commit with Conventional Commits, push, and open a PR targeting develop
- NEVER commit to main directly
- Type /exit when done`;
}

// ── Squad Context Assembly ────────────────────────────────────────────

/**
 * Gather squad context for prompt injection.
 * Includes SQUAD.md mission/goals, agent's existing state, and relevant briefs.
 * This ensures agents build on existing knowledge rather than starting from scratch.
 */
export function gatherSquadContext(
  squadName: string,
  agentName: string,
  options: { verbose?: boolean; maxTokens?: number; agentPath?: string } = {}
): string {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return '';

  const memoryDir = findMemoryDir();
  const maxTokens = options.maxTokens || DEFAULT_CONTEXT_TOKENS;
  const sections: string[] = [];
  let estimatedTokens = 0;

  // Helper to estimate tokens (rough: ~4 chars per token)
  const estimateTokens = (text: string) => Math.ceil(text.length / 4);

  // 1. SQUAD.md - mission, goals, and key context
  const squadFile = join(squadsDir, squadName, 'SQUAD.md');
  if (existsSync(squadFile)) {
    try {
      const squadContent = readFileSync(squadFile, 'utf-8');
      // Extract key sections (skip frontmatter YAML, focus on mission/goals/output)
      const missionMatch = squadContent.match(/## Mission[\s\S]*?(?=\n## |$)/i);
      const goalsMatch = squadContent.match(/## (?:Goals|Objectives)[\s\S]*?(?=\n## |$)/i);
      const outputMatch = squadContent.match(/## Output[\s\S]*?(?=\n## |$)/i);
      const contextMatch = squadContent.match(/## Context[\s\S]*?(?=\n## |$)/i);

      let squadContext = '';
      if (missionMatch) squadContext += missionMatch[0] + '\n';
      if (goalsMatch) squadContext += goalsMatch[0] + '\n';
      if (outputMatch) squadContext += outputMatch[0] + '\n';
      if (contextMatch) squadContext += contextMatch[0] + '\n';

      // If no structured sections found, include first 2000 chars
      if (!squadContext && squadContent.length > 0) {
        squadContext = squadContent.substring(0, DEFAULT_FALLBACK_CHARS);
      }

      if (squadContext) {
        const tokens = estimateTokens(squadContext);
        if (estimatedTokens + tokens < maxTokens) {
          sections.push(`## Squad Context (${squadName})\n${squadContext.trim()}`);
          estimatedTokens += tokens;
        }
      }
    } catch (e) {
      if (options.verbose) writeLine(`  ${colors.dim}warn: failed reading SQUAD.md: ${e instanceof Error ? e.message : String(e)}${RESET}`);
    }
  }

  // 2. Squad goals - current objectives set by founder/cofounder
  if (memoryDir) {
    const goalsFile = join(memoryDir, squadName, 'goals.md');
    if (existsSync(goalsFile)) {
      try {
        const goalsContent = readFileSync(goalsFile, 'utf-8');
        const tokens = estimateTokens(goalsContent);
        if (estimatedTokens + tokens < maxTokens && goalsContent.trim()) {
          sections.push(`## Squad Goals (${squadName})\n${goalsContent.trim()}`);
          estimatedTokens += tokens;
        }
      } catch (e) {
        if (options.verbose) writeLine(`  ${colors.dim}warn: failed reading squad goals: ${e instanceof Error ? e.message : String(e)}${RESET}`);
      }
    }
  }

  // 3. Company directives - strategic directives that override everything
  if (memoryDir) {
    const directivesFile = join(memoryDir, 'company', 'directives.md');
    if (existsSync(directivesFile)) {
      try {
        const directivesContent = readFileSync(directivesFile, 'utf-8');
        const tokens = estimateTokens(directivesContent);
        if (estimatedTokens + tokens < maxTokens && directivesContent.trim()) {
          sections.push(`## Company Directives\n${directivesContent.trim()}`);
          estimatedTokens += tokens;
        }
      } catch (e) {
        if (options.verbose) writeLine(`  ${colors.dim}warn: failed reading company directives: ${e instanceof Error ? e.message : String(e)}${RESET}`);
      }
    }
  }

  // 4. Agent's existing state - what the agent knows from prior runs
  if (memoryDir) {
    const stateFile = join(memoryDir, squadName, agentName, 'state.md');
    if (existsSync(stateFile)) {
      try {
        const stateContent = readFileSync(stateFile, 'utf-8');
        const tokens = estimateTokens(stateContent);

        if (estimatedTokens + tokens < maxTokens && stateContent.trim()) {
          sections.push(`## Your Previous State\nThis is your memory from your last execution:\n\n${stateContent.trim()}`);
          estimatedTokens += tokens;
        }
      } catch (e) {
        if (options.verbose) writeLine(`  ${colors.dim}warn: failed reading agent state: ${e instanceof Error ? e.message : String(e)}${RESET}`);
      }
    }
  }

  // 5. Related briefs (if any exist in memory/squad/agent/briefs/)
  if (memoryDir) {
    const briefsDir = join(memoryDir, squadName, agentName, 'briefs');
    if (existsSync(briefsDir)) {
      try {
        const briefFiles = readdirSync(briefsDir)
          .filter(f => f.endsWith('.md'))
          .slice(0, MAX_AGENT_BRIEFS);

        for (const briefFile of briefFiles) {
          const briefPath = join(briefsDir, briefFile);
          const briefContent = readFileSync(briefPath, 'utf-8');
          const tokens = estimateTokens(briefContent);

          if (estimatedTokens + tokens < maxTokens) {
            sections.push(`## Brief: ${briefFile.replace('.md', '')}\n${briefContent.trim()}`);
            estimatedTokens += tokens;
          } else {
            break; // Stop adding briefs if we're over budget
          }
        }
      } catch (e) {
        if (options.verbose) writeLine(`  ${colors.dim}warn: failed reading agent briefs: ${e instanceof Error ? e.message : String(e)}${RESET}`);
      }
    }
  }

  // 6. Squad-level briefs (shared context for all agents in squad)
  if (memoryDir) {
    const squadBriefsDir = join(memoryDir, squadName, '_briefs');
    if (existsSync(squadBriefsDir)) {
      try {
        const squadBriefs = readdirSync(squadBriefsDir)
          .filter(f => f.endsWith('.md'))
          .slice(0, MAX_SQUAD_BRIEFS);

        for (const briefFile of squadBriefs) {
          const briefPath = join(squadBriefsDir, briefFile);
          const briefContent = readFileSync(briefPath, 'utf-8');
          const tokens = estimateTokens(briefContent);

          if (estimatedTokens + tokens < maxTokens) {
            sections.push(`## Squad Brief: ${briefFile.replace('.md', '')}\n${briefContent.trim()}`);
            estimatedTokens += tokens;
          } else {
            break;
          }
        }
      } catch (e) {
        if (options.verbose) writeLine(`  ${colors.dim}warn: failed reading squad briefs: ${e instanceof Error ? e.message : String(e)}${RESET}`);
      }
    }
  }

  // 7. Daily briefing (cross-squad context)
  if (memoryDir) {
    const briefingPath = join(memoryDir, 'daily-briefing.md');
    if (existsSync(briefingPath)) {
      try {
        const briefingContent = readFileSync(briefingPath, 'utf-8');
        if (briefingContent.trim()) {
          const tokens = estimateTokens(briefingContent);
          if (estimatedTokens + tokens < maxTokens) {
            sections.push(`## Daily Briefing\n${briefingContent.trim()}`);
            estimatedTokens += tokens;
          }
        }
      } catch (e) {
        if (options.verbose) writeLine(`  ${colors.dim}warn: failed reading daily briefing: ${e instanceof Error ? e.message : String(e)}${RESET}`);
      }
    }
  }

  // 8. Cross-squad learnings (from context_from in agent frontmatter)
  if (memoryDir && options.agentPath) {
    const frontmatter = parseAgentFrontmatter(options.agentPath);
    if (frontmatter.context_from && frontmatter.context_from.length > 0) {
      for (const relatedSquad of frontmatter.context_from) {
        // Related squad shared learnings
        const learningsPath = join(memoryDir, relatedSquad, 'shared', 'learnings.md');
        if (existsSync(learningsPath)) {
          try {
            let learningsContent = readFileSync(learningsPath, 'utf-8');
            if (learningsContent.trim()) {
              if (learningsContent.length > MAX_LEARNINGS_CHARS) {
                learningsContent = learningsContent.slice(0, MAX_LEARNINGS_CHARS) + '\n...(truncated)';
              }
              const tokens = estimateTokens(learningsContent);
              if (estimatedTokens + tokens < maxTokens) {
                sections.push(`## ${relatedSquad} Squad Learnings\n${learningsContent.trim()}`);
                estimatedTokens += tokens;
              }
            }
          } catch (e) {
            if (options.verbose) writeLine(`  ${colors.dim}warn: failed reading ${relatedSquad} learnings: ${e instanceof Error ? e.message : String(e)}${RESET}`);
          }
        }

        // Related squad lead state
        const leadStatePath = join(memoryDir, relatedSquad, `${relatedSquad}-lead`, 'state.md');
        if (existsSync(leadStatePath)) {
          try {
            let leadState = readFileSync(leadStatePath, 'utf-8');
            if (leadState.trim()) {
              if (leadState.length > MAX_LEAD_STATE_CHARS) {
                leadState = leadState.slice(0, MAX_LEAD_STATE_CHARS) + '\n...(truncated)';
              }
              const tokens = estimateTokens(leadState);
              if (estimatedTokens + tokens < maxTokens) {
                sections.push(`## ${relatedSquad} Lead State\n${leadState.trim()}`);
                estimatedTokens += tokens;
              }
            }
          } catch (e) {
            if (options.verbose) writeLine(`  ${colors.dim}warn: failed reading ${relatedSquad} lead state: ${e instanceof Error ? e.message : String(e)}${RESET}`);
          }
        }
      }
    }
  }

  if (sections.length === 0) {
    return '';
  }

  if (options.verbose) {
    writeLine(`  ${colors.dim}Context: ${sections.length} sections (~${estimatedTokens} tokens)${RESET}`);
  }

  return `\n# EXISTING CONTEXT\nBuild on this existing knowledge - do NOT start from scratch:\n\n${sections.join('\n\n')}\n`;
}
