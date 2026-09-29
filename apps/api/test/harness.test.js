import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  advanceHarnessPhase,
  applySteering,
  consumeHarnessStep,
  createHarnessCheckpoint,
  harnessBudgetStatus,
  harnessSystemInstruction,
  detectEvidenceContradictions,
  openCodeToolsFor,
  prepareReflection,
  queueIntentFor,
  reflectionInstruction,
  shouldReflect,
  shouldSalvage,
  steeringActionFor,
  toolFamiliesFor,
  userInputRequest,
  verificationRequirementsFor,
  verifyHarness,
} from '../src/harness.ts';

function evt(sequence, type, payload = {}) {
  return {
    eventId: `evt-${sequence}`,
    sessionId: 'session-1',
    taskId: 'task-1',
    runId: 'run-1',
    sequence,
    type,
    timestamp: new Date(2026, 8, 28, 12, 0, sequence).toISOString(),
    payload,
  };
}

test('harness infers explicit Build acceptance criteria without inventing unrelated work', () => {
  assert.deepEqual(
    verificationRequirementsFor('fix trimming, run tests, build frontend, commit and push to main'),
    ['changes', 'tests', 'build', 'commit', 'publish'],
  );
  assert.deepEqual(verificationRequirementsFor('explain how this file works'), []);
  assert.deepEqual(verificationRequirementsFor('start localhost and verify preview'), ['preview']);
  assert.deepEqual(verificationRequirementsFor('check online for the latest official docs'), ['browser']);
});

test('harness starts durable and progressively discloses tool families', () => {
  const cp = createHarnessCheckpoint({
    prompt: 'fix it and run tests',
    mode: 'build',
    permission: 'full',
    plane: 'workspace',
    now: '2026-09-28T12:00:00.000Z',
  });
  assert.equal(cp.phase, 'received');
  assert.equal(cp.step, 0);
  assert.equal(cp.stepBudget, 30);
  assert.deepEqual(cp.verification.required, ['changes', 'tests']);
  assert.deepEqual(cp.toolFamilies, ['repository']);

  const context = advanceHarnessPhase(cp, 'context_loading', { mode: 'build', permission: 'full' });
  assert.deepEqual(context.toolFamilies, ['repository']);

  const executing = advanceHarnessPhase(context, 'executing', { mode: 'build', permission: 'full' });
  assert.ok(executing.toolFamilies.includes('terminal'));
  assert.ok(executing.toolFamilies.includes('tests'));

  const researching = advanceHarnessPhase(createHarnessCheckpoint({
    prompt: 'search the web for the latest official docs', mode: 'build', permission: 'full', plane: 'workspace',
  }), 'executing', { mode: 'build', permission: 'full' });
  assert.ok(researching.toolFamilies.includes('browser'));
  assert.equal(openCodeToolsFor(researching).websearch, true);
  assert.equal(openCodeToolsFor(researching).webfetch, true);

  assert.deepEqual(toolFamiliesFor({ mode: 'ask', permission: 'read-only', phase: 'executing' }), ['repository']);
  assert.equal(openCodeToolsFor({
    ...executing,
    toolFamilies: ['repository'],
  }).write, false);
  assert.deepEqual(toolFamiliesFor({ mode: 'build', permission: 'full', phase: 'finalizing' }), []);
});

test('step budget warns, forces finalization, and disables salvage at the hard boundary', () => {
  let cp = createHarnessCheckpoint({
    prompt: 'fix it',
    mode: 'build',
    permission: 'full',
    plane: 'workspace',
    stepBudget: 8,
  });
  cp = advanceHarnessPhase(cp, 'executing', { mode: 'build', permission: 'full' });

  cp = consumeHarnessStep(cp, { mode: 'build', permission: 'full' });
  assert.equal(harnessBudgetStatus(cp).stage, 'warn');

  for (let i = 0; i < 4; i++) cp = consumeHarnessStep(cp, { mode: 'build', permission: 'full' });
  assert.equal(harnessBudgetStatus(cp).remaining, 3);
  assert.equal(harnessBudgetStatus(cp).stage, 'finalize');

  for (let i = 0; i < 2; i++) cp = consumeHarnessStep(cp, { mode: 'build', permission: 'full' });
  assert.equal(harnessBudgetStatus(cp).remaining, 1);
  assert.equal(harnessBudgetStatus(cp).stage, 'force-final');

  cp.verification.status = 'needs_more_work';
  assert.equal(shouldSalvage(cp, 'still working'), false);
  assert.deepEqual(cp.toolFamilies, []);
});

