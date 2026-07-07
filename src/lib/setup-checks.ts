/**
 * Setup checks and validation for squads setup command
 * Provides prerequisite checking with helpful fix guidance
 */

import { execSync, spawn } from 'child_process';
import {
  colors,
  RESET,
  icons,
  writeLine,
} from './terminal.js';

export type CheckStatus = 'ok' | 'missing' | 'warning' | 'error';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message?: string;
  hint?: string;
  fixCommand?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  cliCheck?: string;
  envKey?: string;
  installCmd?: string;
  loginCmd?: string;
  requiresSubscription: boolean;
  requiresApiKey: boolean;
}

export const PROVIDERS: Record<string, ProviderInfo> = {
  claude: {
    id: 'claude',
    name: 'Claude Code (Anthropic)',
    cliCheck: 'claude',
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    loginCmd: 'claude login',
    requiresSubscription: true,
    requiresApiKey: false,
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini (Google)',
    cliCheck: 'gemini',
    envKey: 'GEMINI_API_KEY',
    installCmd: 'npm install -g @google/gemini-cli',
    requiresSubscription: false,
    requiresApiKey: true,
  },
  openai: {
    id: 'openai',
    name: 'GPT (OpenAI)',
    envKey: 'OPENAI_API_KEY',
    requiresSubscription: false,
    requiresApiKey: true,
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama (Local)',
    cliCheck: 'ollama',
    installCmd: 'brew install ollama',
    requiresSubscription: false,
    requiresApiKey: false,
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor IDE',
    requiresSubscription: true,
    requiresApiKey: false,
  },
  aider: {
    id: 'aider',
    name: 'Aider',
    cliCheck: 'aider',
    installCmd: 'pip install aider-chat',
    requiresSubscription: false,
    requiresApiKey: true,
  },
  none: {
    id: 'none',
    name: 'Planning Only (no agent execution)',
    requiresSubscription: false,
    requiresApiKey: false,
  },
};

/**
 * Check if a command exists in PATH
 */
export function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Docker is running
 */
