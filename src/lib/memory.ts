import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { withLock } from './lock.js';

/**
 * Validate a single memory path segment (squad / agent / type) before it
 * becomes a directory or file name (cli#1045). The write path used to
 * join(memoryDir, squad, agent, `${type}.md`) with whatever it was handed —
 * an absolute path, a falsy stringification ("0", "null"), or a `.md`-suffixed
 * name would produce corrupt trees (falsy-named dirs under the memory root, a
 * `.md` FILE turned into a directory chain). 15+ such trees were found in a
 * corpus audit and they broke hq commits (the guardrail hook rejects them).
 * Fail loud here instead of writing garbage.
 */
export function assertValidMemorySegment(segment: unknown, role: string): string {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw new Error(`invalid memory ${role}: expected a non-empty string, got ${JSON.stringify(segment)} (cli#1045)`);
  }
  const s = segment.trim();
  const bad = new Set(['0', 'null', 'undefined', 'none', 'nan', '.', '..']);
  if (s.length === 0 || bad.has(s.toLowerCase())) {
    throw new Error(`invalid memory ${role}: falsy/reserved segment ${JSON.stringify(segment)} (cli#1045)`);
  }
  // Path separators / absolute fragments would blow the segment across
  // directory levels (the nested-home-dir corruption class).
  if (/[/\\]/.test(s)) {
    throw new Error(`invalid memory ${role}: contains a path separator ${JSON.stringify(segment)} — segments are single names (cli#1045)`);
  }
  // A `.md` (or any extension) on a squad/agent name means a file name is
  // being used where a directory is expected.
  if (/\.[A-Za-z0-9]+$/.test(s)) {
    throw new Error(`invalid memory ${role}: looks like a file name ${JSON.stringify(segment)} — expected a bare directory name (cli#1045)`);
  }
  return s;
}

/** Build the canonical memory file path for a squad/agent/type triple,
 * validating every segment first (cli#1045) — single source of truth for the
 * write paths. */
function memoryFilePath(memoryDir: string, squad: unknown, agent: unknown, type: unknown): string {
  return join(
    memoryDir,
    assertValidMemorySegment(squad, 'squad'),
    assertValidMemorySegment(agent, 'agent'),
    `${assertValidMemorySegment(type, 'type')}.md`,
  );
}

export interface MemoryEntry {
  squad: string;
  agent: string;
  type: 'state' | 'output' | 'learnings' | 'feedback';
  content: string;
  path: string;
  lastUpdated?: string;
}

export interface SearchResult {
  entry: MemoryEntry;
  matches: string[];
  score: number;
}

