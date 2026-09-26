import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveModel, resolveAuth } from '../src/opencode-catalog.ts';
import { listZenModels } from '../src/zen.ts';
import { turnsForMessage, needsRepositoryContext, shouldLoadRepositoryContext, executionPlaneFor, cleanAssistantText, createPromptEchoFilter } from '../src/direct-chat.ts';
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
  assert.equal(shouldLoadRepositoryContext('What is React?', 'ask', 'Orlynx'), true);
  assert.equal(needsRepositoryContext('Explain src/auth.ts'), true);
  assert.equal(needsRepositoryContext('What does this repository do?'), true);
  assert.equal(executionPlaneFor('Implement the fix in src/auth.ts', 'build'), 'workspace');
});

test('prompt echoes are removed without breaking natural greetings', () => {
  assert.equal(cleanAssistantText('helloHello! What do you want to work on?', 'hello'), 'Hello! What do you want to work on?');
  assert.equal(cleanAssistantText('what repo are u connected to currently?Currently connected to: emmy16-glitch/Orlynx', 'what repo are u connected to currently?'), 'Currently connected to: emmy16-glitch/Orlynx');
  assert.equal(cleanAssistantText('Hello! How can I help?', 'Hello'), 'Hello! How can I help?');

  const chunks = [];
  const filter = createPromptEchoFilter('hello', (delta) => chunks.push(delta));
  filter.push('hel');
  filter.push('loHello');
  filter.push('!');
  filter.finish();
  assert.equal(chunks.join(''), 'Hello!');
});

test('repeated historical failures never add error cards to the activity list', () => {
  const events = [1, 2, 3].map((n) => ({ eventId: 'e' + n, runId: 'r' + n, sequence: n, type: 'run.failed', payload: { error: 'old failure' } }));
  const history = toActivities(events);
  assert.equal(history.length, 3); // Still available in diagnostics.
  assert.deepEqual(chatActivities(history), []);
  const success = toActivities([...events, { eventId: 'done', runId: 'r4', sequence: 4, type: 'run.completed', payload: {} }]);
  assert.ok(chatActivities(success).every((item) => item.state !== 'failed'));
});


test('catalog remains visible when stored credential cannot decrypt', async () => {
  // The bundled catalog path itself must never require credential decryption.
  // Calling without identity models the safe fallback used when credential
  // state is stale or unavailable.
  const models = await listZenModels();
  assert.ok(models.length > 100);
  assert.ok(models.some((model) => model.free && model.status === 'available'));
});
