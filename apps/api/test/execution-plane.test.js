import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { executionPlaneFor, executionPlaneForSession, publishIntentFor } from '../src/direct-chat.ts';
import { chooseNextQueuedTask, workspaceCanAcceptTask, delayedWorkspaceTaskExpired, instructionForModeAccess, buildPresentationInstruction } from '../src/agents.ts';
import { getAgentAdapter } from '../src/agent-runtime.ts';
import { classifyError } from '../src/ai.ts';
import { createHarnessCheckpoint, needsSelectedModelReview, selectedModelReviewInstruction } from '../src/harness.ts';

// Keep routing tests deterministic: these assertions require no live workspace.
test('an existing Codespace never changes the mode/request execution decision', () => {
  assert.equal(executionPlaneFor('Hello', 'build'), 'direct');
  assert.equal(executionPlaneFor('Explain this repo', 'ask'), 'direct');
  assert.equal(executionPlaneFor('Plan the refactor and show the steps', 'plan'), 'direct');
  assert.equal(executionPlaneFor('Run git status -sb', 'build'), 'workspace');
});

test('a ready workspace preserves Build continuity while Ask and Plan stay lightweight', () => {
  const ready = { state: 'ready', bridgeState: 'ready' };
  const connecting = { state: 'connecting', bridgeState: 'disconnected' };

  // Runtime/working-tree truth must come from the live workspace.
  assert.equal(executionPlaneForSession('Have U started local host??', 'build', ready), 'workspace');
  assert.equal(executionPlaneForSession('What changed?', 'build', ready), 'workspace');
  assert.equal(executionPlaneForSession('Is the dev server running?', 'ask', ready), 'workspace');
  assert.equal(executionPlaneForSession('Show me the current git diff', 'plan', ready), 'workspace');

  // Once Build already has a warm workspace, conversational follow-ups stay
  // with the same OpenCode/workspace session instead of cold-starting the
  // separate direct runtime.
  assert.equal(executionPlaneForSession('Explain the authentication flow', 'build', ready), 'workspace');
  assert.equal(executionPlaneForSession('Review this architecture and suggest improvements', 'build', ready), 'workspace');
  assert.equal(executionPlaneForSession('How can we improve everything significantly?', 'build', ready), 'workspace');

  // Ask and Plan retain the fast direct lane unless they explicitly need live
  // mutable state.
  assert.equal(executionPlaneForSession('Explain this file', 'ask', ready), 'direct');
  assert.equal(executionPlaneForSession('Plan the next fix', 'plan', ready), 'direct');

  // A non-ready workspace cannot be trusted just to preserve Build continuity;
  // the direct classifier remains authoritative until it is actually ready.
  assert.equal(executionPlaneForSession('Explain this file', 'build', connecting), 'direct');
  assert.equal(executionPlaneForSession('Explain this file', 'ask', null), 'direct');
});

