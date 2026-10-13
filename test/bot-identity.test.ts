import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Bot identity must come from the configured GitHub App — never from a
// hardcoded company/person (a stranger's App must not commit as ours).

const OUR_OLD_LOGIN = 'agents-squads[bot]';

let home: string;
const savedHome = process.env.HOME;
let fetchMock: ReturnType<typeof vi.fn>;

function writeAppConfig(extra: Record<string, unknown> = {}): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const secrets = join(home, '.squads', 'secrets');
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, 'app.pem'), privateKey);
  writeFileSync(
    join(secrets, 'github-app.json'),
    JSON.stringify({ app_id: 42, installation_id: 7, pem_path: join(secrets, 'app.pem'), ...extra }),
  );
}

function json(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'squads-botid-'));
  process.env.HOME = home;
  vi.resetModules();
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/access_tokens')) {
      return json({ token: 'tok', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (url.endsWith('/app')) return json({ slug: 'acme-robot' });
    if (url.includes('/users/')) return json({ id: 999 });
    return { ok: false } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('bot identity derived from the GitHub App', () => {
  it('derives name/email from the App slug and bot user id, then caches', async () => {
    writeAppConfig();
    const { getBotGitEnv, getBotLoginSync } = await import('../src/lib/github.js');
    expect(getBotLoginSync()).toBeNull(); // unknown until resolved: callers skip filters

    const env = await getBotGitEnv();
    expect(env.GIT_AUTHOR_NAME).toBe('acme-robot[bot]');
    expect(env.GIT_COMMITTER_NAME).toBe('acme-robot[bot]');
    expect(env.GIT_AUTHOR_EMAIL).toBe('999+acme-robot[bot]@users.noreply.github.com');
    expect(env.GIT_COMMITTER_EMAIL).toBe(env.GIT_AUTHOR_EMAIL);
    expect(JSON.stringify(env)).not.toContain('agents-squads');

    expect(getBotLoginSync()).toBe('acme-robot[bot]');
    expect(existsSync(join(home, '.squads', 'cache', 'github-app-identity.json'))).toBe(true);

    // second call served from cache: no further /app lookups
    const appCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/app')).length;
    const before = appCalls();
    await getBotGitEnv();
    expect(appCalls()).toBe(before);
  });

  it('honours bot_name / bot_email from github-app.json without any lookup', async () => {
    writeAppConfig({ bot_name: 'mine[bot]', bot_email: 'me@example.test' });
    const { getBotGitEnv, getBotLoginSync } = await import('../src/lib/github.js');
    expect(getBotLoginSync()).toBe('mine[bot]');
    const env = await getBotGitEnv();
    expect(env.GIT_AUTHOR_NAME).toBe('mine[bot]');
    expect(env.GIT_AUTHOR_EMAIL).toBe('me@example.test');
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/app'))).toBe(false);
  });

  it('sets no author env and no login when no App is configured', async () => {
    const { getBotGitEnv, getBotLoginSync } = await import('../src/lib/github.js');
    expect(await getBotGitEnv()).toEqual({});
    expect(getBotLoginSync()).toBeNull();
  });

  it('sets no author env when the identity cannot be resolved', async () => {
    writeAppConfig();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/access_tokens')
        ? json({ token: 'tok', expires_at: new Date(Date.now() + 3600_000).toISOString() })
        : ({ ok: false } as unknown as Response));
    const { getBotGitEnv } = await import('../src/lib/github.js');
    expect(await getBotGitEnv()).toEqual({});
  });
});

describe('--author filters use the derived login', () => {
  async function commandsFor(): Promise<string[]> {
    const cmds: string[] = [];
    vi.doMock('child_process', async (orig) => ({
      ...(await orig<typeof import('child_process')>()),
      execSync: vi.fn((cmd: string) => { cmds.push(cmd); return '[]'; }),
    }));
    const { recordArtifacts } = await import('../src/lib/outcomes.js');
    recordArtifacts({
      executionId: 'e1', squad: 's', agent: 'a', completedAt: new Date().toISOString(),
      costUsd: 0, repo: 'owner/repo',
    });
    vi.doUnmock('child_process');
    return cmds.filter(c => c.startsWith('gh pr list') || c.startsWith('gh issue list'));
  }

  it('filters by the configured bot login, never the hardcoded one', async () => {
    writeAppConfig({ bot_name: 'mine[bot]', bot_email: 'me@example.test' });
    const cmds = await commandsFor();
    expect(cmds).toHaveLength(2);
    for (const c of cmds) {
      expect(c).toContain('--author "mine[bot]"');
      expect(c).not.toContain(OUR_OLD_LOGIN);
    }
  });

  it("filters by the operator's own login (@me) when no App is configured", async () => {
    const cmds = await commandsFor();
    expect(cmds).toHaveLength(2);
    for (const c of cmds) {
      expect(c).toContain('--author "@me"');
      expect(c).not.toContain(OUR_OLD_LOGIN);
    }
  });

  it('skips the filter while a configured App login is still unknown', async () => {
    writeAppConfig();
    const cmds = await commandsFor();
    expect(cmds).toHaveLength(2);
    for (const c of cmds) expect(c).not.toContain('--author');
  });
});
