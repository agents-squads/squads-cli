/**
 * Template loading and variable substitution for squads setup
 *
 * Template sources (checked in order):
 * 1. Local agents-squads repo clone (if in agents-squads directory)
 * 2. User's global templates (~/.squads/templates/)
 * 3. Bundled templates (dist/templates/)
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// GitHub repo for templates
export const AGENTS_SQUADS_REPO = 'https://github.com/agents-squads/agents-squads.git';

/**
 * Template source info
 */
export interface TemplateSource {
  type: 'repo' | 'global' | 'bundled';
  path: string;
  description: string;
}

/**
 * Find templates directory with priority:
 * 1. Local agents-squads repo (best - has domain starters)
 * 2. User's global templates (~/.squads/templates/)
 * 3. Bundled templates in CLI package
 */
function findTemplatesDir(): TemplateSource {
  // 1. Check for local agents-squads repo (look for .agents/squads/_template)
  const repoLocations = [
    join(process.cwd(), '..', 'agents-squads'),           // Sibling directory
    join(homedir(), 'agents-squads', 'agents-squads'),    // Common clone location
    join(homedir(), 'code', 'agents-squads'),             // Alternative
    join(homedir(), 'projects', 'agents-squads'),         // Alternative
  ];

  for (const repoPath of repoLocations) {
    const templatePath = join(repoPath, '.agents', 'squads', '_template');
    if (existsSync(templatePath) && existsSync(join(templatePath, 'SQUAD.md'))) {
      return {
        type: 'repo',
        path: repoPath,
        description: `agents-squads repo at ${repoPath}`,
      };
    }
  }

  // 2. Check user's global templates
  const globalTemplates = join(homedir(), '.squads', 'templates');
  if (existsSync(globalTemplates)) {
    return {
      type: 'global',
      path: globalTemplates,
      description: 'User global templates (~/.squads/templates/)',
    };
  }

  // 3. Fall back to bundled templates
  const bundledLocations = [
    join(__dirname, '..', 'templates'),           // dist/templates (production)
    join(__dirname, '..', '..', 'templates'),     // src/../templates (dev)
    join(__dirname, '..', '..', '..', 'templates'), // npm installed
  ];

  for (const bundled of bundledLocations) {
    if (existsSync(bundled)) {
      return {
        type: 'bundled',
        path: bundled,
        description: 'CLI bundled templates',
      };
    }
  }

  // Default fallback
  return {
    type: 'bundled',
    path: join(__dirname, '..', '..', 'templates'),
    description: 'CLI bundled templates (not found)',
  };
}

const TEMPLATE_SOURCE = findTemplatesDir();

/**
 * Get current template source info
 */
export function getTemplateSource(): TemplateSource {
  return TEMPLATE_SOURCE;
}

/**
 * Check if using agents-squads repo templates
 */
export function isUsingRepoTemplates(): boolean {
  return TEMPLATE_SOURCE.type === 'repo';
}

/**
 * Template variables for substitution
 */
export interface TemplateVariables {
  // Squad variables
  SQUAD_NAME?: string;       // Human-readable name: "My First Squad"
  SQUAD_ID?: string;         // Kebab-case ID: "my-first-squad"
  SQUAD_DESCRIPTION?: string;
  GOAL?: string;

  // Provider variables
  PROVIDER?: string;         // Provider ID: "claude", "gemini", etc.
  PROVIDER_NAME?: string;    // Display name: "Claude Code (Anthropic)"

  // Custom variables
  [key: string]: string | undefined;
}

/**
 * Resolve template path based on source type
 */
function resolveTemplatePath(templatePath: string): string {
  if (TEMPLATE_SOURCE.type === 'repo') {
    // For repo source, map template paths to repo structure
    // CLI templates are in different locations than repo templates
    const mappings: Record<string, string> = {
      'first-squad/SQUAD.md.template': '.agents/squads/_template/SQUAD.md',
      'first-squad/lead.md.template': '.agents/squads/_template/agent.md',
      'core/AGENTS.md.template': 'AGENTS.md',  // Use repo's AGENTS.md? Or skip
      'core/CLAUDE.md.template': 'CLAUDE.md',
    };

    const mapped = mappings[templatePath];
    if (mapped) {
      return join(TEMPLATE_SOURCE.path, mapped);
    }

    // For unmapped, try direct path
    return join(TEMPLATE_SOURCE.path, templatePath);
  }

  // For bundled/global, use direct path
  return join(TEMPLATE_SOURCE.path, templatePath);
}