export function findMemoryDir(): string | null {
  let dir = process.cwd();

  for (let i = 0; i < 5; i++) {
    const memoryPath = join(dir, '.agents', 'memory');
    if (existsSync(memoryPath)) {
      return memoryPath;
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export function listMemoryEntries(memoryDir: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];

  const squads = readdirSync(memoryDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  for (const squad of squads) {
    const squadPath = join(memoryDir, squad);
    const agents = readdirSync(squadPath, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);

    for (const agent of agents) {
      const agentPath = join(squadPath, agent);
      const files = readdirSync(agentPath).filter(f => f.endsWith('.md'));

      for (const file of files) {
        const filePath = join(agentPath, file);
        const type = file.replace('.md', '') as MemoryEntry['type'];

        entries.push({
          squad,
          agent,
          type,
          content: readFileSync(filePath, 'utf-8'),
          path: filePath
        });
      }
    }
  }

  return entries;
}

// Semantic expansions for common business terms
const SEMANTIC_EXPANSIONS: Record<string, string[]> = {
  'pricing': ['price', 'cost', '$', 'revenue', 'fee', 'rate'],
  'price': ['pricing', 'cost', '$', 'fee'],
  'revenue': ['income', 'sales', 'mrr', 'arr', '$'],
  'cost': ['expense', 'spend', 'budget', '$', 'price'],
  'customer': ['client', 'lead', 'prospect', 'user'],
  'client': ['customer', 'lead', 'prospect'],
  'lead': ['prospect', 'customer', 'client', 'pipeline'],
  'agent': ['squad', 'bot', 'ai'],
  'squad': ['team', 'agent', 'group'],
  'status': ['state', 'progress', 'health'],
  'bug': ['issue', 'error', 'problem', 'fix'],
  'feature': ['capability', 'function', 'ability'],
};

function expandQuery(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/);
  const expanded = new Set(words);

  for (const word of words) {
    if (SEMANTIC_EXPANSIONS[word]) {
      SEMANTIC_EXPANSIONS[word].forEach(syn => expanded.add(syn));
    }
  }

  return Array.from(expanded);
}

function getFileAge(filePath: string): number {
  try {
    const { statSync } = require('fs');
    const stats = statSync(filePath);
    const ageMs = Date.now() - stats.mtimeMs;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return ageDays;
  } catch {
    return 999;
  }
}

export function searchMemory(query: string, memoryDir?: string): SearchResult[] {
  const dir = memoryDir || findMemoryDir();
  if (!dir) return [];

  const entries = listMemoryEntries(dir);
  const results: SearchResult[] = [];
  const queryLower = query.toLowerCase();
  const expandedTerms = expandQuery(queryLower);

  for (const entry of entries) {
    const contentLower = entry.content.toLowerCase();
    const lines = entry.content.split('\n');
    const matches: string[] = [];
    let score = 0;
    let directHits = 0;
    let expandedHits = 0;

    // Check direct query words first
    const directWords = queryLower.split(/\s+/);
    for (const word of directWords) {
      if (contentLower.includes(word)) {
        directHits += 1;
        score += 2; // Direct matches worth more
      }
    }

    // Check expanded terms
    for (const term of expandedTerms) {
      if (contentLower.includes(term)) {
        expandedHits += 1;
        score += 0.5; // Expanded matches worth less but still count

        // Find matching lines with context
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.toLowerCase().includes(term) && line.trim() && !matches.includes(line.trim())) {
            matches.push(line.trim());
          }
        }
      }
    }

    // Boost score for exact phrase match
    if (contentLower.includes(queryLower)) {
      score += 5;
    }

    // Recency boost - files updated recently are more relevant
    const ageDays = getFileAge(entry.path);
    if (ageDays < 1) {
      score *= 1.5; // Updated today
    } else if (ageDays < 7) {
      score *= 1.2; // Updated this week
    } else if (ageDays > 30) {
      score *= 0.8; // Stale data penalty
    }

    // Type weighting - balanced across types
    const typeWeights: Record<string, number> = {
      'state': 1.2,      // Current state slightly preferred
      'learnings': 1.1,  // Learnings are valuable
      'output': 1.0,     // Recent outputs
      'feedback': 0.9,   // Feedback less commonly needed
    };
    score *= typeWeights[entry.type] || 1.0;

    if (score > 0 && (directHits > 0 || expandedHits > 1)) {
      results.push({ entry, matches: matches.slice(0, 7), score });
    }
  }

  // Sort by score descending
  return results.sort((a, b) => b.score - a.score);
}

