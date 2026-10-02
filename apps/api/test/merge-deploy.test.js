// Merge + deploy-verification tests. GitHub and Render are mocked at the
// fetch boundary; no live credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mergeIntentFor, deployIntentFor } from '../src/direct-chat.ts';

// The GitHub App gateway reads env lazily, so test credentials can be
// installed here; all network traffic is mocked at the fetch boundary.
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const testPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.GITHUB_APP_ID = '12345';
process.env.GITHUB_APP_SLUG = 'orlynx-test';
process.env.GITHUB_CLIENT_ID = 'test-client-id';
process.env.GITHUB_APP_CLIENT_SECRET = 'test-client-secret';
process.env.GITHUB_APP_PRIVATE_KEY = testPem;
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.ORLYNX_PUBLIC_URL = 'https://orlynx.test';
import { computeBrokerSnapshot, noteComputeFailure, resetComputeBrokerForTests, computeTargetQuarantined } from '../src/compute-broker.ts';
import { store } from '../src/store.js';

const INSTALLATION_ID = 424242;
const realFetch = globalThis.fetch;

function installGitHub() {
  if (!store.db.githubInstallations.some((item) => item.id === INSTALLATION_ID)) {
    store.db.githubInstallations.push({
      id: INSTALLATION_ID, account: 'acme', accountType: 'User',
      installedAt: new Date().toISOString(), status: 'active',
    });
  }
}

