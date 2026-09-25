import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { streamWithOfficialOpenCode, verifyProviderRuntime } from '../src/opencode-local.ts';
import { setControlPlaneRepositoryForTests } from '../src/storage.ts';
import { encryptCredential } from '../src/credentials.ts';

const snapshot = JSON.parse(fs.readFileSync(new URL('../src/opencode-models.json', import.meta.url), 'utf8'));
const input = () => ({ runtimeKey: 'test-session', userId: 'test-user', modelId: 'opencode/big-pickle', system: 'Be concise.', messages: [{ role: 'user', content: 'Hello' }], signal: new AbortController().signal, onDelta: () => {} });
const frame = (content, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'big-pickle', choices: [{ index: 0, delta: content ? { content } : {}, finish_reason }] }) + '\n\n';

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

test('real SDK streams first delta before the response finishes', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let first;
  const gotFirst = new Promise((resolve) => { first = resolve; });
  const encoder = new TextEncoder();
  mockFetch(t, async (url, init) => {
    assert.equal(String(url), 'https://opencode.ai/zen/v1/chat/completions');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer public');
    assert.equal(JSON.parse(init.body).model, 'big-pickle');
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(encoder.encode(frame('Hello')));
      await gate;
      controller.enqueue(encoder.encode(frame(' there') + frame('', 'stop') + 'data: [DONE]\n\n'));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
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
  const abort = new AbortController();
  mockFetch(t, async () => new Response(frame('partial') + frame('later') + frame('', 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(streamWithOfficialOpenCode({ ...input(), signal: abort.signal, onDelta: () => abort.abort(new Error('Stopped by user')) }), /Stopped by user/);
});

test('public 403 preserves status and is not classified as paid quota or expired account', async (t) => {
  mockFetch(t, async () => new Response('private-provider-detail', { status: 403 }));
  await assert.rejects(streamWithOfficialOpenCode(input()), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.publicAccess, true);
    assert.doesNotMatch(error.message, /private-provider-detail|quota|Reconnect/);
    return true;
  });
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
  const { streamDirectRepositoryChat } = await import('../src/direct-chat.ts');
  const { recoverInterruptedDirectRuns } = await import('../src/agents.ts');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let first;
  const gotFirst = new Promise((resolve) => { first = resolve; });
  const controller = new TextEncoder();
  mockFetch(t, async (url) => {
    assert.equal(String(url), 'https://opencode.ai/zen/v1/chat/completions');
    return new Response(new ReadableStream({ async start(stream) {
      stream.enqueue(controller.encode(frame('Hello')));
      await gate;
      stream.enqueue(controller.encode(frame('!') + frame('', 'stop') + 'data: [DONE]\n\n'));
      stream.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
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
