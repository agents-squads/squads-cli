import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { findMemoryDir, appendToMemory } from '../lib/memory.js';
import { loadSquad } from '../lib/squad-parser.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  icons,
  writeLine,
} from '../lib/terminal.js';
import { track, Events } from '../lib/telemetry.js';

export interface FeedbackEntry {
  date: string;
  execution: string;
  rating: number;  // 1-5
  feedback: string;
  learnings?: string[];
}

function getFeedbackPath(squadName: string): string | null {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return null;

  // Find the lead agent for this squad
  const squad = loadSquad(squadName);
  const agentName = squad?.agents[0]?.name || `${squadName}-lead`;

  return join(memoryDir, squadName, agentName, 'feedback.md');
}

function getOutputPath(squadName: string): string | null {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return null;

  const squad = loadSquad(squadName);
  const agentName = squad?.agents[0]?.name || `${squadName}-lead`;

  return join(memoryDir, squadName, agentName, 'output.md');
}

function getLastExecution(squadName: string): { date: string; summary: string } | null {
  const outputPath = getOutputPath(squadName);
  if (!outputPath || !existsSync(outputPath)) {
    return null;
  }

  const content = readFileSync(outputPath, 'utf-8');
  const lines = content.split('\n');

  // Try to extract date from content
  let date = 'unknown';
  let summary = lines.slice(0, 5).join('\n');

  // Look for date patterns
  const dateMatch = content.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    date = dateMatch[1];
  }

  // Look for title
  const titleMatch = content.match(/^#\s+(.+)$/m);
  if (titleMatch) {
    summary = titleMatch[1];
  }

  return { date, summary };
}

function parseFeedbackHistory(content: string): FeedbackEntry[] {
  const entries: FeedbackEntry[] = [];
  const sections = content.split(/---\n/).filter(s => s.trim());

  for (const section of sections) {
    const dateMatch = section.match(/_Date:\s*(.+)_/);
    const ratingMatch = section.match(/\*\*Rating\*\*:\s*(\d)\/5/);
    const feedbackMatch = section.match(/\*\*Feedback\*\*:\s*(.+)/);
    const executionMatch = section.match(/\*\*Execution\*\*:\s*(.+)/);

    if (dateMatch && ratingMatch) {
      const entry: FeedbackEntry = {
        date: dateMatch[1],
        execution: executionMatch?.[1] || 'unknown',
        rating: parseInt(ratingMatch[1]),
        feedback: feedbackMatch?.[1] || '',
        learnings: [],
      };

      // Extract learnings
      const learningsMatch = section.match(/\*\*Learnings\*\*:\n((?:- .+\n?)+)/);
      if (learningsMatch) {
        entry.learnings = learningsMatch[1]
          .split('\n')
          .filter(l => l.startsWith('- '))
          .map(l => l.replace(/^- /, ''));
      }

      entries.push(entry);
    }
  }

  return entries;
}

export async function feedbackAddCommand(
  squadName: string,
  rating: string,
  feedback: string,
  options: { learning?: string[] }
): Promise<void> {
  await track(Events.CLI_FEEDBACK_ADD, { squad: squadName, rating: parseInt(rating) });
  const feedbackPath = getFeedbackPath(squadName);
  if (!feedbackPath) {
    writeLine(`  ${colors.red}Could not find memory directory${RESET}`);
    return;
  }

  const ratingNum = parseInt(rating);
  if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    writeLine(`  ${colors.red}Rating must be 1-5${RESET}`);
    return;
  }

  // Get last execution for context
  const lastExec = getLastExecution(squadName);

  // Ensure directory exists
  const dir = dirname(feedbackPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Build feedback entry
  const date = new Date().toISOString().split('T')[0];
  let entry = `\n---\n_Date: ${date}_\n\n`;
  entry += `**Execution**: ${lastExec?.summary || 'Manual feedback'}\n`;
  entry += `**Rating**: ${ratingNum}/5 ${'★'.repeat(ratingNum)}${'☆'.repeat(5 - ratingNum)}\n`;
  entry += `**Feedback**: ${feedback}\n`;

  if (options.learning && options.learning.length > 0) {
    entry += `**Learnings**:\n`;
    for (const learning of options.learning) {
      entry += `- ${learning}\n`;
    }

    // Also add learnings to the learnings file
    const squad = loadSquad(squadName);
    const agentName = squad?.agents[0]?.name || `${squadName}-lead`;

    for (const learning of options.learning) {
      await appendToMemory(squadName, agentName, 'learnings', `From feedback (${date}): ${learning}`);
    }
  }

  // Append to feedback file
  let existing = '';
  if (existsSync(feedbackPath)) {
    existing = readFileSync(feedbackPath, 'utf-8');
  } else {
    existing = `# ${squadName} - Feedback Log\n\n> Execution feedback and learnings\n`;
  }

  writeFileSync(feedbackPath, existing + entry);

  // Display
  const stars = `${colors.yellow}${'★'.repeat(ratingNum)}${'☆'.repeat(5 - ratingNum)}${RESET}`;

  writeLine();
  writeLine(`  ${icons.success} Feedback recorded for ${colors.cyan}${squadName}${RESET}`);
  writeLine(`  Rating: ${stars}`);
  writeLine(`  ${feedback}`);
  if (options.learning && options.learning.length > 0) {
    writeLine(`  ${colors.dim}+ ${options.learning.length} learning(s) added${RESET}`);
  }
  writeLine();
}

