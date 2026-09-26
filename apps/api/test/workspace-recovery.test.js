import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceNeedsSshRebuild, workspaceNeedsCodespaceReplacement, workspaceConnectionMatchesRevision, workspaceFullyReady, workspaceStartupPending, shouldRecoverTransientBridgeClose } from '../src/workspaces.ts';
import { codespaceMatchesProject, orlynxSessionId } from '../src/github-codespaces.ts';
import { workspaceOpenCodeHealthState } from '../src/opencode.ts';

test('missing SSH server bootstrap failures request a Codespace rebuild', () => {
  assert.equal(workspaceNeedsSshRebuild('Codespace bootstrap failed: failed to start SSH server'), true);
  assert.equal(workspaceNeedsSshRebuild('error getting ssh server details'), true);
  assert.equal(workspaceNeedsSshRebuild('GitHub Codespace did not become ready before the startup timeout.'), false);
  assert.equal(workspaceNeedsSshRebuild('Codespace SSH did not become ready after 25 bootstrap attempts within 120 seconds.'), true);
});

test('missing or invisible Codespaces request automatic replacement', () => {
  assert.equal(workspaceNeedsCodespaceReplacement('Codespace bootstrap failed (exit 1): getting full codespace details: HTTP 404: Not Found (https://api.github.com/user/codespaces/orlynx-old)'), true);
  assert.equal(workspaceNeedsCodespaceReplacement('GitHub Codespaces request failed (HTTP 404): Not Found.'), true);
  assert.equal(workspaceNeedsCodespaceReplacement('Codespace bootstrap failed: failed to start SSH server'), true);
  assert.equal(workspaceNeedsCodespaceReplacement('GitHub Codespace did not become ready before the startup timeout.'), false);
  assert.equal(workspaceNeedsCodespaceReplacement('Codespace SSH server is unavailable after 3 attempts.'), true);
});

test('bridge runtime revision marker distinguishes current and stale bridges', () => {
  assert.equal(workspaceConnectionMatchesRevision('bridge-abc123-current', 'abc123'), true);
  assert.equal(workspaceConnectionMatchesRevision('bridge-oldrev-current', 'abc123'), false);
  assert.equal(workspaceConnectionMatchesRevision(undefined, 'abc123'), false);
});