export function getSquadState(squadName: string): MemoryEntry[] {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return [];

  const squadPath = join(memoryDir, squadName);
  if (!existsSync(squadPath)) return [];

  const entries: MemoryEntry[] = [];
  const agents = readdirSync(squadPath, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  for (const agent of agents) {
    const statePath = join(squadPath, agent, 'state.md');
    if (existsSync(statePath)) {
      entries.push({
        squad: squadName,
        agent,
        type: 'state',
        content: readFileSync(statePath, 'utf-8'),
        path: statePath
      });
    }
  }

  return entries;
}

// Rendering order for `getSquadMemory` — state first (current status), then
// learnings alongside it (what `squads memory write` lands in by default),
// then the less commonly read types.
const SQUAD_MEMORY_TYPE_ORDER: MemoryEntry['type'][] = ['state', 'learnings', 'output', 'feedback'];

/**
 * Get every memory entry (state, learnings, output, feedback) for a squad,
 * grouped by agent. Unlike getSquadState (state.md only), this is what
 * `squads memory read` renders so a `squads memory write` is visible
 * immediately afterward.
 */
export function getSquadMemory(squadName: string): MemoryEntry[] {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return [];

  const squadPath = join(memoryDir, squadName);
  if (!existsSync(squadPath)) return [];

  const entries: MemoryEntry[] = [];
  const agents = readdirSync(squadPath, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  for (const agent of agents) {
    for (const type of SQUAD_MEMORY_TYPE_ORDER) {
      const filePath = join(squadPath, agent, `${type}.md`);
      if (existsSync(filePath)) {
        entries.push({
          squad: squadName,
          agent,
          type,
          content: readFileSync(filePath, 'utf-8'),
          path: filePath
        });
      }
    }
  }

  return entries;
}

/**
 * Update memory file with distributed locking
 * Safe for concurrent access from multiple agents
 */
export async function updateMemory(
  squadName: string,
  agentName: string,
  type: MemoryEntry['type'],
  content: string
): Promise<void> {
  const memoryDir = findMemoryDir();
  if (!memoryDir) {
    throw new Error('No .agents/memory directory found');
  }

  const filePath = memoryFilePath(memoryDir, squadName, agentName, type);
  const dir = dirname(filePath);

  await withLock(filePath, () => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, content);
  });
}

/**
 * Sync version for backward compatibility (no locking - use with caution)
 * @deprecated Use async updateMemory() for safe concurrent access
 */
export function updateMemorySync(
  squadName: string,
  agentName: string,
  type: MemoryEntry['type'],
  content: string
): void {
  const memoryDir = findMemoryDir();
  if (!memoryDir) {
    throw new Error('No .agents/memory directory found');
  }

  const filePath = memoryFilePath(memoryDir, squadName, agentName, type);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, content);
}

/**
 * Append to memory file with distributed locking
 * Safe for concurrent access from multiple agents
 */
export async function appendToMemory(
  squadName: string,
  agentName: string,
  type: MemoryEntry['type'],
  addition: string
): Promise<void> {
  const memoryDir = findMemoryDir();
  if (!memoryDir) {
    throw new Error('No .agents/memory directory found');
  }

  const filePath = memoryFilePath(memoryDir, squadName, agentName, type);

  await withLock(filePath, () => {
    let existing = '';
    if (existsSync(filePath)) {
      existing = readFileSync(filePath, 'utf-8');
    }

    const timestamp = new Date().toISOString().split('T')[0];
    // Format: ## YYYY-MM-DD: First line as heading (synthesizer-friendly)
    const lines = addition.trim().split('\n');
    const heading = lines[0].replace(/^#+\s*/, '').replace(/^\*\*/, '').replace(/\*\*$/, '');
    const body = lines.slice(1).join('\n').trim();
    const entry = body
      ? `## ${timestamp}: ${heading}\n\n${body}`
      : `## ${timestamp}: ${heading}`;
    const newContent = existing + `\n\n${entry}`;

    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, newContent.trim());
  });
}

/**
 * Sync version for backward compatibility (no locking - use with caution)
 * @deprecated Use async appendToMemory() for safe concurrent access
 */
export function appendToMemorySync(
  squadName: string,
  agentName: string,
  type: MemoryEntry['type'],
  addition: string
): void {
  const memoryDir = findMemoryDir();
  if (!memoryDir) {
    throw new Error('No .agents/memory directory found');
  }

  const filePath = memoryFilePath(memoryDir, squadName, agentName, type);

  let existing = '';
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, 'utf-8');
  }

  const timestamp = new Date().toISOString().split('T')[0];
  // Format: ## YYYY-MM-DD: First line as heading (synthesizer-friendly)
  const lines = addition.trim().split('\n');
  const heading = lines[0].replace(/^#+\s*/, '').replace(/^\*\*/, '').replace(/\*\*$/, '');
  const body = lines.slice(1).join('\n').trim();
  const entry = body
    ? `## ${timestamp}: ${heading}\n\n${body}`
    : `## ${timestamp}: ${heading}`;
  const newContent = existing + `\n\n${entry}`;

  updateMemorySync(squadName, agentName, type, newContent.trim());
}