export async function feedbackShowCommand(
  squadName: string,
  options: { limit?: string }
): Promise<void> {
  await track(Events.CLI_FEEDBACK_SHOW, { squad: squadName });
  const feedbackPath = getFeedbackPath(squadName);
  if (!feedbackPath || !existsSync(feedbackPath)) {
    writeLine(`  ${colors.yellow}No feedback recorded for ${squadName}${RESET}`);
    return;
  }

  const content = readFileSync(feedbackPath, 'utf-8');
  const entries = parseFeedbackHistory(content);

  const limit = options.limit ? parseInt(options.limit) : 5;
  const recent = entries.slice(-limit).reverse();

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}feedback${RESET} ${colors.cyan}${squadName}${RESET}`);
  writeLine();

  if (recent.length === 0) {
    writeLine(`  ${colors.dim}No feedback entries yet${RESET}`);
    return;
  }

  // Calculate average rating
  const avgRating = entries.reduce((sum, e) => sum + e.rating, 0) / entries.length;

  writeLine(`  ${colors.dim}Average: ${avgRating.toFixed(1)}/5 (${entries.length} entries)${RESET}`);
  writeLine();

  for (const entry of recent) {
    const stars = `${colors.yellow}${'★'.repeat(entry.rating)}${'☆'.repeat(5 - entry.rating)}${RESET}`;
    writeLine(`  ${colors.dim}${entry.date}${RESET} ${stars}`);
    writeLine(`  ${entry.feedback}`);
    if (entry.learnings && entry.learnings.length > 0) {
      for (const learning of entry.learnings) {
        writeLine(`  ${colors.green}→ ${learning}${RESET}`);
      }
    }
    writeLine();
  }
}

export async function feedbackStatsCommand(): Promise<void> {
  await track(Events.CLI_FEEDBACK_STATS);
  const memoryDir = findMemoryDir();
  if (!memoryDir) {
    writeLine(`  ${colors.red}Could not find memory directory${RESET}`);
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}feedback stats${RESET}`);
  writeLine();

  const squads = readdirSync(memoryDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  // Table
  const w = { squad: 18, avg: 12, count: 8, trend: 6 };
  const tableWidth = w.squad + w.avg + w.count + w.trend + 4;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  const header = `  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('SQUAD', w.squad)}${RESET}` +
    `${bold}${padEnd('AVG', w.avg)}${RESET}` +
    `${bold}${padEnd('COUNT', w.count)}${RESET}` +
    `${bold}TREND${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`;
  writeLine(header);

  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const squad of squads) {
    const feedbackPath = getFeedbackPath(squad);
    if (!feedbackPath || !existsSync(feedbackPath)) {
      continue;
    }

    const content = readFileSync(feedbackPath, 'utf-8');
    const entries = parseFeedbackHistory(content);

    if (entries.length === 0) continue;

    const avgRating = entries.reduce((sum, e) => sum + e.rating, 0) / entries.length;

    // Calculate trend (last 3 vs previous)
    let trend = `${colors.dim}→${RESET}`;
    if (entries.length >= 4) {
      const recent = entries.slice(-3).reduce((s, e) => s + e.rating, 0) / 3;
      const older = entries.slice(-6, -3).reduce((s, e) => s + e.rating, 0) / Math.min(3, entries.slice(-6, -3).length);
      if (recent > older + 0.3) trend = `${colors.green}↑${RESET}`;
      else if (recent < older - 0.3) trend = `${colors.red}↓${RESET}`;
    }

    const stars = `${colors.yellow}${'★'.repeat(Math.round(avgRating))}${'☆'.repeat(5 - Math.round(avgRating))}${RESET}`;

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(squad, w.squad)}${RESET}` +
      `${padEnd(stars, w.avg + 20)}` + // extra for color codes
      `${padEnd(String(entries.length), w.count)}` +
      `${trend}` +
      ` ${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads feedback show ${colors.cyan}<squad>${RESET}   ${colors.dim}View squad feedback${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads feedback add ${colors.cyan}<squad>${RESET}    ${colors.dim}Add new feedback${RESET}`);
  writeLine();
}
