import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceNeedsSshRebuild, workspaceConnectionMatchesRevision, workspaceFullyReady, workspaceStartupPending, shouldRecoverTransientBridgeClose } from '../src/workspaces.ts';

test('missing SSH server bootstrap failures request a Codespace rebuild', () => {
  assert.equal(workspaceNeedsSshRebuild('Codespace bootstrap failed: failed to start SSH server'), true);
  assert.equal(workspaceNeedsSshRebuild('error getting ssh server details'), true);
  assert.equal(workspaceNeedsSshRebuild('GitHub Codespace did not become ready before the startup timeout.'), false);
});

test('bridge runtime revision marker distinguishes current and stale bridges', () => {
  assert.equal(workspaceConnectionMatchesRevision('bridge-abc123-current', 'abc123'), true);
  assert.equal(workspaceConnectionMatchesRevision('bridge-oldrev-current', 'abc123'), false);
  assert.equal(workspaceConnectionMatchesRevision(undefined, 'abc123'), false);
});


test('workspace startup keeps waiting after bridge connection until OpenCode is ready', () => {
  assert.equal(workspaceStartupPending({ state: 'connecting', bridgeState: 'connecting', openCodeState: 'installing' }), true);
  assert.equal(workspaceStartupPending({ state: 'connecting', bridgeState: 'ready', openCodeState: 'starting' }), true);
  assert.equal(workspaceStartupPending({ state: 'ready', bridgeState: 'ready', openCodeState: 'ready' }), false);
  assert.equal(workspaceStartupPending({ state: 'failed', bridgeState: 'disconnected', openCodeState: 'failed' }), false);
});

test('workspace readiness requires both authenticated bridge and healthy OpenCode', () => {
  assert.equal(workspaceFullyReady({ state: 'ready', bridgeState: 'ready', openCodeState: 'ready' }), true);
  assert.equal(workspaceFullyReady({ state: 'connecting', bridgeState: 'ready', openCodeState: 'starting' }), false);
  assert.equal(workspaceFullyReady({ state: 'ready', bridgeState: 'connecting', openCodeState: 'ready' }), false);
});


test('authenticated transient bridge closes trigger self-healing', () => {
  assert.equal(shouldRecoverTransientBridgeClose(true, 1006), true);
  assert.equal(shouldRecoverTransientBridgeClose(true, 1001), true);
  assert.equal(shouldRecoverTransientBridgeClose(true, 1012), true);
  assert.equal(shouldRecoverTransientBridgeClose(false, 1006), false);
  assert.equal(shouldRecoverTransientBridgeClose(true, 1008), false);
});
