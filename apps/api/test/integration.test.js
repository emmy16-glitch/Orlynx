import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.ORLYNX_API || 'http://localhost:4000';

async function health() {
  try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; }
}

describe('fail-closed production integrations (API must be running)', async () => {
  if (!await health()) {
    console.log('  (API integration checks skipped — API is not running)');
    return;
  }

  it('reports integration readiness without disclosing credentials', async () => {
    const status = await (await fetch(`${BASE}/v1/integrations/status`)).json();
    assert.equal(typeof status.github.configured, 'boolean');
    assert.equal(typeof status.github.connected, 'boolean');
    assert.equal(typeof status.agent.configured, 'boolean');
    assert.equal(typeof status.agent.connected, 'boolean');
    assert.equal(status.cloud.configured, false);
    assert.equal(JSON.stringify(status).includes('PRIVATE KEY'), false);
    assert.equal(Object.hasOwn(status.github, 'token'), false);
  });

  it('does not create synthetic local repositories or demo sessions', async () => {
    const response = await fetch(`${BASE}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'not-imported', owner: 'local', branch: 'main' }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /imported GitHub repository/i);
  });

  it('does not create conversation messages for an unknown project session', async () => {
    const response = await fetch(`${BASE}/v1/sessions/not-a-session/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'run tests', clientId: 'unavailable-agent' }) });
    assert.equal(response.status, 404);
  });

  it('does not report cloud readiness when the remote execution bridge is absent', async () => {
    const response = await fetch(`${BASE}/v1/sessions/not-a-session/cloud`, { method: 'POST' });
    assert.equal(response.status, 404);
  });
});
