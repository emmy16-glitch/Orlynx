import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.deepEqual(adapters.map(adapter => adapter.id), ['opencode', 'mini-swe', 'cline']);
  assert.equal(getAgentAdapter('cline').capabilities.directChat, false);
  assert.equal(getAgentAdapter('mini-swe').capabilities.repositoryWrite, true);
  assert.throws(() => getAgentAdapter('unknown-runtime'), /not installed/i);
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
    system: 'Private Orlynx instruction.',
    agent: 'build',
  });
  assert.equal(payload.adapterId, 'opencode');
  assert.equal(payload.taskId, 'task-1');
  assert.equal(payload.text, 'Inspect the repository.');
  assert.equal(payload.system, 'Private Orlynx instruction.');
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

test('workspace bridge sends private Orlynx guidance through OpenCode system', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  assert.match(bridge, /if \(payload\.system\) body\.system = String\(payload\.system\)/);
  assert.match(bridge, /parts: \[\{ type: 'text', text: publicContext \}\]/);
  assert.match(bridge, /payload\.handoff/);
});

test('workspace bridge can start without OpenCode and reports adapter status separately', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  assert.match(bridge, /bridgeAgentAdapters/);
  assert.match(bridge, /ADAPTER_STATUS/);
  assert.match(bridge, /agent-adapters/);
  assert.doesNotMatch(bridge, /!CONNECTION_ID \|\| !OPENCODE_PASSWORD/);
});


test('visible agent controls and task admission use the selected adapter explicitly', () => {
  const web = fs.readFileSync(new URL('../../../apps/web/src/ProductionApp.tsx', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
  assert.match(web, /className="ai-control-trigger composer-chip agent-chip"/);
  assert.match(web, /className="ai-dropdown-topline"/);
  assert.match(web, /onSelectAdapter=\{\(id\) =>/);
  assert.match(web, /const agentChoices = adapters.map/);
  assert.doesNotMatch(web, /displayName: 'Cline', detail: 'Coming soon'/);
  assert.match(web, /adapterId: activeAi\.adapterId \|\| 'opencode'/);
  assert.match(web, /mode: activeAi\.mode/);
  assert.match(routes, /selectedAdapterId/);
  assert.match(routes, /startRun\(s\.id, s\.project, text, selectedAdapterId/);
});

test('controlled Git publish keeps credentials in the control plane and never delegates publication to the AI shell', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
  const publisher = fs.readFileSync(new URL('../src/publisher.ts', import.meta.url), 'utf8');

  assert.match(bridge, /case 'git\.fetch'/);
  assert.match(bridge, /case 'git\.reconcile-published'/);
  assert.doesNotMatch(bridge, /case 'git\.push':/);
  assert.match(routes, /publishCommittedWorkspaceHead/);
  assert.match(routes, /publishVerifiedChangeSet/);
  assert.match(publisher, /githubInstallationApiRequest/);
  assert.match(publisher, /force:\s*false/);
  assert.doesNotMatch(publisher, /bridgeRequest[^\n]*['"]git\.push['"]/);
  assert.match(routes, /const publishIntent = effectiveMode === 'build' \? publishIntentFor/);
  assert.match(routes, /Published .* to/);
});

test('promotion scheduler preserves adapter-ready wakeups that arrive while a pass is active', () => {
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  assert.match(agents, /promotionWakeups/);
  assert.match(agents, /Do not drop readiness\/queue wake-ups/);
  assert.match(agents, /while \(promotionWakeups\.delete\(sessionId\)\)/);
});


test('AI overview exposes configured portable adapters before a workspace is ready', () => {
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
  const config = fs.readFileSync(new URL('../src/portable-agent-config.ts', import.meta.url), 'utf8');
  assert.match(routes, /portableAdapterConfig\(adapter\.id\)/);
  assert.match(routes, /portable\?\.configured \? 'available' : 'not_installed'/);
  assert.match(routes, /Ready when the workspace starts\./);
  assert.match(routes, /const authoritativePersisted = workspaceReady && persisted/);
  assert.match(config, /https:\/\/openrouter\.ai\/api\/v1/);
  assert.match(config, /openrouter\/poolside\/laguna-s-2\.1:free/);
  assert.match(config, /ORLYNX_OPENROUTER_API_KEY/);
});
