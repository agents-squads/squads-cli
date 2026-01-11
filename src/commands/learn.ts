import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { findMemoryDir, appendToMemory } from '../lib/memory.js';
import { findSquadsDir, listSquads } from '../lib/squad-parser.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  icons,
  writeLine,
} from '../lib/terminal.js';
import { track, Events } from '../lib/telemetry.js';

export interface Learning {
  date: string;
  insight: string;
  category: 'success' | 'failure' | 'pattern' | 'tip';
  tags: string[];
  squad?: string;
  context?: string;
}

/**
 * Get the learnings file path for a squad
 */
function getLearningsPath(squadName: string): string | null {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return null;

  return join(memoryDir, squadName, 'shared', 'learnings.md');
}

/**
 * Parse existing learnings from a file
 */
function parseLearnings(content: string): Learning[] {
  const learnings: Learning[] = [];
  const sections = content.split(/\n---\n/).filter(s => s.trim());

  for (const section of sections) {
    if (section.startsWith('#')) continue; // Skip header

    const dateMatch = section.match(/_(\d{4}-\d{2}-\d{2})_/);
    const categoryMatch = section.match(/\*\*(\w+)\*\*:/);
    const tagsMatch = section.match(/Tags: `([^`]+)`/);

    // Extract the insight (the main content)
    const lines = section.split('\n').filter(l => l.trim() && !l.startsWith('_') && !l.includes('Tags:'));
    const insight = lines
      .map(l => l.replace(/^\*\*\w+\*\*:\s*/, ''))
      .join(' ')
      .trim();

    if (dateMatch && insight) {
      learnings.push({
        date: dateMatch[1],
        insight,
        category: (categoryMatch?.[1]?.toLowerCase() as Learning['category']) || 'tip',
        tags: tagsMatch?.[1]?.split(',').map(t => t.trim()) || [],
      });
    }
  }

  return learnings;
}

/**
 * Format a learning entry for storage
 */
function formatLearning(learning: Learning): string {
  const categoryEmoji = {
    success: icons.success,
    failure: '✗',
    pattern: '◆',
    tip: '→',
  };

  let entry = `\n---\n_${learning.date}_\n\n`;
  entry += `${categoryEmoji[learning.category]} **${learning.category.charAt(0).toUpperCase() + learning.category.slice(1)}**: ${learning.insight}\n`;

  if (learning.tags.length > 0) {
    entry += `Tags: \`${learning.tags.join(', ')}\`\n`;
  }

  if (learning.context) {
    entry += `\n_Context: ${learning.context}_\n`;
  }

  return entry;
}

/**
 * Add a learning
 */
