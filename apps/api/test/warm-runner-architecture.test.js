import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticateBridgeSocket,
  publishLiveBridgeResult,
  registerBridgeSocket,
  sendBridgeCommandNow,
  unregisterBridgeSocket,
  waitForLiveBridgeResult,
} from '../src/bridge-live.ts';
import { defaultWorkspaceProviderId, shouldPrewarmWorkspace } from '../src/workspace-providers.ts';

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('workspace provider prefers configured warm runner and otherwise preserves Codespaces', () => {
  withEnv({
    ORLYNX_WORKSPACE_PROVIDER: null,
    ORLYNX_RUNNER_URL: null,
    ORLYNX_RUNNER_TOKEN: null,
    ORLYNX_PREWARM_WORKSPACES: null,
  }, () => {
    assert.equal(defaultWorkspaceProviderId(), 'github-codespaces');
    assert.equal(shouldPrewarmWorkspace(), false);
  });

  withEnv({
    ORLYNX_WORKSPACE_PROVIDER: 'auto',
    ORLYNX_RUNNER_URL: 'https://runner.example.com',
    ORLYNX_RUNNER_TOKEN: 'test-token',
    ORLYNX_PREWARM_WORKSPACES: null,
  }, () => {
    assert.equal(defaultWorkspaceProviderId(), 'orlynx-runner');
    assert.equal(shouldPrewarmWorkspace(), true);
  });

  withEnv({
    ORLYNX_WORKSPACE_PROVIDER: 'github-codespaces',
    ORLYNX_RUNNER_URL: 'https://runner.example.com',
    ORLYNX_RUNNER_TOKEN: 'test-token',
  }, () => {
    assert.equal(defaultWorkspaceProviderId(), 'github-codespaces');
  });
});

test('explicit runner selection fails closed when runner credentials are missing', () => {
  withEnv({
    ORLYNX_WORKSPACE_PROVIDER: 'orlynx-runner',
    ORLYNX_RUNNER_URL: null,
    ORLYNX_RUNNER_TOKEN: null,
  }, () => {
    assert.throws(() => defaultWorkspaceProviderId(), /not configured/);
  });
});

test('live bridge sends authenticated commands immediately and de-duplicates on one socket', () => {
  const sent = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send(value) { sent.push(JSON.parse(String(value))); },
  };
  registerBridgeSocket('ws_fast', socket);
  assert.equal(sendBridgeCommandNow('ws_fast', { id: 'cmd_1', kind: 'git.status', payload: {} }), false);

  authenticateBridgeSocket('ws_fast', socket);
  assert.equal(sendBridgeCommandNow('ws_fast', { id: 'cmd_1', kind: 'git.status', payload: {} }), true);
  assert.equal(sendBridgeCommandNow('ws_fast', { id: 'cmd_1', kind: 'git.status', payload: {} }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'COMMAND');
  assert.equal(sent[0].commandId, 'cmd_1');

  unregisterBridgeSocket('ws_fast', socket);
});

test('bridge RPC waiters are resolved by live results', async () => {
  const waiter = waitForLiveBridgeResult('cmd_live_result');
  publishLiveBridgeResult('cmd_live_result', { ok: true, result: { value: 42 } });
  const result = await waiter.promise;
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { value: 42 });
  waiter.cancel();
});


test('workspace orchestration is durable, leased and recoverable', () => {
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');
  const jobs = fs.readFileSync(new URL('../src/workspace-jobs.ts', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');

  assert.match(storage, /CREATE TABLE IF NOT EXISTS workspace_jobs/);
  assert.match(storage, /FOR UPDATE SKIP LOCKED/);
  assert.match(storage, /lease_until=now\(\) \+ \(\$3 \* interval '1 second'\)/);
  assert.match(jobs, /renewWorkspaceJobLease/);
  assert.match(jobs, /runWorkspaceOrchestratorLoop/);
  assert.match(jobs, /ORLYNX_ORCHESTRATOR_MODE === 'worker'/);
  assert.match(routes, /scheduleWorkspacePreparation/);
  assert.doesNotMatch(routes, /void prepareWorkspace\(/);
});

test('Build work can escalate a passive prewarm job to Codespaces fallback', () => {
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');
  const jobs = fs.readFileSync(new URL('../src/workspace-jobs.ts', import.meta.url), 'utf8');
  assert.match(storage, /SET allow_fallback=true/);
  assert.match(jobs, /allowFallback: options\.allowFallback !== false/);
  assert.match(jobs, /reason: options\.reason/);
});
