import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { findMemoryDir, appendToMemory } from '../lib/memory.js';
import { loadSquad } from '../lib/squad-parser.js';

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
  const feedbackPath = getFeedbackPath(squadName);
  if (!feedbackPath) {
    console.error(chalk.red('Error: Could not find memory directory'));
    return;
  }

  const ratingNum = parseInt(rating);
  if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    console.error(chalk.red('Error: Rating must be 1-5'));
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
      appendToMemory(squadName, agentName, 'learnings', `From feedback (${date}): ${learning}`);
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
  const stars = '★'.repeat(ratingNum) + '☆'.repeat(5 - ratingNum);
  console.log(chalk.green(`✓ Feedback recorded for ${squadName}`));
  console.log(`  Rating: ${chalk.yellow(stars)}`);
  console.log(`  ${feedback}`);
  if (options.learning && options.learning.length > 0) {
    console.log(chalk.dim(`  + ${options.learning.length} learning(s) added`));
  }
}

export async function feedbackShowCommand(
  squadName: string,
  options: { limit?: string }
): Promise<void> {
  const feedbackPath = getFeedbackPath(squadName);
  if (!feedbackPath || !existsSync(feedbackPath)) {
    console.log(chalk.yellow(`No feedback recorded for ${squadName}`));
    return;
  }

  const content = readFileSync(feedbackPath, 'utf-8');
  const entries = parseFeedbackHistory(content);

  const limit = options.limit ? parseInt(options.limit) : 5;
  const recent = entries.slice(-limit).reverse();

  console.log(chalk.bold.cyan(`\n${squadName} - Recent Feedback\n`));

  if (recent.length === 0) {
    console.log(chalk.dim('No feedback entries yet'));
    return;
  }

  // Calculate average rating
  const avgRating = entries.reduce((sum, e) => sum + e.rating, 0) / entries.length;

  console.log(chalk.dim(`Average rating: ${avgRating.toFixed(1)}/5 (${entries.length} entries)\n`));

  for (const entry of recent) {
    const stars = '★'.repeat(entry.rating) + '☆'.repeat(5 - entry.rating);
    console.log(`${chalk.dim(entry.date)} ${chalk.yellow(stars)}`);
    console.log(`  ${entry.feedback}`);
    if (entry.learnings && entry.learnings.length > 0) {
      for (const learning of entry.learnings) {
        console.log(chalk.green(`  → ${learning}`));
      }
    }
    console.log();
  }
}

export async function feedbackStatsCommand(): Promise<void> {
  const memoryDir = findMemoryDir();
  if (!memoryDir) {
    console.error(chalk.red('Error: Could not find memory directory'));
    return;
  }

  console.log(chalk.bold.cyan('\nFeedback Summary\n'));
  console.log('────────────────────────────────────────');
  console.log(chalk.dim('Squad               Avg     Count  Trend'));
  console.log('────────────────────────────────────────');

  const squads = readdirSync(memoryDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

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
    let trend = '→';
    if (entries.length >= 4) {
      const recent = entries.slice(-3).reduce((s, e) => s + e.rating, 0) / 3;
      const older = entries.slice(-6, -3).reduce((s, e) => s + e.rating, 0) / Math.min(3, entries.slice(-6, -3).length);
      if (recent > older + 0.3) trend = chalk.green('↑');
      else if (recent < older - 0.3) trend = chalk.red('↓');
    }

    const stars = '★'.repeat(Math.round(avgRating)) + '☆'.repeat(5 - Math.round(avgRating));
    console.log(
      `${squad.padEnd(18)} ${chalk.yellow(stars.slice(0, 5))}   ${String(entries.length).padStart(3)}    ${trend}`
    );
  }

  console.log('────────────────────────────────────────');
}