function mockFetch(handler) {
  globalThis.fetch = async (url, init) => handler(String(url), init || {});
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function githubOk({ prState = {}, repoInfo = {}, mergeResult = null, mergeStatus = 200 } = {}) {
  return async (url, init) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (url.includes('/access_tokens')) {
      return jsonResponse(201, { token: 'test-token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: 'write', pull_requests: 'write' } });
    }
    if (url.includes('/installation/repositories')) {
      return jsonResponse(200, {
        total_count: 1,
        repositories: [{ id: 99, full_name: 'acme/demo', name: 'demo', owner: { login: 'acme', type: 'User' }, private: false, default_branch: 'main', language: 'TypeScript', updated_at: new Date().toISOString(), html_url: 'https://github.com/acme/demo' }],
      });
    }
    if (method === 'PUT' && url.includes('/merge')) {
      if (mergeStatus !== 200) return jsonResponse(mergeStatus, { message: 'refused' });
      return jsonResponse(200, mergeResult || { merged: true, sha: 'abc123def456' });
    }
    if (url.match(/\/pulls\/\d+$/)) {
      return jsonResponse(200, {
        number: 7, html_url: 'https://github.com/acme/demo/pull/7', state: 'open', merged: false,
        merge_commit_sha: null, mergeable_state: 'clean', mergeable: true,
        head: { sha: 'deadbeef', ref: 'orlynx/publish-x' }, base: { ref: 'main' },
        ...prState,
      });
    }
    if (url.match(/\/repos\/acme\/demo$/)) {
      return jsonResponse(200, { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true, ...repoInfo });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
}

test('merge and deploy intent phrasing is recognized', () => {
  assert.equal(mergeIntentFor('merge it'), true);
  assert.equal(mergeIntentFor('merge this'), true);
  assert.equal(mergeIntentFor('finish and merge'), true);
  assert.equal(mergeIntentFor("don't merge yet"), false);
  assert.equal(mergeIntentFor('Implement the merge sort fix'), false);
  assert.equal(deployIntentFor('deploy it'), true);
  assert.equal(deployIntentFor('finish and deploy'), true);
  assert.equal(deployIntentFor('push to main'), false);
});

test('control-plane merge succeeds and records the merge commit', async () => {
  installGitHub();
  mockFetch(githubOk());
  try {
    const { mergeGitHubPullRequest } = await import('../src/github.ts');
    const result = await mergeGitHubPullRequest('acme/demo', 7, { installationId: INSTALLATION_ID });
    assert.equal(result.merged, true);
    assert.equal(result.sha, 'abc123def456');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('merge is idempotent when the PR is already merged', async () => {
  installGitHub();
  mockFetch(githubOk({ prState: { merged: true, state: 'closed', merge_commit_sha: 'abc123def456' } }));
  try {
    const { mergeGitHubPullRequest } = await import('../src/github.ts');
    const result = await mergeGitHubPullRequest('acme/demo', 7, { installationId: INSTALLATION_ID });
    assert.equal(result.merged, true);
    assert.equal(result.alreadyMerged, true);
    assert.equal(result.sha, 'abc123def456');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('merge refuses safely on conflicts, blocks, and policy mismatch', async () => {
  installGitHub();
  const { mergeGitHubPullRequest } = await import('../src/github.ts');
  mockFetch(githubOk({ prState: { mergeable_state: 'dirty' } }));
  await assert.rejects(() => mergeGitHubPullRequest('acme/demo', 7, { installationId: INSTALLATION_ID }), /conflict/i);
  mockFetch(githubOk({ prState: { mergeable_state: 'blocked' } }));
  await assert.rejects(() => mergeGitHubPullRequest('acme/demo', 7, { installationId: INSTALLATION_ID }), /approval|required checks/i);
  mockFetch(githubOk({ repoInfo: { allow_squash_merge: false } }));
  await assert.rejects(() => mergeGitHubPullRequest('acme/demo', 7, { method: 'squash', installationId: INSTALLATION_ID }), /policy/i);
  globalThis.fetch = realFetch;
});

test('merge reports pending checks instead of claiming completion', async () => {
  installGitHub();
  mockFetch(githubOk({ prState: { mergeable_state: 'behind' } }));
  try {
    const { mergeGitHubPullRequest } = await import('../src/github.ts');
    const result = await mergeGitHubPullRequest('acme/demo', 7, { installationId: INSTALLATION_ID });
    assert.equal(result.merged, false);
    assert.equal(result.checksPending, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('merge surfaces approval failures from GitHub as approval errors', async () => {
  installGitHub();
  mockFetch(githubOk({ mergeStatus: 403 }));
  try {
    const { mergeGitHubPullRequest } = await import('../src/github.ts');
    await assert.rejects(() => mergeGitHubPullRequest('acme/demo', 7, { installationId: INSTALLATION_ID }), /approval|checks/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('merge never touches the workspace and stays control-plane-only', async () => {
  const fs = await import('node:fs');
  const publisher = fs.readFileSync(new URL('../src/publisher.ts', import.meta.url), 'utf8');
  assert.match(publisher, /mergePublishedPullRequest/);
  assert.match(publisher, /mergeGitHubPullRequest/);
  assert.doesNotMatch(publisher, /x-access-token|GIT_CONFIG_VALUE/);
});

test('one runtime outage is recorded once across readiness wait and failover', async () => {
  // Regression: waitForRuntimeReady recorded the failure and then
  // failoverDirectTaskToWorkspace recorded the identical error again,
  // doubling consecutiveFailures and the quarantine duration.
  const fs = await import('node:fs');
  const runtime = fs.readFileSync(new URL('../src/opencode-local.ts', import.meta.url), 'utf8');
  assert.match(runtime, /brokerRecorded/);
  const agents = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  assert.match(agents, /brokerRecorded/);
  assert.match(agents, /if\s*\(\s*!options\.brokerRecorded\s*\)\s*noteComputeFailure/);
  resetComputeBrokerForTests();
  // Untagged repeat failures still accumulate (distinct events).
  noteComputeFailure('direct-runtime', 'outage one');
  assert.equal(computeTargetQuarantined('direct-runtime'), true);
  resetComputeBrokerForTests();
});

test('distinct failures still accumulate', () => {
  resetComputeBrokerForTests();
  noteComputeFailure('e2b', 'first outage');
  noteComputeFailure('e2b', 'second outage');
  const row = computeBrokerSnapshot().find((item) => item.id === 'e2b');
  assert.equal(row.consecutiveFailures, 2);
  resetComputeBrokerForTests();
});

test('render deploy status is unknown without configuration, never faked', async () => {
  delete process.env.RENDER_API_KEY;
  delete process.env.RENDER_SERVICE_ID;
  const { renderDeployStatus } = await import('../src/render.ts');
  const result = await renderDeployStatus('abc1234');
  assert.equal(result.configured, false);
  assert.match(result.message, /not configured/i);
});

test('render deploy status reflects live, failed, and drift states', async () => {
  process.env.RENDER_API_KEY = 'test-key';
  process.env.RENDER_SERVICE_ID = 'srv_test';
  const { renderDeployStatus } = await import('../src/render.ts');
  const deploy = (status, sha) => async (url) => {
    assert.match(String(url), /api\.render\.com/);
    return jsonResponse(200, [{ deploy: { id: 'dep_1', status, commit: { id: sha }, finishedAt: '2026-10-02T00:00:00Z' } }]);
  };
  mockFetch(deploy('live', 'abc1234def'));
  assert.equal((await renderDeployStatus('abc1234def')).live, true);
  mockFetch(deploy('build_failed', 'abc1234def'));
  assert.equal((await renderDeployStatus('abc1234def')).failed, true);
  mockFetch(deploy('live', '9999999fff'));
  const drift = await renderDeployStatus('abc1234def');
  assert.equal(drift.live, true);
  assert.equal(drift.commitMatches, false);
  globalThis.fetch = realFetch;
  delete process.env.RENDER_API_KEY;
  delete process.env.RENDER_SERVICE_ID;
});

test('deploy verification selects the expected commit from recent Render deploys', async () => {
  process.env.RENDER_API_KEY = 'test-key';
  process.env.RENDER_SERVICE_ID = 'srv_test';
  delete process.env.RENDER_SERVICE_IDS;
  const { renderDeployStatus } = await import('../src/render.ts');
  mockFetch(async () => jsonResponse(200, [
    { deploy: { id: 'dep_newer', status: 'live', commit: { id: '9999999fff' } } },
    { deploy: { id: 'dep_expected', status: 'build_in_progress', commit: { id: 'abc1234def' } } },
  ]));
  const result = await renderDeployStatus('abc1234def');
  assert.equal(result.deployId, 'dep_expected');
  assert.equal(result.commitMatches, true);
  assert.equal(result.live, false);
  assert.equal(result.status, 'build_in_progress');
  globalThis.fetch = realFetch;
  delete process.env.RENDER_API_KEY;
  delete process.env.RENDER_SERVICE_ID;
});

test('deploy verification proves the whole configured Render fleet', async () => {
  process.env.RENDER_API_KEY = 'test-key';
  process.env.RENDER_SERVICE_ID = 'srv_api';
  process.env.RENDER_SERVICE_IDS = 'srv_runtime,srv_runner2';
  const { renderDeployStatus } = await import('../src/render.ts');
  mockFetch(async (url) => {
    const match = String(url).match(/services\/([^/]+)\/deploys/);
    assert.ok(match);
    const serviceId = decodeURIComponent(match[1]);
    return jsonResponse(200, [{ deploy: { id: `dep_${serviceId}`, status: 'live', commit: { id: 'abc1234def' } } }]);
  });
  const result = await renderDeployStatus('abc1234def');
  assert.equal(result.live, true);
  assert.equal(result.commitMatches, true);
  assert.equal(result.services?.length, 3);
  assert.match(result.message, /All 3 Render services are live/);
  globalThis.fetch = realFetch;
  delete process.env.RENDER_API_KEY;
  delete process.env.RENDER_SERVICE_ID;
  delete process.env.RENDER_SERVICE_IDS;
});

test('stale runner builds are marked degraded, never healthy', async () => {
  const { probeRunnerHost } = await import('../src/runner-pool.ts');
  process.env.RENDER_GIT_COMMIT = 'expected123';
  process.env.ORLYNX_RUNNER_TOKEN = 'test-runner-token';
  const health = (buildCommit) => async () => jsonResponse(200, {
    ok: true, capacity: 1, running: 0, available: 1, draining: false,
    protocolVersion: 1, buildCommit, capabilities: {},
  });
  mockFetch(health('stale999'));
  const staleHost = { id: 'test-stale-host', url: 'https://runner-stale.test', publicUrl: 'https://runner-stale.test', weight: 1 };
  const stale = await probeRunnerHost(staleHost, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.ok, false);
  assert.match(stale.detail || '', /stale build/);
  mockFetch(health('expected123'));
  const freshHost = { id: 'test-fresh-host', url: 'https://runner-fresh.test', publicUrl: 'https://runner-fresh.test', weight: 1 };
  const fresh = await probeRunnerHost(freshHost, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.buildCommit, 'expected123');
  globalThis.fetch = realFetch;
  delete process.env.RENDER_GIT_COMMIT;
  delete process.env.ORLYNX_RUNNER_TOKEN;
});
