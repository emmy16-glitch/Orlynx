import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { emptyAgentStreamState } from '../../web/src/agent-stream/protocol.ts';
import { normalizeOrlynxEvents } from '../../web/src/agent-stream/adapter.ts';
import { applyRawAgentEvents, reconcileAgentStream, rebuildAgentStream } from '../../web/src/agent-stream/store.ts';
import { selectActivities, selectLiveReplies } from '../../web/src/agent-stream/view.ts';

const raw = (eventId, sequence, type, runId = 'run-a', payload = {}, timestamp = '2026-09-27T10:00:00.000Z') => ({
  eventId, sessionId: 'session-a', runId, sequence, timestamp, type, payload,
});

test('raw Orlynx transport events normalize into the canonical lifecycle', () => {
  const events = normalizeOrlynxEvents([
    raw('1', 1, 'run.started', 'run-a', { messageId: 'user-1', plane: 'direct' }),
    raw('2', 2, 'message.delta', 'run-a', { delta: 'Hello' }),
    raw('3', 3, 'tool.started', 'run-a', { tool: 'read', toolCallId: 'call-1', path: 'package.json' }),
    raw('4', 4, 'tool.completed', 'run-a', { tool: 'read', toolCallId: 'call-1' }),
    raw('5', 5, 'run.completed', 'run-a', {}),
  ]);
  assert.deepEqual(events.map((event) => event.type), [
    'RUN_STARTED', 'TEXT_CONTENT', 'TOOL_START', 'TOOL_END', 'RUN_FINISHED',
  ]);
});

test('canonical store keeps text, tools and run lifecycle under stable identities', () => {
  const state = applyRawAgentEvents(emptyAgentStreamState(), [
    raw('1', 1, 'run.started', 'run-a', { messageId: 'user-1', plane: 'workspace' }),
    raw('2', 2, 'message.delta', 'run-a', { delta: 'Checking ' }),
    raw('3', 3, 'message.delta', 'run-a', { delta: 'now.' }),
    raw('4', 4, 'tool.started', 'run-a', { tool: 'exec', toolCallId: 'same', cmd: 'npm test' }),
    raw('5', 5, 'tool.output', 'run-a', { tool: 'exec', toolCallId: 'same', outDelta: '8 passed\n' }),
    raw('6', 6, 'tool.completed', 'run-a', { tool: 'exec', toolCallId: 'same', exitCode: 0 }),
  ]);
  assert.equal(selectLiveReplies(state)[0].text, 'Checking now.');
  const rows = selectActivities(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Tests passed');
  assert.equal(rows[0].rawOutput, '8 passed\n');
});

test('provider tool IDs cannot collide across simultaneous runs', () => {
  const state = applyRawAgentEvents(emptyAgentStreamState(), [
    raw('a1', 1, 'tool.started', 'run-a', { tool: 'exec', toolCallId: '1', cmd: 'npm test' }),
    raw('b1', 2, 'tool.started', 'run-b', { tool: 'exec', toolCallId: '1', cmd: 'npm run build' }),
    raw('a2', 3, 'tool.completed', 'run-a', { tool: 'exec', toolCallId: '1' }),
    raw('b2', 4, 'tool.completed', 'run-b', { tool: 'exec', toolCallId: '1' }),
  ]);
  assert.equal(Object.keys(state.tools).length, 2);
  assert.deepEqual(selectActivities(state).map((row) => row.runId).sort(), ['run-a', 'run-b']);
});

test('event replay is idempotent and sequence, not timestamp, orders text', () => {
  const batch = [
    raw('1', 1, 'run.started', 'run-a', { messageId: 'user-1' }),
    raw('2', 2, 'message.delta', 'run-a', { delta: 'A' }, '2026-09-27T10:00:01.000Z'),
    raw('3', 3, 'message.delta', 'run-a', { delta: 'B' }, '2026-09-27T10:00:01.000Z'),
  ];
  let state = applyRawAgentEvents(emptyAgentStreamState(), batch);
  state = applyRawAgentEvents(state, [...batch, raw('4', 4, 'message.delta', 'run-a', { delta: 'C' }, '2026-09-27T10:00:01.000Z')]);
  assert.equal(selectLiveReplies(state)[0].text, 'ABC');
  assert.equal(state.seenEventIds.size, 4);
});

test('steady heartbeats remain state-only while actionable failures surface once', () => {
  const state = applyRawAgentEvents(emptyAgentStreamState(), [
    raw('1', 1, 'state.delta', 'run-a', { scope: 'agent-adapter', adapterId: 'opencode', state: 'ready' }),
    raw('2', 2, 'state.delta', 'run-a', { scope: 'agent-adapter', adapterId: 'opencode', state: 'ready' }),
    raw('3', 3, 'state.delta', 'run-a', { scope: 'agent-adapter', adapterId: 'opencode', state: 'unavailable', reason: 'runtime unavailable' }),
    raw('4', 4, 'state.delta', 'run-a', { scope: 'agent-adapter', adapterId: 'opencode', state: 'unavailable', reason: 'runtime unavailable' }),
  ]);
  const rows = selectActivities(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'AI runtime unavailable');
  assert.equal(rows[0].state, 'failed');
});

test('workspace progress evolves one semantic row', () => {
  const rows = selectActivities(rebuildAgentStream([
    raw('1', 1, 'workspace.preparing', 'run-a', { message: 'Starting environment…' }),
    raw('2', 2, 'workspace.preparing', 'run-a', { message: 'Connecting…' }),
    raw('3', 3, 'workspace.ready', 'run-a', { provider: 'orlynx-runner' }),
  ]));
  assert.equal(rows.length, 0);
});

test('durable snapshots repair state without rewinding fresher SSE', () => {
  const live = applyRawAgentEvents(emptyAgentStreamState(), [
    raw('1', 1, 'run.started', 'run-a', { messageId: 'user-1' }),
    raw('2', 2, 'message.delta', 'run-a', { delta: 'newest response' }, '2026-09-27T10:00:02.000Z'),
  ]);
  const repaired = reconcileAgentStream(live, [{
    id: 'run-a', state: 'running', messageId: 'user-1', partialText: 'newest',
    partialUpdatedAt: '2026-09-27T10:00:01.000Z',
  }], []);
  assert.equal(selectLiveReplies(repaired)[0].text, 'newest response');
});

test('React consumes the canonical stream instead of a raw event switchboard', () => {
  const app = fs.readFileSync(new URL('../../web/src/ProductionApp.tsx', import.meta.url), 'utf8');
  const facade = fs.readFileSync(new URL('../../web/src/ui/mapping.ts', import.meta.url), 'utf8');
  assert.match(app, /applyRawAgentEvents\(current, batch\)/);
  assert.match(app, /selectActivities\(agentStream\)/);
  assert.match(app, /selectLiveReplies\(agentStream, messages\)/);
  assert.doesNotMatch(app, /applyLiveReplyEvents/);
  assert.doesNotMatch(facade, /case 'tool\.started'/);
});

test('activity evidence stays visible inline without empty disclosure controls', () => {
  const product = fs.readFileSync(new URL('../../web/src/ui/product.tsx', import.meta.url), 'utf8');
  assert.match(product, /const structuredEvidence = Boolean/);
  assert.match(product, /const details = hasVisibleDetail \?/);
  assert.match(product, /<span className="ox-code-label">Command<\/span>/);
  assert.doesNotMatch(product, /className="ox-activity-disclosure"/);
  assert.doesNotMatch(product, /showEvidence/);
});
