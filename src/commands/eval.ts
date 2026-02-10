/**
 * squads eval — Agent readiness scorer.
 *
 * Evaluates an agent's readiness for autonomous or platform deployment
 * by checking definition quality, execution history, memory usage,
 * output consistency, and resource safety.
 *
 * Readiness levels:
 * - Untested: No local runs → cannot deploy
 * - Development: 1+ runs → local autonomous (L2) with supervision
 * - Staging: 5+ runs, >80% success → cloud with approval gates
 * - Production: 10+ runs, >95% success, memory working → cloud autonomous
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import {
  findSquadsDir,
  loadSquad,
  listAgents,
  Agent,
} from '../lib/squad-parser.js';
import { findMemoryDir } from '../lib/memory.js';
import { track } from '../lib/telemetry.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface EvalDimension {
  name: string;
  score: number; // 0-10
  maxScore: number;
  status: 'pass' | 'warn' | 'fail';
  details: string;
}

interface EvalResult {
  agent: string;
  squad: string;
  overallScore: number; // 0-100
  readinessLevel: 'untested' | 'development' | 'staging' | 'production';
  dimensions: EvalDimension[];
  recommendations: string[];
}

// Required frontmatter fields for a well-defined agent
const REQUIRED_FIELDS = ['name', 'role', 'model'];
const RECOMMENDED_FIELDS = ['squad', 'trigger', 'schedule', 'status', 'timeout'];

// Patterns that indicate destructive actions
const DESTRUCTIVE_PATTERNS = [
  /force.push/i,
  /--force/,
  /git\s+reset\s+--hard/i,
  /rm\s+-rf/,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
  /--dangerously/,
];

// ─── Scoring Functions ───────────────────────────────────────────────────────

function scoreDefinitionQuality(agentPath: string): EvalDimension {
  const content = readFileSync(agentPath, 'utf-8');

  let score = 0;
  const maxScore = 10;
  const issues: string[] = [];

  // Parse frontmatter
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = matter(content);
    frontmatter = parsed.data || {};
  } catch {
    return {
      name: 'Definition quality',
      score: 0,
      maxScore,
      status: 'fail',
      details: 'Failed to parse frontmatter',
    };
  }

  // Check required fields (3 points)
  let requiredPresent = 0;
  for (const field of REQUIRED_FIELDS) {
    if (frontmatter[field]) {
      requiredPresent++;
    } else {
      issues.push(`Missing required field: ${field}`);
    }
  }
  score += Math.round((requiredPresent / REQUIRED_FIELDS.length) * 3);

  // Check recommended fields (2 points)
  let recommendedPresent = 0;
  for (const field of RECOMMENDED_FIELDS) {
    if (frontmatter[field]) recommendedPresent++;
  }
  score += Math.round((recommendedPresent / RECOMMENDED_FIELDS.length) * 2);

  // Check instruction length (2 points)
  const bodyLength = content.split('---').slice(2).join('---').trim().length;
  if (bodyLength > 500) {
    score += 2;
  } else if (bodyLength > 200) {
    score += 1;
    issues.push('Instructions could be more detailed');
  } else {
    issues.push('Instructions are very short (<200 chars)');
  }

  // Check for role/mission description (1 point)
  if (content.match(/##\s*(Role|Mission|Purpose|Responsibilities)/i)) {
    score += 1;
  } else {
    issues.push('No Role/Mission section found');
  }

  // Check for output format (1 point)
  if (content.match(/##\s*(Output|Format|Report|Deliverable)/i)) {
    score += 1;
  } else {
    issues.push('No Output format section');
  }

  // Check for constraints/rules (1 point)
  if (content.match(/##\s*(Constraints|Rules|Never|Always|Guidelines)/i)) {
    score += 1;
  }

  const status = score >= 8 ? 'pass' : score >= 5 ? 'warn' : 'fail';
  const details = issues.length > 0 ? issues.join('; ') : 'Well-defined agent';

  return { name: 'Definition quality', score, maxScore, status, details };
}

function scoreExecutionReliability(memoryDir: string, squad: string, agent: string): EvalDimension {
  const maxScore = 10;
  const agentMemoryDir = join(memoryDir, squad, agent);

  if (!existsSync(agentMemoryDir)) {
    return {
      name: 'Execution reliability',
      score: 0,
      maxScore,
      status: 'fail',
      details: 'No execution history found',
    };
  }

  // Check for state.md (indicates the agent has run and persisted state)
  const stateFile = join(agentMemoryDir, 'state.md');
  const outputFile = join(agentMemoryDir, 'output.md');

  let runsDetected = 0;
  let hasRecentActivity = false;

  // Count evidence of runs from state.md modifications
  if (existsSync(stateFile)) {
    const stat = statSync(stateFile);
    const fileContent = readFileSync(stateFile, 'utf-8');
    runsDetected += fileContent.length > 50 ? 1 : 0;

    // Check if modified in last 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    if (stat.mtimeMs > sevenDaysAgo) {
      hasRecentActivity = true;
      runsDetected += 2;
    }
  }

  if (existsSync(outputFile)) {
    const stat = statSync(outputFile);
    const fileContent = readFileSync(outputFile, 'utf-8');
    runsDetected += fileContent.length > 100 ? 2 : 1;

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    if (stat.mtimeMs > sevenDaysAgo) {
      hasRecentActivity = true;
    }
  }

  // Check for execution log files
  const logDir = join(memoryDir, '..', 'logs', squad);
  if (existsSync(logDir)) {
    try {
      const logFiles = readdirSync(logDir).filter(f => f.startsWith(agent));
      runsDetected += logFiles.length;
    } catch { /* ignore */ }
  }

  // Score based on evidence
  let score = 0;
  if (runsDetected >= 10) score = 10;
  else if (runsDetected >= 5) score = 8;
  else if (runsDetected >= 3) score = 6;
  else if (runsDetected >= 1) score = 4;
  else score = 0;

  // Bonus for recent activity
  if (hasRecentActivity && score < 10) score = Math.min(score + 1, 10);

  const status = score >= 8 ? 'pass' : score >= 4 ? 'warn' : 'fail';
  const details = runsDetected === 0
    ? 'No runs detected'
    : `~${runsDetected} run(s) detected${hasRecentActivity ? ', active in last 7 days' : ''}`;

  return { name: 'Execution reliability', score, maxScore, status, details };
}

