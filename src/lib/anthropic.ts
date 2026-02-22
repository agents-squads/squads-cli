/**
 * Anthropic SDK wrapper for Skills API
 *
 * Handles direct API calls for skills management:
 * - List uploaded skills
 * - Upload new skills
 * - Delete skills
 * - Get skill details
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Beta headers required for Skills API (reserved for API implementation)
const _SKILLS_BETA = 'skills-2025-10-02';
const _CODE_EXECUTION_BETA = 'code-execution-2025-08-25';

export interface Skill {
  id: string;
  display_title: string;
  description?: string;
  created_at: string;
  updated_at: string;
  files?: SkillFile[];
}

export interface SkillFile {
  name: string;
  content: string;
}

let client: Anthropic | null = null;

/**
 * Get or create Anthropic client instance
 */
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for skills management');
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

/**
 * List all uploaded skills
 */
export async function listSkills(): Promise<Skill[]> {
  // Validate API key is available
  getClient();

  try {
    // Note: The actual Skills API may have a different endpoint
    // This is a placeholder until we have the exact API spec
    // Real implementation will use: anthropic.beta.skills.list({ betas: [SKILLS_BETA] })
    return [];
  } catch (error) {
    if (error instanceof Error && error.message.includes('404')) {
      // Skills not supported yet or endpoint not found
      return [];
    }
    throw error;
  }
}

/**
 * Load skill files from a directory
 * Expects: SKILL.md and optionally scripts/, examples/, etc.
 */
export function loadSkillFiles(skillPath: string): SkillFile[] {
  const files: SkillFile[] = [];

  function walkDir(dir: string, prefix = ''): void {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Recursively walk subdirectories
        walkDir(fullPath, relativePath);
      } else if (entry.isFile()) {
        // Read file content
        const content = readFileSync(fullPath, 'utf-8');
        files.push({
          name: relativePath,
          content
        });
      }
    }
  }

  walkDir(skillPath);
  return files;
}

/**
 * Extract skill title from SKILL.md frontmatter or first heading
 */
export function extractSkillTitle(files: SkillFile[]): string {
  const skillMd = files.find(f => f.name === 'SKILL.md' || f.name.endsWith('/SKILL.md'));
  if (!skillMd) {
    throw new Error('SKILL.md not found in skill directory');
  }

  const content = skillMd.content;

  // Try YAML frontmatter first
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const nameMatch = frontmatterMatch[1].match(/^name:\s*(.+)$/m);
    if (nameMatch) {
      return nameMatch[1].trim();
    }
  }

  // Fall back to first markdown heading
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }

  throw new Error('Could not extract skill title from SKILL.md');
}

/**
 * Extract skill description from SKILL.md
 */
export function extractSkillDescription(files: SkillFile[]): string | undefined {
  const skillMd = files.find(f => f.name === 'SKILL.md' || f.name.endsWith('/SKILL.md'));
  if (!skillMd) return undefined;

  const content = skillMd.content;

  // Try YAML frontmatter first
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const descMatch = frontmatterMatch[1].match(/^description:\s*(.+)$/m);
    if (descMatch) {
      return descMatch[1].trim();
    }
  }

  // Fall back to first paragraph after heading
  const paragraphMatch = content.match(/^#.+\n+(.+)/m);
  if (paragraphMatch) {
    return paragraphMatch[1].trim();
  }

  return undefined;
}

/**
 * Upload a skill to Anthropic
 */
export async function uploadSkill(skillPath: string): Promise<Skill> {
  // Validate API key is available
  getClient();
  const files = loadSkillFiles(skillPath);

  if (files.length === 0) {
    throw new Error(`No files found in skill directory: ${skillPath}`);
  }

  // Check total size (8MB limit)
  const totalSize = files.reduce((sum, f) => sum + Buffer.byteLength(f.content, 'utf-8'), 0);
  const maxSize = 8 * 1024 * 1024; // 8MB
  if (totalSize > maxSize) {
    throw new Error(`Skill size ${(totalSize / 1024 / 1024).toFixed(2)}MB exceeds 8MB limit`);
  }

  const displayTitle = extractSkillTitle(files);
  const description = extractSkillDescription(files);

  try {
    // Note: This is a placeholder for the actual Skills API endpoint
    // The real implementation will use the correct beta endpoint
    // Placeholder response until we have actual API spec
    const skill: Skill = {
      id: `skill_${Date.now()}`,
      display_title: displayTitle,
      description,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      files
    };

    return skill;
  } catch (error) {
    throw new Error(`Failed to upload skill: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Delete a skill by ID
 */
export async function deleteSkill(skillId: string): Promise<void> {
  // Validate API key is available
  getClient();

  try {
    // Placeholder until we have actual API spec
    // No-op: Skills API not yet available
  } catch (error) {
    throw new Error(`Failed to delete skill: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get skill details by ID
 */
export async function getSkill(skillId: string): Promise<Skill | null> {
  // Validate API key is available
  getClient();

  try {
    // Placeholder until we have actual API spec
    return null;
  } catch (error) {
    if (error instanceof Error && error.message.includes('404')) {
      return null;
    }
    throw error;
  }
}

/**
 * Check if API key is configured
 */
export function isApiKeyConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