test('verified Build work must be challenged by the currently selected model before finalization', () => {
  const checkpoint = createHarnessCheckpoint({
    prompt: 'Fix the bug and run tests',
    mode: 'build',
    permission: 'full',
    plane: 'workspace',
  });
  checkpoint.verification = {
    required: ['tests'],
    satisfied: ['tests'],
    missing: [],
    status: 'passed',
    checkedAt: new Date().toISOString(),
  };

  assert.equal(needsSelectedModelReview(checkpoint, 'build', 'opencode/model-a'), true);
  checkpoint.modelReviewAttempts = 1;
  checkpoint.modelReviewModelId = 'opencode/model-a';
  assert.equal(needsSelectedModelReview(checkpoint, 'build', 'opencode/model-a'), false);
  assert.equal(needsSelectedModelReview(checkpoint, 'build', 'opencode/model-b'), true);
  assert.equal(needsSelectedModelReview(checkpoint, 'ask', 'opencode/model-a'), false);

  const instruction = selectedModelReviewInstruction(checkpoint, 'opencode/model-b', ['tests passed'], []);
  assert.match(instruction, /independent reasoning\/quality partner/i);
  assert.match(instruction, /Do not merely agree with Orlynx/i);
  assert.match(instruction, /Model → Orlynx: verified/i);

  const gateway = fs.readFileSync(new URL('../src/bridge-gateway.ts', import.meta.url), 'utf8');
  assert.match(gateway, /needsSelectedModelReview\(task\.harness/);
  assert.match(gateway, /mandatory selected-model review/);
  assert.match(gateway, /Orlynx → Model: verification passed/);
  assert.match(gateway, /modelReviewCompletedAt/);
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

test('explicit publish language is typo-tolerant and bypasses AI ambiguity', () => {
  assert.equal(publishIntentFor('push to main', 'main'), 'direct');
  assert.equal(publishIntentFor('puhs to main', 'main'), 'direct');
  assert.equal(publishIntentFor('push to main', 'feature/demo'), null);
  assert.equal(publishIntentFor('push to master', 'main'), null);
  assert.equal(publishIntentFor('publish it', 'main'), 'direct');
  assert.equal(publishIntentFor('create a PR', 'main'), 'pull-request');
  assert.equal(publishIntentFor('explain how git push works', 'main'), null);
  assert.equal(executionPlaneFor('puhs to main', 'build'), 'workspace');
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
  assert.equal(executionPlaneFor('on the repo any updates??', 'build'), 'workspace');
  assert.equal(executionPlaneFor('any new updates on main?', 'build'), 'workspace');
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


test('explicit after-current queue intent waits behind active work across execution lanes', () => {
  const active = { id: 'active-build', state: 'running', plane: 'workspace', prompt: 'Build it', createdAt: '', updatedAt: '' };
  const deferred = { id: 'deferred-chat', state: 'queued', plane: 'direct', prompt: 'Explain next', harness: { queueAfterActive: true }, createdAt: '', updatedAt: '' };
  assert.equal(chooseNextQueuedTask([active, deferred]), undefined);
  active.state = 'completed';
  assert.equal(chooseNextQueuedTask([active, deferred])?.id, 'deferred-chat');
});

test('direct chat bypasses a blocked workspace task in the queue', () => {
  const first = { id: 'build-task', state: 'queued', plane: 'workspace', prompt: 'Run tests', createdAt: '', updatedAt: '' };
  const second = { id: 'chat-task', state: 'queued', plane: 'direct', prompt: 'hi', createdAt: '', updatedAt: '' };
  assert.equal(chooseNextQueuedTask([first, second])?.id, 'chat-task');
});

test('queued work never starts concurrently with unresolved active work', () => {
  const queued = { id: 'queued', state: 'queued', plane: 'direct', prompt: 'next', createdAt: '', updatedAt: '' };
  for (const state of ['running', 'waiting_input', 'waiting_approval']) {
    const active = { id: `active-${state}`, state, plane: 'workspace', prompt: 'current', createdAt: '', updatedAt: '' };
    assert.equal(chooseNextQueuedTask([active, queued]), undefined, state);
  }
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

test('free allowance errors are classified separately from runtime failures', () => {
  assert.equal(classifyError('Free usage exceeded, subscribe to Go'), 'quota');
  assert.equal(classifyError('usage limit exceeded'), 'quota');
  assert.equal(classifyError('connection timed out'), 'engine');
});

test('workspace OpenCode keeps free models on public auth and paid models on account auth', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  assert.match(bridge, /const desired: OpenCodeAuthMode = publicAccess \? 'public' : 'account'/);
  assert.match(bridge, /event\.type === 'message\.part\.delta'/);
  assert.match(bridge, /messageRoles\.get\(messageID\) !== 'assistant'/);
  assert.match(bridge, /blockedTextParts/);
});

test('free-model provider rejection never tells the user to reconnect an optional account key', () => {
  const gateway = fs.readFileSync(new URL('../src/bridge-gateway.ts', import.meta.url), 'utf8');
  assert.match(gateway, /const freePublicModel = command\.payload\.openCodePublicAccess === true/);
  assert.match(gateway, /freePublicModel && classifiedErrorKind === 'auth'[\s\S]*?\? 'model'/);
  assert.match(gateway, /This does not mean your account needs reconnecting/);
});



test('queued Build work tells the user what runtime state it is waiting on', () => {
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  assert.match(agents, /sourceType: 'agent\.runtime\.wait'/);
  assert.match(agents, /OpenCode disconnected · recovering the existing workspace runtime/);
  assert.match(agents, /Starting OpenCode in the existing workspace/);
});

test('Build admission proves repository freshness before model execution', () => {
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  assert.match(agents, /bridgeRequest\(readyWorkspace\.id, 'git\.sync'/);
  assert.match(agents, /Checking .* against GitHub/);
  assert.match(agents, /Workspace updated to latest/);
  assert.match(agents, /stopped before executing stale or conflicting code/);
  assert.match(bridge, /case 'git\.sync'/);
  assert.match(bridge, /git\(\['merge', '--ff-only', remoteRef\]/);
  assert.match(bridge, /state: 'blocked_dirty'/);
  assert.match(bridge, /state: 'blocked_diverged'/);
  assert.match(bridge, /state: 'branch_mismatch'/);
});

test('Codespace repository sync uses native Git credentials without persisting the GitHub token', () => {
  const runtime = fs.readFileSync(new URL('../src/runtime-worker.ts', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('../../../runtime-worker/src/index.ts', import.meta.url), 'utf8');
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(runtime, /ORLYNX_GITHUB_TOKEN/);
  assert.doesNotMatch(worker, /ORLYNX_GITHUB_TOKEN/);
  assert.doesNotMatch(bridge, /if \(!GITHUB_TOKEN\) throw new Error\('GitHub credentials are unavailable in this workspace\.'\)/);
  assert.match(bridge, /const authEnv = GITHUB_TOKEN \? \{/);
  assert.match(bridge, /native Codespaces Git credential helper/);
  assert.match(agents, /errorKind: 'repository'/);
});

test('Build dependency hydration avoids accidental lockfile churn', () => {
  assert.match(buildPresentationInstruction('build'), /prefer npm ci rather than npm install/i);
  assert.match(buildPresentationInstruction('build'), /Do not leave package-lock\.json changed unless the task intentionally changes dependencies/i);
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


test('workspace Build keeps private Orlynx guardrails separate from user text', () => {
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  assert.match(agents, /const privateSystem = \[[\s\S]*?instructionForModeAccess\(mode, permission\)[\s\S]*?buildPresentationInstruction\(mode\)/);
  assert.match(agents, /text: task\.prompt,[\s\S]*?system: privateSystem/);
  assert.match(agents, /adapter\.prompt\(project, engineSession\.id, userText, \{[\s\S]*?system: privateSystem,[\s\S]*?tools: openCodeToolsFor\(localHarness\)/);
  assert.doesNotMatch(agents, /text: guardedText/);
});


test('repository preflight transport interruptions requeue Build instead of reporting AI runtime failure', () => {
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  assert.match(agents, /transportInterrupted/);
  assert.match(agents, /markWorkspaceConnectionLost\(readyWorkspace\.id\)/);
  assert.match(agents, /nextQueued\.state = 'queued'/);
  assert.match(agents, /repository_preflight_recovery/);
  assert.match(agents, /GitHub check paused · reconnecting workspace/);
});

test('durable scheduler permits one direct conversation beside one workspace Build run', () => {
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');
  assert.match(storage, /COALESCE\(active\.execution_plane, 'workspace'\) = COALESCE\(queued\.execution_plane, 'workspace'\)/);
  assert.match(storage, /ORDER BY CASE WHEN queued\.execution_plane='direct' THEN 0 ELSE 1 END/);
});
