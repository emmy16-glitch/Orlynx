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

test('all production provider modules load without an OpenCode CLI', async () => {
  await verifyProviderRuntime();
});

test('free model direct chat streams from OpenCode Zen with public auth', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let first;
  const gotFirst = new Promise((resolve) => { first = resolve; });

  mockProviderFetch(t, async (url, init = {}) => {
    const value = String(url);
    assert.match(value, /^https:\/\/opencode\.ai\/zen\//);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer public');
    return new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(frame('Hello')));
        await gate;
        controller.enqueue(new TextEncoder().encode(frame(' there')));
        controller.enqueue(new TextEncoder().encode(frame('', 'stop') + 'data: [DONE]\n\n'));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  setControlPlaneRepositoryForTests({ getProviderConnection: async () => null });

  let completed = false;
  const chunks = [];
  const response = streamWithOfficialOpenCode({
    ...input(),
    onDelta: (delta) => { chunks.push(delta); first(); },
  }).then((text) => { completed = true; return text; });

  await gotFirst;
  assert.equal(completed, false);
  assert.deepEqual(chunks, ['Hello']);
  release();
  assert.equal(await response, 'Hello there');
});

test('free models ignore a stale saved Zen key and still use public auth', async (t) => {
  process.env.ORLYNX_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  setControlPlaneRepositoryForTests({
    getProviderConnection: async () => ({ state: 'connected', credential: encryptCredential('stale-saved-key') }),
  });

  mockProviderFetch(t, async (_url, init = {}) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer public');
    return new Response(frame('Public') + frame('', 'stop') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
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

test('explicit cancellation rejects instead of marking partial text complete', async (t) => {
  const abort = new AbortController();
  setControlPlaneRepositoryForTests({ getProviderConnection: async () => null });

  mockProviderFetch(t, async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame('partial')));
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));

  await assert.rejects(
    streamWithOfficialOpenCode({
      ...input(),
      signal: abort.signal,
      onDelta: () => abort.abort(new Error('Stopped by user')),
    }),
    /Stopped by user/,
  );
});

test('paid model receives the saved server-side credential', async (t) => {
  process.env.ORLYNX_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  setControlPlaneRepositoryForTests({
    getProviderConnection: async () => ({ state: 'connected', credential: encryptCredential('saved-test-key') }),
  });

  mockProviderFetch(t, async (_url, init = {}) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer saved-test-key');
    return new Response(frame('OK') + frame('', 'stop') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
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

test('Hello streams directly and browser reload recovery does not cancel it', async (t) => {
  const { streamDirectRepositoryChat } = await import('../src/direct-chat.ts');
  const { recoverInterruptedDirectRuns } = await import('../src/agents.ts');

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let first;
  const gotFirst = new Promise((resolve) => { first = resolve; });

  mockProviderFetch(t, async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(frame('Hello')));
      await gate;
      controller.enqueue(new TextEncoder().encode(frame('!')));
      controller.enqueue(new TextEncoder().encode(frame('', 'stop') + 'data: [DONE]\n\n'));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));

  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
  t.after(() => {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  });

  const task = {
    id: 'task-reload',
    runId: 'run-reload',
    plane: 'direct',
    state: 'running',
    updatedAt: new Date(0).toISOString(),
  };
  let writes = 0;
  setControlPlaneRepositoryForTests({
    getProviderConnection: async () => null,
    listMessages: async () => [{ id: 'hello-message', role: 'user', text: 'Hello' }],
    listTasks: async () => [task],
    putTask: async () => { writes++; },
  });

  const response = streamDirectRepositoryChat({
    runId: task.runId,
    messageId: 'hello-message',
    prompt: 'Hello',
    modelId: 'opencode/big-pickle',
    mode: 'ask',
    session: {
      id: 'reload-session',
      userId: 'test-user',
      projectId: 'p',
      project: 'owner/repo',
      branch: 'main',
    },
    onDelta: () => first(),
  });

  await gotFirst;
  await recoverInterruptedDirectRuns('reload-session');
  assert.equal(writes, 0);
  assert.equal(task.state, 'running');
  release();
  assert.equal(await response, 'Hello!');
});
