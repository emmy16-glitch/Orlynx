import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activityTranscriptLabel, buildConversationTimeline, chatActivities, parseTestCounts, toActivities } from '../../web/src/ui/mapping.ts';
import { applyLiveReplyEvents, reconcileLiveRepliesFromRuns } from '../../web/src/ui/live-replies.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const webSrc = path.join(root, 'apps/web/src');

let seq = 0;
const evt = (type, payload = {}, runId = 'run-a', eventId) => {
  seq += 1;
  return {
    eventId: eventId || `evt-${seq}-${type}`,
    sessionId: 'session-a', runId, sequence: seq,
    timestamp: new Date(seq * 1000).toISOString(), type, payload,
  };
};
const fresh = () => { seq = 0; };
const adapterReady = (runId = 'run-a') => evt('state.delta', { scope: 'agent-adapter', adapterId: 'opencode', state: 'ready' }, runId);

describe('conversation projection: adapter heartbeat suppression', () => {
  it('TEST 1: 100 repeated ready heartbeats produce zero visible rows', () => {
    fresh();
    const rows = toActivities(Array.from({ length: 100 }, () => adapterReady()));
    assert.equal(rows.length, 0);
  });

  it('TEST 2: starting -> ready coalesces into one meaningful transition', () => {
    fresh();
    const rows = toActivities([
      evt('state.delta', { scope: 'agent-adapter', adapterId: 'opencode', state: 'starting' }),
      adapterReady(),
      adapterReady(),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Orlynx AI ready');
    assert.equal(rows[0].state, 'success');
    assert.doesNotMatch(rows[0].title, /adapter/i);
  });

  it('TEST 3: ready -> error becomes a visible actionable row', () => {
    fresh();
    const rows = toActivities([
      evt('state.delta', { scope: 'agent-adapter', adapterId: 'opencode', state: 'starting' }),
      adapterReady(),
      evt('state.delta', { scope: 'agent-adapter', adapterId: 'opencode', state: 'unavailable', reason: 'OpenCode runtime unavailable' }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'failed');
    assert.match(rows[0].title, /AI runtime unavailable|Authentication required|Model/i);
    assert.doesNotMatch(rows[0].title, /adapter/i);
  });

  it('TEST 4: error -> ready recovers in place without duplicate rows', () => {
    fresh();
    const rows = toActivities([
      evt('state.delta', { scope: 'agent-adapter', adapterId: 'opencode', state: 'starting' }),
      adapterReady(),
      evt('state.delta', { scope: 'agent-adapter', adapterId: 'opencode', state: 'unavailable', reason: 'boom' }),
      adapterReady(),
      adapterReady(),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'success');
    assert.equal(rows[0].title, 'Orlynx AI ready');
  });

  it('non-adapter infrastructure heartbeats stay hidden unless failing', () => {
    fresh();
    const quiet = toActivities([
      evt('state.delta', { scope: 'bridge', state: 'ready' }),
      evt('state.delta', { scope: 'runtime-worker', state: 'connected' }),
    ]);
    assert.equal(quiet.length, 0);
    const loud = toActivities([
      evt('state.delta', { scope: 'bridge', state: 'disconnected', reason: 'transport lost' }),
    ]);
    assert.equal(loud.length, 1);
    assert.equal(loud[0].state, 'failed');
  });
});

describe('conversation projection: tool lifecycle coalescing', () => {
  it('TEST 5: requested + started + outputs + completed is ONE activity', () => {
    fresh();
    const rows = toActivities([
      evt('tool.requested', { tool: 'exec', cmd: 'npm test', toolCallId: 'call-1' }),
      evt('tool.started', { tool: 'exec', cmd: 'npm test', toolCallId: 'call-1' }),
      evt('tool.output', { tool: 'exec', toolCallId: 'call-1', outDelta: 'line1\n' }),
      evt('tool.output', { tool: 'exec', toolCallId: 'call-1', outDelta: 'line2\n' }),
      evt('tool.output', { tool: 'exec', toolCallId: 'call-1', outDelta: 'line3\n' }),
      evt('tool.completed', { tool: 'exec', toolCallId: 'call-1', exitCode: 0 }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'success');
  });

  it('TEST 6: tool output is attached to the same activity', () => {
    fresh();
    const [row] = toActivities([
      evt('tool.requested', { tool: 'exec', cmd: 'npm test', toolCallId: 'call-1' }),
      evt('tool.started', { tool: 'exec', cmd: 'npm test', toolCallId: 'call-1' }),
      evt('tool.output', { tool: 'exec', toolCallId: 'call-1', outDelta: 'line1\n' }),
      evt('tool.output', { tool: 'exec', toolCallId: 'call-1', outDelta: 'line2\n' }),
      evt('tool.completed', { tool: 'exec', toolCallId: 'call-1', exitCode: 0 }),
    ]);
    assert.equal(row.rawOutput, 'line1\nline2\n');
    assert.equal(row.evidence?.command, 'npm test');
  });

  it('TEST 7: tool.failed is one failed activity', () => {
    fresh();
    const rows = toActivities([
      evt('tool.requested', { tool: 'exec', cmd: 'npm test', toolCallId: 'call-1' }),
      evt('tool.started', { tool: 'exec', cmd: 'npm test', toolCallId: 'call-1' }),
      evt('tool.failed', { tool: 'exec', toolCallId: 'call-1', error: 'exit code 1', exitCode: 1 }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'failed');
    assert.ok(rows[0].summary);
  });

  it('TEST 8: two different toolCallIds stay two activities', () => {
    fresh();
    const rows = toActivities([
      evt('tool.requested', { tool: 'exec', cmd: 'npm test', toolCallId: 'call-1' }),
      evt('tool.started', { tool: 'exec', cmd: 'npm test', toolCallId: 'call-1' }),
      evt('tool.requested', { tool: 'exec', cmd: 'npm run build', toolCallId: 'call-2' }),
      evt('tool.started', { tool: 'exec', cmd: 'npm run build', toolCallId: 'call-2' }),
      evt('tool.completed', { tool: 'exec', toolCallId: 'call-1' }),
      evt('tool.completed', { tool: 'exec', toolCallId: 'call-2' }),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.state), ['success', 'success']);
  });

  it('TEST 9: same toolCallId replay does not duplicate', () => {
    fresh();
    const batch = [
      evt('tool.requested', { tool: 'exec', cmd: 'npm test', toolCallId: 'call-1' }, 'run-a', 'same-1'),
      evt('tool.started', { tool: 'exec', cmd: 'npm test', toolCallId: 'call-1' }, 'run-a', 'same-2'),
      evt('tool.completed', { tool: 'exec', toolCallId: 'call-1' }, 'run-a', 'same-3'),
    ];
    const once = toActivities(batch);
    const twice = toActivities([...batch, ...batch]);
    assert.equal(once.length, 1);
    assert.equal(twice.length, 1);
  });

  it('TEST 15: run A tools never merge with run B tools', () => {
    fresh();
    const rows = toActivities([
      evt('tool.started', { tool: 'exec', cmd: 'npm test', toolCallId: 'call-1' }, 'run-a'),
      evt('tool.started', { tool: 'exec', cmd: 'npm test', toolCallId: 'call-1' }, 'run-b'),
      evt('tool.completed', { tool: 'exec', toolCallId: 'call-1' }, 'run-a'),
      evt('tool.completed', { tool: 'exec', toolCallId: 'call-1' }, 'run-b'),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.runId).sort(), ['run-a', 'run-b']);
  });
});

describe('conversation projection: workspace lifecycle', () => {
  it('TEST 10: preparing events coalesce into one running row', () => {
    fresh();
    const rows = toActivities([
      evt('workspace.preparing', { message: 'Starting GitHub Codespace…' }),
      evt('workspace.preparing', { message: 'Waiting for GitHub…' }),
      evt('workspace.preparing', { message: 'Connecting…' }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'running');
    assert.equal(rows[0].title, 'Preparing workspace');
    assert.equal(rows[0].summary, 'Connecting…');
  });

  it('workspace recovery is explicit, then resolves to one ready row', () => {
    fresh();
    const rows = toActivities([
      evt('workspace.preparing', { message: 'Starting GitHub Codespace…' }),
      evt('workspace.reconnecting', { message: 'Previous Codespace could not establish SSH. Starting a fresh Codespace…' }),
      evt('workspace.ready', { provider: 'github-codespaces' }),
      evt('workspace.ready', { provider: 'github-codespaces' }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Workspace ready');
    assert.equal(rows[0].state, 'success');
  });

  it('TEST 11: repeated workspace.ready does not duplicate', () => {
    fresh();
    const rows = toActivities([
      evt('workspace.preparing', { message: 'Starting…' }),
      evt('workspace.ready', {}),
      evt('workspace.ready', {}),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Workspace ready');
  });
});

describe('conversation projection: stream/telemetry hygiene', () => {
  it('TEST 12: message.start/end leave no activity rows', () => {
    fresh();
    const rows = toActivities([evt('message.start', { model: 'x' }), evt('message.end', {})]);
    assert.equal(rows.length, 0);
  });

  it('TEST 13: message.delta leaves no activity rows', () => {
    fresh();
    const rows = toActivities([
      evt('message.delta', { delta: 'Hello' }),
      evt('message.delta', { delta: ' world' }),
    ]);
    assert.equal(rows.length, 0);
  });

  it('state.snapshot restoration stays out of the transcript', () => {
    fresh();
    assert.equal(toActivities([evt('state.snapshot', { project: 'a/b', branch: 'main' })]).length, 0);
  });

  it('TEST 14: ordering is deterministic by sequence', () => {
    fresh();
    const a = evt('tool.started', { tool: 'read', path: 'a.ts', callId: 'r1' });
    const b = evt('tool.started', { tool: 'read', path: 'b.ts', callId: 'r2' });
    const rows = toActivities([b, a]);
    assert.deepEqual(rows.map((r) => r.sequence).sort((x, y) => x - y), rows.map((r) => r.sequence));
    assert.equal(rows[0].evidence?.path, 'a.ts');
  });

  it('repeated identical thought progress does not open a row per tick', () => {
    fresh();
    const rows = toActivities([
      evt('activity.progress', { text: 'Reviewing the request' }),
      evt('activity.progress', { text: 'Reviewing the request' }),
      evt('activity.progress', { text: 'Reviewing the request' }),
    ]);
    assert.equal(rows.length, 1);
  });

  it('replayed run.completed does not duplicate the completion card', () => {
    fresh();
    const rows = toActivities([
      evt('run.completed', { summary: 'Done' }, 'run-a', 'done-1'),
      evt('run.completed', { summary: 'Done' }, 'run-a', 'done-2'),
    ]);
    assert.equal(rows.filter((r) => r.title === 'Work completed').length, 1);
  });
});

describe('conversation projection: results and failures', () => {
  it('TEST 16: test counts surface passed/failed', () => {
    fresh();
    const [row] = toActivities([evt('receipt.created', { cmd: 'npm test', code: 0, out: '42 passed, 0 failed' })]);
    assert.equal(row.title, 'Tests passed');
    assert.match(row.summary || '', /42 passed/);
    assert.equal(parseTestCounts('42 passed\n0 failed')?.passed, 42);
  });

  it('TEST 17: failures stay visible and actionable in product language', () => {
    fresh();
    const auth = toActivities([evt('run.failed', { errorKind: 'auth', error: 'credential rejected' }, 'run-a')]);
    assert.equal(auth[0].title, 'Reconnect AI');
    fresh();
    const model = toActivities([evt('run.failed', { errorKind: 'model', error: 'unknown model' }, 'run-b')]);
    assert.equal(model[0].title, 'Model unavailable');
    for (const rows of [auth, model]) {
      assert.equal(rows.at(-1)?.state, 'failed');
      assert.equal(chatActivities(rows).length, rows.length);
    }
  });

  it('TEST 18: raw technical evidence remains attached', () => {
    fresh();
    const [row] = toActivities([
      evt('tool.started', { tool: 'bash', command: 'npm test', callId: 't1' }),
      evt('tool.output', { tool: 'bash', callId: 't1', outDelta: '42 passed\n' }),
      evt('tool.completed', { tool: 'bash', callId: 't1', exitCode: 0 }),
    ]);
    assert.equal(row.evidence?.command, 'npm test');
    assert.equal(row.rawOutput, '42 passed\n');
    assert.equal(row.collapsible, true);
    assert.ok(row.rawRef);
  });

  it('assistant + work stay chronologically interleaved without telemetry rows', () => {
    fresh();
    const activities = toActivities([
      adapterReady(),
      { ...evt('activity.progress', { text: 'Reading files' }), timestamp: '2026-09-27T05:00:01.000Z' },
      { ...evt('tool.started', { tool: 'bash', command: 'npm test', callId: 'test-1' }), timestamp: '2026-09-27T05:00:02.000Z' },
      { ...evt('message.start', {}), timestamp: '2026-09-27T05:00:03.000Z' },
      { ...evt('tool.completed', { tool: 'bash', callId: 'test-1' }), timestamp: '2026-09-27T05:00:04.000Z' },
    ]);
    const timeline = buildConversationTimeline([
      { id: 'u1', role: 'user', text: 'Run the tests', createdAt: '2026-09-27T05:00:00.000Z' },
      { id: 'a1', role: 'assistant', text: 'Tests pass.', createdAt: '2026-09-27T05:00:05.000Z' },
    ], activities);
    assert.deepEqual(timeline.map((entry) => entry.kind === 'message' ? `message:${entry.message.role}` : `activity:${activityTranscriptLabel(entry.activity)}`), [
      'message:user',
      'activity:Thought',
      'activity:Run tests',
      'message:assistant',
    ]);
  });
});

describe('conversation projection: presentation contract', () => {
  it('TEST 19: main transcript uses summary/collapsed presentation', () => {
    const app = fs.readFileSync(path.join(webSrc, 'ProductionApp.tsx'), 'utf8');
    const product = fs.readFileSync(path.join(webSrc, 'ui/product.tsx'), 'utf8');
    assert.match(app, /<TaskActivityRow item=\{item\} detailMode="summary"/);
    assert.doesNotMatch(app, /<TaskActivityRow item=\{item\} detailMode="code"/);
    assert.match(product, /const \[showEvidence, setShowEvidence\] = React\.useState\(false\)/);
    assert.match(product, /const \[showRaw, setShowRaw\] = React\.useState\(false\)/);
    assert.doesNotMatch(product, /useState\(detailMode === 'code' \|\| isCurrent\)/);
  });

  it('TEST 20: raw output renders in a bounded scrollable detail container', () => {
    const css = fs.readFileSync(path.join(webSrc, 'styles.css'), 'utf8');
    const components = fs.readFileSync(path.join(webSrc, 'ui/components.css'), 'utf8');
    for (const source of [css, components]) {
      assert.match(source, /\.ox-raw pre \{[^}]*max-height:[^}]*overflow: auto/s);
    }
    assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.transcript-activity-shell \.ox-raw pre \{\s*max-height: 240px/);
  });

  it('disclosure controls stay keyboard-accessible', () => {
    const product = fs.readFileSync(path.join(webSrc, 'ui/product.tsx'), 'utf8');
    assert.match(product, /aria-expanded=\{showEvidence\}/);
    assert.match(product, /aria-expanded=\{showRaw\}/);
    assert.match(product, /aria-controls=\{`ox-evidence-\$\{item\.id\}`\}/);
    assert.match(product, /type="button"/);
  });
});

describe('live working indicator and composer interaction (sections 60-81)', () => {
  const app = () => fs.readFileSync(path.join(webSrc, 'ProductionApp.tsx'), 'utf8');
  const components = () => fs.readFileSync(path.join(webSrc, 'ui/components.css'), 'utf8');
  const css = () => fs.readFileSync(path.join(webSrc, 'styles.css'), 'utf8');

  it('79A/C: tapping Send gives immediate visual feedback via a submitting state', () => {
    assert.match(app(), /aria-label=\{sending \? 'Sending…' :/);
    assert.match(app(), /\{sending \? <Spinner label="Sending" \/> : <Icon name="send" \/>\}/);
  });

  it('79B: duplicate taps cannot submit the same message twice', () => {
    assert.match(app(), /if \(!session \|\| !text \|\| submittingRef\.current \|\| sending \|\| !online\) return false/);
    assert.match(app(), /submittingRef\.current = true/);
    assert.match(app(), /disabled=\{!composer\.trim\(\) \|\| sending \|\| !aiAccountConnected/);
  });

  it('79D: the draft survives submission failure and the spinner never sticks', () => {
    const src = app();
    const sendStart = src.indexOf('async function sendMessage(overrideText');
    const sendBlock = src.slice(sendStart, src.indexOf('async function startCloud(', sendStart));
    assert.match(sendBlock, /The draft is preserved/);
    assert.match(sendBlock, /finally \{ submittingRef\.current = false; setSending\(false\); \}/);
    assert.doesNotMatch(sendBlock, /catch[\s\S]{0,400}?setComposer\(''\)/);
  });

  it('64/65: Send stays Send; Stop is a separate compact control for the active run', () => {
    const src = app();
    assert.match(src, /className="active-work-stop" onClick=\{stopRun\}/);
    assert.match(src, /\{stopping \? 'Stopping…' : <><span aria-hidden>■<\/span> Stop<\/>\}/);
    assert.doesNotMatch(src, /composer-send[\s\S]{0,300}?stopRun/);
    assert.match(src, /aria-label=\{stopping \? 'Stopping the current task' : 'Stop the current task'\}/);
  });

  it('66: Stop disables while pending; cancellation resolves visibly in place', () => {
    assert.match(app(), /const \[stopping, setStopping\] = useState\(false\)/);
    assert.match(app(), /if \(stopping\) return;/);
    assert.match(app(), /setStopping\(true\)[\s\S]*?setStopping\(false\)/);
    fresh();
    const rows = toActivities([evt('run.failed', { cancelled: true, error: 'stopped' }, 'run-a')]);
    assert.equal(rows.at(-1)?.title, 'Work stopped');
    assert.equal(rows.at(-1)?.state, 'cancelled');
  });

  it('61/74: the working indicator reflects the user task, never infrastructure', () => {
    const src = app();
    assert.match(src, /const currentActivity = transcriptActivities\.find\(\(item: any\) => item\.id === currentActivityId\)/);
    assert.match(src, /const showWorkBar = tab === 'chat' && Boolean\(currentActivity \|\| runActive\)/);
    assert.match(src, /workBarLabel = waitingForUser[\s\S]*?currentActivity\?\.title \|\| 'Orlynx is working'/);
    const barStart = src.indexOf('active-work-bar');
    const barBlock = src.slice(barStart, barStart + 1200);
    assert.doesNotMatch(barBlock, /adapter|heartbeat|bridge|state\.delta/i);
  });

  it('75: waiting for approval is distinguishable from working', () => {
    assert.match(app(), /waitingForUser && currentActivity\?\.category === 'approval' \? 'Waiting for you'/);
    assert.match(app(), /data-state=\{waitingForUser \? 'waiting' : 'working'\}/);
    assert.match(css(), /\.active-work-pill\[data-state="waiting"\]/);
  });

  it('60/62/72: one calm motion language, current activity only', () => {
    assert.match(components(), /\.ox-activity\[data-current="true"\]\[data-state="active"\] \.mark \{\s*border-color:[^}]*animation: ox-spin 1\.1s linear infinite/s);
    assert.match(components(), /\.ox-activity\[data-current="true"\]\[data-state="active"\] \.mark svg \{ display: none; \}/);
    assert.doesNotMatch(components(), /\.ox-activity\[data-state="todo"\][^{]*\{[^}]*animation:/);
  });

  it('63: reduced motion keeps state readable without animation', () => {
    assert.match(components(), /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ox-activity \.mark[^{]*\{[^}]*animation: none/);
    assert.match(components(), /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ox-spinner \{ animation: none/);
  });

  it('67/77: send has a subtle press transition and reachable targets', () => {
    assert.match(css(), /\.composer-send\.ox-btn:active:not\(:disabled\) \{\s*transform: scale\(0\.95\)/);
    assert.match(css(), /\.active-work-stop\.ox-btn \{\s*min-height: 44px/);
    assert.match(css(), /\.active-work-pill \{\s*pointer-events: auto;[\s\S]*?min-height: 44px/);
  });

  it('71: streaming keeps a single subtle cue', () => {
    const streamLine = app().split('\n').find((line) => line.includes('stream-caret'));
    assert.ok(streamLine?.includes('draftReply'));
    assert.doesNotMatch(streamLine || '', /Spinner|ox-pulse|bouncing/);
  });
});


describe('run-scoped live assistant streaming', () => {
  it('keeps overlapping direct/workspace deltas in separate replies', () => {
    const replies = applyLiveReplyEvents({}, [
      { type: 'run.started', runId: 'run-a', sequence: 1, timestamp: '2026-09-27T10:00:00.000Z', payload: { messageId: 'u-a', plane: 'direct' } },
      { type: 'run.started', runId: 'run-b', sequence: 2, timestamp: '2026-09-27T10:00:00.001Z', payload: { messageId: 'u-b', plane: 'workspace' } },
      { type: 'message.delta', runId: 'run-a', sequence: 3, timestamp: '2026-09-27T10:00:00.002Z', payload: { delta: 'Hello ' } },
      { type: 'message.delta', runId: 'run-b', sequence: 4, timestamp: '2026-09-27T10:00:00.002Z', payload: { delta: 'Running ' } },
      { type: 'message.delta', runId: 'run-a', sequence: 5, timestamp: '2026-09-27T10:00:00.002Z', payload: { delta: 'there' } },
      { type: 'message.delta', runId: 'run-b', sequence: 6, timestamp: '2026-09-27T10:00:00.002Z', payload: { delta: 'tests' } },
    ]);
    assert.equal(replies['run-a'].text, 'Hello there');
    assert.equal(replies['run-b'].text, 'Running tests');
    assert.equal(replies['run-a'].messageId, 'u-a');
    assert.equal(replies['run-b'].messageId, 'u-b');
  });

  it('accepts same-timestamp deltas in sequence order and ignores replay', () => {
    let replies = applyLiveReplyEvents({}, [
      { type: 'run.started', runId: 'r', sequence: 10, timestamp: '2026-09-27T10:00:00.000Z', payload: {} },
      { type: 'message.delta', runId: 'r', sequence: 11, timestamp: '2026-09-27T10:00:01.000Z', payload: { delta: 'A' } },
      { type: 'message.delta', runId: 'r', sequence: 12, timestamp: '2026-09-27T10:00:01.000Z', payload: { delta: 'B' } },
    ]);
    replies = applyLiveReplyEvents(replies, [
      { type: 'message.delta', runId: 'r', sequence: 12, timestamp: '2026-09-27T10:00:01.000Z', payload: { delta: 'B' } },
      { type: 'message.delta', runId: 'r', sequence: 13, timestamp: '2026-09-27T10:00:01.000Z', payload: { delta: 'C' } },
    ]);
    assert.equal(replies.r.text, 'ABC');
  });

  it('does not let an older HTTP snapshot rewind newer SSE text', () => {
    const current = applyLiveReplyEvents({}, [
      { type: 'run.started', runId: 'r', sequence: 1, timestamp: '2026-09-27T10:00:00.000Z', payload: { messageId: 'u1' } },
      { type: 'message.delta', runId: 'r', sequence: 2, timestamp: '2026-09-27T10:00:02.000Z', payload: { delta: 'Newest streamed answer' } },
    ]);
    const reconciled = reconcileLiveRepliesFromRuns(current, [{
      id: 'r', state: 'running', messageId: 'u1', partialText: 'Newest streamed',
      partialUpdatedAt: '2026-09-27T10:00:01.000Z', startedAt: '2026-09-27T10:00:00.000Z',
    }], []);
    assert.equal(reconciled.r.text, 'Newest streamed answer');
  });

  it('replaces transient reply only after the durable assistant message exists', () => {
    const current = {
      r: { runId: 'r', text: 'partial', startedAt: '2026-09-27T10:00:00.000Z', messageId: 'u1', state: 'completed', lastEventAt: 1, lastSequence: 2 },
    };
    const preserved = reconcileLiveRepliesFromRuns(current, [{ id: 'r', state: 'completed', messageId: 'u1' }], []);
    assert.equal(preserved.r.text, 'partial');
    const removed = reconcileLiveRepliesFromRuns(current, [{ id: 'r', state: 'completed', messageId: 'u1' }], [
      { id: 'msg_r', role: 'assistant', text: 'final' },
    ]);
    assert.equal(removed.r, undefined);
  });
});
