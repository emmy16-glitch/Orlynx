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
  openCodeToolsFor,
  shouldSalvage,
  steeringActionFor,
  toolFamiliesFor,
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

test('result verifier requests one salvage pass for missing evidence or progress-only text', () => {
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

  cp.salvageAttempts = 1;
  assert.equal(shouldSalvage(cp, 'I am still working on it'), false);
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

test('OpenCode tool work emits canonical step boundaries for harness budgeting', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  const protocol = fs.readFileSync(new URL('../src/agent-protocol.ts', import.meta.url), 'utf8');
  assert.match(bridge, /bridgeEvent\(ws, 'step\.started'/);
  assert.match(bridge, /bridgeEvent\(ws, 'step\.finished'/);
  assert.match(protocol, /'step\.started': 'step\.started'/);
  assert.match(protocol, /'step\.finished': 'step\.finished'/);
});

test('active message admission steers the running workspace task rather than creating another Build task', () => {
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /const steeringAction = steeringActionFor\(String\(text\)\)/);
  assert.match(routes, /find\(\(item\) => item\.state === 'running' && \(item\.plane \|\| 'workspace'\) === 'workspace'\)/);
  assert.match(routes, /applySteering\(activeTask, String\(text\), steeringAction, now\)/);
  assert.match(routes, /Added that to the current Build task\./);
  assert.match(routes, /bridgeCancelCommand/);
});