test('active-turn steering classifies source-style APPEND REPLACE STOP behavior', () => {
  assert.equal(steeringActionFor('also check mobile reconnect'), 'append');
  assert.equal(steeringActionFor('make sure WAV still works'), 'append');
  assert.equal(steeringActionFor('forget recording, only check reconnect'), 'replace');
  assert.equal(steeringActionFor('instead only fix MP3'), 'replace');
  assert.equal(steeringActionFor('stop'), 'stop');
  assert.equal(steeringActionFor('cancel the current task'), 'stop');
  assert.equal(steeringActionFor('why are you changing that file?'), 'ignore');
});

test('APPEND and REPLACE stay on the same durable task while STOP cancels it', () => {
  const base = {
    id: 'task-1',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    plane: 'workspace',
    runId: 'run-1',
    state: 'running',
    prompt: 'fix recording',
    mode: 'build',
    permission: 'full',
    createdAt: '2026-09-28T12:00:00.000Z',
    updatedAt: '2026-09-28T12:00:00.000Z',
  };

  const appended = applySteering(base, 'also check mobile reconnect', 'append', '2026-09-28T12:01:00.000Z');
  assert.equal(appended.id, base.id);
  assert.equal(appended.runId, base.runId);
  assert.equal(appended.prompt, base.prompt);
  assert.equal(appended.harness?.inbox.at(-1)?.action, 'append');

  const replaced = applySteering(appended, 'forget recording, only fix reconnect', 'replace', '2026-09-28T12:02:00.000Z');
  assert.equal(replaced.id, base.id);
  assert.equal(replaced.prompt, 'forget recording, only fix reconnect');
  assert.equal(replaced.harness?.steeringRevision, 2);

  const stopped = applySteering(replaced, 'stop', 'stop', '2026-09-28T12:03:00.000Z');
  assert.equal(stopped.state, 'cancelled');
  assert.equal(stopped.harness?.phase, 'cancelled');
});

test('result verifier uses durable canonical evidence instead of trusting final prose', () => {
  let cp = createHarnessCheckpoint({
    prompt: 'fix trimming, run tests, build, commit and push to main',
    mode: 'build',
    permission: 'full',
    plane: 'workspace',
  });
  cp = advanceHarnessPhase(cp, 'verifying', { mode: 'build', permission: 'full' });

  const events = [
    evt(1, 'changes.updated', { files: [{ path: 'src/trim.ts' }] }),
    evt(2, 'tool.completed', { command: 'node --test test/trim.test.js', semanticType: 'test-result', exitCode: 0 }),
    evt(3, 'tool.completed', { command: 'npm run build', semanticType: 'build-result', exitCode: 0 }),
    evt(4, 'tool.completed', { command: 'git commit -m "fix trim"', exitCode: 0 }),
    evt(5, 'receipt.created', { publish: true, pushedBranch: 'main', commitSha: 'abc1234' }),
  ];

  cp = verifyHarness(cp, events);
  assert.equal(cp.verification.status, 'passed');
  assert.deepEqual(cp.verification.missing, []);
  assert.deepEqual(cp.verification.satisfied, ['changes', 'tests', 'build', 'commit', 'publish']);
});

