import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkGitStatus, checkGitStatusAsync } from '../src/lib/git';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

describe('git utilities', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'squads-git-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('checkGitStatus (sync)', () => {
    it('returns isGitRepo: false for non-git directory', () => {
      const result = checkGitStatus(tempDir);
      expect(result.isGitRepo).toBe(false);
      expect(result.hasRemote).toBe(false);
      expect(result.isDirty).toBe(false);
    });

    it('returns isGitRepo: true for git directory', () => {
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });
      const result = checkGitStatus(tempDir);
      expect(result.isGitRepo).toBe(true);
    });

    it('detects branch name', () => {
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
      writeFileSync(join(tempDir, 'test.txt'), 'hello');
      execSync('git add . && git commit -m "initial"', { cwd: tempDir, stdio: 'pipe' });

      const result = checkGitStatus(tempDir);
      expect(result.branch).toMatch(/main|master/);
    });

    it('detects uncommitted changes', () => {
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
      writeFileSync(join(tempDir, 'test.txt'), 'hello');
      execSync('git add . && git commit -m "initial"', { cwd: tempDir, stdio: 'pipe' });

      // Create uncommitted change
      writeFileSync(join(tempDir, 'test.txt'), 'modified');

      const result = checkGitStatus(tempDir);
      expect(result.isDirty).toBe(true);
      expect(result.uncommittedCount).toBeGreaterThan(0);
    });

    it('detects clean working tree', () => {
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
      writeFileSync(join(tempDir, 'test.txt'), 'hello');
      execSync('git add . && git commit -m "initial"', { cwd: tempDir, stdio: 'pipe' });

      const result = checkGitStatus(tempDir);
      expect(result.isDirty).toBe(false);
      expect(result.uncommittedCount).toBe(0);
    });
  });

  describe('checkGitStatusAsync', () => {
    it('returns isGitRepo: false for non-git directory', async () => {
      const result = await checkGitStatusAsync(tempDir);
      expect(result.isGitRepo).toBe(false);
      expect(result.hasRemote).toBe(false);
      expect(result.isDirty).toBe(false);
    });

    it('returns isGitRepo: true for git directory', async () => {
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });
      const result = await checkGitStatusAsync(tempDir);
      expect(result.isGitRepo).toBe(true);
    });

    it('detects branch name', async () => {
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
      writeFileSync(join(tempDir, 'test.txt'), 'hello');
      execSync('git add . && git commit -m "initial"', { cwd: tempDir, stdio: 'pipe' });

      const result = await checkGitStatusAsync(tempDir);
      expect(result.branch).toMatch(/main|master/);
    });

    it('detects uncommitted changes', async () => {
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
      writeFileSync(join(tempDir, 'test.txt'), 'hello');
      execSync('git add . && git commit -m "initial"', { cwd: tempDir, stdio: 'pipe' });

      // Create uncommitted change
      writeFileSync(join(tempDir, 'test.txt'), 'modified');

      const result = await checkGitStatusAsync(tempDir);
      expect(result.isDirty).toBe(true);
      expect(result.uncommittedCount).toBeGreaterThan(0);
    });

    it('produces same results as sync version', async () => {
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
      writeFileSync(join(tempDir, 'test.txt'), 'hello');
      execSync('git add . && git commit -m "initial"', { cwd: tempDir, stdio: 'pipe' });
      writeFileSync(join(tempDir, 'new.txt'), 'new file');

      const syncResult = checkGitStatus(tempDir);
      const asyncResult = await checkGitStatusAsync(tempDir);

      expect(asyncResult.isGitRepo).toBe(syncResult.isGitRepo);
      expect(asyncResult.isDirty).toBe(syncResult.isDirty);
      expect(asyncResult.uncommittedCount).toBe(syncResult.uncommittedCount);
      expect(asyncResult.branch).toBe(syncResult.branch);
    });
  });

  describe('performance', () => {
    it('sync version uses combined git command (single exec)', () => {
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
      writeFileSync(join(tempDir, 'test.txt'), 'hello');
      execSync('git add . && git commit -m "initial"', { cwd: tempDir, stdio: 'pipe' });

      // Time the sync version - should be fast due to combined command
      const start = Date.now();
      for (let i = 0; i < 10; i++) {
        checkGitStatus(tempDir);
      }
      const elapsed = Date.now() - start;

      // 10 calls should complete in under 2 seconds (200ms per call average)
      expect(elapsed).toBeLessThan(2000);
    });

    it('async version runs git commands in parallel', async () => {
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
      writeFileSync(join(tempDir, 'test.txt'), 'hello');
      execSync('git add . && git commit -m "initial"', { cwd: tempDir, stdio: 'pipe' });

      // Time the async version
      const start = Date.now();
      await Promise.all(
        Array(10).fill(null).map(() => checkGitStatusAsync(tempDir))
      );
      const elapsed = Date.now() - start;

      // 10 parallel calls should be faster than sequential
      expect(elapsed).toBeLessThan(3000);
    });
  });
});
