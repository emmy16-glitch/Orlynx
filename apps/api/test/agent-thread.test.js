import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyAgentStreamState } from '../../web/src/agent-stream/protocol.ts';
import { applyRawAgentEvents } from '../../web/src/agent-stream/store.ts';
import { selectActivities, selectLiveReplies } from '../../web/src/agent-stream/view.ts';
import { buildThread, currentTurnWork } from '../../web/src/agent-stream/thread.ts';
import { toThreadPart, toThreadParts } from '../../web/src/agent-stream/parts.ts';

const raw = (eventId, sequence, type, runId = 'run-a', payload = {}, timestamp = '2026-09-27T10:00:00.000Z') => ({
  eventId, sessionId: 'session-a', runId, sequence, timestamp, type, payload,
});

const runA = (id, seq, type, payload = {}) => raw(id, seq, type, 'run-a', payload);
const runB = (id, seq, type, payload = {}) => raw(id, seq, type, 'run-b', payload);

test('overlapping direct + workspace runs never mix text', () => {
  const state = applyRawAgentEvents(emptyAgentStreamState(), [
    runA('a1', 1, 'run.started', { messageId: 'user-1', plane: 'direct' }),
    runB('b1', 2, 'run.started', { messageId: 'user-2', plane: 'workspace' }),
    runA('a2', 3, 'message.delta', { delta: 'direct answer ' }),
    runB('b2', 4, 'message.delta', { delta: 'build answer ' }),
    runA('a3', 5, 'message.delta', { delta: 'continues' }),
    runB('b3', 6, 'message.delta', { delta: 'progress' }),
  ]);
  const replies = selectLiveReplies(state);
  assert.equal(replies.length, 2);
  assert.equal(replies.find((r) => r.runId === 'run-a').text, 'direct answer continues');
  assert.equal(replies.find((r) => r.runId === 'run-b').text, 'build answer progress');
});

test('tool requested/start/output/end stays one object that mutates in place', () => {
  const state = applyRawAgentEvents(emptyAgentStreamState(), [
    runA('t1', 1, 'run.started', { messageId: 'user-1' }),
    runA('t2', 2, 'tool.requested', { tool: 'exec', toolCallId: 'c1', cmd: 'npm test' }),
    runA('t3', 3, 'tool.started', { tool: 'exec', toolCallId: 'c1', cmd: 'npm test' }),
    runA('t4', 4, 'tool.output', { tool: 'exec', toolCallId: 'c1', outDelta: '28/42 ' }),
    runA('t5', 5, 'tool.output', { tool: 'exec', toolCallId: 'c1', outDelta: 'completed' }),
    runA('t6', 6, 'tool.completed', { tool: 'exec', toolCallId: 'c1', exitCode: 0 }),
  ]);
  const rows = selectActivities(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'success');
  assert.match(rows[0].rawOutput || '', /28\/42 completed/);
});

test('workspace preparing/ready stays one lifecycle; 100 heartbeats add zero rows', () => {
  const events = [
    runA('w1', 1, 'run.started', { messageId: 'user-1' }),
    runA('w2', 2, 'workspace.preparing', { message: 'Starting' }),
    runA('w3', 3, 'workspace.preparing', { message: 'Connecting' }),
    runA('w4', 4, 'workspace.ready', { provider: 'orlynx-runner' }),
  ];
  for (let i = 0; i < 100; i++) {
    events.push(runA(`h${i}`, 10 + i, 'state.delta', { scope: 'agent-adapter', adapterId: 'opencode', state: 'ready' }));
  }
  const rows = selectActivities(applyRawAgentEvents(emptyAgentStreamState(), events));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Workspace ready');
});

test('message markers and snapshots never become chat rows; failures stay actionable', () => {
  const state = applyRawAgentEvents(emptyAgentStreamState(), [
    runA('m1', 1, 'run.started', { messageId: 'user-1' }),
    runA('m2', 2, 'message.start', {}),
    runA('m3', 3, 'state.snapshot', { scope: 'session', ok: true }),
    runA('m4', 4, 'message.delta', { delta: 'hi' }),
    runA('m5', 5, 'message.end', {}),
    runA('m6', 6, 'state.delta', { scope: 'agent-adapter', adapterId: 'opencode', state: 'unavailable', reason: 'runtime unavailable' }),
  ]);
  const rows = selectActivities(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'AI runtime unavailable');
});

