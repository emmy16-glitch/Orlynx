import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('cold-start worker sweeps durable active sessions without browser activity', () => {
  const jobs = fs.readFileSync(new URL('../src/workspace-jobs.ts', import.meta.url), 'utf8');
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');

  assert.match(storage, /listActiveTaskSessionIds/);
  assert.match(storage, /state IN \('queued','running','waiting_input','waiting_approval'\)/);
  assert.match(jobs, /recoverDurableTaskSessionsOnce/);
  assert.match(jobs, /recoverInterruptedDirectRuns/);
  assert.match(jobs, /ORLYNX_RECOVERY_SWEEP_MS \|\| 30_000/);
  assert.match(jobs, /nextRecoverySweepAt = 0/);
});

test('queued Build wakes stopped workspace and repairs stale adapter automatically', () => {
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');

  assert.match(agents, /reason: 'queue_wake'/);
  assert.match(agents, /waking it automatically/);
  assert.match(agents, /reason: 'adapter_recovery'/);
  assert.match(agents, /adapterStale/);
  assert.match(agents, /7 \* 24 \* 60 \* 60_000/);
});

test('workspace preparation scheduling is idempotent and does not spam duplicate queued events', () => {
  const jobs = fs.readFileSync(new URL('../src/workspace-jobs.ts', import.meta.url), 'utf8');

  assert.match(jobs, /const inserted = await repository\.enqueueWorkspaceJob\(job\)/);
  assert.match(jobs, /if \(inserted\) \{[\s\S]*orchestrator\.queued/);
});

test('interactive provider failover reaches runner pool after Codespaces and E2B', async () => {
  const previousKey = process.env.E2B_API_KEY;
  const previousHosts = process.env.ORLYNX_RUNNER_HOSTS;
  const previousToken = process.env.ORLYNX_RUNNER_TOKEN;
  process.env.E2B_API_KEY = 'e2b_test';
  process.env.ORLYNX_RUNNER_HOSTS = 'fallback=https://runner.example.test';
  process.env.ORLYNX_RUNNER_TOKEN = 'runner_test';
  try {
    const { fallbackWorkspaceProviderId } = await import('../src/workspace-providers.ts');
    assert.equal(fallbackWorkspaceProviderId('github-codespaces', ['github-codespaces']), 'e2b');
    assert.equal(fallbackWorkspaceProviderId('e2b', ['github-codespaces', 'e2b']), 'orlynx-runner');
    assert.equal(fallbackWorkspaceProviderId('orlynx-runner', ['github-codespaces', 'e2b', 'orlynx-runner']), null);
  } finally {
    if (previousKey === undefined) delete process.env.E2B_API_KEY; else process.env.E2B_API_KEY = previousKey;
    if (previousHosts === undefined) delete process.env.ORLYNX_RUNNER_HOSTS; else process.env.ORLYNX_RUNNER_HOSTS = previousHosts;
    if (previousToken === undefined) delete process.env.ORLYNX_RUNNER_TOKEN; else process.env.ORLYNX_RUNNER_TOKEN = previousToken;
  }
});

test('E2B startup check validates control-plane credentials without creating a sandbox', () => {
  const e2b = fs.readFileSync(new URL('../src/e2b-provider.ts', import.meta.url), 'utf8');
  assert.match(e2b, /e2bPlatformHealth/);
  assert.match(e2b, /Sandbox\.list/);
  assert.match(e2b, /nextItems/);
  const healthStart = e2b.indexOf('export async function e2bPlatformHealth');
  const healthEnd = e2b.indexOf('async function connectSandbox', healthStart);
  const block = e2b.slice(healthStart, healthEnd);
  assert.doesNotMatch(block, /Sandbox\.create/);
});