test('browser research verification requires real web tool evidence', () => {
  let cp = createHarnessCheckpoint({
    prompt: 'search the web for the latest official docs',
    mode: 'build', permission: 'full', plane: 'workspace',
  });
  cp = verifyHarness(cp, [evt(1, 'tool.completed', { tool: 'websearch', exitCode: 0 })]);
  assert.equal(cp.verification.status, 'passed');
  assert.deepEqual(cp.verification.satisfied, ['browser']);
});

test('result verifier supports bounded model reflection instead of one-shot salvage', () => {
  let cp = createHarnessCheckpoint({
    prompt: 'fix it and run tests',
    mode: 'build',
    permission: 'full',
    plane: 'workspace',
  });
  cp = verifyHarness(cp, [evt(1, 'changes.updated', { files: [{ path: 'src/a.ts' }] })]);
  assert.equal(cp.verification.status, 'needs_more_work');
  assert.deepEqual(cp.verification.missing, ['tests']);
  assert.equal(shouldSalvage(cp, 'I am still working on it'), true);

  cp = prepareReflection(cp, [evt(2, 'tool.output', { command: 'npm test', out: 'still investigating' })]);
  assert.equal(cp.reflectionAttempts, 1);
  assert.equal(shouldReflect(cp, 'I am still working on it'), true);
  cp.reflectionAttempts = 4;
  cp.salvageAttempts = 4;
  assert.equal(shouldReflect(cp, 'I am still working on it'), false);
});

test('reflection detects contradictory preview evidence and tells the model to diagnose the right layer', () => {
  let cp = createHarnessCheckpoint({
    prompt: 'start localhost preview',
    mode: 'build',
    permission: 'full',
    plane: 'workspace',
  });
  const events = [
    evt(1, 'tool.output', { command: 'curl http://localhost:5173/', out: 'HTTP/1.1 200 OK' }),
    evt(2, 'tool.output', { command: 'ss -ltn', out: 'LISTEN 0 511 0.0.0.0:5173' }),
  ];
  cp = verifyHarness(cp, events);
  const contradictions = detectEvidenceContradictions(events, cp.verification.missing);
  assert.equal(contradictions.length, 1);
  assert.match(contradictions[0], /local web server appears healthy/i);
  cp = prepareReflection(cp, events);
  const instruction = reflectionInstruction(cp, ['Private Codespaces previews may require authenticated external navigation.']);
  assert.match(instruction, /Reflection cycle 1\/4/);
  assert.match(instruction, /reasoning layer/i);
  assert.match(instruction, /Do not repeat the same failed command/i);
  assert.match(instruction, /Verified lessons from earlier successful work/);
});

test('waiting-for-user is a real paused harness state with no active tools', () => {
  const cp = createHarnessCheckpoint({ prompt: 'deploy it', mode: 'build', permission: 'full', plane: 'workspace' });
  const waiting = advanceHarnessPhase(cp, 'waiting_input', { mode: 'build', permission: 'full' });
  assert.deepEqual(waiting.toolFamilies, []);
});

test('Preview reflection diagnoses provider transport before mutating project config', () => {
  let cp = createHarnessCheckpoint({
    prompt: 'start localhost and open preview',
    mode: 'build',
    permission: 'full',
    plane: 'workspace',
  });
  cp = advanceHarnessPhase(cp, 'executing', { mode: 'build', permission: 'full' });
  cp = verifyHarness(cp, [
    evt(1, 'tool.completed', { command: 'curl http://localhost:5173/', out: 'HTTP/1.1 200 OK' }),
  ]);
  cp = prepareReflection(cp, [
    evt(1, 'tool.completed', { command: 'curl http://localhost:5173/', out: 'HTTP/1.1 200 OK' }),
  ]);
  const instruction = reflectionInstruction(cp);
  assert.match(instruction, /diagnose Orlynx\/provider forwarding before editing the repository/i);
  assert.match(instruction, /diagnostic-only project change is no longer needed/i);
  assert.match(instruction, /detach the process cleanly/i);
});

