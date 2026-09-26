import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { streamWithOfficialOpenCode, verifyProviderRuntime } from '../src/opencode-local.ts';
import { setControlPlaneRepositoryForTests } from '../src/storage.ts';
import { encryptCredential } from '../src/credentials.ts';
import { cleanLegacyAssistantText } from '../src/direct-chat.ts';

const snapshot = JSON.parse(fs.readFileSync(new URL('../src/opencode-models.json', import.meta.url), 'utf8'));

const input = () => ({
  runtimeKey: 'test-session',
  userId: 'test-user',
  modelId: 'opencode/big-pickle',
  system: 'Be concise.',
  messages: [{ role: 'user', content: 'Hello' }],
  signal: new AbortController().signal,
  onDelta: () => {},
});

const frame = (content, finish_reason = null) =>
  'data: ' + JSON.stringify({
    id: 'test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'big-pickle',
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason }],
  }) + '\n\n';

function mockProviderFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('models.dev')) return Response.json({ opencode: snapshot });
    return handler(url, init);
  };
  t.after(() => {
    globalThis.fetch = original;
    setControlPlaneRepositoryForTests(undefined);
  });
}

function streamed(text) {
  return new Response(frame(text) + frame('', 'stop') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('all production provider modules load without an OpenCode CLI', async () => {
  await verifyProviderRuntime();
});

test('free Plan/Ask uses OpenCode Zen directly with public auth', async (t) => {
  setControlPlaneRepositoryForTests({ getProviderConnection: async () => null });

  mockProviderFetch(t, async (url, init = {}) => {
    const value = String(url);
    assert.match(value, /^https:\/\/opencode\.ai\/zen\//);
    assert.doesNotMatch(value, /orlynx-opencode-runtime|runtime\.test/);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer public');
    return streamed('Hello');
  });

  const chunks = [];
  const result = await streamWithOfficialOpenCode({
    ...input(),
    onDelta: (delta) => chunks.push(delta),
  });

  assert.equal(result, 'Hello');
  assert.deepEqual(chunks, ['Hello']);
});

test('free model ignores a stale saved Zen key', async (t) => {
  process.env.ORLYNX_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  setControlPlaneRepositoryForTests({
    getProviderConnection: async () => ({
      state: 'connected',
      credential: encryptCredential('stale-saved-key'),
    }),
  });

  mockProviderFetch(t, async (url, init = {}) => {
    assert.match(String(url), /^https:\/\/opencode\.ai\/zen\//);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer public');
    return streamed('Public');
  });

  assert.equal(await streamWithOfficialOpenCode(input()), 'Public');
});

test('public provider rejection stays a public-access error', async (t) => {
  setControlPlaneRepositoryForTests({ getProviderConnection: async () => null });
  mockProviderFetch(t, async () => new Response('denied', { status: 403 }));

  await assert.rejects(streamWithOfficialOpenCode(input()), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.publicAccess, true);
    assert.doesNotMatch(error.message, /Reconnect|saved credential/i);
    return true;
  });
});

test('paid model receives the saved server-side credential', async (t) => {
  process.env.ORLYNX_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  setControlPlaneRepositoryForTests({
    getProviderConnection: async () => ({
      state: 'connected',
      credential: encryptCredential('saved-test-key'),
    }),
  });

  mockProviderFetch(t, async (url, init = {}) => {
    assert.match(String(url), /^https:\/\/opencode\.ai\/zen\//);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer saved-test-key');
    return streamed('OK');
  });

  assert.equal(
    await streamWithOfficialOpenCode({ ...input(), modelId: 'opencode/qwen3.8-max' }),
    'OK',
  );
});

test('legacy leaked transcript wrapper is removed before future history reuse', () => {
  const leaked = 'Conversation so far: User: hello Respond naturally to the latest user message. Do not repeat the transcript.Hi there';
  assert.equal(cleanLegacyAssistantText(leaked), 'Hi there');
});
