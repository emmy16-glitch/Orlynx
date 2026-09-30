import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptCredential, decryptCredential } from '../src/credentials.ts';
import { githubUserAccessToken } from '../src/github.ts';
import { setControlPlaneRepositoryForTests } from '../src/storage.ts';

function envFixture(t) {
  const previous = {
    key: process.env.ORLYNX_CREDENTIAL_ENCRYPTION_KEY,
    client: process.env.GITHUB_CLIENT_ID,
    secret: process.env.GITHUB_APP_CLIENT_SECRET,
  };
  process.env.ORLYNX_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.GITHUB_CLIENT_ID = 'client-test';
  process.env.GITHUB_APP_CLIENT_SECRET = 'secret-test';
  t.after(() => {
    setControlPlaneRepositoryForTests(undefined);
    if (previous.key === undefined) delete process.env.ORLYNX_CREDENTIAL_ENCRYPTION_KEY; else process.env.ORLYNX_CREDENTIAL_ENCRYPTION_KEY = previous.key;
    if (previous.client === undefined) delete process.env.GITHUB_CLIENT_ID; else process.env.GITHUB_CLIENT_ID = previous.client;
    if (previous.secret === undefined) delete process.env.GITHUB_APP_CLIENT_SECRET; else process.env.GITHUB_APP_CLIENT_SECRET = previous.secret;
  });
}

test('concurrent long-idle GitHub token requests consume a rotating refresh token only once', async (t) => {
  envFixture(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const now = Date.now();
  let connection = {
    userId: 'user-1',
    installationId: 99,
    login: 'tester',
    accessToken: encryptCredential('expired-access'),
    refreshToken: encryptCredential('refresh-old'),
    accessTokenExpiresAt: new Date(now - 60_000).toISOString(),
    refreshTokenExpiresAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
  };
  let refreshCalls = 0;
  let writes = 0;

  setControlPlaneRepositoryForTests({
    getGitHubConnectionByUser: async () => structuredClone(connection),
    upsertGitHubConnection: async (value) => { connection = structuredClone(value); writes += 1; },
  });

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://github.com/login/oauth/access_token');
    refreshCalls += 1;
    const params = new URLSearchParams(String(init?.body || ''));
    assert.equal(params.get('refresh_token'), 'refresh-old');
    await gate;
    return new Response(JSON.stringify({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      expires_in: 28_800,
      refresh_token_expires_in: 15_552_000,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const first = githubUserAccessToken('user-1');
  const second = githubUserAccessToken('user-1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshCalls, 1);
  release();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, 'access-new');
  assert.equal(b, 'access-new');
  assert.equal(refreshCalls, 1);
  assert.equal(writes, 1);
  assert.equal(decryptCredential(connection.refreshToken), 'refresh-new');
});

test('expired refresh token fails closed before hitting GitHub', async (t) => {
  envFixture(t);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('should not fetch'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const now = Date.now();
  setControlPlaneRepositoryForTests({
    getGitHubConnectionByUser: async () => ({
      userId: 'user-2',
      installationId: 100,
      login: 'tester',
      accessToken: encryptCredential('expired-access'),
      refreshToken: encryptCredential('expired-refresh'),
      accessTokenExpiresAt: new Date(now - 60_000).toISOString(),
      refreshTokenExpiresAt: new Date(now - 60_000).toISOString(),
      createdAt: new Date(now - 60_000).toISOString(),
      updatedAt: new Date(now - 60_000).toISOString(),
    }),
  });

  await assert.rejects(() => githubUserAccessToken('user-2'), /Reconnect GitHub/);
  assert.equal(calls, 0);
});


test('failed refresh accepts a newer token persisted by another API process', async (t) => {
  envFixture(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const now = Date.now();
  const expired = {
    userId: 'user-3',
    installationId: 101,
    login: 'tester',
    accessToken: encryptCredential('expired-access'),
    refreshToken: encryptCredential('refresh-raced'),
    accessTokenExpiresAt: new Date(now - 60_000).toISOString(),
    refreshTokenExpiresAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
  };
  const rotated = {
    ...expired,
    accessToken: encryptCredential('access-from-other-process'),
    refreshToken: encryptCredential('refresh-from-other-process'),
    accessTokenExpiresAt: new Date(now + 8 * 60 * 60_000).toISOString(),
    updatedAt: new Date(now + 1_000).toISOString(),
  };
  let reads = 0;
  setControlPlaneRepositoryForTests({
    getGitHubConnectionByUser: async () => {
      reads += 1;
      return structuredClone(reads >= 3 ? rotated : expired);
    },
    upsertGitHubConnection: async () => { throw new Error('this process must not overwrite the winner'); },
  });

  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'bad_refresh_token' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });

  const token = await githubUserAccessToken('user-3');
  assert.equal(token, 'access-from-other-process');
  assert.ok(reads >= 3);
});
