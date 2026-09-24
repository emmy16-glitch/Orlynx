// Live E2E uses an authenticated Orlynx session, an authorized GitHub repository,
// and a real AI runtime. It never creates fixtures or writes a remote commit.
const BASE = process.env.ORLYNX_API || 'http://localhost:4000';
const SESSION_COOKIE = process.env.ORLYNX_SESSION_COOKIE;
const authHeaders = SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : {};
function request(path, init = {}) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...authHeaders, ...(init.headers || {}) },
  });
}
async function json(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error || 'request failed'}`);
  return body;
}
async function main() {
  if (!SESSION_COOKIE) {
    console.error('E2E BLOCKED: set ORLYNX_SESSION_COOKIE to an authenticated Orlynx session cookie.');
    process.exitCode = 2;
    return;
  }
  const readiness = await json(await request('/v1/integrations/status'));
  if (!readiness.github.connected || !readiness.ai.available) {
    console.error('E2E BLOCKED: connect GitHub and AI before running the live integration check.');
    process.exitCode = 2;
    return;
  }
  const listing = await json(await request('/v1/repos'));
  const repo = listing.github?.[0];
  if (!repo) {
    console.error('E2E BLOCKED: install the GitHub App on at least one repository before running live integration checks.');
    process.exitCode = 2;
    return;
  }
  const branch = repo.defaultBranch;
  console.log(`[e2e] clone authorized repository ${repo.full}@${branch}`);
  await json(await request('/v1/repos/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: repo.full, branch }) }));
  const session = await json(await request('/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: repo.full, owner: repo.owner, branch, permission: 'read-only' }) }));
  console.log(`  session ${session.id}`);

  console.log('[e2e] send a read-only request to Orlynx AI');
  const sent = await json(await request(`/v1/sessions/${session.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Summarize the top-level structure of this repository. Do not edit files, commit, or push.', clientId: `e2e-${Date.now()}` }) }));
  const deadline = Date.now() + Number(process.env.ORLYNX_E2E_TIMEOUT_MS || 10 * 60_000);
  let run = sent.run;
  while (run?.state === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const runs = await json(await request(`/v1/sessions/${session.id}/runs`));
    run = runs.find((item) => item.id === run.id) || run;
  }
  if (!run || run.state !== 'completed') throw new Error(`AI run did not complete (${run?.state || 'missing'}).`);
  const messages = await json(await request(`/v1/sessions/${session.id}/messages`));
  if (!messages.some((message) => message.role === 'assistant' && message.text)) throw new Error('AI returned no assistant message.');
  console.log(`  AI run ${run.id} completed; assistant response persisted.`);

  console.log('[e2e] verify ordered event replay');
  const response = await request(`/v1/sessions/${session.id}/events?after=0`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const timeout = Date.now() + 5000;
  while (Date.now() < timeout && (buffer.match(/^id: /gm) || []).length < 5) {
    const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  const sequences = [...buffer.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  if (sequences.length < 3 || sequences.some((value, index) => index && value < sequences[index - 1])) throw new Error('SSE event replay was missing or out of order.');
  console.log('\nLIVE E2E PASSED (read-only GitHub import + Orlynx AI + SSE).');
}
main().catch((error) => { console.error('LIVE E2E FAILED:', error.message); process.exitCode = 1; });
