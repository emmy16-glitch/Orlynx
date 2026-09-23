import { describe, it } from 'node:test';
import assert from 'node:assert';

const BASE = process.env.ORLYNX_API || 'http://localhost:4000';

async function health() {
  try {
    const r = await fetch(`${BASE}/health`);
    return r.ok;
  } catch { return false; }
}

describe('orlynx integration (requires api on :4000)', async () => {
  const up = await health();
  if (!up) {
    console.log('  (api not running — integration tests skipped)');
    return;
  }

  it('idempotent send: same clientId never duplicates run', async () => {
    const s = await (await fetch(`${BASE}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'integ-idem', branch: 'main' }) })).json();
    const body = { text: 'Update README docs', clientId: 'test-client-1' };
    const r1 = await (await fetch(`${BASE}/v1/sessions/${s.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    const r2 = await (await fetch(`${BASE}/v1/sessions/${s.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    assert.equal(r1.message.id, r2.message.id, 'duplicate message created');
    assert.equal(r2.deduplicated, true, 'second send not flagged deduplicated');
    const msgs = await (await fetch(`${BASE}/v1/sessions/${s.id}/messages`)).json();
    assert.equal(msgs.filter((m) => m.id === 'test-client-1').length, 1);
    assert.ok(msgs.some((m) => m.role === 'assistant' && m.text), 'assistant response was not persisted');
  });

  it('runs snapshot endpoint restores task state', async () => {
    const s = await (await fetch(`${BASE}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'integ-runs', branch: 'main' }) })).json();
    await fetch(`${BASE}/v1/sessions/${s.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Fix login bug and run tests' }) });
    const runs = await (await fetch(`${BASE}/v1/sessions/${s.id}/runs`)).json();
    assert.ok(runs.length >= 1, 'no runs in snapshot');
    assert.ok(['completed', 'running'].includes(runs[runs.length - 1].state), 'unexpected run state');
  });

  it('SSE replay is ordered with monotonic sequences', async () => {
    const s = await (await fetch(`${BASE}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'integ-sse', branch: 'main' }) })).json();
    await fetch(`${BASE}/v1/sessions/${s.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Update docs' }) });
    // Read the infinite SSE stream via reader, then cancel — fetch().text() never resolves on SSE.
    const res = await fetch(`${BASE}/v1/sessions/${s.id}/events?after=0`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if ((buf.match(/^id: /gm) || []).length >= 5) break;
    }
    reader.cancel().catch(() => {});
    const seqs = [...buf.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.ok(seqs.length >= 3, `expected replayed events, got ${seqs.length}`);
    const sorted = [...seqs].sort((a, b) => a - b);
    assert.deepEqual(seqs, sorted, 'events out of order');
  });

  it('empty message rejected (composer guard)', async () => {
    const s = await (await fetch(`${BASE}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'integ-empty', branch: 'main' }) })).json();
    const r = await fetch(`${BASE}/v1/sessions/${s.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '   ' }) });
    assert.equal(r.status, 400, 'empty message not rejected');
  });
});
