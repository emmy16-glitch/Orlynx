import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('direct chat has bounded silence, first-token and stale-task deadlines', () => {
  const direct = fs.readFileSync(new URL('../src/direct-chat.ts', import.meta.url), 'utf8');
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');

  assert.match(direct, /ORLYNX_DIRECT_TURN_TIMEOUT_MS \|\| 3 \* 60_000/);
  assert.match(direct, /ORLYNX_DIRECT_FIRST_TOKEN_TIMEOUT_MS \|\| 30_000/);
  assert.match(direct, /stage === 'modelRequestStartedMs'\) armFirstTokenTimer\(\)/);
  assert.match(direct, /firstTokenSeen = true;\s*clearFirstTokenTimer\(\)/);
  assert.match(direct, /The model did not start streaming in time/);

  assert.match(agents, /ORLYNX_DIRECT_TASK_TIMEOUT_MS \|\| 4 \* 60_000/);
  assert.match(agents, /const taskTimeoutMs = \(task\.plane \|\| 'workspace'\) === 'direct' \? directTaskTimeoutMs : timeoutMs/);
});

test('direct task heartbeat reflects provider activity rather than timer liveness', () => {
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');

  assert.match(agents, /let providerActivityAt = task\.updatedAt/);
  assert.match(agents, /const markProviderActivity = \(\) => \{ providerActivityAt = new Date\(\)\.toISOString\(\); \}/);
  assert.match(agents, /if \(providerActivityAt === persistedActivityAt\) return/);
  assert.match(agents, /onStatus: \(text\) => \{\s*markProviderActivity\(\)/);
  assert.match(agents, /onDelta: \(delta\) => \{[\s\S]*?markProviderActivity\(\)/);
});

test('silent transient direct-chat failure retries once only before visible output', () => {
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');

  assert.match(agents, /const retrySilentTurn = async/);
  assert.match(agents, /visible\.length !== visibleBefore/);
  assert.match(agents, /\[502, 503, 504\]\.includes\(error\.statusCode\)/);
  assert.match(agents, /AI connection stalled before any response · retrying once/);
  assert.match(agents, /let responseText = await retrySilentTurn\(task\.prompt, task\.messageId\)/);
  assert.doesNotMatch(agents, /while \([^\n]*retrySilentTurn/);
});

test('API wake proactively warms the separate free-model runtime without delaying listen', () => {
  const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const warm = source.indexOf('void warmOpenCodeRuntime()');
  const listen = source.indexOf('server.listen(');

  assert.ok(warm >= 0, 'startup schedules OpenCode runtime prewarm');
  assert.ok(listen > warm, 'prewarm is scheduled before the listener callback');
  assert.match(source, /\[startup-smoke\] direct-runtime warm=/);
  assert.doesNotMatch(source, /await warmOpenCodeRuntime\(\)/);
});


test('browser retries message admission with the same client id across transient cold-start failures', () => {
  const app = fs.readFileSync(new URL('../../web/src/ProductionApp.tsx', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');

  assert.match(app, /const clientId = uid\(\)/);
  assert.match(app, /const messageBody = JSON\.stringify\(\{[\s\S]*clientId/);
  assert.match(app, /const delays = \[0, 750, 1_500\]/);
  assert.match(app, /controller\.abort\(new Error\('message admission timeout'\)\)/);
  assert.match(app, /\[502, 503, 504\]\.includes\(status\)/);
  assert.match(app, /Orlynx is waking · reconnecting your message automatically/);

  assert.match(routes, /existingMessages\.find\(\(m: \{ id: string \}\) => m\.id === clientId\)/);
  assert.match(routes, /deduplicated: true/);
});
