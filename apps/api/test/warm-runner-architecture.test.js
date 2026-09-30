import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticateBridgeSocket,
  publishLiveBridgeResult,
  registerBridgeSocket,
  sendBridgeCommandNow,
  unregisterBridgeSocket,
  waitForLiveBridgeResult,
} from '../src/bridge-live.ts';
import { defaultWorkspaceProviderId, shouldPrewarmWorkspace } from '../src/workspace-providers.ts';
import { OrlynxRunnerProvider } from '../src/orlynx-runner.ts';
import { probeRunnerHost, rankedRunnerHosts, runnerGlobalMaxWorkspaces, runnerHosts } from '../src/runner-pool.ts';
import { workspaceShouldAdoptPreferredRunner } from '../src/workspaces.ts';

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('workspace provider prefers configured warm runner and otherwise preserves Codespaces', () => {
  withEnv({
    ORLYNX_WORKSPACE_PROVIDER: null,
    ORLYNX_RUNNER_URL: null,
    ORLYNX_RUNNER_TOKEN: null,
    ORLYNX_PREWARM_WORKSPACES: null,
  }, () => {
    assert.equal(defaultWorkspaceProviderId(), 'github-codespaces');
    assert.equal(shouldPrewarmWorkspace(), false);
  });

  withEnv({
    ORLYNX_WORKSPACE_PROVIDER: 'auto',
    ORLYNX_RUNNER_URL: 'https://runner.example.com',
    ORLYNX_RUNNER_TOKEN: 'test-token',
    ORLYNX_PREWARM_WORKSPACES: null,
  }, () => {
    assert.equal(defaultWorkspaceProviderId(), 'orlynx-runner');
    assert.equal(shouldPrewarmWorkspace(), true);
  });

  withEnv({
    ORLYNX_WORKSPACE_PROVIDER: 'github-codespaces',
    ORLYNX_RUNNER_URL: 'https://runner.example.com',
    ORLYNX_RUNNER_TOKEN: 'test-token',
  }, () => {
    assert.equal(defaultWorkspaceProviderId(), 'github-codespaces');
  });
});



