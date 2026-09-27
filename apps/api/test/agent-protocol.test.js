import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBridgeEvent, scopeToolCallId, PROTOCOL_VERSION } from '../src/agent-protocol.ts';

test('protocol version is declared and versioned', () => {
  assert.equal(PROTOCOL_VERSION, 1);
});

test('terminal/file/test/preview/permission/subagent events keep first-class semantics', () => {
  const cases = [
    ['terminal.started', 'terminal.started'],
    ['terminal.output', 'terminal.output'],
    ['file.changed', 'file.changed'],
    ['test.result', 'test.result'],
    ['build.result', 'build.result'],
    ['preview.ready', 'preview.ready'],
    ['permission.request', 'permission.request'],
    ['subagent.started', 'subagent.started'],
    ['tool.progress', 'tool.progress'],
  ];
  for (const [raw, expected] of cases) {
    const normalized = normalizeBridgeEvent(raw, { toolCallId: 'x' });
    assert.equal(normalized.type, expected, raw);
    assert.equal(normalized.heartbeat, false, raw);
    assert.equal(normalized.extension, false, raw);
  }
});

test('unknown provider events become extension events, never silent generic progress', () => {
  const normalized = normalizeBridgeEvent('opencode.weird-thing', { foo: 1 });
  assert.equal(normalized.type, 'extension.event');
  assert.equal(normalized.extension, true);
  assert.equal(normalized.payload.sourceType, 'opencode.weird-thing');
});

test('heartbeats are telemetry and never become transcript rows', () => {
  for (const raw of ['heartbeat', 'ping', 'adapter.heartbeat', 'bridge.heartbeat']) {
    assert.equal(normalizeBridgeEvent(raw, {}).heartbeat, true, raw);
  }
});

test('tool-call ids are scoped per run', () => {
  assert.notEqual(scopeToolCallId('run-a', '1'), scopeToolCallId('run-b', '1'));
  assert.equal(scopeToolCallId('run-a', '1'), 'run-a:1');
});
