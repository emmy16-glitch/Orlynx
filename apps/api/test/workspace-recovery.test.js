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

test('workspace OpenCode readiness ignores one transient health miss before declaring unavailable', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  assert.match(bridge, /OPENCODE_HEALTH_FAILURE_THRESHOLD = 2/);
  assert.match(bridge, /openCodeTransientHealthFailures \+= 1/);
  assert.match(bridge, /keeping adapter ready/);
  assert.match(bridge, /openCodeTransientHealthFailures < OPENCODE_HEALTH_FAILURE_THRESHOLD/);
  assert.match(bridge, /openCodeTransientHealthFailures = 0;\s*openCodeLifecycle = \{ state: 'ready' \}/);
});

test('workspace bridge repairs a missing or stale OpenCode binary before declaring the adapter unavailable', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  assert.match(bridge, /resolveOpenCodeBinary/);
  assert.match(bridge, /repairOpenCodeBinary/);
  assert.match(bridge, /opencode-self-heal/);
  assert.match(bridge, /opencode-linux-x64-baseline/);
  assert.match(bridge, /opencode-linux-arm64/);
  assert.match(bridge, /\/opt\/orlynx\/bin\/opencode/);
  assert.match(bridge, /npm.*install|spawnSync\('npm'/s);
  assert.match(bridge, /binary_unavailable/);

  for (const relative of ['../src/runtime-worker.ts', '../../../runtime-worker/src/index.ts']) {
    const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.match(source, /OPENCODE_VERSION=%s/);
  }

  const runner = fs.readFileSync(new URL('../../../runner-runtime/Dockerfile', import.meta.url), 'utf8');
  assert.match(runner, /ENV OPENCODE_VERSION=\$\{OPENCODE_VERSION\}/);
});