test('human-only input can be requested after the streamed model diagnostic', () => {
  const value = userInputRequest('Model → Orlynx: the repository cannot reveal this secret.\n\n[NEEDS_USER_INPUT] Please provide the deployment token.');
  assert.equal(value, 'Please provide the deployment token.');
  assert.equal(userInputRequest('Model → Orlynx: I can inspect this myself.'), undefined);
});

test('hidden harness instruction carries phase budget criteria tools and steering without becoming user text', () => {
  let cp = createHarnessCheckpoint({
    prompt: 'fix it and run tests',
    mode: 'build',
    permission: 'full',
    plane: 'workspace',
  });
  cp = applySteering({
    id: 'task-1', sessionId: 'session-1', workspaceId: 'workspace-1', plane: 'workspace',
    state: 'running', prompt: 'fix it and run tests', mode: 'build', permission: 'full',
    harness: cp, createdAt: cp.updatedAt, updatedAt: cp.updatedAt,
  }, 'also check mobile reconnect', 'append').harness;

  const text = harnessSystemInstruction(cp);
  assert.match(text, /Orlynx harness phase:/);
  assert.match(text, /Acceptance criteria: changes, tests/);
  assert.match(text, /Active tool families:/);
  assert.match(text, /\[APPEND\] also check mobile reconnect/);
  assert.match(text, /Progress text is not a final answer/);
});

test('Postgres task storage persists harness checkpoints as JSONB', () => {
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');
  assert.match(storage, /ALTER TABLE tasks ADD COLUMN IF NOT EXISTS harness_state jsonb/);
  assert.match(storage, /harness: \(row\.harness_state \|\| undefined\) as TaskRecord\['harness'\]/);
  assert.match(storage, /JSON\.stringify\(v\.harness \|\| null\)/);
  assert.match(storage, /harness_state=EXCLUDED\.harness_state/);
});

test('verified learning memory is durable Postgres state, not temporary JSON', () => {
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');
  const memory = fs.readFileSync(new URL('../src/agent-memory.ts', import.meta.url), 'utf8');
  assert.match(storage, /CREATE TABLE IF NOT EXISTS agent_lessons/);
  assert.match(storage, /putAgentLesson/);
  assert.match(storage, /listAgentLessons/);
  assert.match(memory, /rememberVerifiedLesson/);
  assert.match(memory, /verification\.status !== 'passed'/);
  assert.match(memory, /Verified Orlynx experience from earlier successful work/);
  assert.match(memory, /scope: 'environment'/);
});

