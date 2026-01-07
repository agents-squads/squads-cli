/**
 * Skill management commands for Agent Skills API
 *
 * Commands:
 * - squads skill list          # List uploaded skills
 * - squads skill upload <path> # Upload a skill directory
 * - squads skill delete <id>   # Delete a skill
 * - squads skill show <id>     # Show skill details
 * - squads skill convert <agent> # Convert agent.md to SKILL.md format
 */

import { Command } from 'commander';
import ora from 'ora';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import {
  listSkills,
  uploadSkill,
  deleteSkill,
  getSkill,
  isApiKeyConfigured,
  Skill
} from '../lib/anthropic.js';
import {
  findSquadsDir,
  loadAgentDefinition
} from '../lib/squad-parser.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine
} from '../lib/terminal.js';

/**
 * Register skill command with the CLI program
 */
export function registerSkillCommand(program: Command): void {
  const skill = program
    .command('skill')
    .description('Manage Agent Skills (upload, list, delete)');

  // List skills
  skill
    .command('list')
    .description('List uploaded skills from Anthropic API')
    .action(skillListCommand);

  // Upload skill
  skill
    .command('upload <path>')
    .description('Upload a skill directory to Anthropic API')
    .action(skillUploadCommand);

  // Delete skill
  skill
    .command('delete <skillId>')
    .description('Delete a skill from Anthropic API')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(skillDeleteCommand);

  // Show skill details
  skill
    .command('show <skillId>')
    .description('Show details for a skill')
    .action(skillShowCommand);

  // Convert agent to skill format
  skill
    .command('convert <agent>')
    .description('Convert an agent.md file to SKILL.md format')
    .option('-o, --output <path>', 'Output directory (default: .agents/skills/<agent-name>)')
    .action(skillConvertCommand);
}

/**
 * List all uploaded skills
 */
async function skillListCommand(): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('Skills')} ${colors.dim}list${RESET}`);
  writeLine();

  if (!isApiKeyConfigured()) {
    writeLine(`  ${icons.error} ${colors.red}ANTHROPIC_API_KEY not configured${RESET}`);
    writeLine(`  ${colors.dim}Set the environment variable to use skills management.${RESET}`);
    writeLine();
    return;
  }

  const spinner = ora('Fetching skills...').start();

  try {
    const skills = await listSkills();

    if (skills.length === 0) {
      spinner.info('No skills uploaded yet');
      writeLine();
      writeLine(`  ${colors.dim}Upload a skill:${RESET}`);
      writeLine(`    ${colors.cyan}squads skill upload <path>${RESET}`);
      writeLine();
      writeLine(`  ${colors.dim}Convert an agent to skill format:${RESET}`);
      writeLine(`    ${colors.cyan}squads skill convert <squad>/<agent>${RESET}`);
      writeLine();
      return;
    }

    spinner.succeed(`Found ${skills.length} skill(s)`);
    writeLine();

    // Display skills table
    writeLine(`  ${colors.dim}ID${RESET}                    ${colors.dim}Title${RESET}                ${colors.dim}Updated${RESET}`);
    writeLine(`  ${colors.dim}${'─'.repeat(60)}${RESET}`);

    for (const skill of skills) {
      const id = skill.id.slice(0, 20).padEnd(22);
      const title = (skill.display_title || 'Untitled').slice(0, 20).padEnd(22);
      const updated = new Date(skill.updated_at).toLocaleDateString();
      writeLine(`  ${colors.cyan}${id}${RESET}${title}${colors.dim}${updated}${RESET}`);
    }

    writeLine();
  } catch (error) {
    spinner.fail('Failed to list skills');
    writeLine(`  ${colors.red}${error instanceof Error ? error.message : String(error)}${RESET}`);
    writeLine();
  }
}

/**
 * Upload a skill directory
 */
async function skillUploadCommand(skillPath: string): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('Skills')} ${colors.dim}upload${RESET}`);
  writeLine();

  if (!isApiKeyConfigured()) {
    writeLine(`  ${icons.error} ${colors.red}ANTHROPIC_API_KEY not configured${RESET}`);
    writeLine(`  ${colors.dim}Set the environment variable to use skills management.${RESET}`);
    writeLine();
    return;
  }

  // Resolve path
  const fullPath = skillPath.startsWith('/') ? skillPath : join(process.cwd(), skillPath);

  if (!existsSync(fullPath)) {
    writeLine(`  ${icons.error} ${colors.red}Directory not found: ${skillPath}${RESET}`);
    writeLine();
    return;
  }

  // Check for SKILL.md
  const skillMdPath = join(fullPath, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    writeLine(`  ${icons.error} ${colors.red}SKILL.md not found in ${skillPath}${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Create a SKILL.md file or use:${RESET}`);
    writeLine(`    ${colors.cyan}squads skill convert <squad>/<agent>${RESET}`);
    writeLine();
    return;
  }

  const spinner = ora('Uploading skill...').start();

  try {
    const skill = await uploadSkill(fullPath);
    spinner.succeed(`Skill uploaded: ${skill.display_title}`);
    writeLine();
    writeLine(`  ${colors.dim}ID:${RESET} ${colors.cyan}${skill.id}${RESET}`);
    if (skill.description) {
      writeLine(`  ${colors.dim}Description:${RESET} ${skill.description}`);
    }
    writeLine();
    writeLine(`  ${colors.dim}Use in run command:${RESET}`);
    writeLine(`    ${colors.cyan}squads run <squad> --skills ${skill.id}${RESET}`);
    writeLine();
  } catch (error) {
    spinner.fail('Failed to upload skill');
    writeLine(`  ${colors.red}${error instanceof Error ? error.message : String(error)}${RESET}`);
    writeLine();
  }
}

