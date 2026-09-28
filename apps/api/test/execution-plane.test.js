import test from 'node:test';
import assert from 'node:assert/strict';
import { executionPlaneFor, executionPlaneForSession } from '../src/direct-chat.ts';
import { chooseNextQueuedTask, workspaceCanAcceptTask, delayedWorkspaceTaskExpired, instructionForModeAccess, buildPresentationInstruction } from '../src/agents.ts';
import { getAgentAdapter } from '../src/agent-runtime.ts';

// Keep routing tests deterministic: these assertions require no live workspace.
test('an existing Codespace never changes the mode/request execution decision', () => {
  assert.equal(executionPlaneFor('Hello', 'build'), 'direct');
  assert.equal(executionPlaneFor('Explain this repo', 'ask'), 'direct');
  assert.equal(executionPlaneFor('Plan the refactor and show the steps', 'plan'), 'direct');
  assert.equal(executionPlaneFor('Run git status -sb', 'build'), 'workspace');
});

test('a ready workspace is reused only for questions that require live mutable state', () => {
  const ready = { state: 'ready', bridgeState: 'ready' };
  const connecting = { state: 'connecting', bridgeState: 'disconnected' };

  // Runtime/working-tree truth must come from the live workspace.
  assert.equal(executionPlaneForSession('Have U started local host??', 'build', ready), 'workspace');
  assert.equal(executionPlaneForSession('What changed?', 'build', ready), 'workspace');
  assert.equal(executionPlaneForSession('Is the dev server running?', 'ask', ready), 'workspace');
  assert.equal(executionPlaneForSession('Show me the current git diff', 'plan', ready), 'workspace');

  // General explanation and planning stay on the fast direct lane even after
  // a workspace exists. Merely having a Codespace/runner is not a routing rule.
  assert.equal(executionPlaneForSession('Explain this file', 'ask', ready), 'direct');
  assert.equal(executionPlaneForSession('Plan the next fix', 'plan', ready), 'direct');
  assert.equal(executionPlaneForSession('Explain the authentication flow', 'build', ready), 'direct');
  assert.equal(executionPlaneForSession('Review this architecture and suggest improvements', 'build', ready), 'direct');

  // A non-ready workspace cannot be trusted for live-state questions; the
  // direct classifier remains authoritative until the runtime is actually ready.
  assert.equal(executionPlaneForSession('Explain this file', 'ask', connecting), 'direct');
  assert.equal(executionPlaneForSession('Explain this file', 'ask', null), 'direct');
});

test('Build ask-first permits observable runtime work without granting file changes', () => {
  const instruction = instructionForModeAccess('build', 'ask-first');
  assert.match(instruction, /run tests/i);
  assert.match(instruction, /development servers/i);
  assert.match(instruction, /Do NOT create, modify or delete project files/i);
  assert.doesNotMatch(instruction, /Inspect, search and explain only/i);
  assert.match(instructionForModeAccess('ask', 'full'), /READ ONLY/);
  assert.match(instructionForModeAccess('plan', 'full'), /PLAN/);
  assert.equal(instructionForModeAccess('build', 'full'), '');
});

test('plain conversation does not start a development environment', () => {
  assert.equal(executionPlaneFor('Hello', 'build'), 'direct');
  assert.equal(executionPlaneFor('What does this repository do?', 'build'), 'direct');
  assert.equal(executionPlaneFor('Explain the authentication flow', 'build'), 'direct');
  assert.equal(executionPlaneFor('Review this architecture and suggest improvements', 'ask'), 'direct');
});

test('runtime and mutating build work requests the development environment', () => {
  assert.equal(executionPlaneFor('Run the tests and fix what fails', 'build'), 'workspace');
  assert.equal(executionPlaneFor('carry out test', 'build'), 'workspace');
  assert.equal(executionPlaneFor('perform the tests', 'build'), 'workspace');
  assert.equal(executionPlaneFor('conduct testing', 'build'), 'workspace');
  assert.equal(executionPlaneFor('rerun the build', 'build'), 'workspace');
  assert.equal(executionPlaneFor('npm install and start the dev server', 'build'), 'workspace');
  assert.equal(executionPlaneFor('Implement the login fix', 'build'), 'workspace');
  assert.equal(executionPlaneFor('Update the README file', 'build'), 'workspace');
  assert.equal(executionPlaneFor('run git status -sb', 'build'), 'workspace');
  assert.equal(executionPlaneFor('run it in codespace', 'build'), 'workspace');
  assert.equal(executionPlaneFor('git log --oneline -10', 'build'), 'workspace');
  assert.equal(executionPlaneFor('check the main repo and pull update', 'build'), 'workspace');
  assert.equal(executionPlaneFor('can you check the repo now', 'build'), 'workspace');
  assert.equal(executionPlaneFor('I switched you to build mode so check', 'build'), 'workspace');
  assert.equal(executionPlaneFor('start the local host', 'build'), 'workspace');
});

test('explanatory Build questions stay conversational unless they request changes', () => {
  assert.equal(executionPlaneFor('How do I run npm install?', 'build'), 'direct');
  assert.equal(executionPlaneFor('What does git status show?', 'build'), 'direct');
  assert.equal(executionPlaneFor('Review this architecture and suggest improvements', 'build'), 'direct');
  assert.equal(executionPlaneFor('Review this architecture and fix the problems', 'build'), 'workspace');
});

test('plan and ask modes remain direct even when the wording asks for execution', () => {
  assert.equal(executionPlaneFor('Plan how to refactor the backend', 'plan'), 'direct');
  assert.equal(executionPlaneFor('run git status -sb', 'plan'), 'direct');
  assert.equal(executionPlaneFor('Tell me how you would fix the build', 'ask'), 'direct');
  assert.equal(executionPlaneFor('run the tests', 'ask'), 'direct');
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


test('Build execution reserves prose for final results instead of narrating tool progress', () => {
  const instruction = buildPresentationInstruction('build');
  assert.match(instruction, /do not narrate routine progress/i);
  assert.match(instruction, /Reserve normal assistant prose for the final result/i);
  assert.match(instruction, /GitHub authentication is managed by the Orlynx GitHub App/i);
  assert.match(instruction, /Never ask the user to run gh auth login/i);
  assert.match(instruction, /Do not run raw git push from the provider shell/i);
  assert.match(instruction, /Orlynx controlled publish\/review/i);
  assert.equal(buildPresentationInstruction('plan'), '');
  assert.equal(buildPresentationInstruction('ask'), '');
});