test('Codespace bootstrap provides a private authenticated safe GitHub CLI for Preview forwarding', () => {
  for (const relative of ['../src/runtime-worker.ts', '../../../runtime-worker/src/index.ts']) {
    const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /ORLYNX_GITHUB_TOKEN/);
    assert.match(source, /gh version 2\.101\.0/);
    assert.match(source, /9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8/);
    assert.match(source, /b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f/);
    assert.match(source, /sha256sum -c/);
    assert.match(source, /ORLYNX_GH_BIN=%s/);
    assert.match(source, /downloaded=0/);
  }

  const apiWorker = fs.readFileSync(new URL('../src/runtime-worker.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(apiWorker, /bootstrapScript\(workspace, values, bridgeUrl, openCodeApiKey, githubUserToken\)/);

  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  assert.match(bridge, /const GH_BIN = process\.env\.ORLYNX_GH_BIN \|\| 'gh'/);
  assert.match(bridge, /const GITHUB_TOKEN = process\.env\.GITHUB_TOKEN \|\| process\.env\.ORLYNX_GITHUB_TOKEN \|\| ''/);
  assert.match(bridge, /spawnSync\(GH_BIN, \['--version'\]/);
  assert.match(bridge, /spawn\(GH_BIN, \['codespace', 'ports', 'forward'/);
  assert.doesNotMatch(bridge, /--all-interfaces/);
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
  assert.match(source, /reusableForSession\(input\) \|\| await this\.reusableForProject\(input\)/);
  assert.match(source, /sessionHasActiveWork/);
  assert.match(source, /ORLYNX_CODESPACE_RETENTION_MINUTES \|\| 7 \* 24 \* 60/);
  assert.match(source, /\['running', 'queued', 'waiting_input', 'waiting_approval'\]\.includes\(task\.state\)/);
});


test('Codespace bootstrap prewarms Playwright browser dependencies once per version', () => {
  const source = fs.readFileSync(new URL('../src/runtime-worker.ts', import.meta.url), 'utf8');
  assert.match(source, /ORLYNX_PREWARM_BROWSER_RUNTIME/);
  assert.match(source, /playwright-cli-\$playwright_version/);
  assert.match(source, /install-deps chromium/);
  assert.match(source, /install chromium/);
  assert.match(source, /libatk-1\.0\.so\.0/);
  assert.match(source, /playwright-\$playwright_version\.ready/);
  assert.match(source, /chromium\.launch/);
  assert.match(source, /if ! \(\s*set -e[\s\S]*install-deps chromium/);
  assert.match(source, /Playwright Chromium prewarm failed; continuing workspace bootstrap/);
});

test('Codespace SSH bootstrap retries transient readiness races instead of one-shot timing out', () => {
  const source = fs.readFileSync(new URL('../src/runtime-worker.ts', import.meta.url), 'utf8');
  assert.match(source, /ORLYNX_BOOTSTRAP_TIMEOUT_MS \|\| 5 \* 60_000/);
  assert.match(source, /ORLYNX_BOOTSTRAP_ATTEMPT_TIMEOUT_MS \|\| 150_000/);
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


test('new sessions may reuse only an idle Codespace for the same repository and branch', () => {
  const source = fs.readFileSync(new URL('../src/github-codespaces.ts', import.meta.url), 'utf8');
  const createStart = source.indexOf('async create(');
  const createEnd = source.indexOf('async replace(', createStart);
  const createBlock = source.slice(createStart, createEnd);
  assert.match(createBlock, /reusableForSession\(input\) \|\| await this\.reusableForProject\(input\)/);
  assert.match(source, /codespaceMatchesProject\(item, input\.repositoryId, input\.branch\)/);
  assert.match(source, /sessionHasActiveWork\(previousSessionId\)/);
});

test('SSH replacement recovery is automatic but bounded to one replacement per preparation', () => {
  const source = fs.readFileSync(new URL('../src/workspaces.ts', import.meta.url), 'utf8');
  assert.match(source, /replacementDepth = 0/);
  assert.match(source, /workspaceNeedsCodespaceReplacement\(detail\) && replacementDepth < 1/);
  assert.match(source, /return prepareWorkspaceOnce\(input, replacementDepth \+ 1, context\)/);
});


test('stale failed workspace adapter requeues Build and repairs instead of emitting AI runtime failure', () => {
  const source = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  const failedBlockStart = source.indexOf("if (adapterState.state === 'failed')");
  const failedBlockEnd = source.indexOf('// Build must never silently execute against a stale checkout.', failedBlockStart);
  assert.ok(failedBlockStart >= 0 && failedBlockEnd > failedBlockStart);
  const block = source.slice(failedBlockStart, failedBlockEnd);

  assert.match(block, /nextQueued\.state = 'queued'/);
  assert.match(block, /putWorkspaceAgentAdapter\([\s\S]*state: 'starting'/);
  assert.match(block, /markWorkspaceConnectionLost\(readyWorkspace\.id\)/);
  assert.match(block, /reason: 'adapter_failed_recovery'/);
  assert.match(block, /Repairing this workspace AI runtime/);
  assert.doesNotMatch(block, /run\.failed/);
  assert.doesNotMatch(block, /nextQueued\.state = 'failed'/);
});

test('queued Build work durably schedules recoverable workspace repair', () => {
  const source = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  assert.match(source, /workspaceNeedsCodespaceReplacement\(readyWorkspace\.failureCode\)/);
  assert.match(source, /readyWorkspace\.provider === 'orlynx-runner'/);
  assert.match(source, /scheduleWorkspacePreparation\(\{/);
  assert.match(source, /reason: 'queue_repair'/);
});


test('waiting-for-user replies stay attached to the same task across workspace reconnect', () => {
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /waitingInputTask/);
  assert.match(routes, /applySteering\(waitingInputTask, String\(text\), 'append'/);
  assert.match(routes, /reason: 'waiting_input_resume'/);
  assert.match(routes, /recoveringWorkspace: true|recoveringRuntime: true/);
  assert.doesNotMatch(routes, /waitingForSameTask: true/);
  assert.match(routes, /task\.state === 'waiting_input'/);
});


test('slow Codespace provisioning remains queued instead of becoming a failed workspace', () => {
  const workspaces = fs.readFileSync(new URL('../src/workspaces.ts', import.meta.url), 'utf8');
  const jobs = fs.readFileSync(new URL('../src/workspace-jobs.ts', import.meta.url), 'utf8');
  assert.match(workspaces, /Build remains queued and will continue automatically/);
  assert.match(jobs, /Codespace provisioning is still pending/);
  assert.match(jobs, /orchestrator\.provisioning/);
});

test('queue promoter preserves running and human-wait guards from the full durable task set', () => {
  const source = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  const promoterStart = source.indexOf('async function promoteNextQueuedRunInner');
  const promoterEnd = source.indexOf('export async function resumeWaitingInputTask', promoterStart);
  assert.ok(promoterStart >= 0 && promoterEnd > promoterStart);
  const promoter = source.slice(promoterStart, promoterEnd);

  assert.match(promoter, /const nextQueued = chooseNextQueuedTask\(tasks\)/);
  assert.doesNotMatch(promoter, /chooseNextQueuedTask\(queued\)/);
  assert.match(promoter, /if \(!nextQueued\) return null/);
});

test('stale workspace sync preserves isolated package-lock drift before fast-forwarding', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');

  assert.match(bridge, /packageLockOnly/);
  assert.match(bridge, /git\(\['diff', 'HEAD', '--binary', '--', 'package-lock\.json'\]\)/);
  assert.match(bridge, /\.orlynx', 'recovery'/);
  assert.match(bridge, /git\(\['restore', '--source=HEAD', '--staged', '--worktree', '--', 'package-lock\.json'\]\)/);
  assert.match(bridge, /recoveredGeneratedLockfile/);
  assert.match(bridge, /line\.startsWith\('\?\?'\)/);
  assert.match(agents, /preserved incidental package-lock drift/);
  assert.match(agents, /recoveryPatch/);
});