function scoreMemoryUtilization(memoryDir: string, squad: string, agent: string): EvalDimension {
  const maxScore = 10;
  const agentMemoryDir = join(memoryDir, squad, agent);

  if (!existsSync(agentMemoryDir)) {
    return {
      name: 'Memory utilization',
      score: 0,
      maxScore,
      status: 'fail',
      details: 'No memory directory',
    };
  }

  let score = 0;
  const issues: string[] = [];

  // Check state.md exists and has content (3 points)
  const stateFile = join(agentMemoryDir, 'state.md');
  if (existsSync(stateFile)) {
    const content = readFileSync(stateFile, 'utf-8').trim();
    if (content.length > 100) {
      score += 3;
    } else if (content.length > 0) {
      score += 1;
      issues.push('state.md exists but is sparse');
    } else {
      issues.push('state.md is empty');
    }
  } else {
    issues.push('No state.md — agent doesn\'t persist state');
  }

  // Check learnings.md exists and has content (3 points)
  const learningsFile = join(agentMemoryDir, 'learnings.md');
  if (existsSync(learningsFile)) {
    const content = readFileSync(learningsFile, 'utf-8').trim();
    if (content.length > 100) {
      score += 3;
    } else if (content.length > 0) {
      score += 1;
      issues.push('learnings.md exists but is sparse');
    } else {
      issues.push('learnings.md is empty');
    }
  } else {
    issues.push('No learnings.md — agent doesn\'t learn across runs');
  }

  // Check output.md exists and has content (2 points)
  const outputFile = join(agentMemoryDir, 'output.md');
  if (existsSync(outputFile)) {
    const content = readFileSync(outputFile, 'utf-8').trim();
    if (content.length > 50) {
      score += 2;
    } else {
      score += 1;
      issues.push('output.md is sparse');
    }
  } else {
    issues.push('No output.md');
  }

  // Check for briefs or additional memory files (2 points)
  try {
    const files = readdirSync(agentMemoryDir);
    const extraFiles = files.filter(f => !['state.md', 'output.md', 'learnings.md'].includes(f));
    if (extraFiles.length > 0) {
      score += 2;
    }
  } catch { /* ignore */ }

  const status = score >= 8 ? 'pass' : score >= 4 ? 'warn' : 'fail';
  const details = issues.length > 0 ? issues.join('; ') : 'Memory well-utilized';

  return { name: 'Memory utilization', score, maxScore, status, details };
}

