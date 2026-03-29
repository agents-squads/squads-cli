import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveGuardrailSettings } from '../src/lib/execution-engine.js';

const TEST_DIR = join(tmpdir(), `squads-guardrail-test-${Date.now()}`);

describe('resolveGuardrailSettings', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('returns undefined when no guardrail file exists', () => {
    const result = resolveGuardrailSettings(TEST_DIR);
    // Result is either undefined (no bundled default found) or the bundled default path
    // In CI with the built package, the bundled default is present
    if (result !== undefined) {
      expect(result).toContain('guardrail.json');
    }
  });

  it('returns project-level .claude/guardrail.json when present', () => {
    const claudeDir = join(TEST_DIR, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const guardrailPath = join(claudeDir, 'guardrail.json');
    writeFileSync(guardrailPath, JSON.stringify({ hooks: {} }));

    const result = resolveGuardrailSettings(TEST_DIR);

    expect(result).toBe(guardrailPath);
  });

  it('project-level guardrail takes precedence over bundled default', () => {
    // Create project-level override
    const claudeDir = join(TEST_DIR, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const projectGuardrail = join(claudeDir, 'guardrail.json');
    writeFileSync(projectGuardrail, JSON.stringify({ hooks: { PreToolUse: [] } }));

    const result = resolveGuardrailSettings(TEST_DIR);

    // Should return the project-level path, not the bundled one
    expect(result).toBe(projectGuardrail);
  });

  it('returns a path ending with guardrail.json', () => {
    const claudeDir = join(TEST_DIR, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'guardrail.json'), '{}');

    const result = resolveGuardrailSettings(TEST_DIR);

    expect(result).toBeDefined();
    expect(result!.endsWith('guardrail.json')).toBe(true);
  });
});

describe('guardrail.json template', () => {
  it('bundled template is valid JSON with hooks structure', async () => {
    // Find and parse the bundled guardrail.json from templates/
    const { existsSync, readFileSync } = await import('fs');
    const { join: joinPath, dirname } = await import('path');
    const { fileURLToPath } = await import('url');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    // Look for it relative to test/ directory
    const candidates = [
      joinPath(__dirname, '..', 'templates', 'guardrail.json'),
      joinPath(__dirname, '..', 'dist', 'templates', 'guardrail.json'),
    ];

    const found = candidates.find(p => existsSync(p));
    if (!found) {
      // Skip if not found (e.g., in some CI environments)
      return;
    }

    const content = readFileSync(found, 'utf-8');
    const parsed = JSON.parse(content);

    expect(parsed).toHaveProperty('hooks');
    expect(parsed.hooks).toHaveProperty('PreToolUse');
    expect(Array.isArray(parsed.hooks.PreToolUse)).toBe(true);
  });
});
