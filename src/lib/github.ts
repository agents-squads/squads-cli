import { execSync } from 'child_process';

export interface GitHubRepoResult {
  url: string;
  fullName: string;
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
