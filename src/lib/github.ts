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

// Co-author trailers marking machine authorship. ONE identity per provider —
// these surface in commit views and contributor counts, so any variation
// (claude[bot] vs Claude vs model-named) multiplies phantom contributors.
// Anthropic's canonical trailer is `Claude <noreply@anthropic.com>` — the same
// one Claude Code emits and seed SYSTEM.md / init commits instruct (#837).
const AI_COAUTHORS: Record<string, string> = {
  anthropic: 'Co-Authored-By: Claude <noreply@anthropic.com>',
  claude: 'Co-Authored-By: Claude <noreply@anthropic.com>',
  gemini: 'Co-Authored-By: gemini-code-assist <200291788+gemini-code-assist@users.noreply.github.com>',
  google: 'Co-Authored-By: gemini-code-assist <200291788+gemini-code-assist@users.noreply.github.com>',
  openai: 'Co-Authored-By: GPT <noreply@openai.com>',
  deepseek: 'Co-Authored-By: DeepSeek <noreply@deepseek.com>',
};

/**
 * Get the Co-Authored-By trailer for the model that wrote the code.
 */
export function getCoAuthorTrailer(provider: string): string {
  const key = provider.toLowerCase().replace(/-.*$/, ''); // "claude-sonnet" → "claude"
  return AI_COAUTHORS[key] || `Co-Authored-By: ${provider} <noreply@agents-squads.com>`;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Match GitHub's auth-failure wording across git's HTTP transport and the
 * `gh` CLI (#1133 — the ~1h installation-token TTL outlives long lanes, and
 * both surfaces phrase an expired/invalid token differently).
 */
export function isGhAuthFailure(text: string): boolean {
  return /bad credentials|401 unauthorized|http\/1\.1 401|https response received an unexpected status code \[401\]|authentication failed|could not read username|requires authentication|invalid or expired token/i.test(text);
}

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
 *
 * `forceRefresh` bypasses the cache — used by callers retrying a git/gh
 * operation that just failed auth (#1133): the cache's TTL check alone only
 * protects the process that minted the token; it can't tell that GitHub
 * rejected it early (revocation, clock drift, or a stale value baked into a
 * long-running child's env before this process ever ran).
 */
export async function getGitHubAppToken(opts?: { forceRefresh?: boolean }): Promise<string | null> {
  // Return cached token if still valid (5 min buffer)
  if (!opts?.forceRefresh && cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
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
export async function getBotGhEnv(opts?: { forceRefresh?: boolean }): Promise<Record<string, string>> {
  const token = await getGitHubAppToken(opts);
  if (!token) return {};
  return { GH_TOKEN: token };
}

/**
 * Get the git push URL with bot token embedded for authentication.
 * Returns null if app not configured.
 */
export async function getBotPushUrl(repo: string, opts?: { forceRefresh?: boolean }): Promise<string | null> {
  const token = await getGitHubAppToken(opts);
  if (!token) return null;
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

/**
 * Env vars that make git call OUR credential helper — a fresh `squads`
 * subprocess minting a live installation token — instead of any static
 * embedded token or pre-existing helper (macOS Keychain, `gh auth setup-git`,
 * etc). This is what makes a bot-authored `git push` survive a lane that
 * outlives the ~1h token TTL (#1133): git invokes credential helpers as a
 * new process every time it needs credentials, so unlike a token baked into
 * `GH_TOKEN`/a remote URL at spawn time, this one can never go stale.
 *
 * `credential.helper` is cleared first (empty value) because git queries
 * every configured helper in order — without clearing, an already-configured
 * helper (e.g. `gh auth setup-git`'s, which itself just reads the same
 * frozen `GH_TOKEN`) could still win the race and hand git a stale token.
 *
 * Deliberately env-scoped (`GIT_CONFIG_*`, per git's own env-based config
 * mechanism) rather than written to `.git/config`: multiple lanes run in
 * parallel worktrees of the same repo and share that file, so mutating it
 * risks the exact cross-lane git-config corruption this codebase has hit
 * before. Env vars are private to this process tree.
 */
export function buildBotGitCredentialEnv(): Record<string, string> {
  if (!loadAppConfig()) return {};
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '!squads __git-credential-helper',
  };
}

/**
 * Git credential helper protocol handler (invoked as `squads
 * __git-credential-helper get`, registered via `buildBotGitCredentialEnv`).
 * Git pipes `key=value` lines on stdin and reads `username=`/`password=`
 * lines back on stdout for the `get` action; `store`/`erase` are no-ops here
 * (there's nothing to persist — every `get` mints/returns a live token).
 */
export async function runGitCredentialHelper(action: string): Promise<void> {
  await drainStdin();
  if (action !== 'get') return;
  const token = await getGitHubAppToken();
  if (!token) return; // let git fall through (prompt / another configured source)
  process.stdout.write(`username=x-access-token\npassword=${token}\n`);
}

function drainStdin(): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(); return; }
    process.stdin.resume();
    process.stdin.on('end', resolve);
    process.stdin.on('error', () => resolve());
  });
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