function scoreOutputConsistency(memoryDir: string, squad: string, agent: string): EvalDimension {
  const maxScore = 10;
  const outputFile = join(memoryDir, squad, agent, 'output.md');

  if (!existsSync(outputFile)) {
    return {
      name: 'Output consistency',
      score: 0,
      maxScore,
      status: 'fail',
      details: 'No output.md found',
    };
  }

  const content = readFileSync(outputFile, 'utf-8').trim();
  let score = 0;

  // Check if output has structure (headers, lists, etc.)
  const hasHeaders = /^##?\s/m.test(content);
  const hasLists = /^[-*]\s/m.test(content);
  const hasStructuredSections = (content.match(/^##\s/gm) || []).length >= 2;

  if (hasHeaders) score += 3;
  if (hasLists) score += 2;
  if (hasStructuredSections) score += 3;

  // Check reasonable output length
  if (content.length > 200) score += 2;
  else if (content.length > 50) score += 1;

  const status = score >= 8 ? 'pass' : score >= 4 ? 'warn' : 'fail';
  const details = score >= 8
    ? 'Well-structured output'
    : `Output structure: headers=${hasHeaders}, lists=${hasLists}, sections=${hasStructuredSections}`;

  return { name: 'Output consistency', score, maxScore, status, details };
}

function scoreResourceSafety(agentPath: string): EvalDimension {
  const maxScore = 10;
  const content = readFileSync(agentPath, 'utf-8');

  let score = 10;
  const issues: string[] = [];

  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(content)) {
      score -= 2;
      issues.push(`Mentions destructive pattern: ${pattern.source}`);
    }
  }

  // Check if agent has safety constraints
  if (content.match(/##\s*(Constraints|Safety|Rules|Never)/i)) {
    score = Math.min(score + 1, 10);
  }

  score = Math.max(score, 0);
  const status = score >= 8 ? 'pass' : score >= 5 ? 'warn' : 'fail';
  const details = issues.length > 0 ? issues.join('; ') : 'No destructive patterns detected';

  return { name: 'Resource safety', score, maxScore, status, details };
}

// ─── Main Eval ───────────────────────────────────────────────────────────────

function evaluateAgent(squad: string, agentName: string, agentPath: string): EvalResult {
  const memoryDir = findMemoryDir();
  const dimensions: EvalDimension[] = [];

  // 1. Definition quality
  dimensions.push(scoreDefinitionQuality(agentPath));

  // 2. Execution reliability
  if (memoryDir) {
    dimensions.push(scoreExecutionReliability(memoryDir, squad, agentName));
  } else {
    dimensions.push({
      name: 'Execution reliability',
      score: 0,
      maxScore: 10,
      status: 'fail',
      details: 'No memory directory found',
    });
  }

  // 3. Output consistency
  if (memoryDir) {
    dimensions.push(scoreOutputConsistency(memoryDir, squad, agentName));
  } else {
    dimensions.push({
      name: 'Output consistency',
      score: 0,
      maxScore: 10,
      status: 'fail',
      details: 'No memory directory found',
    });
  }

  // 4. Memory utilization
  if (memoryDir) {
    dimensions.push(scoreMemoryUtilization(memoryDir, squad, agentName));
  } else {
    dimensions.push({
      name: 'Memory utilization',
      score: 0,
      maxScore: 10,
      status: 'fail',
      details: 'No memory directory found',
    });
  }

  // 5. Resource safety
  dimensions.push(scoreResourceSafety(agentPath));

  // Calculate overall score
  const totalScore = dimensions.reduce((sum, d) => sum + d.score, 0);
  const totalMax = dimensions.reduce((sum, d) => sum + d.maxScore, 0);
  const overallScore = Math.round((totalScore / totalMax) * 100);

  // Determine readiness level
  let readinessLevel: EvalResult['readinessLevel'];
  const execDim = dimensions.find(d => d.name === 'Execution reliability');
  const execScore = execDim?.score || 0;

  if (execScore === 0) {
    readinessLevel = 'untested';
  } else if (overallScore >= 80 && execScore >= 8) {
    readinessLevel = 'production';
  } else if (overallScore >= 60 && execScore >= 6) {
    readinessLevel = 'staging';
  } else {
    readinessLevel = 'development';
  }

  // Generate recommendations
  const recommendations: string[] = [];
  for (const dim of dimensions) {
    if (dim.status === 'fail') {
      recommendations.push(`Fix: ${dim.name} — ${dim.details}`);
    } else if (dim.status === 'warn') {
      recommendations.push(`Improve: ${dim.name} — ${dim.details}`);
    }
  }

  return {
    agent: agentName,
    squad,
    overallScore,
    readinessLevel,
    dimensions,
    recommendations,
  };
}

// ─── Display ─────────────────────────────────────────────────────────────────

function renderBar(score: number, max: number): string {
  const filled = Math.round((score / max) * 10);
  const empty = 10 - filled;
  const bar = chalk.green('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
  return `${bar} ${score}/${max}`;
}

function renderReadinessLevel(level: EvalResult['readinessLevel']): string {
  switch (level) {
    case 'untested': return chalk.red('UNTESTED');
    case 'development': return chalk.yellow('DEVELOPMENT');
    case 'staging': return chalk.blue('STAGING');
    case 'production': return chalk.green('PRODUCTION');
  }
}

function renderResult(result: EvalResult): void {
  console.log(`
${chalk.bold(`Agent Readiness: ${result.squad}/${result.agent}`)}
${chalk.dim('━'.repeat(50))}
`);

  for (const dim of result.dimensions) {
    const icon = dim.status === 'pass' ? chalk.green('✓')
      : dim.status === 'warn' ? chalk.yellow('⚠')
      : chalk.red('✗');
    console.log(`  ${icon} ${dim.name.padEnd(22)} ${renderBar(dim.score, dim.maxScore)}`);
  }

  console.log(`
  Overall readiness:     ${chalk.bold(String(result.overallScore) + '%')} — ${renderReadinessLevel(result.readinessLevel)}
`);

  if (result.recommendations.length > 0) {
    console.log(`  ${chalk.bold('Recommendations:')}`);
    for (const rec of result.recommendations) {
      console.log(`  ${chalk.dim('→')} ${rec}`);
    }
    console.log('');
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

export async function evalCommand(target: string, options: {
  json?: boolean;
  verbose?: boolean;
}): Promise<void> {
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    console.error(chalk.red('No .agents/squads/ directory found.'));
    console.log(chalk.dim('Run: squads init'));
    return;
  }

  // Parse target: squad/agent or squad
  const parts = target.split('/');
  const squadName = parts[0];
  const agentFilter = parts[1]; // optional

  // Validate squad exists
  const squad = loadSquad(squadName);
  if (!squad) {
    console.error(chalk.red(`Squad not found: ${squadName}`));
    return;
  }

  // Get agents to evaluate
  const allAgents = listAgents(squadsDir, squadName);
  const agents = agentFilter
    ? allAgents.filter(a => a.name === agentFilter)
    : allAgents;

  if (agents.length === 0) {
    console.error(chalk.red(`No agents found${agentFilter ? `: ${agentFilter}` : ''}`));
    return;
  }

  const results: EvalResult[] = [];

  for (const agent of agents) {
    if (!agent.filePath) continue;
    const result = evaluateAgent(squadName, agent.name, agent.filePath);
    results.push(result);
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Render results
  for (const result of results) {
    renderResult(result);
  }

  // Summary if evaluating multiple agents
  if (results.length > 1) {
    const avgScore = Math.round(results.reduce((sum, r) => sum + r.overallScore, 0) / results.length);
    const levels = results.reduce((acc, r) => {
      acc[r.readinessLevel] = (acc[r.readinessLevel] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log(chalk.bold('Squad Summary'));
    console.log(chalk.dim('━'.repeat(50)));
    console.log(`  Agents evaluated: ${results.length}`);
    console.log(`  Average score: ${avgScore}%`);
    for (const [level, count] of Object.entries(levels)) {
      console.log(`  ${renderReadinessLevel(level as EvalResult['readinessLevel'])}: ${count}`);
    }
    console.log('');
  }

  await track('cli.eval', {
    squad: squadName,
    agents: results.length,
    avgScore: Math.round(results.reduce((sum, r) => sum + r.overallScore, 0) / results.length),
  });
}

// ─── Command Registration ────────────────────────────────────────────────────

export function registerEvalCommand(program: Command): void {
  program
    .command('eval <target>')
    .description('Evaluate agent readiness for deployment (e.g., squads eval company/coo)')
    .option('-j, --json', 'Output as JSON')
    .option('-v, --verbose', 'Show detailed scoring info')
    .action((target, options) => evalCommand(target, {
      json: options.json,
      verbose: options.verbose,
    }));
}
