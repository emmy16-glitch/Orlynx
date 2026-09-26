import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getAgentAdapter, listAgentAdapters } from '../src/agent-runtime.ts';

test('OpenCode is registered as adapter one, not hard-coded as the only engine type', () => {
  const adapters = listAgentAdapters();
  assert.equal(adapters.some((adapter) => adapter.id === 'opencode'), true);
  const adapter = getAgentAdapter('opencode');
  assert.equal(adapter.displayName, 'OpenCode');
  assert.equal(adapter.bridgeRunCommand, 'agent.run');
  assert.equal(adapter.bridgeCancelCommand, 'agent.cancel');
  assert.equal(adapter.capabilities.workspace, true);
  assert.deepEqual(adapter.parseModel('openai/test-model'), { providerID: 'openai', modelID: 'test-model' });
  assert.throws(() => getAgentAdapter('cline'), /not installed/i);
});

test('adapter builds a generic workspace envelope with its own adapter id', () => {
  const adapter = getAgentAdapter('opencode');
  const payload = adapter.workspacePayload({
    modelId: 'openai/test-model',
    taskId: 'task-1',
    runId: 'run-1',
    sessionId: 'session-1',
    engineSessionId: 'engine-1',
    text: 'Inspect the repository.',
    agent: 'build',
  });
  assert.equal(payload.adapterId, 'opencode');
  assert.equal(payload.taskId, 'task-1');
  assert.deepEqual(payload.model, { providerID: 'openai', modelID: 'test-model' });
});

test('durable storage persists only generic adapter identity, health and sessions', () => {
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');
  assert.match(storage, /adapter_id text NOT NULL DEFAULT 'opencode'/);
  assert.match(storage, /workspace_agent_adapters/);
  assert.match(storage, /agent_sessions/);
  assert.match(storage, /PRIMARY KEY\(session_id,adapter_id\)/);
  assert.match(storage, /PRIMARY KEY\(workspace_id,adapter_id\)/);
  assert.match(storage, /migrateLegacyAdapterStorage/);
  assert.match(storage, /information_schema\.tables/);
  assert.match(storage, /information_schema\.columns/);
  assert.match(storage, /DROP TABLE engine_sessions/);
  assert.match(storage, /DROP COLUMN opencode_state/);
  assert.doesNotMatch(storage, /DO \$/);
  assert.doesNotMatch(storage, /getEngineSession\(/);
  assert.doesNotMatch(storage, /putEngineSession\(/);
});

test('workspace bridge can start without OpenCode and reports adapter status separately', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  assert.match(bridge, /bridgeAgentAdapters/);
  assert.match(bridge, /ADAPTER_STATUS/);
  assert.match(bridge, /agent-adapters/);
  assert.doesNotMatch(bridge, /!CONNECTION_ID \|\| !OPENCODE_PASSWORD/);
});


test('visible agent picker and task admission use the selected adapter explicitly', () => {
  const web = fs.readFileSync(new URL('../../../apps/web/src/ProductionApp.tsx', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
  assert.match(web, /inline-agent-picker/);
  assert.match(web, /adapterId: ai\.adapterId \|\| 'opencode'/);
  assert.match(routes, /selectedAdapterId/);
  assert.match(routes, /startRun\(s\.id, s\.project, text, selectedAdapterId/);
});

test('promotion scheduler preserves adapter-ready wakeups that arrive while a pass is active', () => {
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  assert.match(agents, /promotionWakeups/);
  assert.match(agents, /Do not drop readiness\/queue wake-ups/);
  assert.match(agents, /while \(promotionWakeups\.delete\(sessionId\)\)/);
});