test('typed parts dispatch: terminal/file/test/git/approval each get their own kind', () => {
  const state = applyRawAgentEvents(emptyAgentStreamState(), [
    runA('p1', 1, 'run.started', { messageId: 'user-1' }),
    runA('p2', 2, 'tool.started', { tool: 'exec', toolCallId: 'term', cmd: 'npm run dev -- --port 5173' }),
    runA('p3', 3, 'tool.output', { tool: 'exec', toolCallId: 'term', outDelta: 'Local: http://localhost:5173/' }),
    runA('p4', 4, 'tool.completed', { tool: 'exec', toolCallId: 'term', exitCode: 0 }),
    runA('p5', 5, 'tool.started', { tool: 'exec', toolCallId: 't', cmd: 'npm test' }),
    runA('p6', 6, 'tool.completed', { tool: 'exec', toolCallId: 't', out: '42 passed, 0 failed', exitCode: 0 }),
    runA('p7', 7, 'changes.updated', { changeId: 'c1', count: 2, files: [{ path: 'auth.ts' }, { path: 'auth.test.ts' }] }),
    runA('p8', 8, 'approval.required', { approvalId: 'ap1', action: 'exec.outside-root', detail: 'Run migration?' }),
  ]);
  const rows = selectActivities(state);
  const kinds = toThreadParts(rows).map((part) => part.kind);
  assert.ok(kinds.includes('preview'), `expected preview in ${kinds}`);
  assert.ok(kinds.includes('test-result'), `expected test-result in ${kinds}`);
  assert.ok(kinds.includes('file-change'), `expected file-change in ${kinds}`);
  assert.ok(kinds.includes('approval'), `expected approval in ${kinds}`);
  // Terminal detail is typed, not a generic card.
  assert.equal(toThreadPart(rows.find((r) => /5173|dev/.test(`${r.summary} ${r.title}`))).kind, 'preview');
});

test('thread groups work with the run that triggered it; reconnect never duplicates', () => {
  const batch = [
    runA('a1', 1, 'run.started', { messageId: 'user-1' }),
    runA('a2', 2, 'message.delta', { delta: 'answer A' }),
    runA('a3', 3, 'tool.started', { tool: 'read', toolCallId: 'r1', path: 'a.ts' }),
    runA('a4', 4, 'tool.completed', { tool: 'read', toolCallId: 'r1' }),
    runB('b1', 5, 'run.started', { messageId: 'user-2' }),
    runB('b2', 6, 'message.delta', { delta: 'answer B' }),
  ];
  let state = applyRawAgentEvents(emptyAgentStreamState(), batch);
  // Reconnect replay of the same batch is idempotent.
  state = applyRawAgentEvents(state, batch);
  const messages = [
    { id: 'user-1', role: 'user', text: 'Fix login', createdAt: '2026-09-27T10:00:00.000Z' },
    { id: 'user-2', role: 'user', text: 'Also explain JWT', createdAt: '2026-09-27T10:00:05.000Z' },
  ];
  const thread = buildThread(messages, selectActivities(state), selectLiveReplies(state), state);
  assert.equal(thread.length, 2);
  assert.equal(thread[0].work.length, 1);
  assert.equal(thread[0].work[0].runId, 'run-a');
  assert.equal(thread[1].liveReply.text, 'answer B');
  assert.equal(thread[1].work.length, 0);
  assert.ok(currentTurnWork(thread));
});

test('failed and cancelled runs preserve partial text', () => {
  const failed = applyRawAgentEvents(emptyAgentStreamState(), [
    runA('f1', 1, 'run.started', { messageId: 'user-1' }),
    runA('f2', 2, 'message.delta', { delta: 'partial work' }),
    runA('f3', 3, 'run.failed', { error: 'boom', errorKind: 'engine' }),
  ]);
  assert.equal(selectLiveReplies(failed)[0].text, 'partial work');
  const cancelled = applyRawAgentEvents(emptyAgentStreamState(), [
    runA('c1', 1, 'run.started', { messageId: 'user-1' }),
    runA('c2', 2, 'message.delta', { delta: 'half answer' }),
    runA('c3', 3, 'run.failed', { cancelled: true }),
  ]);
  assert.equal(selectLiveReplies(cancelled)[0].text, 'half answer');
});
