import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveTargetRepoRoot, resolveOwnedRepoRoots } from '../src/lib/execution-engine.js';
import { parseSquadFile } from '../src/lib/squad-parser.js';
import type { Squad } from '../src/lib/squad-parser.js';

/**
 * #1092: worktree provisioning must resolve the repo from `<repo>#<n>` refs
 * in the --task directive when the squad owns that repo (repo: + also_owns:),
 * instead of always defaulting to the squad's primary repo. Routing is
 * allowlisted — a task naming a repo the squad does NOT own never reroutes.
 */

let base: string;
let projectRoot: string;

function squadWith(overrides: Partial<Squad>): Squad {
  return { name: 'app', dir: 'app', mission: '', agents: [], pipelines: [], triggers: { scheduled: [], event: [], manual: [] }, routines: [], dependencies: [], outputPath: '', goals: [], ...overrides };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'squads-routing-'));
  projectRoot = join(base, 'hq');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(base, 'squads-app'), { recursive: true });
  mkdirSync(join(base, 'squads-api'), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveTargetRepoRoot task routing (#1092)', () => {
  const squad = () => squadWith({
    repo: 'agents-squads/squads-app',
    also_owns: ['agents-squads/squads-api'],
  });

  it('routes to the primary repo when no task is given (existing behavior)', () => {
    expect(resolveTargetRepoRoot(projectRoot, squad())).toBe(join(base, 'squads-app'));
  });

  it('routes to an also_owns repo referenced as <repo>#<n> in the task', () => {
    expect(resolveTargetRepoRoot(projectRoot, squad(), 'Work squads-api#166 — wire the SSE endpoints'))
      .toBe(join(base, 'squads-api'));
  });

  it('routes on fully-qualified org/repo#n refs', () => {
    expect(resolveTargetRepoRoot(projectRoot, squad(), 'Work agents-squads/squads-api#162'))
      .toBe(join(base, 'squads-api'));
  });

  it('keeps the primary repo when the task references the primary repo', () => {
    expect(resolveTargetRepoRoot(projectRoot, squad(), 'Work squads-app#65 — home screen'))
      .toBe(join(base, 'squads-app'));
  });

  it('first owned ref wins when the task references several repos', () => {
    expect(resolveTargetRepoRoot(projectRoot, squad(), 'Work squads-api#166, mirrors squads-app#65'))
      .toBe(join(base, 'squads-api'));
  });

  it('never routes to a repo the squad does not own', () => {
    expect(resolveTargetRepoRoot(projectRoot, squad(), 'Work squads-cli#1092 — not ours'))
      .toBe(join(base, 'squads-app'));
  });

  it('skips unowned refs but honors a later owned ref', () => {
    expect(resolveTargetRepoRoot(projectRoot, squad(), 'After squads-cli#1092 lands, work squads-api#166'))
      .toBe(join(base, 'squads-api'));
  });

  it('does not cross-route when the org differs on a qualified ref', () => {
    expect(resolveTargetRepoRoot(projectRoot, squad(), 'Work other-org/squads-api#1'))
      .toBe(join(base, 'squads-app'));
  });

  it('falls back to the primary repo when the owned repo is not checked out as a sibling', () => {
    rmSync(join(base, 'squads-api'), { recursive: true, force: true });
    expect(resolveTargetRepoRoot(projectRoot, squad(), 'Work squads-api#166'))
      .toBe(join(base, 'squads-app'));
  });

  it('routes to a later owned ref when the first owned ref is not checked out', () => {
    mkdirSync(join(base, 'squads-console'), { recursive: true });
    rmSync(join(base, 'squads-api'), { recursive: true, force: true });
    const s = squadWith({
      repo: 'agents-squads/squads-app',
      also_owns: ['agents-squads/squads-api', 'agents-squads/squads-console'],
    });
    expect(resolveTargetRepoRoot(projectRoot, s, 'Work squads-api#166 then squads-console#3'))
      .toBe(join(base, 'squads-console'));
  });

  it('falls back to projectRoot when the squad has no repo binding', () => {
    expect(resolveTargetRepoRoot(projectRoot, squadWith({}), 'Work squads-api#166'))
      .toBe(projectRoot);
  });

  it('falls back to projectRoot when the primary repo dir does not exist', () => {
    const s = squadWith({ repo: 'agents-squads/nonexistent' });
    expect(resolveTargetRepoRoot(projectRoot, s, 'no refs here')).toBe(projectRoot);
  });
});