/**
 * Delete a skill
 */
async function skillDeleteCommand(skillId: string, options: { force?: boolean }): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('Skills')} ${colors.dim}delete${RESET}`);
  writeLine();

  if (!isApiKeyConfigured()) {
    writeLine(`  ${icons.error} ${colors.red}ANTHROPIC_API_KEY not configured${RESET}`);
    writeLine();
    return;
  }

  if (!options.force) {
    writeLine(`  ${colors.yellow}Warning: This will permanently delete the skill.${RESET}`);
    writeLine(`  ${colors.dim}Use --force to skip this confirmation.${RESET}`);
    writeLine();
    // In a real CLI, we'd prompt for confirmation here
    // For now, require --force
    return;
  }

  const spinner = ora('Deleting skill...').start();

  try {
    await deleteSkill(skillId);
    spinner.succeed(`Skill deleted: ${skillId}`);
    writeLine();
  } catch (error) {
    spinner.fail('Failed to delete skill');
    writeLine(`  ${colors.red}${error instanceof Error ? error.message : String(error)}${RESET}`);
    writeLine();
  }
}

/**
 * Show skill details
 */
async function skillShowCommand(skillId: string): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('Skills')} ${colors.dim}show${RESET}`);
  writeLine();

  if (!isApiKeyConfigured()) {
    writeLine(`  ${icons.error} ${colors.red}ANTHROPIC_API_KEY not configured${RESET}`);
    writeLine();
    return;
  }

  const spinner = ora('Fetching skill...').start();

  try {
    const skill = await getSkill(skillId);

    if (!skill) {
      spinner.fail(`Skill not found: ${skillId}`);
      writeLine();
      return;
    }

    spinner.succeed(`Found skill: ${skill.display_title}`);
    writeLine();
    writeLine(`  ${colors.dim}ID:${RESET}          ${colors.cyan}${skill.id}${RESET}`);
    writeLine(`  ${colors.dim}Title:${RESET}       ${skill.display_title}`);
    if (skill.description) {
      writeLine(`  ${colors.dim}Description:${RESET} ${skill.description}`);
    }
    writeLine(`  ${colors.dim}Created:${RESET}     ${new Date(skill.created_at).toLocaleString()}`);
    writeLine(`  ${colors.dim}Updated:${RESET}     ${new Date(skill.updated_at).toLocaleString()}`);

    if (skill.files && skill.files.length > 0) {
      writeLine();
      writeLine(`  ${colors.dim}Files:${RESET}`);
      for (const file of skill.files) {
        const size = Buffer.byteLength(file.content, 'utf-8');
        writeLine(`    ${colors.cyan}${file.name}${RESET} ${colors.dim}(${formatBytes(size)})${RESET}`);
      }
    }

    writeLine();
  } catch (error) {
    spinner.fail('Failed to fetch skill');
    writeLine(`  ${colors.red}${error instanceof Error ? error.message : String(error)}${RESET}`);
    writeLine();
  }
}

/**
 * Convert an agent.md file to SKILL.md format
 */
