/**
 * #1337 — every Claude-harness spawn path must hand the executor the sandbox
 * settings file (excludedCommands for gh/gcloud/terraform/docker, escape hatch
 * closed). The conversation path is covered behaviorally in
 * test/lib/workflow.test.ts; foreground + detached live inside
 * executeWithClaude (too entangled to run in a unit test), so they are pinned
 * structurally here. A new `buildSandboxSettings(` call site fails the count
 * below on purpose: add the path to this list and to the coverage.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildSandboxSettings, writeSandboxSettingsFile, DEFAULT_EXCLUDED_COMMANDS,
} from '../src/lib/sandbox-settings.js';
import { buildDetachedShellScript } from '../src/lib/execution-engine.js';

const SRC = join(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('sandbox settings reach every Claude spawn path (#1337)', () => {
  it('exactly these sites build sandbox settings: foreground, detached, conversation, lane-settings helper', () => {
    const sites = walk(SRC)
      .map((p) => ({ p, n: (readFileSync(p, 'utf-8').match(/buildSandboxSettings\(/g) ?? []).length }))
      .filter((s) => s.n > 0 && !s.p.endsWith('sandbox-settings.ts'))
      .map((s) => [s.p.slice(SRC.length + 1), s.n]);
    expect(sites).toEqual(expect.arrayContaining([['lib/execution-engine.ts', 2], ['lib/lane-settings.ts', 1], ['lib/workflow.ts', 1]]));
    expect(sites).toHaveLength(3);
  });

  it('foreground: the written settings file is pushed as --settings in both sandbox and non-sandbox branches', () => {
    const src = read('lib/execution-engine.ts');
    const fg = src.slice(src.indexOf('── Foreground mode'), src.indexOf('── Detached modes'));
    expect(fg).toContain("claudeArgs.push('--settings', settingsPath)"); // sandbox on
    expect(fg).toMatch(/claudeArgs\.push\('--settings', writeSandboxSettingsFile\(/); // sandbox off (guardrail only)
  });

  it('detached (background + watch share one script): settings file flows into the wrapper', () => {
    const src = read('lib/execution-engine.ts');
    const det = src.slice(src.indexOf('── Detached modes'), src.indexOf('── Background mode'));
    expect(det).toContain('detachedSettingsFile = writeSandboxSettingsFile(settings');
    expect(det).toContain('settingsFile: detachedSettingsFile');
    // Both watch and background go through the same wrapperScript.
    expect(det).toContain('wrapperScript');

    const script = buildDetachedShellScript({
      projectRoot: '/proj', squadName: 'engineering', agentName: 'pr-reviewer', timestamp: 1,
      claudeModelAlias: 'sonnet', escapedPrompt: 'x', logFile: '/tmp/l.log', pidFile: '/tmp/l.pid',
      allowedTools: ['Read'], settingsFile: '/proj/.git/squads-sandbox-settings.json',
    });
    expect(script).toMatch(/claude --print .*--settings '\/proj\/\.git\/squads-sandbox-settings\.json' /);
  });

  it('conversation: pushes --settings with the sandbox file', () => {
    const src = read('lib/workflow.ts');
    expect(src).toMatch(/claudeArgs\.push\('--settings', writeSandboxSettingsFile\(settings/);
  });

  it('no caller overrides excludedCommands (an override would silently drop `gh *`)', () => {
    const offenders = walk(SRC)
      .filter((p) => !p.endsWith('sandbox-settings.ts'))
      .filter((p) => /excludedCommands\s*:/.test(readFileSync(p, 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('the file a lane receives carries gh in excludedCommands and no unsandboxed retry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'squads-spawn-'));
    const path = writeSandboxSettingsFile(buildSandboxSettings({ cwd: '/w' }), dir);
    const written = JSON.parse(readFileSync(path, 'utf-8')) as {
      sandbox: { excludedCommands: string[]; allowUnsandboxedCommands: boolean; enabled: boolean };
    };
    expect(written.sandbox.enabled).toBe(true);
    expect(written.sandbox.excludedCommands).toEqual(DEFAULT_EXCLUDED_COMMANDS);
    expect(written.sandbox.excludedCommands).toContain('gh *');
    expect(written.sandbox.allowUnsandboxedCommands).toBe(false);
  });
});
