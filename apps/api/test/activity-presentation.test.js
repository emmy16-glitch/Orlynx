import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTestCounts, toActivities } from '../../web/src/ui/mapping.ts';

const event = (sequence, type, payload = {}, runId = 'run-a', eventId = `evt-${sequence}`) => ({
  eventId, sessionId: 'session-a', runId, sequence, timestamp: new Date(sequence * 1000).toISOString(), type, payload,
});

describe('normalized agent activity presentation', () => {
  it('coalesces activity lifecycle updates into one stable, observable action', () => {
    const rows = toActivities([
      event(1, 'run.started'),
      event(2, 'activity.started', { text: 'Reading files' }),
      event(3, 'activity.progress', { text: 'Reasoning over repository' }),
      event(4, 'activity.progress', { text: 'Updating middleware' }),
      event(5, 'run.completed', { summary: 'Ready for review' }),
    ]);
    const agent = rows.find((row) => row.category === 'agent' && row.title === 'Updating files');
    assert.ok(agent);
    assert.equal(agent.state, 'success');
    assert.equal(rows.filter((row) => row.category === 'agent').length, 1);
    assert.ok(rows.every((row) => !/reasoning|thinking/i.test(row.title)));
  });

  it('keeps one activity row as an admitted prompt moves from queued to running', () => {
    const rows = toActivities([
      event(1, 'run.queued', { position: 1 }),
      event(2, 'run.started'),
      event(3, 'activity.progress', { text: 'Reading files' }),
      event(4, 'run.completed', { summary: 'Ready for review' }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, 'agent');
    assert.equal(rows[0].state, 'success');
    assert.equal(rows[0].title, 'Inspecting the repository');
  });

  it('labels queued Build work and preserves observable command/path evidence', () => {
    const queued = toActivities([event(1, 'run.queued', { position: 2, mode: 'build', plane: 'workspace' })])[0];
    assert.equal(queued.title, 'Waiting to start Build task');
    assert.equal(queued.summary, 'Position 2 · starts automatically');

    const command = toActivities([
      event(2, 'tool.started', { tool: 'bash', command: 'git status -sb', path: '/workspaces/Echoo-main', title: 'git status', callId: 'cmd-1' }),
      event(3, 'tool.completed', { tool: 'bash', command: 'git status -sb', path: '/workspaces/Echoo-main', callId: 'cmd-1', out: '## main...origin/main' }),
    ])[0];
    assert.equal(command.category, 'git');
    assert.equal(command.title, 'Inspecting Git state');
    assert.equal(command.evidence?.command, 'git status -sb');
    assert.equal(command.evidence?.path, '/workspaces/Echoo-main');
    assert.equal(command.rawOutput, '## main...origin/main');
  });

  it('projects bounded code changes into inline diff evidence', () => {
    const [row] = toActivities([event(1, 'changes.updated', {
      changeId: 'chg-1',
      count: 1,
      files: [{ path: 'src/auth.ts', action: 'modify', diff: '@@ -1 +1 @@\n-old\n+new' }],
    })]);
    assert.equal(row.category, 'file');
    assert.equal(row.title, 'Code changes ready');
    assert.equal(row.summary, '1 file changed');
    assert.deepEqual(row.evidence?.files, [{ path: 'src/auth.ts', action: 'modify', diff: '@@ -1 +1 @@\n-old\n+new' }]);
  });

  it('turns test receipts into counts and human-first failures while retaining raw output by reference', () => {
    const raw = '4 failed\n22 passed\n0 skipped\n✕ Duplicate message created';
    const [result] = toActivities([event(1, 'receipt.created', { cmd: 'npm test', code: 1, out: raw })]);
    assert.equal(result.category, 'test');
    assert.equal(result.state, 'failed');
    assert.equal(result.title, 'Tests failed');
    assert.equal(result.summary, '22 passed · 4 failed · 0 skipped · Main issue: Duplicate message created');
    assert.deepEqual(result.evidence?.failures, ['Duplicate message created']);
    assert.equal(result.rawOutput, raw);
    assert.equal(result.rawRef, 'event:evt-1');
    assert.equal(parseTestCounts('# pass 8\n# fail 0\n# skipped 2')?.passed, 8);
  });

  it('groups changed files and prevents duplicate event replay from duplicating evidence', () => {
    const one = event(1, 'file.changed', { path: 'src/a.ts', action: 'modify' });
    const rows = toActivities([one, one, event(2, 'file.changed', { path: 'src/b.ts', action: 'create' })]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].summary, '2 files changed');
    assert.deepEqual(rows[0].evidence?.files, [{ path: 'src/a.ts', action: 'modify' }, { path: 'src/b.ts', action: 'create' }]);
  });

  it('correlates command start and failure, translating timeout while preserving details', () => {
    const rows = toActivities([
      event(1, 'tool.started', { tool: 'exec', cmd: 'npm run test', toolCallId: 'call-1' }),
      event(2, 'tool.failed', { tool: 'exec', toolCallId: 'call-1', error: 'shell tool terminated after timeout 15000ms' }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Running tests');
    assert.equal(rows[0].summary, 'The command timed out. The process may still be running.');
    assert.equal(rows[0].rawOutput, 'shell tool terminated after timeout 15000ms');
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

  it('bounds long sessions and sorts out-of-order events without repeating replayed ids', () => {
    const events = Array.from({ length: 150 }, (_, i) => event(i + 1, 'activity.progress', { text: `step ${i}` }, 'run-long'));
    const rows = toActivities([...events].reverse().concat(events[0]));
    assert.equal(rows.length, 1, 'same run activity is reconciled to its latest state');
    assert.equal(rows[0].title, 'step 149');
    const many = toActivities(Array.from({ length: 150 }, (_, i) => event(i + 1, 'workspace.stopped', {}, `run-${i}`)));
    assert.equal(many.length, 100);
  });

  it('keeps structured/raw output behind separate explicit controls and has a concise live status', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../../web/src/ui/product.tsx', import.meta.url), 'utf8');
    const stream = fs.readFileSync(new URL('../../web/src/ui/workstream.tsx', import.meta.url), 'utf8');
    assert.match(source, /View results/);
    assert.match(source, /Show raw output/);
    assert.match(source, /ox-inline-diff/);
    assert.match(stream, /Summary/);
    assert.match(stream, /Code/);
    assert.match(stream, /orlynx:activity-detail-mode/);
    assert.match(stream, /aria-live="polite"/);
    assert.match(stream, /statusLabel/);
  });
});
