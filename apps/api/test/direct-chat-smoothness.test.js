import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('direct chat has bounded silence, first-token and stale-task deadlines', () => {
  const direct = fs.readFileSync(new URL('../src/direct-chat.ts', import.meta.url), 'utf8');
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');

  assert.match(direct, /ORLYNX_DIRECT_TURN_TIMEOUT_MS \|\| 5 \* 60_000/);
  assert.match(direct, /ORLYNX_DIRECT_FIRST_TOKEN_TIMEOUT_MS \|\| 30_000/);
  assert.match(direct, /ORLYNX_DIRECT_STREAM_SILENCE_TIMEOUT_MS \|\| 45_000/);
  assert.match(direct, /stage === 'modelRequestStartedMs'\) armFirstTokenTimer\(\)/);
  assert.match(direct, /firstTokenSeen = true;\s*clearFirstTokenTimer\(\)/);
  assert.match(direct, /The model did not start streaming in time/);
  assert.match(direct, /The model is taking longer than usual · Orlynx will recover automatically if it stalls/);
  assert.match(direct, /The model stopped streaming for too long/);
  assert.match(direct, /armStreamSilenceTimer\(\)/);

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
  assert.match(agents, /\[502, 503, 504\]\.includes\(error\.statusCode \|\| 0\)/);
  assert.match(agents, /elapsedMs < 15_000/);
  assert.match(agents, /Never repeat a full 75s Render-runtime wake timeout/);
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


test('background runtime prewarm can outlive the interactive failover window', () => {
  const runtime = fs.readFileSync(new URL('../src/opencode-local.ts', import.meta.url), 'utf8');

  assert.match(runtime, /timeoutOverrideMs\?: number/);
  assert.match(runtime, /const configuredTimeout = timeoutOverrideMs \?\? Number\(process\.env\.ORLYNX_OPENCODE_RUNTIME_WAKE_TIMEOUT_MS/);
  assert.match(runtime, /waitForRuntimeReady\(controller\.signal, undefined, undefined, timeoutMs\)/);
  assert.match(runtime, /waitForRuntimeReady\(controller\.signal, undefined, undefined, 90_000\)/);
  assert.match(runtime, /await waitForRuntimeReady\(input\.signal, input\.onStatus, input\.onTiming\);/);
  assert.match(runtime, /recordFailure = true/);
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


test('pre-model GitHub repository context reads are network-bounded', () => {
  const github = fs.readFileSync(new URL('../src/github.ts', import.meta.url), 'utf8');

  assert.match(github, /ORLYNX_GITHUB_API_TIMEOUT_MS \|\| 15_000/);
  assert.match(github, /function githubApiFetch/);
  assert.match(github, /AbortSignal\.timeout\(GITHUB_API_TIMEOUT_MS\)/);
  assert.match(github, /githubApiFetch\(\`\$\{API\}\/repos\/\$\{owner\}\/\$\{name\}\/git\/trees/);
  assert.match(github, /githubApiFetch\(\`\$\{API\}\/repos\/\$\{encodeURIComponent\(repo\.owner\)\}\/\$\{encodeURIComponent\(repo\.name\)\}\/contents/);
});

test('waiting-input reply is durably queued instead of returning a retryable 503', () => {
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');

  assert.match(routes, /reason: 'waiting_input_provider_recovery'/);
  assert.match(routes, /recoveringRuntime: true/);
  assert.match(routes, /Your reply was saved\. Orlynx is recovering the AI runtime/);
  assert.doesNotMatch(routes, /waitingForSameTask: true/);
});


test('project open and mobile resume proactively wake the direct AI runtime', () => {
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../../web/src/ProductionApp.tsx', import.meta.url), 'utf8');

  assert.match(routes, /router\.post\('\/ai\/runtime\/prewarm'/);
  assert.match(routes, /void warmOpenCodeRuntime\(\)\.catch/);
  const calls = app.match(/fetch\('\/v1\/ai\/runtime\/prewarm', \{ method: 'POST' \}\)/g) || [];
  assert.ok(calls.length >= 2, 'runtime is warmed on project open and visible resume');
});


test('temporary GitHub context failure degrades chat instead of failing the whole turn', () => {
  const direct = fs.readFileSync(new URL('../src/direct-chat.ts', import.meta.url), 'utf8');

  assert.match(direct, /try \{\s*context = await repositoryContext/);
  assert.match(direct, /Repository context is temporarily unavailable · continuing without blocking chat/);
  assert.match(direct, /Do not invent repository file contents or claim they were inspected/);
  assert.match(direct, /timings\.repoContextFallback = 1/);
});

test('direct completion uses an atomic steering revision guard so late follow-ups cannot be overwritten', () => {
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');

  assert.match(agents, /finalSteeringRevision/);
  assert.match(agents, /completeDirectTaskIfUnchanged\(task, finalSteeringRevision\)/);
  assert.match(agents, /A follow-up arrived while the response was finalizing/);
  assert.match(storage, /completeDirectTaskIfUnchanged/);
  assert.match(storage, /harness_state->>'steeringRevision'/);
  assert.match(storage, /AND state='running'/);
  assert.match(storage, /RETURNING id/);
});

test('direct runtime outages fail over the same durable turn to workspace compute', () => {
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  const runtime = fs.readFileSync(new URL('../src/opencode-local.ts', import.meta.url), 'utf8');
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');

  assert.match(agents, /failoverDirectTaskToWorkspace/);
  assert.match(agents, /task\.plane = 'workspace'/);
  assert.match(agents, /task\.state = 'queued'/);
  assert.match(agents, /run\.plane = 'workspace'/);
  assert.match(agents, /direct_runtime_failover/);
  assert.match(agents, /selectWorkspaceProvider\(\{ taskText: task\.prompt \}\)/);
  assert.match(agents, /message: 'Switching compute…'/);
  assert.match(agents, /\[502, 503, 504\]\.includes\(error\.statusCode \|\| 0\)/);
  assert.match(storage, /getProject\(id: string\)/);
  assert.match(runtime, /DEFAULT_RUNTIME_WAKE_TIMEOUT_MS = 12_000/);
  assert.match(runtime, /computeTargetQuarantined\('direct-runtime'\)/);
  assert.match(runtime, /input\.onStatus\?\.\('Switching compute…'\)/);
});

