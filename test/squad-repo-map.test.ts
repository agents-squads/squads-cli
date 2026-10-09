/**
 * Squad → repo attribution comes from each SQUAD.md `repo:` field, never from
 * a built-in list of one company's repos (#961).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { squadRepoMap, squadsForRepo } from '../src/lib/squad-parser.js';
import { getMultiRepoGitStats } from '../src/lib/git.js';

beforeAll(() => {
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_INDEX_FILE;
});

let base: string;

function squad(name: string, repo?: string): void {
  const dir = join(base, '.agents', 'squads', name);
  mkdirSync(dir, { recursive: true });
  const fm = repo === undefined ? '' : `---\nrepo: ${repo}\n---\n`;
  writeFileSync(join(dir, 'SQUAD.md'), `${fm}# Squad: ${name}\n\nThe ${name} squad.\n`);
}

function repoWithCommit(name: string): void {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execSync('git init -q -b main && touch a && git add a && git commit -q -m c', { cwd: dir, env, stdio: 'pipe' });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'squads-repomap-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('squadRepoMap', () => {
  it('reads repo: as org/name, name or a .git URL tail; [] when absent', () => {
    squad('web', 'acme/acme-web');
    squad('api', 'acme-api');
    squad('cli', 'git@github.com:acme/acme-cli.git');
    squad('ops');
    const map = squadRepoMap(join(base, '.agents', 'squads'));
    expect(map).toEqual({ web: ['acme-web'], api: ['acme-api'], cli: ['acme-cli'], ops: [] });
    expect(squadsForRepo('acme-web', map)).toEqual(['web']);
    expect(squadsForRepo('hq', map)).toEqual([]);
  });

  it('is empty without a squads directory', () => {
    expect(squadRepoMap(null)).toEqual({});
  });
});

describe('multi-repo git stats', () => {
  it("reads the squads' declared repos under basePath, not a fixed list", async () => {
    squad('web', 'acme/acme-web');
    repoWithCommit('acme-web');
    repoWithCommit('hq'); // one company's layout — must not be picked up
    const cwd = process.cwd();
    process.chdir(base);
    try {
      const stats = await getMultiRepoGitStats(base, 7);
      expect([...stats.commitsByRepo.keys()]).toEqual(['acme-web']);
    } finally {
      process.chdir(cwd);
    }
  });
});