describe('resolveOwnedRepoRoots (#1092)', () => {
  it('returns primary + existing also_owns sibling dirs', () => {
    const s = squadWith({
      repo: 'agents-squads/squads-app',
      also_owns: ['agents-squads/squads-api', 'agents-squads/not-checked-out'],
    });
    expect(resolveOwnedRepoRoots(projectRoot, s))
      .toEqual([join(base, 'squads-app'), join(base, 'squads-api')]);
  });

  it('returns just the resolved primary root without also_owns', () => {
    const s = squadWith({ repo: 'agents-squads/squads-app' });
    expect(resolveOwnedRepoRoots(projectRoot, s)).toEqual([join(base, 'squads-app')]);
  });
});

describe('parseSquadFile also_owns (#1092)', () => {
  it('parses also_owns from SQUAD.md frontmatter', () => {
    const squadDir = join(base, '.agents', 'squads', 'app');
    mkdirSync(squadDir, { recursive: true });
    const file = join(squadDir, 'SQUAD.md');
    writeFileSync(file, [
      '---',
      'name: app',
      'repo: agents-squads/squads-app',
      'also_owns:',
      '  - agents-squads/squads-api',
      '---',
      '',
      '# Squad: app',
    ].join('\n'));
    const squad = parseSquadFile(file);
    expect(squad.repo).toBe('agents-squads/squads-app');
    expect(squad.also_owns).toEqual(['agents-squads/squads-api']);
  });

  it('leaves also_owns undefined when absent', () => {
    const squadDir = join(base, '.agents', 'squads', 'plain');
    mkdirSync(squadDir, { recursive: true });
    const file = join(squadDir, 'SQUAD.md');
    writeFileSync(file, ['---', 'name: plain', 'repo: agents-squads/squads-app', '---', '', '# Squad: plain'].join('\n'));
    expect(parseSquadFile(file).also_owns).toBeUndefined();
  });

  it('drops non-string entries from also_owns', () => {
    const squadDir = join(base, '.agents', 'squads', 'mixed');
    mkdirSync(squadDir, { recursive: true });
    const file = join(squadDir, 'SQUAD.md');
    writeFileSync(file, [
      '---',
      'name: mixed',
      'repo: agents-squads/squads-app',
      'also_owns:',
      '  - agents-squads/squads-api',
      '  - 42',
      '  - null',
      '  - {repo: agents-squads/squads-console}',
      '---',
      '',
      '# Squad: mixed',
    ].join('\n'));
    expect(parseSquadFile(file).also_owns).toEqual(['agents-squads/squads-api']);
  });
});

describe('explicit repo marker beats issue-ref order (#1121)', () => {
  const squad = () => squadWith({
    repo: 'agents-squads/squads-app',
    also_owns: ['agents-squads/squads-api'],
  });

  it('the observed failure: first ref names repo-B, explicit marker names repo-A', () => {
    const task = 'Work the app surface of agents-squads/squads-api#180 (app side, repo agents-squads/squads-app) — wire the QR claim flow';
    expect(resolveTargetRepoRoot(projectRoot, squad(), task)).toBe(join(base, 'squads-app'));
  });

  it('"in repo" and "target repo:" phrasings work too', () => {
    expect(resolveTargetRepoRoot(projectRoot, squad(), 'fix squads-app#5 in repo agents-squads/squads-api')).toBe(join(base, 'squads-api'));
    expect(resolveTargetRepoRoot(projectRoot, squad(), 'target repo: agents-squads/squads-api — burn down squads-app#5')).toBe(join(base, 'squads-api'));
  });

  it('a marker naming an UNOWNED repo is ignored (allowlist holds); refs still route', () => {
    const task = 'work repo evil-org/not-ours — also touch squads-api#3';
    expect(resolveTargetRepoRoot(projectRoot, squad(), task)).toBe(join(base, 'squads-api'));
  });

  it('no marker → ref order unchanged (existing #1092 behavior)', () => {
    expect(resolveTargetRepoRoot(projectRoot, squad(), 'work squads-api#3 then squads-app#4')).toBe(join(base, 'squads-api'));
  });
});
