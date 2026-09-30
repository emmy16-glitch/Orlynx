import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('bridge command terminal states are immutable and duplicate results cannot finalize a task twice', () => {
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');
  const gateway = fs.readFileSync(new URL('../src/bridge-gateway.ts', import.meta.url), 'utf8');

  assert.match(storage, /completeCommand\(id: string, status: 'completed' \| 'failed'.*Promise<boolean>/s);
  assert.match(storage, /AND status IN \('queued','sent'\)/);
  assert.match(storage, /RETURNING id/);

  assert.match(gateway, /command\.status === 'completed' \|\| command\.status === 'failed'/);
  assert.match(gateway, /ignored duplicate terminal result/);
  assert.match(gateway, /const accepted = await repository\.completeCommand/);
  assert.match(gateway, /ignored raced late result/);
  assert.match(gateway, /\['cancelled', 'failed', 'completed'\]\.includes\(task\.state\)/);
});

test('workspace heartbeat renews only exact active agent tasks', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  const gateway = fs.readFileSync(new URL('../src/bridge-gateway.ts', import.meta.url), 'utf8');

  assert.match(bridge, /'task-heartbeat-v2'/);
  assert.match(bridge, /activeTaskIds: \[\.\.\.activeAgents\.keys\(\)\]/);
  assert.match(gateway, /const activeTaskIds = new Set/);
  assert.match(gateway, /activeTaskIds\.has\(task\.id\)/);
  assert.doesNotMatch(gateway, /if \(\(task\.plane \|\| 'workspace'\) !== 'workspace' \|\| task\.state !== 'running'\) continue;\s*task\.updatedAt = now;/);
});

test('running Build transport is repaired early while ghost tasks are released only on exact-heartbeat runtimes', () => {
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');

  assert.match(agents, /ORLYNX_BRIDGE_HEARTBEAT_STALE_MS \|\| 60_000/);
  assert.match(agents, /ORLYNX_ACTIVE_TASK_HEARTBEAT_STALE_MS \|\| 3 \* 60_000/);
  assert.match(agents, /reason: 'running_task_bridge_recovery'/);
  assert.match(agents, /workspace\.capabilities\.includes\('task-heartbeat-v2'\)/);
  assert.match(agents, /previous AI task is no longer active/);
});

test('long-idle GitHub refresh is single-flight and can salvage a token rotated by another API process', () => {
  const github = fs.readFileSync(new URL('../src/github.ts', import.meta.url), 'utf8');

  assert.match(github, /const userTokenRefreshes = new Map<string, Promise<string>>\(\)/);
  assert.match(github, /const existingRefresh = userTokenRefreshes\.get\(userId\)/);
  assert.match(github, /Re-read after acquiring single-flight ownership/);
  assert.match(github, /for \(const delay of \[0, 150, 350, 700\]\)/);
  assert.match(github, /latestExpiresAt > Date\.now\(\) \+ 5 \* 60_000/);
});
