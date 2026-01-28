import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  findMemoryDir,
  listMemoryEntries,
  searchMemory,
  getSquadState,
  updateMemorySync,
  appendToMemorySync,
} from '../src/lib/memory';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('memory utilities', () => {
  let tempDir: string;
  let memoryDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Use realpathSync to handle macOS /var -> /private/var symlink
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'squads-memory-test-')));
    memoryDir = join(tempDir, '.agents', 'memory');
    mkdirSync(memoryDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('findMemoryDir', () => {
    it('finds .agents/memory in current directory', () => {
      const result = findMemoryDir();
      expect(result).toBe(memoryDir);
    });

    it('finds .agents/memory in parent directory', () => {
      const subDir = join(tempDir, 'sub', 'nested');
      mkdirSync(subDir, { recursive: true });
      process.chdir(subDir);

      const result = findMemoryDir();
      expect(result).toBe(memoryDir);
    });

    it('returns null when no memory dir found', () => {
      // Create temp dir without .agents/memory
      const emptyDir = mkdtempSync(join(tmpdir(), 'squads-empty-'));
      process.chdir(emptyDir);

      const result = findMemoryDir();
      expect(result).toBeNull();

      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('stops searching after 5 parent levels', () => {
      // Create deeply nested dir
      const deepPath = join(tempDir, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
      mkdirSync(deepPath, { recursive: true });
      process.chdir(deepPath);

      // Memory dir is 7 levels up, should not be found
      const result = findMemoryDir();
      expect(result).toBeNull();
    });
  });

  describe('listMemoryEntries', () => {
    it('returns empty array for empty memory directory', () => {
      const result = listMemoryEntries(memoryDir);
      expect(result).toEqual([]);
    });

    it('lists all memory entries across squads', () => {
      // Create test structure
      const cliPath = join(memoryDir, 'cli', 'issue-solver');
      mkdirSync(cliPath, { recursive: true });
      writeFileSync(join(cliPath, 'state.md'), '# State\nTest state content');
      writeFileSync(join(cliPath, 'learnings.md'), '# Learnings\nTest learnings');

      const webPath = join(memoryDir, 'website', 'builder');
      mkdirSync(webPath, { recursive: true });
      writeFileSync(join(webPath, 'output.md'), '# Output\nTest output');

      const result = listMemoryEntries(memoryDir);

      expect(result).toHaveLength(3);
      expect(result.some(e => e.squad === 'cli' && e.agent === 'issue-solver' && e.type === 'state')).toBe(true);
      expect(result.some(e => e.squad === 'cli' && e.agent === 'issue-solver' && e.type === 'learnings')).toBe(true);
      expect(result.some(e => e.squad === 'website' && e.agent === 'builder' && e.type === 'output')).toBe(true);
    });

    it('reads content from memory files', () => {
      const agentPath = join(memoryDir, 'test-squad', 'test-agent');
      mkdirSync(agentPath, { recursive: true });
      writeFileSync(join(agentPath, 'state.md'), 'Test content here');

      const result = listMemoryEntries(memoryDir);

      expect(result[0].content).toBe('Test content here');
    });

    it('ignores non-.md files', () => {
      const agentPath = join(memoryDir, 'test-squad', 'test-agent');
      mkdirSync(agentPath, { recursive: true });
      writeFileSync(join(agentPath, 'state.md'), 'Valid');
      writeFileSync(join(agentPath, 'notes.txt'), 'Should be ignored');
      writeFileSync(join(agentPath, 'config.json'), '{}');

      const result = listMemoryEntries(memoryDir);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('state');
    });
  });

  describe('searchMemory', () => {
    beforeEach(() => {
      // Set up test data
      const cliPath = join(memoryDir, 'cli', 'issue-solver');
      mkdirSync(cliPath, { recursive: true });
      writeFileSync(join(cliPath, 'state.md'), `# State
Last run: 2026-01-25
Status: Active
Working on pricing module`);
      writeFileSync(join(cliPath, 'learnings.md'), `# Learnings
- Learned about cost optimization
- Customer feedback is important`);

      const webPath = join(memoryDir, 'website', 'builder');
      mkdirSync(webPath, { recursive: true });
      writeFileSync(join(webPath, 'state.md'), `# State
Building landing page
Revenue metrics displayed`);
    });

    it('returns empty array when no matches', () => {
      const result = searchMemory('nonexistent-term-xyz', memoryDir);
      expect(result).toEqual([]);
    });

    it('finds direct term matches', () => {
      const result = searchMemory('pricing', memoryDir);

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].matches.some(m => m.toLowerCase().includes('pricing'))).toBe(true);
    });

    it('expands query semantically', () => {
      // Search for 'cost' should also find 'pricing' through expansion
      const result = searchMemory('cost', memoryDir);

      expect(result.length).toBeGreaterThan(0);
      // Should find the learnings file with 'cost optimization'
      expect(result.some(r => r.entry.content.includes('cost'))).toBe(true);
    });

    it('returns results sorted by score', () => {
      const result = searchMemory('pricing', memoryDir);

      // Verify descending score order
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
      }
    });

    it('boosts exact phrase matches', () => {
      const exactResult = searchMemory('cost optimization', memoryDir);
      const partialResult = searchMemory('cost analysis', memoryDir);

      // Exact phrase should score higher
      if (exactResult.length > 0 && partialResult.length > 0) {
        expect(exactResult[0].score).toBeGreaterThan(partialResult[0].score);
      }
    });

    it('handles case insensitivity', () => {
      const lowerResult = searchMemory('pricing', memoryDir);
      const upperResult = searchMemory('PRICING', memoryDir);

      expect(lowerResult.length).toBe(upperResult.length);
    });
  });

  describe('getSquadState', () => {
    it('returns empty array for non-existent squad', () => {
      const result = getSquadState('nonexistent-squad');
      expect(result).toEqual([]);
    });

    it('returns state entries for existing squad', () => {
      const cliPath = join(memoryDir, 'cli', 'issue-solver');
      mkdirSync(cliPath, { recursive: true });
      writeFileSync(join(cliPath, 'state.md'), 'Test state');

      const builderPath = join(memoryDir, 'cli', 'builder');
      mkdirSync(builderPath, { recursive: true });
      writeFileSync(join(builderPath, 'state.md'), 'Builder state');
      writeFileSync(join(builderPath, 'learnings.md'), 'Should not be included');

      const result = getSquadState('cli');

      expect(result).toHaveLength(2);
      expect(result.every(e => e.type === 'state')).toBe(true);
      expect(result.every(e => e.squad === 'cli')).toBe(true);
    });

    it('skips agents without state.md', () => {
      const cliPath = join(memoryDir, 'cli', 'issue-solver');
      mkdirSync(cliPath, { recursive: true });
      writeFileSync(join(cliPath, 'learnings.md'), 'Only learnings');

      const result = getSquadState('cli');
      expect(result).toHaveLength(0);
    });
  });

  describe('updateMemorySync', () => {
    it('creates new memory file', () => {
      updateMemorySync('test-squad', 'test-agent', 'state', 'New content');

      const filePath = join(memoryDir, 'test-squad', 'test-agent', 'state.md');
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, 'utf-8')).toBe('New content');
    });

    it('overwrites existing memory file', () => {
      const agentPath = join(memoryDir, 'test-squad', 'test-agent');
      mkdirSync(agentPath, { recursive: true });
      writeFileSync(join(agentPath, 'state.md'), 'Old content');

      updateMemorySync('test-squad', 'test-agent', 'state', 'Updated content');

      const content = readFileSync(join(agentPath, 'state.md'), 'utf-8');
      expect(content).toBe('Updated content');
    });

    it('creates nested directories if needed', () => {
      updateMemorySync('new-squad', 'new-agent', 'learnings', 'Test');

      const filePath = join(memoryDir, 'new-squad', 'new-agent', 'learnings.md');
      expect(existsSync(filePath)).toBe(true);
    });

    it('throws error when no memory directory found', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'squads-no-memory-'));
      process.chdir(emptyDir);

      expect(() => {
        updateMemorySync('squad', 'agent', 'state', 'content');
      }).toThrow('No .agents/memory directory found');

      rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  describe('appendToMemorySync', () => {
    it('creates new file with addition when file does not exist', () => {
      appendToMemorySync('test-squad', 'test-agent', 'state', 'First entry');

      const filePath = join(memoryDir, 'test-squad', 'test-agent', 'state.md');
      const content = readFileSync(filePath, 'utf-8');

      expect(content).toContain('First entry');
      expect(content).toContain('Added:');
    });

    it('appends to existing content with timestamp', () => {
      const agentPath = join(memoryDir, 'test-squad', 'test-agent');
      mkdirSync(agentPath, { recursive: true });
      writeFileSync(join(agentPath, 'state.md'), 'Original content');

      appendToMemorySync('test-squad', 'test-agent', 'state', 'Appended content');

      const content = readFileSync(join(agentPath, 'state.md'), 'utf-8');
      expect(content).toContain('Original content');
      expect(content).toContain('Appended content');
      expect(content).toContain('---');
    });

    it('throws error when no memory directory found', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'squads-no-memory-'));
      process.chdir(emptyDir);

      expect(() => {
        appendToMemorySync('squad', 'agent', 'state', 'content');
      }).toThrow('No .agents/memory directory found');

      rmSync(emptyDir, { recursive: true, force: true });
    });
  });
});
