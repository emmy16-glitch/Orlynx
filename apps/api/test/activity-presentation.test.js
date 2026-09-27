import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { activityTranscriptLabel, buildConversationTimeline, chatActivities, parseTestCounts, toActivities } from '../../web/src/ui/mapping.ts';

const event = (sequence, type, payload = {}, runId = 'run-a', eventId = `evt-${sequence}`) => ({
  eventId, sessionId: 'session-a', runId, sequence, timestamp: new Date(sequence * 1000).toISOString(), type, payload,
});

describe('canonical agent activity presentation', () => {
  it('coalesces same-phase progress into one evolving semantic activity', () => {
    const rows = toActivities([
      event(1, 'run.started', { plane: 'workspace', mode: 'build', model: 'opencode/free', messageId: 'u1' }),
      event(2, 'activity.started', { text: 'Reading files' }),
      event(3, 'activity.progress', { text: 'Reasoning over repository' }),
      event(4, 'activity.progress', { text: 'Updating middleware' }),
      event(5, 'run.completed', { summary: 'Ready for review' }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Updating files');
    assert.equal(rows[0].state, 'success');
    assert.equal(rows[0].sequence, 5);
  });

  it('keeps one queue lifecycle plus the actual semantic work', () => {
    const rows = toActivities([
      event(1, 'run.queued', { position: 1, mode: 'build', plane: 'workspace' }),
      event(2, 'run.started', { plane: 'workspace', mode: 'build', messageId: 'u1' }),
      event(3, 'activity.progress', { text: 'Reading files' }),
      event(4, 'run.completed', { summary: 'Ready for review' }),
    ]);
    assert.deepEqual(rows.map((row) => row.title), ['Build task started', 'Inspecting the repository']);
    assert.deepEqual(rows.map((row) => row.state), ['success', 'success']);
  });

  it('labels queued Build work and preserves observable command/path evidence', () => {
    const queued = toActivities([event(1, 'run.queued', { position: 2, mode: 'build', plane: 'workspace' })])[0];
    assert.equal(queued.title, 'Waiting to start Build task');
    assert.equal(queued.summary, 'Position 2 · starts automatically');

    const command = toActivities([
      event(2, 'tool.started', { tool: 'bash', command: 'git status -sb', path: '/workspaces/Echoo-main', title: 'git status', callId: 'cmd-1' }),
      event(3, 'tool.output', { tool: 'bash', command: 'git status -sb', callId: 'cmd-1', outDelta: '## main' }),
      event(4, 'tool.output', { tool: 'bash', command: 'git status -sb', callId: 'cmd-1', outDelta: '...origin/main' }),
      event(5, 'tool.completed', { tool: 'bash', command: 'git status -sb', path: '/workspaces/Echoo-main', callId: 'cmd-1' }),
    ])[0];
    assert.equal(command.category, 'git');
    assert.equal(command.title, 'Inspecting Git state');
    assert.equal(command.evidence?.command, 'git status -sb');
    assert.equal(command.evidence?.path, '/workspaces/Echoo-main');
    assert.equal(command.rawOutput, '## main...origin/main');
    assert.match(command.rawRef || '', /^stream:tool:/);
  });

  it('projects code changes into inline evidence without a raw-event card', () => {
    const [row] = toActivities([event(1, 'changes.updated', {
      changeId: 'chg-1',
      count: 1,
      files: [{ path: 'src/auth.ts', action: 'modify', diff: '@@ -1 +1 @@\n-old\n+new' }],
    })]);
    assert.equal(row.category, 'file');
    assert.equal(row.title, 'Updated files');
    assert.equal(row.summary, '1 file changed');
    assert.deepEqual(row.evidence?.files, [{ path: 'src/auth.ts', action: 'modify', diff: '@@ -1 +1 @@\n-old\n+new' }]);
  });

  it('turns test receipts into counts and human-first failures', () => {
    const raw = '4 failed\n22 passed\n0 skipped\n✕ Duplicate message created';
    const [result] = toActivities([event(1, 'receipt.created', { cmd: 'npm test', code: 1, out: raw })]);
    assert.equal(result.category, 'test');
    assert.equal(result.state, 'failed');
    assert.equal(result.title, 'Tests failed');
    assert.equal(result.summary, '22 passed · 4 failed · 0 skipped · Main issue: Duplicate message created');
    assert.deepEqual(result.evidence?.failures, ['Duplicate message created']);
    assert.equal(result.rawOutput, raw);
    assert.match(result.rawRef || '', /^stream:/);
    assert.equal(parseTestCounts('# pass 8\n# fail 0\n# skipped 2')?.passed, 8);
  });

  it('correlates command start and failure into one row with friendly timeout detail', () => {
    const rows = toActivities([
      event(1, 'tool.started', { tool: 'exec', cmd: 'npm run test', toolCallId: 'call-1' }),
      event(2, 'tool.failed', { tool: 'exec', toolCallId: 'call-1', error: 'shell tool terminated after timeout 15000ms' }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Tests failed');
    assert.equal(rows[0].summary, 'The operation timed out. It may still be running.');
    assert.equal(rows[0].rawOutput, rows[0].summary);
  });

  it('reconciles a test receipt into its running command instead of adding a second card', () => {
    const rows = toActivities([
      event(1, 'tool.started', { tool: 'exec', cmd: 'npm test', toolCallId: 'test-call' }),
      event(2, 'tool.completed', { tool: 'exec', cmd: 'npm test', toolCallId: 'test-call' }),
      event(3, 'receipt.created', { cmd: 'npm test', code: 0, out: '8 passed, 0 failed' }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Tests passed');
    assert.equal(rows[0].summary, '8 passed · 0 failed');
    assert.equal(rows[0].state, 'success');
  });

  it('high-frequency progress and workspace status stay bounded by semantic identity', () => {
    const progress = Array.from({ length: 650 }, (_, i) => event(i + 1, 'activity.progress', { text: `step ${i}` }, 'run-long'));
    const rows = toActivities([...progress].reverse().concat(progress[0]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'step 649');
    assert.equal(rows[0].sequence, 1);

    const workspace = toActivities(Array.from({ length: 650 }, (_, i) => event(i + 1, 'workspace.preparing', { message: `stage ${i}` }, 'run-long')));
    assert.equal(workspace.length, 1);
    assert.equal(workspace[0].summary, 'stage 649');
  });

  it('keeps failures in chat while normal completion remains implicit', () => {
    const rows = toActivities([
      event(1, 'run.started', { plane: 'workspace', messageId: 'u1' }),
      event(2, 'run.failed', { error: 'command failed', errorKind: 'engine', recoverable: true }),
    ]);
    const visible = chatActivities(rows);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].state, 'failed');
    assert.equal(visible[0].title, 'AI runtime unavailable');

    const completed = toActivities([
      event(1, 'run.started', { plane: 'workspace', messageId: 'u1' }),
      event(2, 'run.completed', { summary: 'done' }),
    ]);
    assert.equal(completed.length, 0);
  });

  it('interleaves messages and semantic execution chronologically', () => {
    const messages = [
      { id: 'u1', role: 'user', text: 'Run the tests', createdAt: '2026-09-27T05:00:00.000Z' },
      { id: 'a1', role: 'assistant', text: 'Tests pass.', createdAt: '2026-09-27T05:00:05.000Z' },
    ];
    const activities = toActivities([
      { ...event(1, 'activity.progress', { text: 'Reading files' }), timestamp: '2026-09-27T05:00:01.000Z' },
      { ...event(2, 'tool.started', { tool: 'bash', command: 'npm test', callId: 'test-1' }), timestamp: '2026-09-27T05:00:02.000Z' },
      { ...event(3, 'tool.output', { tool: 'bash', callId: 'test-1', outDelta: '8 passed\n' }), timestamp: '2026-09-27T05:00:03.000Z' },
      { ...event(4, 'tool.completed', { tool: 'bash', callId: 'test-1' }), timestamp: '2026-09-27T05:00:04.000Z' },
    ]);
    const timeline = buildConversationTimeline(messages, activities);
    assert.deepEqual(timeline.map((entry) => entry.kind === 'message'
      ? `message:${entry.message.role}`
      : `activity:${activityTranscriptLabel(entry.activity)}`), [
      'message:user',
      'activity:Working',
      'activity:Run tests',
      'message:assistant',
    ]);
    const testRow = timeline.find((entry) => entry.kind === 'activity' && entry.activity.category === 'test');
    assert.equal(testRow?.kind === 'activity' ? testRow.activity.rawOutput : '', '8 passed\n');
  });

  it('uses process labels without exposing hidden reasoning content', () => {
    const rows = toActivities([
      event(1, 'activity.progress', { text: 'Reviewing the request' }),
      event(2, 'activity.progress', { text: 'Understanding repository…', sourceType: 'repository.map' }),
      event(3, 'tool.started', { tool: 'read', path: 'package.json', callId: 'read-1' }),
      event(4, 'tool.started', { tool: 'bash', command: 'npm run dev', callId: 'cmd-1' }),
      event(5, 'run.failed', { error: 'Vite failed to start' }),
    ]);
    assert.deepEqual(rows.map(activityTranscriptLabel), ['Working', 'Repository', 'Read', 'Run command', 'Error']);
  });

  it('chat consumes canonical stream selectors rather than raw lifecycle reducers', () => {
    const app = fs.readFileSync(new URL('../../web/src/ProductionApp.tsx', import.meta.url), 'utf8');
    assert.match(app, /buildConversationTimeline\(messages, transcriptActivities\)/);
    assert.match(app, /applyRawAgentEvents\(current, batch\)/);
    assert.match(app, /selectLiveReplies\(agentStream, messages\)/);
    assert.match(app, /activity\?limit=500/);
    assert.match(app, /transcript-activity-row/);
    assert.doesNotMatch(app, /applyLiveReplyEvents/);
  });

  it('defaults to collapsed execution and keeps an always-visible detail chevron', () => {
    const source = fs.readFileSync(new URL('../../web/src/ui/product.tsx', import.meta.url), 'utf8');
    const app = fs.readFileSync(new URL('../../web/src/ProductionApp.tsx', import.meta.url), 'utf8');
    assert.match(app, /<TaskActivityRow item=\{item\} detailMode="summary"/);
    assert.match(source, /className="ox-activity-disclosure"/);
    assert.match(source, /aria-label=\{showEvidence \? `Hide details for/);
    assert.doesNotMatch(source, />View code & details</);
  });
});