export function isDockerRunning(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Colima is running (alternative to Docker Desktop on macOS)
 */
export function isColimaRunning(): boolean {
  try {
    const result = execSync('colima status', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    return result.includes('Running');
  } catch {
    return false;
  }
}

/**
 * Check Docker/Colima prerequisites (informational only, never required)
 */
export function checkDockerPrereqs(): CheckResult {
  // Docker is never required for the CLI — purely informational
  if (isDockerRunning()) {
    return { name: 'Docker', status: 'ok', message: 'Available (optional)' };
  }

  if (commandExists('docker')) {
    if (commandExists('colima') && isColimaRunning()) {
      return { name: 'Docker (Colima)', status: 'ok', message: 'Available (optional)' };
    }
  }

  // Not installed or not running — that's fine
  return {
    name: 'Docker',
    status: 'ok',
    message: 'Not detected (optional — not required for CLI usage)',
  };
}

/**
 * Check GitHub CLI
 */
export function checkGhCli(): CheckResult {
  if (!commandExists('gh')) {
    return {
      name: 'GitHub CLI',
      status: 'warning',
      message: 'Recommended for GitHub integration',
      hint: 'Install: https://cli.github.com',
    };
  }

  // Check if authenticated
  try {
    execSync('gh auth status', { stdio: 'ignore' });
    return { name: 'GitHub CLI', status: 'ok' };
  } catch {
    return {
      name: 'GitHub CLI',
      status: 'warning',
      message: 'Installed but not authenticated',
      hint: 'Run: gh auth login',
      fixCommand: 'gh auth login',
    };
  }
}

/**
 * Check GitHub token permissions
 */
export function checkGhPermissions(): CheckResult {
  try {
    // Get current scopes
    const result = execSync('gh auth status 2>&1', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

    // Check for required scopes
    const hasRepo = result.includes('repo') || result.includes('Token scopes:') && !result.includes('none');
    const hasWorkflow = result.includes('workflow');

    if (!hasRepo) {
      return {
        name: 'GitHub Permissions',
        status: 'warning',
        message: 'Missing repo scope',
        hint: 'Run: gh auth refresh -s repo,workflow',
        fixCommand: 'gh auth refresh -s repo,workflow',
      };
    }

    if (!hasWorkflow) {
      return {
        name: 'GitHub Permissions',
        status: 'warning',
        message: 'Missing workflow scope (optional)',
        hint: 'For Actions: gh auth refresh -s repo,workflow',
      };
    }

    return { name: 'GitHub Permissions', status: 'ok' };
  } catch {
    return {
      name: 'GitHub Permissions',
      status: 'warning',
      message: 'Could not verify permissions',
      hint: 'Run: gh auth status',
    };
  }
}

/**
 * Check Claude CLI
 */
export function checkClaudeCli(): CheckResult {
  if (!commandExists('claude')) {
    return {
      name: 'Claude CLI',
      status: 'missing',
      message: 'Required to run agents',
      hint: 'Install: npm install -g @anthropic-ai/claude-code',
      fixCommand: 'npm install -g @anthropic-ai/claude-code',
    };
  }

  // Check if logged in by running claude --version
  try {
    execSync('claude --version', { stdio: 'ignore' });
    return { name: 'Claude CLI', status: 'ok' };
  } catch {
    return {
      name: 'Claude CLI',
      status: 'warning',
      message: 'Installed but may need login',
      hint: 'Run: claude login',
      fixCommand: 'claude login',
    };
  }
}

/**
 * Check provider-specific requirements
 */
export function checkProviderAuth(providerId: string): CheckResult {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return { name: 'Provider', status: 'warning', message: `Unknown provider: ${providerId}` };
  }

  // No requirements for none/cursor
  if (providerId === 'none' || providerId === 'cursor') {
    return { name: provider.name, status: 'ok' };
  }

  // Check CLI if required — missing CLI is a warning (not an error) during init
  // Users can scaffold first and install the provider CLI later
  if (provider.cliCheck) {
    if (!commandExists(provider.cliCheck)) {
      return {
        name: provider.name,
        status: 'warning',
        message: `CLI not installed`,
        hint: provider.installCmd ? `Install: ${provider.installCmd}` : undefined,
        fixCommand: provider.installCmd,
      };
    }
  }

  // Check API key if required
  if (provider.envKey && provider.requiresApiKey) {
    if (!process.env[provider.envKey]) {
      return {
        name: provider.name,
        status: 'warning',
        message: `${provider.envKey} not set`,
        hint: `Set environment variable: export ${provider.envKey}=<your-key>`,
      };
    }
  }

  return { name: provider.name, status: 'ok' };
}

/**
 * Run all prerequisite checks
 */
export function runPrereqChecks(): CheckResult[] {
  return [
    checkDockerPrereqs(),
    checkGhCli(),
  ];
}

/**
 * Run all auth checks for a specific provider
 */
export function runAuthChecks(providerId: string): CheckResult[] {
  const checks: CheckResult[] = [];

  // Provider-specific auth (includes CLI check)
  checks.push(checkProviderAuth(providerId));

  // GitHub permissions (for all providers that use GitHub)
  if (providerId !== 'none') {
    checks.push(checkGhPermissions());
  }

  return checks;
}

/**
 * Display check results with formatting
 */
export function displayCheckResults(checks: CheckResult[]): {
  hasErrors: boolean;
  hasWarnings: boolean;
  errorChecks: CheckResult[];
  warningChecks: CheckResult[];
} {
  const errorChecks: CheckResult[] = [];
  const warningChecks: CheckResult[] = [];

  for (const check of checks) {
    const icon = getStatusIcon(check.status);
    const statusColor = getStatusColor(check.status);

    if (check.status === 'ok') {
      writeLine(`  ${icon} ${check.name}`);
    } else {
      const suffix = check.message ? ` ${colors.dim}(${check.message})${RESET}` : '';
      writeLine(`  ${icon} ${statusColor}${check.name}${RESET}${suffix}`);

      if (check.hint) {
        writeLine(`    ${colors.cyan}→ ${check.hint}${RESET}`);
      }

      if (check.status === 'error' || check.status === 'missing') {
        errorChecks.push(check);
      } else if (check.status === 'warning') {
        warningChecks.push(check);
      }
    }
  }

  return {
    hasErrors: errorChecks.length > 0,
    hasWarnings: warningChecks.length > 0,
    errorChecks,
    warningChecks,
  };
}

function getStatusIcon(status: CheckStatus): string {
  switch (status) {
    case 'ok':
      return `${colors.green}${icons.success}${RESET}`;
    case 'warning':
      return `${colors.yellow}${icons.warning}${RESET}`;
    case 'missing':
    case 'error':
      return `${colors.red}${icons.error}${RESET}`;
  }
}

function getStatusColor(status: CheckStatus): string {
  switch (status) {
    case 'ok':
      return colors.green;
    case 'warning':
      return colors.yellow;
    case 'missing':
    case 'error':
      return colors.red;
  }
}

/**
 * Attempt to fix a failed check by running its fix command
 */
export async function attemptFix(check: CheckResult): Promise<boolean> {
  if (!check.fixCommand) {
    return false;
  }

  writeLine();
  writeLine(`  ${colors.cyan}${icons.progress}${RESET} Running: ${colors.dim}${check.fixCommand}${RESET}`);
  writeLine();

  return new Promise((resolve) => {
    const proc = spawn(check.fixCommand!, [], {
      stdio: 'inherit',
      shell: true,
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Wait for a service to be ready with retry
 */
export async function waitForService(
  name: string,
  checkFn: () => boolean | Promise<boolean>,
  maxAttempts = 30,
  intervalMs = 1000
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const ready = await checkFn();
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
