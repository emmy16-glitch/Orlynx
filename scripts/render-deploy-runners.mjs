// CI runner-fleet deploy: after CI passes on main, trigger one Render deploy
// per active runner service pinned to the validated commit, then poll until
// each deploy reaches a terminal state. Secrets come only from the environment
// (GitHub Actions secrets in CI) and are never printed.
//
// Required env:
//   RENDER_API_KEY            Render API key (Account Settings -> API Keys)
//   RENDER_RUNNER_SERVICE_IDS comma/space-separated Render service IDs (srv_...)
//   RENDER_DEPLOY_COMMIT      exact full commit SHA validated by CI
// Optional env:
//   RENDER_DEPLOY_POLL_MS     poll interval (default 15000)
//   RENDER_DEPLOY_TIMEOUT_MS  per-service deadline (default 600000)

const API = 'https://api.render.com/v1';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    console.error(`missing required env ${name}`);
    process.exit(2);
  }
  return value;
}

function redact(url) {
  return String(url).replace(/\/srv_[A-Za-z0-9]+/g, '/srv_<id>');
}

async function authed(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
  }).catch((error) => {
    throw new Error(`Render API request to ${redact(path)} failed: ${error.message}`);
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('Render API key is invalid or lacks access (HTTP ' + response.status + ').');
  }
  return response;
}

async function triggerDeploy(serviceId, commitId) {
  const response = await authed(`/services/${encodeURIComponent(serviceId)}/deploys`, {
    method: 'POST',
    body: JSON.stringify({ commitId }),
  });
  if (response.status === 404) {
    throw new Error('Render service no longer exists (HTTP 404). Retire it from the pool instead of retrying.');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Render deploy trigger failed (HTTP ${response.status}): ${body.slice(0, 200)}`);
  }
  const body = await response.json();
  const deploy = body.deploy || body;
  if (!deploy || !deploy.id) throw new Error('Render did not return a deploy id.');
  return deploy;
}

async function deployStatus(serviceId, deployId) {
  const response = await authed(`/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`);
  if (!response.ok) throw new Error(`Deploy status check failed (HTTP ${response.status}).`);
  const body = await response.json();
  return body.deploy || body;
}

function terminal(status) {
  const s = String(status || '').toLowerCase();
  return ['live', 'deactivated', 'build_failed', 'failed', 'canceled', 'cancelled'].includes(s);
}

function failed(status) {
  const s = String(status || '').toLowerCase();
  return ['build_failed', 'failed', 'canceled', 'cancelled'].includes(s);
}

async function waitForLive(serviceId, deployId, commitId, label) {
  const pollMs = Math.max(5000, Number(process.env.RENDER_DEPLOY_POLL_MS || 15000));
  const deadline = Date.now() + Math.max(60000, Number(process.env.RENDER_DEPLOY_TIMEOUT_MS || 600000));
  for (;;) {
    const current = await deployStatus(serviceId, deployId);
    const status = String(current.status || 'unknown');
    const gotCommit = current.commit && current.commit.id ? String(current.commit.id) : null;
    console.log(`${label}: deploy ${deployId} status=${status}${gotCommit ? ` commit=${gotCommit.slice(0, 12)}` : ''}`);
    if (gotCommit && !gotCommit.toLowerCase().startsWith(commitId.slice(0, 7).toLowerCase()) && !commitId.toLowerCase().startsWith(gotCommit.slice(0, 7).toLowerCase())) {
      throw new Error(`${label}: deploy references unexpected commit (drift).`);
    }
    if (terminal(status)) {
      if (!String(status).toLowerCase().includes('live') && status.toLowerCase() !== 'live') {
        if (failed(status)) throw new Error(`${label}: deploy ${deployId} ended ${status}.`);
      }
      return { deployId, status, commit: gotCommit };
    }
    if (Date.now() >= deadline) throw new Error(`${label}: deploy ${deployId} did not finish before the deadline (last status=${status}).`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

const serviceIds = required('RENDER_RUNNER_SERVICE_IDS').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
const commitId = required('RENDER_DEPLOY_COMMIT');
required('RENDER_API_KEY');
if (!/^[0-9a-f]{40}$/i.test(commitId)) {
  console.error('RENDER_DEPLOY_COMMIT must be the full 40-hex validated main SHA.');
  process.exit(2);
}

const results = [];
let failedCount = 0;
// Rolling deploy: one service at a time so the pool keeps serving.
for (const [index, serviceId] of serviceIds.entries()) {
  const label = `runner ${index + 1}/${serviceIds.length}`;
  try {
    console.log(`${label}: triggering deploy of ${commitId.slice(0, 12)}`);
    const deploy = await triggerDeploy(serviceId, commitId);
    console.log(`${label}: triggered ${deploy.id}`);
    const done = await waitForLive(serviceId, deploy.id, commitId, label);
    results.push({ service: `runner-${index + 1}`, deployId: done.deployId, status: done.status, commit: (done.commit || commitId).slice(0, 12) });
  } catch (error) {
    failedCount += 1;
    console.error(`${label}: FAILED: ${error instanceof Error ? error.message : error}`);
    results.push({ service: `runner-${index + 1}`, error: error instanceof Error ? error.message : String(error) });
  }
}
console.log(JSON.stringify({ commit: commitId.slice(0, 12), results }, null, 2));
if (failedCount) {
  console.error(`${failedCount}/${serviceIds.length} runner deploys failed.`);
  process.exit(1);
}
console.log(`All ${serviceIds.length} runner deploys live at ${commitId.slice(0, 12)}.`);