test('distributed runner pool ranks healthy capacity and defaults to a global 50-workspace ceiling', async () => {
  const previousHosts = process.env.ORLYNX_RUNNER_HOSTS;
  const previousUrl = process.env.ORLYNX_RUNNER_URL;
  const previousToken = process.env.ORLYNX_RUNNER_TOKEN;
  const previousMax = process.env.ORLYNX_RUNNER_GLOBAL_MAX_WORKSPACES;
  const previousFetch = globalThis.fetch;
  try {
    process.env.ORLYNX_RUNNER_HOSTS = JSON.stringify([
      { id: 'host-a', url: 'https://runner-a.example.com', region: 'eu', weight: 1 },
      { id: 'host-b', url: 'https://runner-b.example.com', region: 'eu', weight: 1 },
    ]);
    delete process.env.ORLYNX_RUNNER_URL;
    process.env.ORLYNX_RUNNER_TOKEN = 'pool-test-token';
    delete process.env.ORLYNX_RUNNER_GLOBAL_MAX_WORKSPACES;

    globalThis.fetch = async (url) => {
      const target = String(url);
      const body = target.includes('runner-a')
        ? { ok: true, capacity: 10, running: 8, available: 2, stopped: 1 }
        : { ok: true, capacity: 10, running: 2, available: 8, stopped: 2 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    assert.deepEqual(runnerHosts().map((host) => host.id), ['host-a', 'host-b']);
    assert.equal(runnerGlobalMaxWorkspaces(), 50);
    const ranked = await rankedRunnerHosts();
    assert.equal(ranked[0]?.id, 'host-b');
    assert.equal(ranked[1]?.id, 'host-a');
  } finally {
    if (previousHosts == null) delete process.env.ORLYNX_RUNNER_HOSTS; else process.env.ORLYNX_RUNNER_HOSTS = previousHosts;
    if (previousUrl == null) delete process.env.ORLYNX_RUNNER_URL; else process.env.ORLYNX_RUNNER_URL = previousUrl;
    if (previousToken == null) delete process.env.ORLYNX_RUNNER_TOKEN; else process.env.ORLYNX_RUNNER_TOKEN = previousToken;
    if (previousMax == null) delete process.env.ORLYNX_RUNNER_GLOBAL_MAX_WORKSPACES; else process.env.ORLYNX_RUNNER_GLOBAL_MAX_WORKSPACES = previousMax;
    globalThis.fetch = previousFetch;
  }
});

test('runner health gives a cold Render service one bounded wake retry before fallback', async () => {
  const previousToken = process.env.ORLYNX_RUNNER_TOKEN;
  const previousTimeout = process.env.ORLYNX_RUNNER_HEALTH_TIMEOUT_MS;
  const previousColdTimeout = process.env.ORLYNX_RUNNER_COLD_START_TIMEOUT_MS;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  try {
    process.env.ORLYNX_RUNNER_TOKEN = 'cold-start-test-token';
    process.env.ORLYNX_RUNNER_HEALTH_TIMEOUT_MS = '2500';
    process.env.ORLYNX_RUNNER_COLD_START_TIMEOUT_MS = '2500';
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new DOMException('runner is waking', 'TimeoutError');
      return new Response(JSON.stringify({
        ok: true,
        capacity: 1,
        running: 0,
        available: 1,
        stopped: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const health = await probeRunnerHost({
      id: 'cold-render-retry',
      url: 'https://cold-render.example.com',
      publicUrl: 'https://cold-render.example.com',
      weight: 1,
    });
    assert.equal(calls, 2);
    assert.equal(health.ok, true);
    assert.equal(health.available, 1);
  } finally {
    if (previousToken == null) delete process.env.ORLYNX_RUNNER_TOKEN; else process.env.ORLYNX_RUNNER_TOKEN = previousToken;
    if (previousTimeout == null) delete process.env.ORLYNX_RUNNER_HEALTH_TIMEOUT_MS; else process.env.ORLYNX_RUNNER_HEALTH_TIMEOUT_MS = previousTimeout;
    if (previousColdTimeout == null) delete process.env.ORLYNX_RUNNER_COLD_START_TIMEOUT_MS; else process.env.ORLYNX_RUNNER_COLD_START_TIMEOUT_MS = previousColdTimeout;
    globalThis.fetch = previousFetch;
  }
});

test('runner image bakes and verifies Chromium E2E runtime', () => {
  const dockerfile = fs.readFileSync(new URL('../../../runner-runtime/Dockerfile', import.meta.url), 'utf8');
  const smoke = fs.readFileSync(new URL('../../../runner-runtime/browser-smoke.mjs', import.meta.url), 'utf8');
  const direct = fs.readFileSync(new URL('../../../runner-direct/index.mjs', import.meta.url), 'utf8');
  const manager = fs.readFileSync(new URL('../../../runner-manager/index.mjs', import.meta.url), 'utf8');
  const workflow = fs.readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(dockerfile, /PLAYWRIGHT_VERSION=1\.63\.0/);
  assert.match(dockerfile, /playwright install --with-deps chromium/);
  assert.match(dockerfile, /PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/);
  assert.match(smoke, /chromium\.launch/);
  assert.match(workflow, /Verify runner Chromium can actually launch/);
  assert.match(direct, /browserE2e: browserRuntimeReady\(\)/);
  assert.match(manager, /browserE2e: process\.env\.ORLYNX_RUNNER_BROWSER_E2E/);
});

test('runner pool force-wakes circuit-open scale-to-zero hosts before declaring zero capacity', () => {
  const pool = fs.readFileSync(new URL('../src/runner-pool.ts', import.meta.url), 'utf8');
  assert.match(pool, /circuitOpen\(host\) && !force/);
  assert.match(pool, /no immediately healthy hosts; forcing wake probe/);
  assert.match(pool, /probeRunnerHost\(host, true\)/);
  assert.match(pool, /forced wake recovered/);
});

test('runner pool carries browser capability and detects E2E task intent', () => {
  const pool = fs.readFileSync(new URL('../src/runner-pool.ts', import.meta.url), 'utf8');
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  assert.match(pool, /browserE2e\?: boolean/);
  assert.match(pool, /taskRequiresBrowserE2e/);
  assert.match(pool, /playwright\|end\[- \]to\[- \]end\|e2e/);
  assert.match(agents, /runnerHostSupportsBrowserE2e/);
  assert.match(agents, /migrateRunnerWorkspaceToCodespacesForCapability/);
  assert.match(agents, /reason: 'browser_capability'/);
});

test('runner pool persists host ownership and manager exposes cache/capacity/drain controls', () => {
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');
  const pool = fs.readFileSync(new URL('../src/runner-pool.ts', import.meta.url), 'utf8');
  const manager = fs.readFileSync(new URL('../../../runner-manager/index.mjs', import.meta.url), 'utf8');
  assert.match(storage, /runner_host_id/);
  assert.match(pool, /ORLYNX_RUNNER_GLOBAL_MAX_WORKSPACES \|\| 50/);
  assert.match(pool, /ORLYNX_RUNNER_CIRCUIT_FAILURES/);
  assert.match(pool, /health\.running \/ Math\.max\(1, .*health\.capacity\)/);
  assert.match(manager, /ORLYNX_RUNNER_MAX_WORKSPACES \|\| 10/);
  assert.match(manager, /ORLYNX_RUNNER_GIT_CACHE_ROOT/);
  assert.match(manager, /git', \['clone', '--mirror'/);
  assert.match(manager, /draining: DRAINING/);
  assert.match(manager, /available: DRAINING \? 0/);
});

test('legacy idle/broken Codespaces migrate to the preferred warm runner without stealing active work', () => {
  const base = {
    provider: 'github-codespaces',
    state: 'failed',
    bridgeState: 'disconnected',
    codespaceName: undefined,
    failureCode: 'GitHub has reached your running Codespace limit.',
  };
  assert.equal(workspaceShouldAdoptPreferredRunner(base, 'orlynx-runner'), true);
  assert.equal(workspaceShouldAdoptPreferredRunner({ ...base, codespaceName: 'broken-ssh', failureCode: 'Codespace SSH did not become ready after 39 bootstrap attempts' }, 'orlynx-runner'), true);
  assert.equal(workspaceShouldAdoptPreferredRunner({ ...base, codespaceName: 'stale-space', failureCode: 'GitHub Codespaces request failed (HTTP 404)' }, 'orlynx-runner'), true);
  assert.equal(workspaceShouldAdoptPreferredRunner({ ...base, codespaceName: 'stopped-space', state: 'stopped', failureCode: undefined }, 'orlynx-runner'), true);
  assert.equal(workspaceShouldAdoptPreferredRunner({ ...base, codespaceName: 'half-ready', state: 'ready', bridgeState: 'disconnected', failureCode: undefined }, 'orlynx-runner'), true);
  assert.equal(workspaceShouldAdoptPreferredRunner({ ...base, codespaceName: 'healthy-space', state: 'ready', bridgeState: 'ready', failureCode: undefined }, 'orlynx-runner'), false);
  assert.equal(workspaceShouldAdoptPreferredRunner({ ...base, codespaceName: 'healthy-space', state: 'ready', bridgeState: 'ready', failureCode: undefined }, 'orlynx-runner', 'ready'), false);
  assert.equal(workspaceShouldAdoptPreferredRunner({ ...base, codespaceName: 'busy-agent', state: 'ready', bridgeState: 'ready', failureCode: undefined }, 'orlynx-runner', 'busy'), false);
  assert.equal(workspaceShouldAdoptPreferredRunner({ ...base, codespaceName: 'unstable-agent', state: 'ready', bridgeState: 'ready', failureCode: undefined }, 'orlynx-runner', 'unavailable'), true);
  assert.equal(workspaceShouldAdoptPreferredRunner({ ...base, codespaceName: 'failed-agent', state: 'ready', bridgeState: 'ready', failureCode: undefined }, 'orlynx-runner', 'failed'), true);
  assert.equal(workspaceShouldAdoptPreferredRunner({ ...base, codespaceName: 'busy-space', state: 'starting', failureCode: undefined }, 'orlynx-runner'), false);
  assert.equal(workspaceShouldAdoptPreferredRunner({ ...base, codespaceName: 'connecting-space', state: 'connecting', bridgeState: 'connecting', failureCode: undefined }, 'orlynx-runner'), false);
  assert.equal(workspaceShouldAdoptPreferredRunner({ ...base, codespaceName: 'stopping-space', state: 'stopping', failureCode: undefined }, 'orlynx-runner'), false);
  assert.equal(workspaceShouldAdoptPreferredRunner(base, 'github-codespaces'), false);
});

test('broken Codespace recovery escapes to the preferred warm runner before replacing another Codespace', () => {
  const workspaces = fs.readFileSync(new URL('../src/workspaces.ts', import.meta.url), 'utf8');
  const failover = workspaces.indexOf("stage: 'workspace.failover'");
  const replacement = workspaces.indexOf("stage: 'codespace.replace'", failover);
  assert.ok(failover >= 0, 'broken Codespace path must expose warm-runner failover');
  assert.ok(replacement > failover, 'warm-runner failover must be attempted before creating another Codespace');
  assert.match(workspaces, /defaultWorkspaceProviderId\(\) === 'orlynx-runner'/);
  assert.match(workspaces, /runnerRecoveryAttempted/);
});

test('workspace message admission adopts legacy runners before reconnect mutation', () => {
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
  const adopt = routes.indexOf('workspaceShouldAdoptPreferredRunner(workspace, undefined, workspaceAdapter?.state)');
  const refresh = routes.indexOf('workspaceNeedsRuntimeRefresh(workspace)', adopt);
  assert.ok(adopt >= 0, 'workspace admission must check legacy-provider adoption');
  assert.ok(refresh > adopt, 'legacy provider adoption must happen before runtime refresh/reconnect mutation');
  assert.match(routes, /getWorkspaceAgentAdapter\(workspace\.id, selectedAdapterId \|\| 'opencode'\)/);
  assert.match(routes, /repositoryId = workspace\?\.repositoryId/);
});

test('explicit runner selection fails closed when runner credentials are missing', () => {
  withEnv({
    ORLYNX_WORKSPACE_PROVIDER: 'orlynx-runner',
    ORLYNX_RUNNER_URL: null,
    ORLYNX_RUNNER_TOKEN: null,
  }, () => {
    assert.throws(() => defaultWorkspaceProviderId(), /not configured/);
  });
});

test('live bridge sends authenticated commands immediately and de-duplicates on one socket', () => {
  const sent = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send(value) { sent.push(JSON.parse(String(value))); },
  };
  registerBridgeSocket('ws_fast', socket);
  assert.equal(sendBridgeCommandNow('ws_fast', { id: 'cmd_1', kind: 'git.status', payload: {} }), false);

  authenticateBridgeSocket('ws_fast', socket);
  assert.equal(sendBridgeCommandNow('ws_fast', { id: 'cmd_1', kind: 'git.status', payload: {} }), true);
  assert.equal(sendBridgeCommandNow('ws_fast', { id: 'cmd_1', kind: 'git.status', payload: {} }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'COMMAND');
  assert.equal(sent[0].commandId, 'cmd_1');

  unregisterBridgeSocket('ws_fast', socket);
});

test('bridge RPC waiters are resolved by live results', async () => {
  const waiter = waitForLiveBridgeResult('cmd_live_result');
  publishLiveBridgeResult('cmd_live_result', { ok: true, result: { value: 42 } });
  const result = await waiter.promise;
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { value: 42 });
  waiter.cancel();
});


test('workspace orchestration is durable, leased and recoverable', () => {
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');
  const jobs = fs.readFileSync(new URL('../src/workspace-jobs.ts', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');

  assert.match(storage, /CREATE TABLE IF NOT EXISTS workspace_jobs/);
  assert.match(storage, /FOR UPDATE SKIP LOCKED/);
  assert.match(storage, /lease_until=now\(\) \+ \(\$3 \* interval '1 second'\)/);
  assert.match(jobs, /renewWorkspaceJobLease/);
  assert.match(jobs, /runWorkspaceOrchestratorLoop/);
  assert.match(jobs, /ORLYNX_ORCHESTRATOR_MODE === 'worker'/);
  assert.match(routes, /scheduleWorkspacePreparation/);
  assert.doesNotMatch(routes, /void prepareWorkspace\(/);
});

test('Build work can escalate a passive prewarm job to Codespaces fallback', () => {
  const storage = fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');
  const jobs = fs.readFileSync(new URL('../src/workspace-jobs.ts', import.meta.url), 'utf8');
  assert.match(storage, /SET allow_fallback=true/);
  assert.match(jobs, /allowFallback: options\.allowFallback !== false/);
  assert.match(jobs, /reason: options\.reason/);
});


test('warm runner preview URLs are signed, short-lived and browser-safe', () => {
  withEnv({
    ORLYNX_RUNNER_URL: 'https://runner.internal.example',
    ORLYNX_RUNNER_PUBLIC_URL: 'https://preview.example.com',
    ORLYNX_RUNNER_TOKEN: 'runner-secret-that-must-not-leak',
    ORLYNX_PREVIEW_TOKEN_TTL_SECONDS: '300',
  }, () => {
    const provider = new OrlynxRunnerProvider();
    const url = provider.previewUrl({
      id: 'ws_preview',
      sessionId: 'session_preview',
      userId: 'user_preview',
      projectId: 'project_preview',
      provider: 'orlynx-runner',
      runnerId: 'orlynx-ws-preview',
      repositoryId: 123,
      branch: 'main',
      state: 'ready',
      bridgeState: 'ready',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, 5173);
    assert.ok(url);
    assert.match(url, /^https:\/\/preview\.example\.com\/preview\/orlynx-ws-preview\/5173\/\?t=\d+\.[A-Za-z0-9_-]+$/);
    assert.equal(url.includes('runner-secret-that-must-not-leak'), false);
  });
});

test('runner preview gateway supports HTTP, cookies and WebSocket/HMR forwarding', () => {
  const manager = fs.readFileSync(new URL('../../../runner-manager/index.mjs', import.meta.url), 'utf8');
  const internal = fs.readFileSync(new URL('../../../runner-runtime/preview-proxy.mjs', import.meta.url), 'utf8');
  assert.match(manager, /validPreviewToken/);
  assert.match(manager, /HttpOnly; Secure; SameSite=Lax/);
  assert.match(manager, /server\.on\('upgrade'/);
  assert.match(manager, /PREVIEW_PROXY_PORT/);
  assert.match(internal, /127\.0\.0\.1/);
  assert.match(internal, /server\.on\('upgrade'/);
  assert.match(internal, /BLOCKED = new Set\(\[4096, PORT\]\)/);
});


test('production start separates API and orchestrator processes', () => {
  const supervisor = fs.readFileSync(new URL('../scripts/production-start.mjs', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.start, 'node scripts/production-start.mjs');
  assert.equal(pkg.scripts['start:api'], 'node dist/index.js');
  assert.match(supervisor, /launch\('api', \['dist\/index\.js'\]\)/);
  assert.match(supervisor, /launch\('orchestrator', \['dist\/orchestrator-worker\.js'\]\)/);
  assert.match(supervisor, /ORLYNX_ORCHESTRATOR_MODE: 'worker'/);
  assert.match(supervisor, /DATABASE_URL \|\| process\.env\.POSTGRES_URL/);
});

test('legacy runtime worker image uses Node 24', () => {
  const dockerfile = fs.readFileSync(new URL('../../../runtime-worker/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^FROM node:24-bookworm-slim/m);
  assert.doesNotMatch(dockerfile, /^FROM node:20-/m);
});


test('Render direct runner provides a single isolated workspace without nested Docker', () => {
  const source = fs.readFileSync(new URL('../../../runner-direct/index.mjs', import.meta.url), 'utf8');
  assert.match(source, /service: 'orlynx-direct-runner'/);
  assert.match(source, /capacity: 1/);
  assert.match(source, /current\.state === 'stopped'/);
  assert.match(source, /reassigning stopped workspace/);
  assert.match(source, /current\.state === 'running' && idle >= IDLE_SECONDS/);
  assert.doesNotMatch(source, /current\.state !== 'stopped' \|\| idle < RECLAIM_SECONDS/);
  assert.match(source, /git', \['clone', '--filter=blob:none'/);
  assert.match(source, /GIT_CONFIG_KEY_0: 'http\.https:\/\/github\.com\/\.extraheader'/);
  assert.match(source, /spawn\(process\.execPath, \[BRIDGE_PATH\]/);
  assert.match(source, /OPENCODE_BIN/);
  assert.match(source, /validPreviewToken/);
  assert.match(source, /server\.on\('upgrade'/);
  assert.match(source, /function touchActivity\(force = false\)/);
  assert.match(source, /function proxyPreview\(req, res, context\) \{\s*touchActivity\(\)/);
  assert.match(source, /socket\.on\('data', \(\) => touchActivity\(\)\)/);
  assert.match(source, /upstreamSocket\.on\('data', \(\) => touchActivity\(\)\)/);
  assert.doesNotMatch(source, /spawn\('docker'/);
});

test('managed runner preview traffic also refreshes workspace activity', () => {
  const manager = fs.readFileSync(new URL('../../../runner-manager/index.mjs', import.meta.url), 'utf8');
  assert.match(manager, /async function touchManagedActivity\(name, force = false\)/);
  assert.match(manager, /async function proxyPreview\(req, res, context\) \{\s*await touchManagedActivity\(context\.name\)/);
  assert.match(manager, /const previewLease = setInterval\(\(\) => \{ void touchManagedActivity\(preview\.name\)/);
  assert.match(manager, /socket\.once\('close', clearPreviewLease\)/);
});

test('bridge lease heartbeat covers long commands as well as agents and terminals', () => {
  const bridge = fs.readFileSync(new URL('../../../bridge/src/index.ts', import.meta.url), 'utf8');
  assert.match(bridge, /inFlight\.size > 0 \|\| activeAgents\.size > 0 \|\| terminals\.size > 0/);
  assert.match(bridge, /if \(inFlight\.size > 0 \|\| activeAgents\.size > 0 \|\| terminals\.size > 0\) touchActivity\(\)/);
});
