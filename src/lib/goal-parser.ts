/**
 * Goal Parser & Validator
 * Parses goal descriptions to extract numeric targets, units, and deadlines
 * Validates that goals meet the requirements for automatic agent binding
 */

import { parseDate } from 'chrono-node';

export interface ParsedGoal {
  description: string;
  targetValue: number | null;
  targetUnit: string | null;
  deadline: Date | null;
  original: string;
}

export interface ValidationResult {
  valid: boolean;
  message?: string;
  parsed?: ParsedGoal;
}

/** Minimal interface for inquirer-like prompting */
interface InquirerLike {
  prompt<T>(questions: { type: string; name: string; message: string; validate?: (val: unknown) => boolean | string; default?: unknown }[]): Promise<T>;
}

/**
 * Extract numeric value from text
 * Handles: "10", "$50K", "5%", "50k", "1.5M"
 */
function extractNumericValue(text: string): { value: number; raw: string } | null {
  // Match: $50K, $50000, 50K, 50000, 5%, 10.5, etc.
  const patterns = [
    // Dollar amounts: $50K, $50M, $50000
    /\$(\d+(?:\.\d+)?)\s*([KMB])?/i,
    // Percentages: 50%, 10.5%
    /(\d+(?:\.\d+)?)\s*%/,
    // Numbers with K/M/B suffix: 50K, 1.5M
    /(\d+(?:\.\d+)?)\s*([KMB])/i,
    // Plain numbers: 10, 50, 1000
    /(\d+(?:\.\d+)?)/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      let value = parseFloat(match[1]);
      const suffix = match[2]?.toUpperCase();

      // Handle K/M/B suffixes
      if (suffix === 'K') value *= 1000;
      else if (suffix === 'M') value *= 1000000;
      else if (suffix === 'B') value *= 1000000000;

      return { value, raw: match[0] };
    }
  }

  return null;
}

/**
 * Extract unit from text near a numeric value
 * Examples: "10 leads", "$50K revenue", "5 posts"
 */
function extractUnit(text: string, numericMatch: string): string | null {
  // Get text after the numeric value
  const afterNumeric = text.split(numericMatch)[1] || '';

  // Common units (singular and plural)
  const commonUnits = [
    'lead', 'leads',
    'dollar', 'dollars', 'revenue', 'sales',
    'post', 'posts', 'article', 'articles',
    'feature', 'features',
    'user', 'users', 'customer', 'customers',
    'bug', 'bugs', 'issue', 'issues',
    'test', 'tests',
    'page', 'pages',
    'service', 'services',
    'integration', 'integrations',
    'demo', 'demos',
    'contact', 'contacts',
    'qualified',
    'backlink', 'backlinks'
  ];

  // Look for unit word after number
  const words = afterNumeric.trim().split(/\s+/);
  for (let i = 0; i < Math.min(3, words.length); i++) {
    const word = words[i].toLowerCase().replace(/[^a-z]/g, '');
    if (commonUnits.includes(word)) {
      return word;
    }
  }

  // Special case: dollar amounts default to "revenue"
  if (numericMatch.includes('$')) {
    return 'revenue';
  }

  // Special case: percentages
  if (numericMatch.includes('%')) {
    return 'percent';
  }

  return null;
}

/**
 * Extract deadline from text
 * Uses chrono-node for natural language date parsing
 */
function extractDeadline(text: string): Date | null {
  // Common deadline patterns
  const deadlineKeywords = ['by', 'before', 'until', 'due'];

  // Look for deadline keyword followed by date
  for (const keyword of deadlineKeywords) {
    const regex = new RegExp(`${keyword}\\s+(.+?)(?:,|$|\\s-\\s)`, 'i');
    const match = text.match(regex);

    if (match) {
      const dateText = match[1].trim();
      const parsed = parseDate(dateText);
      if (parsed) {
        return parsed;
      }
    }
  }

  // Fallback: try parsing the entire text
  const parsed = parseDate(text);
  if (parsed) {
    return parsed;
  }

  return null;
}

/**
 * Parse a goal description to extract target, unit, and deadline
 *
 * Examples:
 * - "Identify 10 qualified leads by Jan 10"
 *   → target: 10, unit: "leads", deadline: 2026-01-10
 * - "Generate $50K revenue by Q1"
 *   → target: 50000, unit: "revenue", deadline: 2026-03-31
 * - "Publish 5 blog posts by end of month"
 *   → target: 5, unit: "posts", deadline: 2026-01-31
 */
