import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceInspector } from '../../web/src/ui/WorkspaceInspector.tsx';

const onOpenChanges = () => {};
const onOpenFiles = () => {};

test('workspace inspector displays only canonical plan, activity and changed files', () => {
  const activities = [
    {
      key: 'plan-1', id: 'plan-1', sequence: 1, category: 'agent', state: 'running',
      title: 'Working through the plan', timestamp: '2026-10-23T12:00:00Z',
      evidence: { items: [
        { content: 'Inspect existing streaming', status: 'completed' },
        { content: 'Update event delivery', status: 'in_progress' },
      ] },
    },
    {
      key: 'tool-1', id: 'tool-1', sequence: 2, category: 'test', state: 'success',
      title: 'Tests passed', summary: '3 passed', timestamp: '2026-10-23T12:00:01Z',
    },
  ];
  const html = renderToStaticMarkup(React.createElement(WorkspaceInspector, {
    activities, changes: [{ files: [{ path: 'apps/api/src/events.ts', additions: 12, deletions: 3 }] }],
    liveFiles: [], runActive: true, onOpenChanges, onOpenFiles,
  }));
  assert.match(html, /Inspect existing streaming/);
  assert.match(html, /Update event delivery/);
  assert.match(html, /aria-valuenow="1"/);
  assert.match(html, /apps\/api\/src\/events\.ts/);
  assert.match(html, /Agent activity/);
  assert.doesNotMatch(html, /Live stream active|Enter to send|Shift \+ Enter/i);
});

test('an empty session does not fabricate task progress, test checks or file changes', () => {
  const html = renderToStaticMarkup(React.createElement(WorkspaceInspector, {
    activities: [], changes: [], liveFiles: [], runActive: false, onOpenChanges, onOpenFiles,
  }));
  assert.match(html, /No changed files yet/);
  assert.match(html, /Work performed in this session will appear here/);
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.doesNotMatch(html, /Tests passed/);
});
