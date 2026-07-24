import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the memory module to use a temp directory
const TEST_DIR = join(tmpdir(), `squads-test-${Date.now()}`);
const MEMORY_DIR = join(TEST_DIR, '.agents', 'memory');

vi.mock('../src/lib/memory.js', () => ({
  findMemoryDir: () => MEMORY_DIR,
}));

// Import after mocking
import {
  listExecutions,
  getExecution,
  getExecutionStats,
  formatDuration,
  formatRelativeTime,
} from '../src/lib/executions.js';

describe('executions', () => {
  beforeEach(() => {
    // Create test directory structure
    mkdirSync(join(MEMORY_DIR, 'cli', 'code-eval'), { recursive: true });
    mkdirSync(join(MEMORY_DIR, 'cli', 'test-eval'), { recursive: true });
    mkdirSync(join(MEMORY_DIR, 'website', 'web-lead'), { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('listExecutions', () => {
    it('returns empty array when no execution logs exist', () => {
      const executions = listExecutions();
      expect(executions).toEqual([]);
    });

    it('parses new format execution entries', () => {
      const logContent = `# cli/code-eval - Execution Log

---
<!-- exec:exec_abc123_xyz -->
**2026-01-08T10:00:00.000Z** | Status: completed
- ID: \`exec_abc123_xyz\`
- Trigger: manual
- Task Type: evaluation
- Completed: 2026-01-08T10:05:00.000Z
- Duration: 300.0s
`;
      writeFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), logContent);

      const executions = listExecutions();
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({
        id: 'exec_abc123_xyz',
        squad: 'cli',
        agent: 'code-eval',
        status: 'completed',
        trigger: 'manual',
        taskType: 'evaluation',
      });
    });

    it('parses legacy format execution entries', () => {
      const logContent = `# cli/code-eval - Execution Log

---
**2026-01-08T10:00:00.000Z** | Status: running

`;
      writeFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), logContent);

      const executions = listExecutions();
      expect(executions).toHaveLength(1);
      expect(executions[0].id).toMatch(/^legacy_/);
      expect(executions[0].status).toBe('running');
    });

    it('filters by squad', () => {
      // Create logs in two squads
      writeFileSync(
        join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'),
        `# cli/code-eval - Execution Log\n\n---\n<!-- exec:exec_cli_1 -->\n**2026-01-08T10:00:00.000Z** | Status: completed\n- ID: \`exec_cli_1\`\n- Trigger: manual\n- Task Type: evaluation\n`
      );
      writeFileSync(
        join(MEMORY_DIR, 'website', 'web-lead', 'executions.md'),
        `# website/web-lead - Execution Log\n\n---\n<!-- exec:exec_web_1 -->\n**2026-01-08T11:00:00.000Z** | Status: completed\n- ID: \`exec_web_1\`\n- Trigger: manual\n- Task Type: lead\n`
      );

      const cliExecs = listExecutions({ squad: 'cli' });
      expect(cliExecs).toHaveLength(1);
      expect(cliExecs[0].squad).toBe('cli');

      const webExecs = listExecutions({ squad: 'website' });
      expect(webExecs).toHaveLength(1);
      expect(webExecs[0].squad).toBe('website');
    });

    it('filters by status', () => {
      const logContent = `# cli/code-eval - Execution Log

---
<!-- exec:exec_running -->
**2026-01-08T10:00:00.000Z** | Status: running
- ID: \`exec_running\`
- Trigger: manual
- Task Type: evaluation

---
<!-- exec:exec_completed -->
**2026-01-08T11:00:00.000Z** | Status: completed
- ID: \`exec_completed\`
- Trigger: manual
- Task Type: evaluation
`;
      writeFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), logContent);

      const runningExecs = listExecutions({ status: 'running' });
      expect(runningExecs).toHaveLength(1);
      expect(runningExecs[0].id).toBe('exec_running');

      const completedExecs = listExecutions({ status: 'completed' });
      expect(completedExecs).toHaveLength(1);
      expect(completedExecs[0].id).toBe('exec_completed');
    });

    it('respects limit option', () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        `---\n<!-- exec:exec_${i} -->\n**2026-01-08T${String(i).padStart(2, '0')}:00:00.000Z** | Status: completed\n- ID: \`exec_${i}\`\n- Trigger: manual\n- Task Type: evaluation\n`
      ).join('\n');

      writeFileSync(
        join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'),
        `# cli/code-eval - Execution Log\n\n${entries}`
      );

      const limited = listExecutions({ limit: 3 });
      expect(limited).toHaveLength(3);
    });

    it('sorts by start time descending', () => {
      const logContent = `# cli/code-eval - Execution Log

---
<!-- exec:exec_early -->
**2026-01-08T08:00:00.000Z** | Status: completed
- ID: \`exec_early\`
- Trigger: manual
- Task Type: evaluation

---
<!-- exec:exec_late -->
**2026-01-08T12:00:00.000Z** | Status: completed
- ID: \`exec_late\`
- Trigger: manual
- Task Type: evaluation
`;
      writeFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), logContent);

      const executions = listExecutions();
      expect(executions[0].id).toBe('exec_late'); // Most recent first
      expect(executions[1].id).toBe('exec_early');
    });
  });

  describe('getExecution', () => {
    it('returns null when execution not found', () => {
      const result = getExecution('nonexistent');
      expect(result).toBeNull();
    });

    it('finds execution by ID', () => {
      const logContent = `# cli/code-eval - Execution Log

---
<!-- exec:exec_target -->
**2026-01-08T10:00:00.000Z** | Status: completed
- ID: \`exec_target\`
- Trigger: scheduled
- Task Type: evaluation
`;
      writeFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), logContent);

      const result = getExecution('exec_target');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('exec_target');
      expect(result?.trigger).toBe('scheduled');
    });
  });

  describe('getExecutionStats', () => {
    it('returns zero stats when no executions', () => {
      const stats = getExecutionStats();
      expect(stats.total).toBe(0);
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
    });

    it('counts executions by status', () => {
      const logContent = `# cli/code-eval - Execution Log

---
<!-- exec:exec_1 -->
**2026-01-08T10:00:00.000Z** | Status: running
- ID: \`exec_1\`
- Trigger: manual
- Task Type: evaluation

---
<!-- exec:exec_2 -->
**2026-01-08T11:00:00.000Z** | Status: completed
- ID: \`exec_2\`
- Trigger: manual
- Task Type: evaluation

---
<!-- exec:exec_3 -->
**2026-01-08T12:00:00.000Z** | Status: failed
- ID: \`exec_3\`
- Trigger: manual
- Task Type: evaluation
`;
      writeFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), logContent);

      const stats = getExecutionStats();
      expect(stats.total).toBe(3);
      expect(stats.running).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
    });

    it('groups by squad', () => {
      writeFileSync(
        join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'),
        `# cli/code-eval - Execution Log\n\n---\n<!-- exec:exec_1 -->\n**2026-01-08T10:00:00.000Z** | Status: completed\n- ID: \`exec_1\`\n- Trigger: manual\n- Task Type: evaluation\n`
      );
      writeFileSync(
        join(MEMORY_DIR, 'website', 'web-lead', 'executions.md'),
        `# website/web-lead - Execution Log\n\n---\n<!-- exec:exec_2 -->\n**2026-01-08T11:00:00.000Z** | Status: completed\n- ID: \`exec_2\`\n- Trigger: manual\n- Task Type: lead\n`
      );

      const stats = getExecutionStats();
      expect(stats.bySquad['cli']).toBe(1);
      expect(stats.bySquad['website']).toBe(1);
    });
  });

  describe('formatDuration', () => {
    it('returns dash for undefined', () => {
      expect(formatDuration(undefined)).toBe('—');
    });

    it('formats milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('formats seconds', () => {
      expect(formatDuration(5000)).toBe('5.0s');
      expect(formatDuration(30500)).toBe('30.5s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(90000)).toBe('1m 30s');
      expect(formatDuration(300000)).toBe('5m 0s');
    });

    it('formats hours and minutes', () => {
      expect(formatDuration(3660000)).toBe('1h 1m');
      expect(formatDuration(7200000)).toBe('2h 0m');
    });
  });

  describe('formatRelativeTime', () => {
    it('returns original string for invalid date', () => {
      expect(formatRelativeTime('invalid')).toBe('invalid');
    });

    it('formats recent times as "just now"', () => {
      const now = new Date().toISOString();
      expect(formatRelativeTime(now)).toBe('just now');
    });

    it('formats minutes ago', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago');
    });

    it('formats hours ago', () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      expect(formatRelativeTime(threeHoursAgo)).toBe('3h ago');
    });

    it('formats days ago', () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      expect(formatRelativeTime(twoDaysAgo)).toBe('2d ago');
    });
  });
});