async function skillConvertCommand(
  agentPath: string,
  options: { output?: string }
): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('Skills')} ${colors.dim}convert${RESET}`);
  writeLine();

  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`  ${icons.error} ${colors.red}No .agents/squads directory found${RESET}`);
    writeLine();
    return;
  }

  // Parse agent path (squad/agent or just agent)
  let agentFilePath: string;
  let squadName: string;
  let agentName: string;

  if (agentPath.includes('/')) {
    const [squad, agent] = agentPath.split('/');
    squadName = squad;
    agentName = agent.replace('.md', '');
    agentFilePath = join(squadsDir, squad, `${agentName}.md`);
  } else {
    // Search for agent in all squads
    agentName = agentPath.replace('.md', '');
    const foundPath = findAgentFile(squadsDir, agentName);
    if (!foundPath) {
      writeLine(`  ${icons.error} ${colors.red}Agent not found: ${agentPath}${RESET}`);
      writeLine(`  ${colors.dim}Use format: squad/agent (e.g., cli/code-eval)${RESET}`);
      writeLine();
      return;
    }
    agentFilePath = foundPath;
    squadName = basename(dirname(agentFilePath));
  }

  if (!existsSync(agentFilePath)) {
    writeLine(`  ${icons.error} ${colors.red}Agent file not found: ${agentFilePath}${RESET}`);
    writeLine();
    return;
  }

  // Read agent definition
  const agentContent = readFileSync(agentFilePath, 'utf-8');

  // Determine output directory
  const skillName = `${squadName}-${agentName}`;
  const outputDir = options.output ||
    join(dirname(squadsDir), 'skills', skillName);

  // Create output directory
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Convert to SKILL.md format
  const skillMd = convertAgentToSkill(agentContent, squadName, agentName);

  // Write SKILL.md
  const skillMdPath = join(outputDir, 'SKILL.md');
  writeFileSync(skillMdPath, skillMd);

  writeLine(`  ${icons.success} ${colors.green}Converted:${RESET} ${agentPath}`);
  writeLine();
  writeLine(`  ${colors.dim}Output:${RESET} ${outputDir}`);
  writeLine(`  ${colors.dim}Files:${RESET}`);
  writeLine(`    ${colors.cyan}SKILL.md${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}Next steps:${RESET}`);
  writeLine(`    1. Review and edit ${colors.cyan}SKILL.md${RESET}`);
  writeLine(`    2. Add scripts or examples if needed`);
  writeLine(`    3. Upload: ${colors.cyan}squads skill upload ${outputDir}${RESET}`);
  writeLine();
}

/**
 * Find an agent file by name across all squads
 */
function findAgentFile(squadsDir: string, agentName: string): string | null {
  const { readdirSync } = require('fs');
  const squads = readdirSync(squadsDir, { withFileTypes: true })
    .filter((d: { isDirectory: () => boolean; name: string }) =>
      d.isDirectory() && !d.name.startsWith('_'))
    .map((d: { name: string }) => d.name);

  for (const squad of squads) {
    const agentPath = join(squadsDir, squad, `${agentName}.md`);
    if (existsSync(agentPath)) {
      return agentPath;
    }
  }

  return null;
}

/**
 * Convert agent.md content to SKILL.md format
 */
function convertAgentToSkill(
  agentContent: string,
  squadName: string,
  agentName: string
): string {
  // Extract existing frontmatter if present
  let existingMeta: Record<string, string> = {};
  let bodyContent = agentContent;

  const frontmatterMatch = agentContent.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    bodyContent = frontmatterMatch[2];

    // Parse simple YAML key: value pairs
    for (const line of frontmatter.split('\n')) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        existingMeta[match[1]] = match[2].trim();
      }
    }
  }

  // Extract title from first heading if not in frontmatter
  const title = existingMeta.name ||
    bodyContent.match(/^#\s+(?:Agent:\s*)?(.+)$/m)?.[1] ||
    `${squadName}-${agentName}`;

  // Extract role/description from agent content
  const roleMatch = bodyContent.match(/^(?:role|description):\s*(.+)$/mi) ||
    bodyContent.match(/^##?\s*(?:Role|Purpose|Description)\s*\n+(.+)/mi);
  const description = existingMeta.description ||
    roleMatch?.[1] ||
    `Agent from ${squadName} squad. Use when working on ${agentName}-related tasks.`;

  // Build SKILL.md
  const skillMd = `---
name: ${squadName}-${agentName}
description: ${description}
---

# ${title}

${bodyContent.trim()}
`;

  return skillMd;
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}
