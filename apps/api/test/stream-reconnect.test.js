import test from 'node:test';
import assert from 'node:assert/strict';
import { eventMatchesSession, reconnectDelayMs } from '../../web/src/agent-stream/reconnect.ts';

test('reconnect backoff is exponential, bounded and jittered', () => {
  assert.equal(reconnectDelayMs(0, () => 0), 800);
  assert.equal(reconnectDelayMs(0, () => 1), 1200);
  assert.equal(reconnectDelayMs(3, () => 0.5), 8000);
  assert.equal(reconnectDelayMs(99, () => 0), 12000);
  assert.equal(reconnectDelayMs(99, () => 1), 18000);
});

test('events from another repository session are rejected before projection', () => {
  assert.equal(eventMatchesSession({ sessionId: 'session-a' }, 'session-a'), true);
  assert.equal(eventMatchesSession({ sessionId: 'session-b' }, 'session-a'), false);
  assert.equal(eventMatchesSession({}, 'session-a'), false);
});