// ── #889: zombie "running" entry cleanup ─────────────────────────────────
import { tombstoneZombieRuns, logExecution } from '../src/lib/execution-log.js';

describe('tombstoneZombieRuns (#889)', () => {
  beforeEach(() => {
    // Create test directory structure (separate scope from executions describe block)
    mkdirSync(join(MEMORY_DIR, 'cli', 'code-eval'), { recursive: true });
  });
  it('returns 0 when no execution log exists', () => {
    const count = tombstoneZombieRuns('cli', 'nonexistent-agent');
    expect(count).toBe(0);
  });

  it('returns 0 when log has no running entries', () => {
    const logContent = `# cli/code-eval - Execution Log

---
<!-- exec:exec_completed -->
**2026-01-08T10:00:00.000Z** | Status: completed
- ID: \`exec_completed\`
- Trigger: manual
- Task Type: evaluation
- Completed: 2026-01-08T10:05:00.000Z
- Duration: 300.0s

---
<!-- exec:exec_failed -->
**2026-01-08T11:00:00.000Z** | Status: failed
- ID: \`exec_failed\`
- Trigger: manual
- Task Type: evaluation
- Completed: 2026-01-08T11:05:00.000Z
- Duration: 300.0s
- Error: something broke
`;
    writeFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), logContent);

    const count = tombstoneZombieRuns('cli', 'code-eval');
    expect(count).toBe(0);

    // Verify content unchanged
    const after = readFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), 'utf-8');
    expect(after).toBe(logContent);
  });

  it('tombstones a single zombie running entry', () => {
    const logContent = `# cli/code-eval - Execution Log

---
<!-- exec:exec_running -->
**2026-01-08T10:00:00.000Z** | Status: running
- ID: \`exec_running\`
- Trigger: manual
- Task Type: evaluation
`;
    writeFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), logContent);

    const count = tombstoneZombieRuns('cli', 'code-eval');
    expect(count).toBe(1);

    // Verify the entry was tombstoned
    const after = readFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), 'utf-8');
    expect(after).not.toContain('Status: running');
    expect(after).toContain('Status: failed');
    expect(after).toContain('zombie entry');
    expect(after).toContain('- Completed:');
    expect(after).toContain('- Duration: unknown');
    expect(after).toContain('- Error: zombie entry');
  });

  it('tombstones multiple zombie running entries', () => {
    const logContent = `# cli/code-eval - Execution Log

---
<!-- exec:exec_1 -->
**2026-01-08T10:00:00.000Z** | Status: running
- ID: \`exec_1\`
- Trigger: manual
- Task Type: evaluation

---
<!-- exec:exec_2 -->
**2026-01-08T11:00:00.000Z** | Status: running
- ID: \`exec_2\`
- Trigger: manual
- Task Type: evaluation
`;
    writeFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), logContent);

    const count = tombstoneZombieRuns('cli', 'code-eval');
    expect(count).toBe(2);

    const after = readFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), 'utf-8');
    // Both entries should be fixed
    expect(after.match(/Status: failed/g)).toHaveLength(2);
    expect(after.match(/zombie entry/g)).toHaveLength(2);
  });

  it('preserves completed and failed entries alongside zombies', () => {
    const logContent = `# cli/code-eval - Execution Log

---
<!-- exec:exec_ok -->
**2026-01-08T10:00:00.000Z** | Status: completed
- ID: \`exec_ok\`
- Trigger: manual
- Task Type: evaluation
- Completed: 2026-01-08T10:05:00.000Z
- Duration: 300.0s

---
<!-- exec:exec_zombie -->
**2026-01-08T11:00:00.000Z** | Status: running
- ID: \`exec_zombie\`
- Trigger: manual
- Task Type: evaluation

---
<!-- exec:exec_bad -->
**2026-01-08T12:00:00.000Z** | Status: failed
- ID: \`exec_bad\`
- Trigger: manual
- Task Type: evaluation
- Completed: 2026-01-08T12:05:00.000Z
- Duration: 300.0s
- Error: bad data
`;
    writeFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), logContent);

    const count = tombstoneZombieRuns('cli', 'code-eval');
    expect(count).toBe(1);

    const after = readFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), 'utf-8');

    // Completed entry should be untouched (no tombstone text)
    expect(after).toContain('Status: completed');
    expect(after.match(/Status: completed/g)).toHaveLength(1);

    // Failed entry should keep its original error message
    expect(after).toContain('bad data');

    // Zombie should be tombstoned
    expect(after).toContain('zombie entry');
    expect(after).toContain('Duration: unknown');

    // Verify only the one zombie entry has "zombie entry" text
    expect(after.match(/zombie entry/g)).toHaveLength(1);
  });

  it('handles legacy format entries without exec: markers', () => {
    // Legacy format has no <!-- exec:ID --> marker
    const logContent = `# cli/code-eval - Execution Log

---
**2026-01-08T10:00:00.000Z** | Status: running
`;
    writeFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), logContent);

    const count = tombstoneZombieRuns('cli', 'code-eval');
    expect(count).toBe(1);

    const after = readFileSync(join(MEMORY_DIR, 'cli', 'code-eval', 'executions.md'), 'utf-8');
    expect(after).not.toContain('Status: running');
    expect(after).toContain('Status: failed');
    expect(after).toContain('zombie entry');
  });

  it('is called automatically by logExecution before writing a new entry', () => {
    // Set up a log with a zombie entry
    mkdirSync(join(MEMORY_DIR, 'cli', 'zombie-test'), { recursive: true });
    const logContent = `# cli/zombie-test - Execution Log

---
<!-- exec:exec_old_zombie -->
**2026-01-08T10:00:00.000Z** | Status: running
- ID: \`exec_old_zombie\`
- Trigger: manual
- Task Type: evaluation
`;
    writeFileSync(join(MEMORY_DIR, 'cli', 'zombie-test', 'executions.md'), logContent);

    // Log a new execution — this should trigger tombstoneZombieRuns
    logExecution({
      squadName: 'cli',
      agentName: 'zombie-test',
      executionId: 'exec_new',
      startTime: '2026-07-22T12:00:00.000Z',
      status: 'running',
      trigger: 'manual',
      taskType: 'execution',
    });

    // Read and verify
    const after = readFileSync(join(MEMORY_DIR, 'cli', 'zombie-test', 'executions.md'), 'utf-8');

    // Old zombie should be tombstoned
    expect(after).toContain('Status: failed');
    expect(after).toContain('zombie entry');

    // New entry should exist and be running
    expect(after).toContain('exec_new');
    expect(after).toContain('Status: running');

    // Verify exactly one "Status: running" (the new entry)
    const runningMatches = after.match(/Status: running/g);
    expect(runningMatches).toHaveLength(1);
  });
});

// ── #911: no bridge configured → silent no-op, no endpoint leak ──────────
import { fetchLearnings } from '../src/lib/execution-log.js';

describe('fetchLearnings without a bridge (#911)', () => {
  it('returns [] silently when bridge_url is unset (fresh local-first install)', async () => {
    const oldBridge = process.env.SQUADS_BRIDGE_URL;
    delete process.env.SQUADS_BRIDGE_URL;
    const warnings: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // fetchLearnings warns via writeLine(stdout) — capture to assert silence.
    (process.stdout.write as unknown) = (chunk: string) => { warnings.push(String(chunk)); return true; };
    try {
      const result = await fetchLearnings('demo');
      expect(result).toEqual([]);
      expect(warnings.join('')).not.toContain('learnings fetch failed');
      expect(warnings.join('')).not.toContain('/api/learnings');
    } finally {
      (process.stdout.write as unknown) = origWrite;
      if (oldBridge !== undefined) process.env.SQUADS_BRIDGE_URL = oldBridge;
    }
  });
});
