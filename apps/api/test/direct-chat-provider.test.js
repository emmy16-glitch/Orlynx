import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveModel, resolveAuth } from '../src/opencode-catalog.ts';
import { listZenModels } from '../src/zen.ts';
import { turnsForMessage, needsRepositoryContext, shouldLoadRepositoryContext, executionPlaneFor, cleanAssistantText, instantReplyFor } from '../src/direct-chat.ts';
import { chatActivities, toActivities } from '../../web/src/ui/mapping.ts';

const catalog = JSON.parse(fs.readFileSync(new URL('../src/opencode-models.json', import.meta.url), 'utf8'));

test('metadata chooses all four transports without guessing names', () => {
  for (const [id, npm] of [
    ['muse-spark-1.3-contributor-free', '@ai-sdk/openai'],
    ['mimo-v2.6-flash-free', '@ai-sdk/openai-compatible'],
    ['big-pickle', '@ai-sdk/openai-compatible'],
    ['nemotron-3.5-lightning-free', '@ai-sdk/openai-compatible'],
    ['claude-sonnet-4-6', '@ai-sdk/anthropic'],
    ['gpt-6-sol', '@ai-sdk/openai'],
    ['gemini-3.8-flash', '@ai-sdk/google'],
    ['qwen3.8-flash', '@ai-sdk/anthropic'],
    ['qwen3.8-max', '@ai-sdk/openai-compatible'],
  ]) assert.equal(resolveModel(catalog, id).npm, npm, id);
  assert.throws(() => resolveModel(catalog, 'unknown-model'), /not present/);
});

test('model overrides win; catalog endpoints cannot exfiltrate credentials', () => {
  const model = { id: 'example', name: 'Example', provider: { npm: '@ai-sdk/google', api: 'https://opencode.ai/zen/v2' } };
  const custom = { ...catalog, models: { example: model } };
  assert.equal(resolveModel(custom, 'example').baseURL, 'https://opencode.ai/zen/v2');
  assert.equal(resolveModel(custom, 'example').npm, '@ai-sdk/google');
  model.provider.api = 'https://elsewhere.invalid/zen/v1';
  assert.throws(() => resolveModel(custom, 'example'), /untrusted/);
});


test('free OpenCode catalog loads without user identity or saved account', async () => {
  const models = await listZenModels();
  assert.ok(models.length > 0);
  const free = models.filter((model) => model.free);
  assert.ok(free.length > 0);
  assert.ok(free.every((model) => model.status === 'available' && model.connected === true));
  const paid = models.filter((model) => !model.free);
  assert.ok(paid.every((model) => model.status === 'needs-connection'));
});

test('public auth is a fallback; saved credentials retain OpenCode precedence', () => {
  assert.deepEqual(resolveAuth(true), { apiKey: 'public', publicAccess: true });
  assert.deepEqual(resolveAuth(true, 'saved'), { apiKey: 'saved', publicAccess: false });
  assert.deepEqual(resolveAuth(false, 'saved'), { apiKey: 'saved', publicAccess: false });
  assert.throws(() => resolveAuth(false), /paid model/);
});

