// Destructive live E2E, isolated to an orlynx-e2e/* branch. Production auth is
// unchanged: CI supplies Playwright-compatible storage state or a dedicated
// authenticated cookie secret obtained through the normal GitHub OAuth flow.
import fs from 'node:fs';

const BASE = process.env.ORLYNX_API || 'http://localhost:4000';
function sessionCookie() {
  if (process.env.ORLYNX_E2E_STORAGE_STATE) {
    const state = JSON.parse(fs.readFileSync(process.env.ORLYNX_E2E_STORAGE_STATE, 'utf8'));
    const cookie = state.cookies?.find((item) => item.name === 'orlynx_session' && BASE.startsWith(`${item.secure ? 'https' : 'http'}://`));
    if (cookie) return `${cookie.name}=${cookie.value}`;
  }
  return process.env.ORLYNX_SESSION_COOKIE || '';
}
const COOKIE = sessionCookie();
function request(path, init = {}) { return fetch(`${BASE}${path}`, { ...init, headers: { ...(COOKIE ? { Cookie: COOKIE } : {}), ...(init.headers || {}) } }); }
async function json(response) { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error || 'request failed'}${body.diagnostic ? ` (${body.diagnostic})` : ''}`); return body; }
const post = (path, body) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!COOKIE) { console.error('E2E BLOCKED: provide ORLYNX_E2E_STORAGE_STATE (recommended) or the dedicated CI ORLYNX_SESSION_COOKIE secret.'); process.exitCode = 2; return; }
  const status = await json(await request('/v1/integrations/status'));
  if (!status.github.connected || !status.workspace.cloudAvailable) { console.error('E2E BLOCKED: GitHub user authorization and the real workspace infrastructure must be connected.'); process.exitCode = 2; return; }
  const listing = await json(await request('/v1/repos'));
  const wanted = process.env.ORLYNX_E2E_REPOSITORY;
  const repo = listing.github?.find((item) => !wanted || item.full === wanted);
  if (!repo) { console.error('E2E BLOCKED: ORLYNX_E2E_REPOSITORY is not authorized for the test account.'); process.exitCode = 2; return; }

  await json(await post('/v1/repos/import', { repository: repo.full, branch: repo.defaultBranch }));
  const session = await json(await post('/v1/sessions', { project: repo.full, owner: repo.owner, branch: repo.defaultBranch }));
  console.log(`[e2e] session ${session.id}; starting real Codespace`);
  await json(await post(`/v1/sessions/${session.id}/cloud`));
  const deadline = Date.now() + Number(process.env.ORLYNX_E2E_TIMEOUT_MS || 20 * 60_000);
  let details;
  while (Date.now() < deadline) {
    details = await json(await request(`/v1/sessions/${session.id}`));
    if (details.workspace?.state === 'ready') break;
    if (details.workspace?.state === 'failed') throw new Error(`Workspace failed: ${details.workspace.failureCode || 'unknown'}`);
    await wait(3_000);
  }
  if (details?.workspace?.state !== 'ready') throw new Error('Workspace did not become ready.');

  const branch = `orlynx-e2e/${Date.now()}`;
  await json(await post(`/v1/sessions/${session.id}/git/e2e-branch`, { branch }));
  const ready = await json(await request(`/v1/integrations/status?sessionId=${encodeURIComponent(session.id)}`));
  if (!ready.ai.available || !ready.workspace.terminalAvailable) throw new Error('AI or the real workspace terminal did not become ready.');

  const filename = `orlynx-e2e-${Date.now()}.txt`;
  const sent = await json(await post(`/v1/sessions/${session.id}/messages`, { text: `Create ${filename} containing exactly: Orlynx real execution plane verified. Do not modify any other file.`, clientId: `e2e-${Date.now()}`, fullAccessForThisTask: true }));
  let run = sent.run;
  while (run?.state === 'running' && Date.now() < deadline) { await wait(2_000); const runs = await json(await request(`/v1/sessions/${session.id}/runs`)); run = runs.find((item) => item.id === run.id) || run; }
  if (run?.state !== 'completed') throw new Error(`AI run did not complete (${run?.state || 'missing'}).`);

  const testCommand = process.env.ORLYNX_E2E_TEST_COMMAND || 'npm test';
  const tested = await json(await post(`/v1/sessions/${session.id}/exec`, { cmd: testCommand, approved: true }));
  if (Number(tested.code) !== 0) throw new Error(`Test command failed: ${tested.stderr || tested.stdout || tested.out || 'no output'}`);
  const diff = await json(await request(`/v1/sessions/${session.id}/git/diff`));
  if (!String(diff.diff || '').includes(filename)) throw new Error('The real Git diff did not include the E2E file.');

  const changes = await json(await request(`/v1/sessions/${session.id}/changes`));
  const change = changes.find((item) => item.reviewState === 'pending' && item.files?.some((file) => file.path === filename));
  if (!change) throw new Error('No reviewable change set was persisted.');
  await json(await post(`/v1/changes/${change.id}/approve`));
  await json(await post(`/v1/changes/${change.id}/commit`, { message: `test: verify Orlynx execution plane ${Date.now()}` }));
  await json(await post(`/v1/changes/${change.id}/push`));

  const messages = await json(await request(`/v1/sessions/${session.id}/messages`));
  if (!messages.some((message) => message.role === 'assistant' && message.text)) throw new Error('Assistant response was not durable.');
  const replay = await request(`/v1/sessions/${session.id}/events?after=0`); const reader = replay.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while ((buffer.match(/^id: /gm) || []).length < 5) { const result = await reader.read(); if (result.done) break; buffer += decoder.decode(result.value, { stream: true }); }
  await reader.cancel(); const sequences = [...buffer.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  if (new Set(sequences).size !== sequences.length || sequences.some((value, index) => index && value <= sequences[index - 1])) throw new Error('Durable event replay contained duplicates or was out of order.');
  console.log(`LIVE E2E PASSED: ${repo.full} → Codespace → bridge → OpenCode → tests → ${branch}`);
}
main().catch((error) => { console.error('LIVE E2E FAILED:', error.message); process.exitCode = 1; });
