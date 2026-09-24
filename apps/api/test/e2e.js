// Live E2E uses an installed GitHub App repo and a real OpenCode server. It never creates demo projects or writes a remote commit.
const BASE = process.env.ORLYNX_API || 'http://localhost:4000';
async function json(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error || 'request failed'}`);
  return body;
}
async function main() {
  const readiness = await json(await fetch(`${BASE}/v1/integrations/status`));
  if (!readiness.github.connected || !readiness.agent.connected) {
    console.error('E2E BLOCKED: configure a GitHub App installation and authenticated OpenCode server. No local/demo fallback is run.');
    process.exitCode = 2;
    return;
  }
  const listing = await json(await fetch(`${BASE}/v1/repos`));
  const repo = listing.github?.[0];
  if (!repo) {
    console.error('E2E BLOCKED: install the GitHub App on at least one repository before running live integration checks.');
    process.exitCode = 2;
    return;
  }
  const branch = repo.defaultBranch;
  console.log(`[e2e] clone authorized repository ${repo.full}@${branch}`);
  await json(await fetch(`${BASE}/v1/repos/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: repo.full, branch }) }));
  const session = await json(await fetch(`${BASE}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: repo.full, owner: repo.owner, branch }) }));
  console.log(`  session ${session.id}`);

  console.log('[e2e] send a read-only request to the configured OpenCode agent');
  const sent = await json(await fetch(`${BASE}/v1/sessions/${session.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Summarize the top-level structure of this repository. Do not edit files, commit, or push.', clientId: `e2e-${Date.now()}` }) }));
  const deadline = Date.now() + Number(process.env.ORLYNX_E2E_TIMEOUT_MS || 10 * 60_000);
  let run = sent.run;
  while (run?.state === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const runs = await json(await fetch(`${BASE}/v1/sessions/${session.id}/runs`));
    run = runs.find((item) => item.id === run.id) || run;
  }
  if (!run || run.state !== 'completed') throw new Error(`OpenCode run did not complete (${run?.state || 'missing'}).`);
  const messages = await json(await fetch(`${BASE}/v1/sessions/${session.id}/messages`));
  if (!messages.some((message) => message.role === 'assistant' && message.text)) throw new Error('OpenCode returned no assistant message.');
  console.log(`  OpenCode run ${run.id} completed; assistant response persisted.`);

  console.log('[e2e] verify ordered event replay');
  const response = await fetch(`${BASE}/v1/sessions/${session.id}/events?after=0`);
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
  console.log('\nLIVE E2E PASSED (read-only GitHub import + OpenCode + SSE).');
}
main().catch((error) => { console.error('LIVE E2E FAILED:', error.message); process.exitCode = 1; });