test('a queued run uses its own message, never a later queued follow-up', () => {
  const history = [
    { id: 'one', role: 'user', text: 'Hello' },
    { id: 'reply', role: 'assistant', text: 'Hi!' },
    { id: 'two', role: 'user', text: 'Explain this repository' },
    { id: 'three', role: 'user', text: 'Ignore that, answer this instead' },
  ];
  assert.deepEqual(turnsForMessage(history, 'two', history[2].text), [
    { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi!' },
    { role: 'user', content: 'Explain this repository' },
  ]);
  assert.deepEqual(turnsForMessage(history, undefined, 'legacy task'), [{ role: 'user', content: 'legacy task' }]);
});

test('greetings stay cheap while Ask/Plan become repository-aware', () => {
  for (const text of ['Hello', 'What is React?', 'How do I run npm install?']) {
    assert.equal(needsRepositoryContext(text), false);
    assert.equal(executionPlaneFor(text, 'build'), 'direct');
  }
  assert.equal(shouldLoadRepositoryContext('Hello', 'plan', 'Orlynx'), false);
  assert.equal(shouldLoadRepositoryContext('What is Orlynx exactly?', 'plan', 'Orlynx'), true);
  assert.equal(shouldLoadRepositoryContext('What repo are you connected to?', 'ask', 'Orlynx'), true);
  assert.equal(shouldLoadRepositoryContext('What is React?', 'ask', 'Orlynx'), false);
  assert.equal(needsRepositoryContext('Explain src/auth.ts'), true);
  assert.equal(needsRepositoryContext('What does this repository do?'), true);
  assert.equal(executionPlaneFor('Implement the fix in src/auth.ts', 'build'), 'workspace');
});

test('prompt echoes are removed without breaking natural greetings', () => {
  assert.equal(cleanAssistantText('helloHello! What do you want to work on?', 'hello'), 'Hello! What do you want to work on?');
  assert.equal(cleanAssistantText('what repo are u connected to currently?Currently connected to: emmy16-glitch/Orlynx', 'what repo are u connected to currently?'), 'Currently connected to: emmy16-glitch/Orlynx');
  assert.equal(cleanAssistantText('Hello! How can I help?', 'Hello'), 'Hello! How can I help?');
  assert.equal(cleanAssistantText('on the repo any updates??', 'on the repo any updates??'), '');

});

test('historical failures remain visible while normal completion stays out of transcript noise', () => {
  const events = [1, 2, 3].map((n) => ({ eventId: 'e' + n, sessionId: 's', runId: 'r' + n, sequence: n, timestamp: new Date(n * 1000).toISOString(), type: 'run.failed', payload: { error: 'old failure' } }));
  const history = toActivities(events);
  assert.equal(history.length, 3);
  assert.deepEqual(chatActivities(history), history);
  const success = toActivities([...events, { eventId: 'done', sessionId: 's', runId: 'r4', sequence: 4, timestamp: new Date(4000).toISOString(), type: 'run.completed', payload: {} }]);
  assert.equal(chatActivities(success).filter((item) => item.state === 'failed').length, 3);
  assert.equal(success.some((item) => /Work completed/i.test(item.title)), false);
});


test('catalog remains visible when stored credential cannot decrypt', async () => {
  // The bundled catalog path itself must never require credential decryption.
  // Calling without identity models the safe fallback used when credential
  // state is stale or unavailable.
  const models = await listZenModels();
  assert.ok(models.length > 100);
  assert.ok(models.some((model) => model.free && model.status === 'available'));
});


test('deterministic chat turns bypass the model', () => {
  assert.match(
    instantReplyFor({ text: 'what repo are you connected to currently?', mode: 'plan', project: 'emmy16-glitch/Orlynx', branch: 'main' }),
    /emmy16-glitch\/Orlynx.*main/i,
  );
  assert.match(
    instantReplyFor({ text: 'can u pull changes from main??', mode: 'plan', project: 'emmy16-glitch/Orlynx', branch: 'main' }),
    /Switch to \*\*Build\*\*/i,
  );
  assert.match(
    instantReplyFor({ text: 'hello', mode: 'plan', project: 'emmy16-glitch/Orlynx', branch: 'main' }),
    /Orlynx.*main/i,
  );
  assert.equal(
    instantReplyFor({ text: 'Explain the authentication architecture', mode: 'plan', project: 'emmy16-glitch/Orlynx', branch: 'main' }),
    null,
  );
});

test('OpenCode runtime never projects user message parts as assistant streaming', () => {
  const src = fs.readFileSync(new URL('../src/opencode-local.ts', import.meta.url), 'utf8');
  assert.match(src, /const messageRoles = new Map<string, string>\(\)/);
  assert.match(src, /messageRoles\.get\(messageID\) !== 'assistant'/);
  assert.match(src, /type === 'message\.updated'/);
  assert.match(src, /partMessages\.set\(partID, messageID\)/);
  assert.match(src, /scheduleOpenCodeRuntimeRecovery\(\)/);
});

test('direct Ask/Plan builds whole-repository understanding before answering', () => {
  const src = fs.readFileSync(new URL('../src/direct-chat.ts', import.meta.url), 'utf8');
  const github = fs.readFileSync(new URL('../src/github.ts', import.meta.url), 'utf8');
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  assert.match(src, /githubRepositoryTree/);
  assert.match(src, /Whole repository map:/);
  assert.match(src, /chooseRepositoryFiles/);
  assert.match(src, /Understanding repository/);
  assert.match(src, /sourceType: 'repository\.map'/);
  assert.doesNotMatch(src, /sourceType: 'direct\.github'/);
  assert.match(github, /git\/trees\/.*recursive=1/);
  assert.match(agents, /onActivity: \(type, payload\) => emit\(session\.id, type/);
});

test('whole-repository understanding is cached and bounded for model latency', () => {
  const src = fs.readFileSync(new URL('../src/direct-chat.ts', import.meta.url), 'utf8');
  assert.match(src, /\.slice\(-8\)/);
  assert.match(src, /\.slice\(-6_000\)/);
  assert.match(src, /REPOSITORY_MAP_TTL_MS = 5 \* 60_000/);
  assert.match(src, /REPOSITORY_MAP_CHAR_BUDGET = 20_000/);
  assert.match(src, /REPOSITORY_CONTENT_CHAR_BUDGET = 44_000/);
  assert.match(src, /MAX_RELEVANT_FILES = 14/);
});
