import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

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

export function searchMemory(query: string, memoryDir?: string): SearchResult[] {
  const dir = memoryDir || findMemoryDir();
  if (!dir) return [];

  const entries = listMemoryEntries(dir);
  const results: SearchResult[] = [];
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);

  for (const entry of entries) {
    const contentLower = entry.content.toLowerCase();
    const matches: string[] = [];
    let score = 0;

    // Check if query appears in content
    for (const word of queryWords) {
      if (contentLower.includes(word)) {
        score += 1;
        // Find matching lines
        const lines = entry.content.split('\n');
        for (const line of lines) {
          if (line.toLowerCase().includes(word) && !matches.includes(line.trim())) {
            matches.push(line.trim());
          }
        }
      }
    }

    // Boost score for exact phrase match
    if (contentLower.includes(queryLower)) {
      score += 5;
    }

    // Boost state files (most important)
    if (entry.type === 'state') {
      score *= 1.5;
    }

    if (score > 0) {
      results.push({ entry, matches: matches.slice(0, 5), score });
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

export function updateMemory(
  squadName: string,
  agentName: string,
  type: MemoryEntry['type'],
  content: string
): void {
  const memoryDir = findMemoryDir();
  if (!memoryDir) {
    throw new Error('No .agents/memory directory found');
  }

  const filePath = join(memoryDir, squadName, agentName, `${type}.md`);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, content);
}

export function appendToMemory(
  squadName: string,
  agentName: string,
  type: MemoryEntry['type'],
  addition: string
): void {
  const memoryDir = findMemoryDir();
  if (!memoryDir) {
    throw new Error('No .agents/memory directory found');
  }

  const filePath = join(memoryDir, squadName, agentName, `${type}.md`);

  let existing = '';
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, 'utf-8');
  }

  const timestamp = new Date().toISOString().split('T')[0];
  const newContent = existing + `\n\n---\n_Added: ${timestamp}_\n\n${addition}`;

  updateMemory(squadName, agentName, type, newContent.trim());
}