export async function learnCommand(
  insight: string,
  options: {
    squad?: string;
    category?: string;
    tags?: string;
    context?: string;
  }
): Promise<void> {
  // Determine squad - use provided or default to 'general'
  let squadName = options.squad || 'general';

  // Validate squad exists if specified
  if (options.squad) {
    const squadsDir = findSquadsDir();
    if (squadsDir) {
      const squads = listSquads(squadsDir);
      if (!squads.includes(options.squad)) {
        writeLine();
        writeLine(`  ${colors.yellow}${icons.warning} Squad '${options.squad}' not found${RESET}`);
        writeLine(`  ${colors.dim}Available: ${squads.join(', ')}${RESET}`);
        writeLine(`  ${colors.dim}Using 'general' instead${RESET}`);
        squadName = 'general';
      }
    }
  }

  // Parse tags
  const tags = options.tags
    ? options.tags.split(',').map(t => t.trim().toLowerCase())
    : [];

  // Auto-extract tags from insight if none provided
  if (tags.length === 0) {
    const autoTags = extractTags(insight);
    tags.push(...autoTags);
  }

  // Determine category
  const category = (options.category as Learning['category']) || inferCategory(insight);

  // Create learning entry
  const learning: Learning = {
    date: new Date().toISOString().split('T')[0],
    insight,
    category,
    tags,
    squad: squadName,
    context: options.context,
  };

  // Get or create learnings file
  const memoryDir = findMemoryDir();
  if (!memoryDir) {
    writeLine(`  ${colors.red}No .agents/memory directory found${RESET}`);
    writeLine(`  ${colors.dim}Run 'squads init' first${RESET}`);
    return;
  }

  const learningsPath = join(memoryDir, squadName, 'shared', 'learnings.md');
  const dir = dirname(learningsPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Read existing or create header
  let content = '';
  if (existsSync(learningsPath)) {
    content = readFileSync(learningsPath, 'utf-8');
  } else {
    content = `# ${squadName} - Learnings\n\n> Accumulated knowledge from sessions\n`;
  }

  // Append learning
  content += formatLearning(learning);
  writeFileSync(learningsPath, content);

  // Track telemetry
  await track(Events.CLI_LEARN, {
    squad: squadName,
    category,
    tagCount: tags.length,
  });

  // Display
  writeLine();
  writeLine(`  ${icons.success} Learning captured for ${colors.cyan}${squadName}${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}Category:${RESET} ${category}`);
  if (tags.length > 0) {
    writeLine(`  ${colors.dim}Tags:${RESET} ${tags.map(t => `#${t}`).join(' ')}`);
  }
  writeLine();
  writeLine(`  ${colors.green}${insight}${RESET}`);
  writeLine();
}

/**
 * Show learnings for a squad
 */
export async function learnShowCommand(
  squadName: string,
  options: { limit?: string; category?: string; tag?: string }
): Promise<void> {
  const memoryDir = findMemoryDir();
  if (!memoryDir) {
    writeLine(`  ${colors.red}No memory directory found${RESET}`);
    return;
  }

  const learningsPath = join(memoryDir, squadName, 'shared', 'learnings.md');
  if (!existsSync(learningsPath)) {
    writeLine(`  ${colors.yellow}No learnings recorded for ${squadName}${RESET}`);
    writeLine(`  ${colors.dim}Add one: squads learn "insight" --squad ${squadName}${RESET}`);
    return;
  }

  const content = readFileSync(learningsPath, 'utf-8');
  const learnings = parseLearnings(content);

  // Filter
  let filtered = learnings;
  if (options.category) {
    filtered = filtered.filter(l => l.category === options.category);
  }
  if (options.tag) {
    filtered = filtered.filter(l => l.tags.includes(options.tag.toLowerCase()));
  }

  // Limit and reverse (most recent first)
  const limit = options.limit ? parseInt(options.limit) : 10;
  const recent = filtered.slice(-limit).reverse();

  // Track
  await track(Events.CLI_LEARN_SHOW, { squad: squadName });

  // Display
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}learnings${RESET} ${colors.cyan}${squadName}${RESET}`);
  writeLine();

  if (recent.length === 0) {
    writeLine(`  ${colors.dim}No learnings found${RESET}`);
    return;
  }

  writeLine(`  ${colors.dim}Showing ${recent.length} of ${filtered.length} learnings${RESET}`);
  writeLine();

  const categoryIcon = {
    success: `${colors.green}${icons.success}${RESET}`,
    failure: `${colors.red}✗${RESET}`,
    pattern: `${colors.purple}◆${RESET}`,
    tip: `${colors.cyan}→${RESET}`,
  };

  for (const learning of recent) {
    writeLine(`  ${colors.dim}${learning.date}${RESET} ${categoryIcon[learning.category]} ${learning.insight}`);
    if (learning.tags.length > 0) {
      writeLine(`    ${colors.dim}${learning.tags.map(t => `#${t}`).join(' ')}${RESET}`);
    }
  }
  writeLine();
}

/**
 * Search learnings across all squads
 */
export async function learnSearchCommand(
  query: string,
  options: { limit?: string }
): Promise<void> {
  const memoryDir = findMemoryDir();
  if (!memoryDir) {
    writeLine(`  ${colors.red}No memory directory found${RESET}`);
    return;
  }

  const squadsDir = findSquadsDir();
  const squads = squadsDir ? listSquads(squadsDir) : [];
  squads.push('general'); // Always check general

  const allLearnings: (Learning & { squad: string })[] = [];

  for (const squad of squads) {
    const learningsPath = join(memoryDir, squad, 'shared', 'learnings.md');
    if (existsSync(learningsPath)) {
      const content = readFileSync(learningsPath, 'utf-8');
      const learnings = parseLearnings(content);
      allLearnings.push(...learnings.map(l => ({ ...l, squad })));
    }
  }

  // Search
  const queryLower = query.toLowerCase();
  const matches = allLearnings.filter(l =>
    l.insight.toLowerCase().includes(queryLower) ||
    l.tags.some(t => t.includes(queryLower))
  );

  // Track
  await track(Events.CLI_LEARN_SEARCH, { query, matches: matches.length });

  // Display
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}search learnings${RESET} "${query}"`);
  writeLine();

  const limit = options.limit ? parseInt(options.limit) : 10;
  const limited = matches.slice(0, limit);

  if (limited.length === 0) {
    writeLine(`  ${colors.dim}No learnings found matching "${query}"${RESET}`);
    return;
  }

  writeLine(`  ${colors.dim}Found ${matches.length} matches${RESET}`);
  writeLine();

  const categoryIcon = {
    success: `${colors.green}${icons.success}${RESET}`,
    failure: `${colors.red}✗${RESET}`,
    pattern: `${colors.purple}◆${RESET}`,
    tip: `${colors.cyan}→${RESET}`,
  };

  for (const learning of limited) {
    writeLine(`  ${colors.cyan}${learning.squad}${RESET} ${categoryIcon[learning.category]} ${learning.insight}`);
  }
  writeLine();
}

/**
 * Auto-extract tags from insight text
 */
function extractTags(insight: string): string[] {
  const tags: string[] = [];
  const lowerInsight = insight.toLowerCase();

  // Common patterns
  const patterns: Record<string, string[]> = {
    'auth': ['auth', 'login', 'token', 'session', 'password'],
    'api': ['api', 'endpoint', 'request', 'response', 'rest'],
    'bug': ['bug', 'fix', 'error', 'issue', 'crash'],
    'perf': ['performance', 'slow', 'fast', 'optimize', 'cache'],
    'ux': ['user', 'ui', 'interface', 'design', 'experience'],
    'test': ['test', 'spec', 'coverage', 'assert'],
    'db': ['database', 'query', 'sql', 'postgres', 'redis'],
    'deploy': ['deploy', 'release', 'production', 'staging'],
  };

  for (const [tag, keywords] of Object.entries(patterns)) {
    if (keywords.some(kw => lowerInsight.includes(kw))) {
      tags.push(tag);
    }
  }

  return tags.slice(0, 3); // Max 3 auto-tags
}

/**
 * Infer category from insight text
 */
function inferCategory(insight: string): Learning['category'] {
  const lower = insight.toLowerCase();

  if (lower.includes('worked') || lower.includes('success') || lower.includes('fixed')) {
    return 'success';
  }
  if (lower.includes('failed') || lower.includes('error') || lower.includes("didn't work")) {
    return 'failure';
  }
  if (lower.includes('pattern') || lower.includes('always') || lower.includes('whenever')) {
    return 'pattern';
  }

  return 'tip';
}
