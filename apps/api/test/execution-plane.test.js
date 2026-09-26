import test from 'node:test';
import assert from 'node:assert/strict';
import { executionPlaneFor, executionPlaneWithExistingWorkspace } from '../src/direct-chat.ts';
import { chooseNextQueuedTask, workspaceCanAcceptTask, delayedWorkspaceTaskExpired } from '../src/agents.ts';
import { getAgentAdapter } from '../src/agent-runtime.ts';

test('existing project workspace is reused for conversational turns', () => {
  assert.equal(executionPlaneWithExistingWorkspace(executionPlaneFor('Hello', 'build'), true), 'workspace');
  assert.equal(executionPlaneWithExistingWorkspace(executionPlaneFor('Explain this repo', 'ask'), true), 'workspace');
  assert.equal(executionPlaneWithExistingWorkspace(executionPlaneFor('Hello', 'build'), false), 'direct');
});

test('plain conversation does not start a development environment', () => {
  assert.equal(executionPlaneFor('Hello', 'build'), 'direct');
  assert.equal(executionPlaneFor('What does this repository do?', 'build'), 'direct');
  assert.equal(executionPlaneFor('Explain the authentication flow', 'build'), 'direct');
  assert.equal(executionPlaneFor('Review this architecture and suggest improvements', 'ask'), 'direct');
});

test('runtime and mutating build work requests the development environment', () => {
  assert.equal(executionPlaneFor('Run the tests and fix what fails', 'build'), 'workspace');
  assert.equal(executionPlaneFor('npm install and start the dev server', 'build'), 'workspace');
  assert.equal(executionPlaneFor('Implement the login fix', 'build'), 'workspace');
  assert.equal(executionPlaneFor('Update the README file', 'build'), 'workspace');
  assert.equal(executionPlaneFor('run git status -sb', 'build'), 'workspace');
  assert.equal(executionPlaneFor('run it in codespace', 'build'), 'workspace');
  assert.equal(executionPlaneFor('git log --oneline -10', 'build'), 'workspace');
  assert.equal(executionPlaneFor('check the main repo and pull update', 'build'), 'workspace');
});

test('plan and ask modes remain direct because they cannot mutate the project', () => {
  assert.equal(executionPlaneFor('Plan how to refactor the backend', 'plan'), 'direct');
  assert.equal(executionPlaneFor('Tell me how you would fix the build', 'ask'), 'direct');
});


test('direct chat bypasses a blocked workspace task in the queue', () => {
  const first = { id: 'build-task', state: 'queued', plane: 'workspace', prompt: 'Run tests', createdAt: '', updatedAt: '' };
  const second = { id: 'chat-task', state: 'queued', plane: 'direct', prompt: 'hi', createdAt: '', updatedAt: '' };
  assert.equal(chooseNextQueuedTask([first, second])?.id, 'chat-task');
});


test('Build work waits while a workspace is failed or still starting', () => {
  assert.equal(workspaceCanAcceptTask({ state: 'failed', bridgeState: 'disconnected' }), false);
  assert.equal(workspaceCanAcceptTask({ state: 'starting', bridgeState: 'disconnected' }), false);
  assert.equal(workspaceCanAcceptTask({ state: 'ready', bridgeState: 'connecting' }), false);
  assert.equal(workspaceCanAcceptTask({ state: 'ready', bridgeState: 'ready' }), true);
});


test('stale delayed Build work expires instead of executing much later', () => {
  const now = Date.parse('2026-09-25T19:00:00Z');
  const oldQueued = {
    id: 'old-queued', sessionId: 's', workspaceId: 'w', plane: 'workspace',
    state: 'queued', prompt: 'install execution', createdAt: '2026-09-25T18:30:00Z', updatedAt: '2026-09-25T18:30:00Z'
  };
  const recentlyQueued = { ...oldQueued, id: 'recent', createdAt: '2026-09-25T18:50:00Z', updatedAt: '2026-09-25T18:50:00Z' };
  const delayedRunning = { ...oldQueued, id: 'delayed-running', state: 'running', updatedAt: '2026-09-25T18:50:00Z' };
  assert.equal(delayedWorkspaceTaskExpired(oldQueued, now), true);
  assert.equal(delayedWorkspaceTaskExpired(recentlyQueued, now), false);
  assert.equal(delayedWorkspaceTaskExpired(delayedRunning, now), true);
});


test('free OpenCode workspace models use public auth instead of a saved account key', () => {
  const adapter = getAgentAdapter('opencode');
  assert.equal(adapter.publicAccessForModel('opencode/muse-spark-1.3-contributor-free'), true);
  assert.equal(adapter.publicAccessForModel('opencode/muse-spark-1.3'), false);
  assert.equal(adapter.publicAccessForModel('anthropic/claude-sonnet-4'), undefined);
});
