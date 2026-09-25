import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resetOpenCodeRuntimeSessionsForTests, streamWithOfficialOpenCode, verifyProviderRuntime } from '../src/opencode-local.ts';
import { setControlPlaneRepositoryForTests } from '../src/storage.ts';
import { encryptCredential } from '../src/credentials.ts';
import { cleanLegacyAssistantText } from '../src/direct-chat.ts';

const snapshot = JSON.parse(fs.readFileSync(new URL('../src/opencode-models.json', import.meta.url), 'utf8'));
const input = () => ({ runtimeKey: 'test-session', userId: 'test-user', modelId: 'opencode/big-pickle', system: 'Be concise.', messages: [{ role: 'user', content: 'Hello' }], signal: new AbortController().signal, onDelta: () => {} });
const frame = (content, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'big-pickle', choices: [{ index: 0, delta: content ? { content } : {}, finish_reason }] }) + '\n\n';
const runtimeFrame = (type, properties = {}) => 'data: ' + JSON.stringify({ type, properties }) + '\n\n';

function configureRuntime(t) {
  resetOpenCodeRuntimeSessionsForTests();
  const previous = {
    url: process.env.ORLYNX_OPENCODE_RUNTIME_URL,
    user: process.env.ORLYNX_OPENCODE_RUNTIME_USERNAME,
    password: process.env.ORLYNX_OPENCODE_RUNTIME_PASSWORD,
  };
  process.env.ORLYNX_OPENCODE_RUNTIME_URL = 'https://runtime.test';
  process.env.ORLYNX_OPENCODE_RUNTIME_USERNAME = 'orlynx';
  process.env.ORLYNX_OPENCODE_RUNTIME_PASSWORD = 'runtime-test-secret';
  t.after(() => {
    resetOpenCodeRuntimeSessionsForTests();
    if (previous.url === undefined) delete process.env.ORLYNX_OPENCODE_RUNTIME_URL; else process.env.ORLYNX_OPENCODE_RUNTIME_URL = previous.url;
    if (previous.user === undefined) delete process.env.ORLYNX_OPENCODE_RUNTIME_USERNAME; else process.env.ORLYNX_OPENCODE_RUNTIME_USERNAME = previous.user;
    if (previous.password === undefined) delete process.env.ORLYNX_OPENCODE_RUNTIME_PASSWORD; else process.env.ORLYNX_OPENCODE_RUNTIME_PASSWORD = previous.password;
  });
}

function runtimeAuth(init) {
  return new Headers(init?.headers).get('authorization');
}

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes('models.dev')
    ? Response.json({ opencode: snapshot }) : handler(url, init);
  setControlPlaneRepositoryForTests({ getProviderConnection: async () => null });
  t.after(() => { globalThis.fetch = original; setControlPlaneRepositoryForTests(undefined); });
}

test('all production provider modules load without an OpenCode CLI', async () => {
  await verifyProviderRuntime();
});

test('dedicated OpenCode runtime streams first delta before the response finishes', async (t) => {
  configureRuntime(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let first;
  const gotFirst = new Promise((resolve) => { first = resolve; });
  const encoder = new TextEncoder();

  mockFetch(t, async (url, init = {}) => {
    const value = String(url);
    if (value.startsWith('https://runtime.test/session?')) {
      assert.equal(runtimeAuth(init), 'Basic ' + Buffer.from('orlynx:runtime-test-secret').toString('base64'));
      return Response.json([]);
    }
    if (value === 'https://runtime.test/session') {
      assert.equal(runtimeAuth(init), 'Basic ' + Buffer.from('orlynx:runtime-test-secret').toString('base64'));
      const body = JSON.parse(init.body);
      assert.equal(body.metadata.orlynxConversationId, 'test-session');
      return Response.json({ id: 'oc-session' });
    }
    if (value === 'https://runtime.test/event') {
      return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(encoder.encode(runtimeFrame('message.part.delta', { sessionID: 'oc-session', field: 'text', delta: 'Hello' })));
        await gate;
        controller.enqueue(encoder.encode(runtimeFrame('message.part.delta', { sessionID: 'oc-session', field: 'text', delta: ' there' })));
        controller.enqueue(encoder.encode(runtimeFrame('session.status', { sessionID: 'oc-session', status: { type: 'idle' } })));
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (value === 'https://runtime.test/session/oc-session/prompt_async') {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.model, { providerID: 'opencode', modelID: 'big-pickle' });
      assert.equal(body.parts[0].text, 'Hello');
      assert.doesNotMatch(body.parts[0].text, /Conversation so far|Respond naturally to the latest user message/);
      return new Response(null, { status: 204 });
    }
    if (value === 'https://runtime.test/session/oc-session/abort') return Response.json(true);
    throw new Error('Unexpected fetch ' + value);
  });

  let completed = false;
  const chunks = [];
  const result = streamWithOfficialOpenCode({ ...input(), onDelta: (text) => { chunks.push(text); first(); } }).then((text) => { completed = true; return text; });
  await gotFirst;
  assert.equal(completed, false);
  assert.deepEqual(chunks, ['Hello']);
  release();
  assert.equal(await result, 'Hello there');
});

test('explicit cancellation rejects instead of marking partial text complete', async (t) => {
  configureRuntime(t);
  const abort = new AbortController();
  const encoder = new TextEncoder();

  mockFetch(t, async (url) => {
    const value = String(url);
    if (value.startsWith('https://runtime.test/session?')) return Response.json([]);
    if (value === 'https://runtime.test/session') return Response.json({ id: 'oc-session' });
    if (value === 'https://runtime.test/event') {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode(runtimeFrame('message.part.delta', { sessionID: 'oc-session', field: 'text', delta: 'partial' })));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (value === 'https://runtime.test/session/oc-session/prompt_async') return new Response(null, { status: 204 });
    if (value === 'https://runtime.test/session/oc-session/abort') return Response.json(true);
    throw new Error('Unexpected fetch ' + value);
  });

  await assert.rejects(
    streamWithOfficialOpenCode({ ...input(), signal: abort.signal, onDelta: () => abort.abort(new Error('Stopped by user')) }),
    /Stopped by user/,
  );
});

test('runtime 403 preserves status and is not classified as paid quota or expired account', async (t) => {
  configureRuntime(t);
  mockFetch(t, async (url) => {
    const value = String(url);
    if (value.startsWith('https://runtime.test/session?')) return Response.json([]);
    if (value === 'https://runtime.test/session') return new Response('private-runtime-detail', { status: 403 });
    throw new Error('Unexpected fetch ' + value);
  });
  await assert.rejects(streamWithOfficialOpenCode(input()), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.publicAccess, true);
    assert.doesNotMatch(error.message, /private-runtime-detail|quota|Reconnect/);
    return true;
  });
});

