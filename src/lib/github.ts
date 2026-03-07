import { execSync } from 'child_process';
import { createSign } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface GitHubRepoResult {
  url: string;
  fullName: string;
}

// ── GitHub App Authentication ─────────────────────────────────────────

interface GitHubAppConfig {
  app_id: number;
  installation_id: number;
  pem_path: string;
}

const APP_CONFIG_PATH = join(homedir(), '.squads', 'secrets', 'github-app.json');
const BOT_NAME = 'agents-squads[bot]';
const BOT_EMAIL = '266303152+agents-squads[bot]@users.noreply.github.com';

// Co-author trailers that resolve to real GitHub profiles with avatars.
// These show up in the Contributors section of repos.
const AI_COAUTHORS: Record<string, string> = {
  anthropic: 'Co-Authored-By: claude[bot] <209825114+claude[bot]@users.noreply.github.com>',
  claude: 'Co-Authored-By: claude[bot] <209825114+claude[bot]@users.noreply.github.com>',
  gemini: 'Co-Authored-By: gemini-code-assist <200291788+gemini-code-assist@users.noreply.github.com>',
  google: 'Co-Authored-By: gemini-code-assist <200291788+gemini-code-assist@users.noreply.github.com>',
  openai: 'Co-Authored-By: GPT <noreply@openai.com>',
};

/**
 * Get the Co-Authored-By trailer for the model that wrote the code.
 * Uses GitHub's noreply emails so avatars show in contributor graph.
 */
export function getCoAuthorTrailer(provider: string): string {
  const key = provider.toLowerCase().replace(/-.*$/, ''); // "claude-sonnet" → "claude"
  return AI_COAUTHORS[key] || `Co-Authored-By: ${provider} <noreply@agents-squads.com>`;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

function loadAppConfig(): GitHubAppConfig | null {
  if (!existsSync(APP_CONFIG_PATH)) return null;
  try {
    const config = JSON.parse(readFileSync(APP_CONFIG_PATH, 'utf-8'));
    if (!config.app_id || !config.installation_id || !config.pem_path) return null;
    return config;
  } catch {
    return null;
  }
}

function generateJWT(appId: number, pemPath: string): string {
  const resolvedPath = pemPath.replace(/^~/, homedir());
  const pem = readFileSync(resolvedPath, 'utf-8');
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + 600,
    iss: String(appId),
  })).toString('base64url');

  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(pem, 'base64url');

  return `${header}.${payload}.${signature}`;
}

/**
 * Get a GitHub App installation token.
 * Caches the token until 5 minutes before expiry.
 * Returns null if the app is not configured.
 */
export async function getGitHubAppToken(): Promise<string | null> {
  // Return cached token if still valid (5 min buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedToken.token;
  }

  const config = loadAppConfig();
  if (!config) return null;

  try {
    const jwt = generateJWT(config.app_id, config.pem_path);
    const response = await fetch(
      `https://api.github.com/app/installations/${config.installation_id}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );

    if (!response.ok) return null;

    const data = await response.json() as { token: string; expires_at: string };
    cachedToken = {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime(),
    };
    return data.token;
  } catch {
    return null;
  }
}

/**
 * Git environment variables for bot-authored commits.
 * Falls back to empty object if app not configured (uses user's git config).
 */
export async function getBotGitEnv(): Promise<Record<string, string>> {
  const token = await getGitHubAppToken();
  if (!token) return {};

  return {
    GIT_AUTHOR_NAME: BOT_NAME,
    GIT_AUTHOR_EMAIL: BOT_EMAIL,
    GIT_COMMITTER_NAME: BOT_NAME,
    GIT_COMMITTER_EMAIL: BOT_EMAIL,
  };
}

/**
 * Environment for gh CLI commands authenticated as the bot.
 * Falls back to empty object (uses user's gh auth).
 */
export async function getBotGhEnv(): Promise<Record<string, string>> {
  const token = await getGitHubAppToken();
  if (!token) return {};
  return { GH_TOKEN: token };
}

/**
 * Get the git push URL with bot token embedded for authentication.
 * Returns null if app not configured.
 */
export async function getBotPushUrl(repo: string): Promise<string | null> {
  const token = await getGitHubAppToken();
  if (!token) return null;
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

/**
 * Detect GitHub org from the current project's git remote.
 * Falls back to undefined if not in a git repo or remote is not GitHub.
 */
export function detectGitHubOrg(cwd: string = process.cwd()): string | undefined {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Match github.com/<org>/<repo>
    const match = remote.match(/github\.com[:/]([^/]+)\//);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect full GitHub repo (org/name) from git remote.
 */
export function detectGitHubRepo(cwd: string = process.cwd()): string | undefined {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create a GitHub repository using the gh CLI.
 * Requires gh CLI to be installed and authenticated.
 */
export function createGitHubRepo(
  name: string,
  options: {
    org?: string;
    description?: string;
    isPrivate?: boolean;
  } = {}
): GitHubRepoResult {
  const { org, description, isPrivate = true } = options;
  const fullName = org ? `${org}/${name}` : name;

  // Verify gh is available
  try {
    execSync('gh --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    throw new Error('gh CLI not found. Install it from https://cli.github.com/');
  }

  // Check if repo already exists
  try {
    execSync(`gh repo view ${fullName} --json name`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    throw new Error(`Repository "${fullName}" already exists on GitHub`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err;
    }
    // Repo doesn't exist — proceed
  }

  // Build gh repo create command
  const args = ['gh', 'repo', 'create', fullName, isPrivate ? '--private' : '--public'];
  if (description) {
    args.push('--description', description);
  }

  const output = execSync(args.join(' '), {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  const url = output || `https://github.com/${fullName}`;
  return { url, fullName };
}
