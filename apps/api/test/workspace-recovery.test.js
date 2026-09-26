import fs from 'node:fs';
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


test('workspace startup waits for the workspace bridge, not for an agent adapter', () => {
  assert.equal(workspaceStartupPending({ state: 'connecting', bridgeState: 'connecting' }), true);
  assert.equal(workspaceStartupPending({ state: 'connecting', bridgeState: 'ready' }), true);
  assert.equal(workspaceStartupPending({ state: 'ready', bridgeState: 'ready' }), false);
  assert.equal(workspaceStartupPending({ state: 'failed', bridgeState: 'disconnected' }), false);
});

test('workspace readiness is independent of OpenCode adapter health', () => {
  assert.equal(workspaceFullyReady({ state: 'ready', bridgeState: 'ready' }), true);
  assert.equal(workspaceFullyReady({ state: 'connecting', bridgeState: 'ready' }), false);
  assert.equal(workspaceFullyReady({ state: 'ready', bridgeState: 'connecting' }), false);
});


test('authenticated transient bridge closes trigger self-healing', () => {
  assert.equal(shouldRecoverTransientBridgeClose(true, 1006), true);
  assert.equal(shouldRecoverTransientBridgeClose(true, 1001), true);
  assert.equal(shouldRecoverTransientBridgeClose(true, 1012), true);
  assert.equal(shouldRecoverTransientBridgeClose(false, 1006), false);
  assert.equal(shouldRecoverTransientBridgeClose(true, 1008), false);
});


test('Codespace bootstrap uses a CPU-compatible native OpenCode binary and smoke-tests it', () => {
  for (const relative of ['../src/runtime-worker.ts', '../../../runtime-worker/src/index.ts']) {
    const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.match(source, /opencode-linux-x64-baseline/);
    assert.match(source, /opencode-linux-arm64/);
    assert.match(source, /\/proc\/cpuinfo/);
    assert.match(source, /opencode-version\.txt/);
    assert.match(source, /--version/);
    assert.match(source, /OPENCODE_BIN=%s/);
  }
});
