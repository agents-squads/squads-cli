import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export interface GitStatus {
  isGitRepo: boolean;
  hasRemote: boolean;
  remoteName?: string;
  remoteUrl?: string;
  branch?: string;
  isDirty: boolean;
  uncommittedCount: number;
}

export function checkGitStatus(cwd: string = process.cwd()): GitStatus {
  const status: GitStatus = {
    isGitRepo: false,
    hasRemote: false,
    isDirty: false,
    uncommittedCount: 0,
  };

  // Check if .git directory exists
  if (!existsSync(join(cwd, '.git'))) {
    return status;
  }

  status.isGitRepo = true;

  try {
    // Get current branch
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    status.branch = branch;

    // Check for remote
    const remotes = execSync('git remote -v', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (remotes) {
      status.hasRemote = true;
      const lines = remotes.split('\n');
      if (lines.length > 0) {
        const parts = lines[0].split(/\s+/);
        status.remoteName = parts[0];
        status.remoteUrl = parts[1];
      }
    }

    // Check for uncommitted changes
    const statusOutput = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (statusOutput) {
      status.isDirty = true;
      status.uncommittedCount = statusOutput.split('\n').filter(l => l.trim()).length;
    }

  } catch {
    // Git commands failed, but we know it's a git repo
  }

  return status;
}

export function initGitRepo(cwd: string = process.cwd()): boolean {
  try {
    execSync('git init', { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function getRepoName(remoteUrl?: string): string | null {
  if (!remoteUrl) return null;

  // Handle various remote URL formats
  // git@github.com:user/repo.git
  // https://github.com/user/repo.git
  const match = remoteUrl.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}