test('free runtime reuses one OpenCode session and sends only the newest user turn', async (t) => {
  configureRuntime(t);
  const encoder = new TextEncoder();
  let creates = 0;
  let prompts = 0;
  mockFetch(t, async (url, init = {}) => {
    const value = String(url);
    if (value.startsWith('https://runtime.test/session?')) return Response.json([]);
    if (value === 'https://runtime.test/session') {
      creates++;
      return Response.json({ id: 'shared-session' });
    }
    if (value === 'https://runtime.test/event') {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode(runtimeFrame('message.part.delta', { sessionID: 'shared-session', field: 'text', delta: 'OK' })));
        controller.enqueue(encoder.encode(runtimeFrame('session.status', { sessionID: 'shared-session', status: { type: 'idle' } })));
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (value === 'https://runtime.test/session/shared-session/prompt_async') {
      prompts++;
      const body = JSON.parse(init.body);
      const expected = prompts === 1 ? 'First question' : 'Second question';
      assert.equal(body.parts[0].text, expected);
      assert.doesNotMatch(body.parts[0].text, /Conversation so far/);
      return new Response(null, { status: 204 });
    }
    throw new Error('Unexpected fetch ' + value);
  });

  const base = input();
  await streamWithOfficialOpenCode({ ...base, messages: [{ role: 'user', content: 'First question' }] });
  await streamWithOfficialOpenCode({
    ...base,
    messages: [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
    ],
  });
  assert.equal(creates, 1);
  assert.equal(prompts, 2);
});

test('legacy leaked transcript wrapper is removed before future history reuse', () => {
  const leaked = 'Conversation so far: User: hello Respond naturally to the latest user message. Do not repeat the transcript.Hi there';
  assert.equal(cleanLegacyAssistantText(leaked), 'Hi there');
});

test('paid model receives the saved server-side credential', async (t) => {
  mockFetch(t, async (_url, init) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer saved-test-key');
    return new Response(frame('OK') + frame('', 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  process.env.ORLYNX_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  setControlPlaneRepositoryForTests({ getProviderConnection: async () => ({ state: 'connected', credential: encryptCredential('saved-test-key') }) });
  assert.equal(await streamWithOfficialOpenCode({ ...input(), modelId: 'opencode/qwen3.8-max' }), 'OK');
});

test('Hello streams without repository/workspace requests and reload does not cancel it', async (t) => {
  configureRuntime(t);
  const { streamDirectRepositoryChat } = await import('../src/direct-chat.ts');
  const { recoverInterruptedDirectRuns } = await import('../src/agents.ts');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let first;
  const gotFirst = new Promise((resolve) => { first = resolve; });
  const encoder = new TextEncoder();

  mockFetch(t, async (url) => {
    const value = String(url);
    if (value.startsWith('https://runtime.test/session?')) return Response.json([]);
    if (value === 'https://runtime.test/session') return Response.json({ id: 'oc-session' });
    if (value === 'https://runtime.test/event') {
      return new Response(new ReadableStream({ async start(stream) {
        stream.enqueue(encoder.encode(runtimeFrame('message.part.delta', { sessionID: 'oc-session', field: 'text', delta: 'Hello' })));
        await gate;
        stream.enqueue(encoder.encode(runtimeFrame('message.part.delta', { sessionID: 'oc-session', field: 'text', delta: '!' })));
        stream.enqueue(encoder.encode(runtimeFrame('session.status', { sessionID: 'oc-session', status: { type: 'idle' } })));
        stream.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (value === 'https://runtime.test/session/oc-session/prompt_async') return new Response(null, { status: 204 });
    if (value === 'https://runtime.test/session/oc-session/abort') return Response.json(true);
    throw new Error('Unexpected fetch ' + value);
  });

  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const task = { id: 'task-reload', runId: 'run-reload', plane: 'direct', state: 'running', updatedAt: new Date(0).toISOString() };
  let writes = 0;
  setControlPlaneRepositoryForTests({
    getProviderConnection: async () => null,
    listMessages: async () => [{ id: 'hello-message', role: 'user', text: 'Hello' }],
    listTasks: async () => [task],
    putTask: async () => { writes++; },
  });
  const response = streamDirectRepositoryChat({
    runId: task.runId, messageId: 'hello-message', prompt: 'Hello', modelId: 'opencode/big-pickle',
    session: { id: 'reload-session', userId: 'test-user', projectId: 'p', project: 'owner/repo', branch: 'main' },
    onDelta: () => first(),
  });
  await gotFirst;
  await recoverInterruptedDirectRuns('reload-session');
  assert.equal(writes, 0);
  assert.equal(task.state, 'running');
  release();
  assert.equal(await response, 'Hello!');
});