export function parseGoalDescription(description: string): ParsedGoal {
  const result: ParsedGoal = {
    description,
    targetValue: null,
    targetUnit: null,
    deadline: null,
    original: description
  };

  // Extract numeric value
  const numericMatch = extractNumericValue(description);
  if (numericMatch) {
    result.targetValue = numericMatch.value;

    // Extract unit
    result.targetUnit = extractUnit(description, numericMatch.raw);
  }

  // Extract deadline
  result.deadline = extractDeadline(description);

  return result;
}

/**
 * Validate goal input
 * Returns validation result with error message if invalid
 */
export function validateGoalInput(input: string): ValidationResult {
  const parsed = parseGoalDescription(input);

  // Check for numeric target
  if (parsed.targetValue === null || parsed.targetUnit === null) {
    return {
      valid: false,
      message: 'Goal must include a numeric target (e.g., "10 leads", "$50K revenue", "5 posts")',
      parsed
    };
  }

  // Warn if no deadline
  if (!parsed.deadline) {
    // This is a warning, not an error
    console.warn('⚠️  No deadline specified. Consider adding one (e.g., "by Jan 10", "by Q1")');
  }

  return {
    valid: true,
    parsed
  };
}

/**
 * Format parsed goal for display
 */
export function formatParsedGoal(parsed: ParsedGoal): string {
  const parts: string[] = [parsed.description];

  if (parsed.targetValue !== null && parsed.targetUnit !== null) {
    parts.push(`\n  Target: ${parsed.targetValue} ${parsed.targetUnit}`);
  }

  if (parsed.deadline) {
    const dateStr = parsed.deadline.toISOString().split('T')[0];
    parts.push(`\n  Deadline: ${dateStr}`);
  }

  return parts.join('');
}

/**
 * Prompt user for missing goal components interactively
 * Returns completed ParsedGoal or null if user cancels
 */
export async function promptForMissingComponents(
  parsed: ParsedGoal,
  inquirer: InquirerLike
): Promise<ParsedGoal | null> {
  const result = { ...parsed };

  // Prompt for target value if missing
  if (result.targetValue === null) {
    const answer = await inquirer.prompt<{ targetValue: number }>([{
      type: 'number',
      name: 'targetValue',
      message: 'Target (e.g., 10, 50, 1000):',
      validate: (val: unknown) => (typeof val === 'number' && val > 0) || 'Must be a positive number'
    }]);

    if (!answer.targetValue) return null;
    result.targetValue = answer.targetValue;
  }

  // Prompt for unit if missing
  if (result.targetUnit === null) {
    const answer = await inquirer.prompt<{ targetUnit: string }>([{
      type: 'input',
      name: 'targetUnit',
      message: 'Unit (e.g., leads, revenue, posts, features):',
      validate: (val: unknown) => (typeof val === 'string' && val.trim().length > 0) || 'Unit is required'
    }]);

    if (!answer.targetUnit) return null;
    result.targetUnit = answer.targetUnit.trim().toLowerCase();
  }

  // Prompt for deadline (optional)
  if (!result.deadline) {
    const answer = await inquirer.prompt<{ deadline: string }>([{
      type: 'input',
      name: 'deadline',
      message: 'Deadline (optional, e.g., Jan 10, Q1 2026, 30 days):',
      default: ''
    }]);

    if (answer.deadline && answer.deadline.trim()) {
      const parsed = parseDate(answer.deadline.trim());
      if (parsed) {
        result.deadline = parsed;
      } else {
        console.warn('⚠️  Could not parse deadline. Skipping.');
      }
    }
  }

  // Update description if it doesn't include the target
  if (!result.description.includes(String(result.targetValue))) {
    const deadlineStr = result.deadline
      ? ` by ${result.deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : '';

    result.description = `${result.description} (${result.targetValue} ${result.targetUnit}${deadlineStr})`;
  }

  return result;
}

/**
 * Extract target keywords from goal description for agent matching
 * Examples:
 * - "Identify 10 qualified leads" → ["identify", "qualified", "leads"]
 * - "Generate $50K revenue" → ["generate", "revenue"]
 */
export function extractKeywords(description: string): string[] {
  // Remove numbers and common words
  const stopWords = ['the', 'a', 'an', 'to', 'of', 'for', 'by', 'in', 'on', 'at', 'and', 'or'];

  return description
    .toLowerCase()
    .replace(/\d+/g, '') // Remove numbers
    .replace(/[^\w\s]/g, ' ') // Remove punctuation
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.includes(word))
    .slice(0, 5); // Top 5 keywords
}