/**
 * Load a template file and substitute variables
 */
export function loadTemplate(templatePath: string, variables: TemplateVariables = {}): string {
  const fullPath = resolveTemplatePath(templatePath);

  if (!existsSync(fullPath)) {
    // Try bundled fallback if repo template not found
    if (TEMPLATE_SOURCE.type === 'repo') {
      const bundledPath = join(__dirname, '..', 'templates', templatePath);
      if (existsSync(bundledPath)) {
        return loadTemplateFromPath(bundledPath, variables);
      }
    }
    throw new Error(`Template not found: ${templatePath} (source: ${TEMPLATE_SOURCE.description})`);
  }

  return loadTemplateFromPath(fullPath, variables);
}

function loadTemplateFromPath(fullPath: string, variables: TemplateVariables): string {
  let content = readFileSync(fullPath, 'utf-8');

  // Substitute all {{VARIABLE}} patterns
  for (const [key, value] of Object.entries(variables)) {
    if (value !== undefined) {
      const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      content = content.replace(pattern, value);
    }
  }

  // Also substitute {VARIABLE} patterns (used in repo templates)
  for (const [key, value] of Object.entries(variables)) {
    if (value !== undefined) {
      const pattern = new RegExp(`\\{${key}\\}`, 'g');
      content = content.replace(pattern, value);
    }
  }

  return content;
}

/**
 * Check if a template exists
 */
export function templateExists(templatePath: string): boolean {
  return existsSync(resolveTemplatePath(templatePath));
}

/**
 * Get domain starters from agents-squads repo
 * Returns available domains if using repo templates
 */
export function getDomainStarters(): string[] {
  if (TEMPLATE_SOURCE.type !== 'repo') {
    return [];
  }

  const domainsDir = join(TEMPLATE_SOURCE.path, 'domains');
  if (!existsSync(domainsDir)) {
    return [];
  }

  return readdirSync(domainsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

/**
 * Copy a domain starter to current directory
 */
export function getDomainStarterPath(domain: string): string | null {
  if (TEMPLATE_SOURCE.type !== 'repo') {
    return null;
  }

  const domainPath = join(TEMPLATE_SOURCE.path, 'domains', domain);
  if (!existsSync(domainPath)) {
    return null;
  }

  return domainPath;
}

/**
 * List all templates in a directory
 */
export function listTemplates(dir: string): string[] {
  let fullDir: string;

  if (TEMPLATE_SOURCE.type === 'repo') {
    fullDir = join(TEMPLATE_SOURCE.path, '.agents', 'squads', '_template');
  } else {
    fullDir = join(TEMPLATE_SOURCE.path, dir);
  }

  if (!existsSync(fullDir)) {
    return [];
  }

  return readdirSync(fullDir).filter(f => {
    const stat = statSync(join(fullDir, f));
    return stat.isFile() && (f.endsWith('.template') || f.endsWith('.md'));
  });
}

/**
 * Get the templates directory path
 */
export function getTemplatesDir(): string {
  return TEMPLATE_SOURCE.path;
}

/**
 * Load all templates from a directory with variables substituted
 */
export function loadTemplateDirectory(
  dir: string,
  variables: TemplateVariables = {}
): Map<string, string> {
  const result = new Map<string, string>();
  const fullDir = join(TEMPLATE_SOURCE.path, dir);

  if (!existsSync(fullDir)) {
    return result;
  }

  const processDir = (currentDir: string, prefix: string) => {
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        processDir(fullPath, relativePath);
      } else if (entry.isFile()) {
        let content = readFileSync(fullPath, 'utf-8');

        // Substitute variables
        for (const [key, value] of Object.entries(variables)) {
          if (value !== undefined) {
            const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
            content = content.replace(pattern, value);
          }
        }

        // Remove .template suffix for output filename
        const outputName = relativePath.replace(/\.template$/, '');
        result.set(outputName, content);
      }
    }
  };

  processDir(fullDir, '');
  return result;
}

/**
 * Convert a name to kebab-case for use as ID
 */
export function toKebabCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Convert a name to Title Case for display
 */
export function toTitleCase(name: string): string {
  return name
    .split(/[-_\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