test('agent memory is user-scoped, relevance-gated, and cannot overwrite another user', () => {
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');
  const memory = fs.readFileSync(new URL('../src/agent-memory.ts', import.meta.url), 'utf8');
  assert.match(memory, /function lessonId\(userId: string/);
  assert.match(memory, /\.update\(\[userId, scope,/);
  assert.match(memory, /if \(overlap === 0\) return 0/);
  assert.match(storage, /WHERE agent_lessons\.user_id=EXCLUDED\.user_id/);
});

test('bridge lifecycle events use the awaited durable live broadcaster', () => {
  const gateway = fs.readFileSync(new URL('../src/bridge-gateway.ts', import.meta.url), 'utf8');
  const events = fs.readFileSync(new URL('../src/events.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(gateway, /repository\.appendEvent\(/);
  assert.match(gateway, /persistLiveEvent/);
  assert.match(events, /export async function emitPersisted/);
  assert.match(events, /subscribers\.get\(sessionId\).*res\.write/s);
  assert.match(events, /eventSubscribers\.get\(sessionId\).*listener/s);
});

test('real workspace reflection carries an id and emits Model to Orlynx activity', () => {
  const gateway = fs.readFileSync(new URL('../src/bridge-gateway.ts', import.meta.url), 'utf8');
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  assert.match(gateway, /reflectionId: task\.harness\.reflectionAttempts/);
  assert.match(bridge, /agent\.dialogue\.model/);
  assert.match(bridge, /Model\\s\*\[→>-\]\\s\*Orlynx:/);
});

test('durable workspace gateway verifies evidence and either salvages or completes explicitly', () => {
  const gateway = fs.readFileSync(new URL('../src/bridge-gateway.ts', import.meta.url), 'utf8');
  assert.match(gateway, /task\.harness = verifyHarness\(task\.harness, recent/);
  assert.match(gateway, /shouldReflect\(task\.harness, responseText\)/);
  assert.match(gateway, /prepareReflection\(task\.harness, recent/);
  assert.match(gateway, /reflectionInstruction\(task\.harness/);
  assert.match(gateway, /needsFinalSynthesis\(task\.harness, responseText\)/);
  assert.match(gateway, /controlledDefaultBranchPublish/);
  assert.match(gateway, /type: 'run\.completed'/);
  assert.match(gateway, /type: 'run\.failed'/);
});

test('OpenCode tool work emits canonical step boundaries for harness budgeting', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  const protocol = fs.readFileSync(new URL('../src/agent-protocol.ts', import.meta.url), 'utf8');
  assert.match(bridge, /bridgeEvent\(ws, 'step\.started'/);
  assert.match(bridge, /bridgeEvent\(ws, 'step\.finished'/);
  assert.match(protocol, /'step\.started': 'step\.started'/);
  assert.match(protocol, /'step\.finished': 'step\.finished'/);
});

test('active message admission continues the same task across direct and workspace planes', () => {
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /const requestedSteeringAction = steeringActionFor\(String\(text\)\)/);
  assert.match(routes, /filter\(\(item\) => \['running', 'waiting_approval', 'waiting_input'\]\.includes\(item\.state\)\)/);
  assert.match(routes, /requestedSteeringAction === 'ignore' \? 'append' : requestedSteeringAction/);
  assert.match(routes, /msg\.runId = activeTask\.runId/);
  assert.match(routes, /resumeWaitingInputTask\(s\.id, waitingInputTask\.id, String\(text\)\)/);
  assert.match(routes, /applySteering\(activeTask, String\(text\), steeringAction, now\)/);
  assert.match(routes, /continued: true/);
  assert.match(routes, /cancelDirectRun/);
  assert.match(routes, /bridgeCancelCommand/);
  assert.doesNotMatch(routes, /const ackRunId =/);
  assert.doesNotMatch(routes, /Added that to the current Build task\./);
});

test('only explicit next-work language creates a separate queued task', () => {
  assert.equal(queueIntentFor('also check the mobile view'), false);
  assert.equal(queueIntentFor('what have you done so far?'), false);
  assert.equal(queueIntentFor('queue this: run the accessibility audit'), true);
  assert.equal(queueIntentFor('after this is finished, run the full test suite'), true);
  assert.equal(queueIntentFor('do this next: inspect the API'), true);
});

test('durable queue exposes edit and cancel controls against the scheduler ledger', () => {
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /router\.get\('\/sessions\/:id\/tasks'/);
  assert.match(routes, /router\.patch\('\/sessions\/:id\/tasks\/:taskId'/);
  assert.match(routes, /router\.delete\('\/sessions\/:id\/tasks\/:taskId'/);
  assert.match(routes, /Only queued tasks can be edited/);
  assert.match(routes, /Only queued tasks can be cancelled here/);
  assert.match(routes, /const explicitQueue = queueIntentFor\(String\(text\)\)/);
  assert.match(routes, /a\.plane === 'direct' \? 0 : 1/);
});

test('direct Ask and Plan continue the same task inbox before finalizing', () => {
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  assert.match(agents, /for \(let continuationRound = 0; continuationRound < 4; continuationRound \+= 1\)/);
  assert.match(agents, /freshTask\.harness\?\.inbox\.filter\(\(item\) => !item\.appliedAt\)/);
  assert.match(agents, /Continue the same Orlynx conversation/);
  assert.match(agents, /latestContinuation/);
  assert.match(agents, /runId: run\.id/);
  assert.match(agents, /agent\.dialogue\.orlynx/);
});