test('workspace startup waits across every provisioning stage until the bridge is ready', () => {
  assert.equal(workspaceStartupPending({ state: 'creating', bridgeState: 'disconnected' }), true);
  assert.equal(workspaceStartupPending({ state: 'starting', bridgeState: 'disconnected' }), true);
  assert.equal(workspaceStartupPending({ state: 'bootstrapping', bridgeState: 'connecting' }), true);
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


test('Orlynx-owned Codespaces can be identified for safe cross-session reuse', () => {
  assert.equal(orlynxSessionId('Orlynx ses_abc123'), 'ses_abc123');
  assert.equal(orlynxSessionId('My personal Codespace'), null);
  assert.equal(orlynxSessionId('Orlynx random-name'), null);
});

test('Codespace project reuse requires the same repository and branch', () => {
  const base = {
    name: 'silver-space',
    display_name: 'Orlynx ses_old',
    state: 'Available',
    repository: { id: 42 },
    git_status: { ref: 'refs/heads/main' },
  };
  assert.equal(codespaceMatchesProject(base, 42, 'main'), true);
  assert.equal(codespaceMatchesProject(base, 43, 'main'), false);
  assert.equal(codespaceMatchesProject(base, 42, 'develop'), false);
  assert.equal(codespaceMatchesProject({ ...base, state: 'Failed' }, 42, 'main'), false);
});

test('quota recovery waits for GitHub to finish stopping an old Codespace', () => {
  const source = fs.readFileSync(new URL('../src/github-codespaces.ts', import.meta.url), 'utf8');
  assert.match(source, /waitUntilStopped/);
  assert.doesNotMatch(source, /setTimeout\(resolve, 1_500\)/);
  assert.match(source, /reusableForProject/);
  assert.match(source, /sessionHasActiveWork/);
});


test('Codespace SSH bootstrap retries transient readiness races instead of one-shot timing out', () => {
  const source = fs.readFileSync(new URL('../src/runtime-worker.ts', import.meta.url), 'utf8');
  assert.match(source, /ORLYNX_BOOTSTRAP_TIMEOUT_MS \|\| 2 \* 60_000/);
  assert.match(source, /ORLYNX_BOOTSTRAP_ATTEMPT_TIMEOUT_MS \|\| 45_000/);
  assert.match(source, /Codespace SSH not ready yet/);
  assert.match(source, /bootstrap attempts/);
  assert.match(source, /HTTP\\s\+\(\?:401\|403\|404\)/);
});

test('bridge disconnect recovery leaves idle Codespaces alone and repairs only active Build work', () => {
  const source = fs.readFileSync(new URL('../src/bridge-gateway.ts', import.meta.url), 'utf8');
  assert.match(source, /ORLYNX_BRIDGE_RECONNECT_GRACE_MS \|\| 20_000/);
  assert.match(source, /activeWorkspaceWork/);
  assert.match(source, /idle workspace transport lost; deferring SSH repair until next Build task/);
  assert.match(source, /active Build work needs transport recovery/);
});

test('workspace startup retries transient GitHub status lookup failures', () => {
  const source = fs.readFileSync(new URL('../src/workspaces.ts', import.meta.url), 'utf8');
  assert.match(source, /Checking GitHub status again/);
  assert.match(source, /HTTP\\s\+\(\?:401\|403\|404\)/);
});


test('workspace OpenCode health accepts both generic adapter and legacy health schemas', () => {
  assert.equal(workspaceOpenCodeHealthState({ bridge: 'ready', adapters: { opencode: { state: 'ready' } } }), 'ready');
  assert.equal(workspaceOpenCodeHealthState({ bridge: 'ready', openCode: 'ready' }), 'ready');
  assert.equal(workspaceOpenCodeHealthState({ bridge: 'ready', openCode: 'starting', adapters: { opencode: { state: 'ready' } } }), 'ready');
  assert.equal(workspaceOpenCodeHealthState({ bridge: 'ready', adapters: { opencode: { state: 'starting' } } }), 'starting');
});


test('new sessions do not inherit another session\'s Codespace runtime', () => {
  const source = fs.readFileSync(new URL('../src/github-codespaces.ts', import.meta.url), 'utf8');
  const createStart = source.indexOf('async create(');
  const createEnd = source.indexOf('async replace(', createStart);
  const createBlock = source.slice(createStart, createEnd);
  assert.match(createBlock, /const existing = await this\.reusableForSession\(input\)/);
  assert.doesNotMatch(createBlock, /reusableForProject\(input\)/);
});

test('SSH replacement recovery is automatic but bounded to one replacement per preparation', () => {
  const source = fs.readFileSync(new URL('../src/workspaces.ts', import.meta.url), 'utf8');
  assert.match(source, /replacementDepth = 0/);
  assert.match(source, /workspaceNeedsCodespaceReplacement\(detail\) && replacementDepth < 1/);
  assert.match(source, /return prepareWorkspaceOnce\(input, replacementDepth \+ 1\)/);
});


test('queued Build work repairs SSH-broken workspaces instead of being failed immediately', () => {
  const source = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  assert.match(source, /workspaceNeedsCodespaceReplacement\(readyWorkspace\.failureCode\)/);
  assert.match(source, /repairing failed workspace before Build task/);
  assert.match(source, /void prepareWorkspace\(\{/);
  assert.match(source, /await promoteNextQueuedRun\(sessionId\)/);
});


test('workspace preparation emits concise user-facing startup stages', () => {
  const source = fs.readFileSync(new URL('../src/workspaces.ts', import.meta.url), 'utf8');
  for (const text of [
    'Starting Codespace…',
    'Waiting for GitHub…',
    'Codespace online. Starting SSH…',
    'Starting SSH and installing Orlynx bridge…',
    'Orlynx bridge installed. Connecting…',
    'Starting OpenCode…',
  ]) assert.match(source, new RegExp(text.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')));
});
