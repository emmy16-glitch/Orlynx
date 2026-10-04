import { useEffect, useState } from 'react';

async function api(path: string, body?: unknown) {
  const response = await fetch(`/v1${path}`, { credentials: 'same-origin', signal: AbortSignal.timeout(660_000), ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Orlynx-E2E': 'browser' }, body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
const delay = () => new Promise(resolve => setTimeout(resolve, 3000));
export function LiveE2EPanel({ onOpen }: { onOpen: (session: any) => void }) {
  const [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false), [progress, setProgress] = useState<string[]>([]), [session, setSession] = useState<any>(null), [result, setResult] = useState<any>(null);
  useEffect(() => { api('/e2e').then(s => setEnabled(s.enabled)).catch(() => {}); }, []);
  async function run() {
    setBusy(true); setResult(null); setProgress([]);
    const note = (text: string) => setProgress(p => [...p, `${new Date().toISOString()} ${text}`]);
    let stream: EventSource | undefined;
    try {
      note('Checking authentication and repository authorization');
      const s = await api('/e2e', {}); setSession(s);
      const plan = s.checkpoint.liveE2EPlan, root = `/sessions/${s.id}`;
      note(`Created isolated verification session ${s.id}; target ${plan.branch}`);
      for (const branch of ['main', 'master', 'unrelated-branch']) {
        const response = await fetch(`/v1${root}/git/e2e-branch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branch }) });
        if (response.status !== 403) throw new Error(`Safety guard did not reject ${branch}`);
      }
      note('main, master and arbitrary branch requests rejected before mutation');
      stream = new EventSource(`/v1${root}/events?after=0`);
      stream.onmessage = event => { try { const e = JSON.parse(event.data); note(`Event ${e.sequence}: ${e.type}`); } catch {} };
      await api(`${root}/cloud`, {});
      const deadline = Date.now() + 20 * 60_000;
      let details;
      while (Date.now() < deadline) {
        details = await api(root);
        note(`Workspace ${details.workspace?.state || 'preparing'} · ${details.workspace?.provider || 'allocating'}`);
        if (details.workspace?.state === 'ready') break;
        if (details.workspace?.state === 'failed') throw new Error(`Workspace failed: ${details.workspace.failureCode}`);
        await delay();
      }
      if (details?.workspace?.state !== 'ready') throw new Error('Workspace readiness timeout');
      await api(`${root}/git/e2e-branch`, { branch: plan.branch });
      const status = await api(`${root}/git/status`);
      if (status.branch !== plan.branch) throw new Error('Actual workspace branch does not match isolated branch');
      note(`Actual Git branch verified: ${status.branch}`);
      const sent = await api(`${root}/messages`, { text: `Create ${plan.filename} containing exactly: Orlynx real execution plane verified. Do not modify any other file. Run npm test and inspect the real Git diff. Do not commit or push; leave the verified changes for review.`, clientId: plan.clientId, adapterId: 'opencode', mode: 'build', fullAccessForThisTask: true });
      let run = sent.run;
      while (Date.now() < deadline && ['queued', 'running'].includes(run?.state)) {
        await delay(); run = (await api(`${root}/runs`)).find((r: any) => r.id === run.id) || run;
        note(`Build ${run.state}`);
      }
      if (run?.state !== 'completed') throw new Error(`Build did not complete: ${run?.state}`);
      note('Running real npm test');
      const tested = await api(`${root}/e2e/test`, {});
      note('npm test passed');
      const changes = await api(`${root}/changes`), change = changes.find((c: any) => c.reviewState === 'pending' && c.files.some((f: any) => f.path === plan.filename));
      if (!change || change.files.length !== 1) throw new Error('Expected single-file ChangeSet is missing');
      const diff = tested;
      if (!String(diff.diff || '').includes(plan.filename)) throw new Error('Real Git diff does not contain verification file');
      await api(`/changes/${change.id}/approve`, {});
      await api(`/changes/${change.id}/commit`, { message: `test: verify Orlynx execution plane ${plan.clientId}` });
      const beforePush = await api(`${root}/git/status`);
      if (beforePush.branch !== plan.branch || !/^orlynx-e2e\/[0-9]{10,17}$/.test(beforePush.branch)) throw new Error('Push stopped: actual workspace branch is unsafe');
      note(`Pre-push Git status verified on ${beforePush.branch}`);
      await api(`/changes/${change.id}/push`, {});
      note('Push completed; verifying GitHub and durable records independently');
      const verified = await api(`${root}/e2e/verify`, {});
      // Replay the full persisted prefix through the actual SSE transport.
      const response = await fetch(`/v1${root}/events?after=0`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok || !response.body) throw new Error('Event replay unavailable');
      const reader = response.body.getReader(), decoder = new TextDecoder(), ids = new Set<string>();
      let buffer = '', previous = 0;
      try {
        while (previous < verified.replay.lastSequence) {
          const chunk = await reader.read(); if (chunk.done) throw new Error('Event replay ended early');
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.match(/^data: (.+)$/m); if (!data) continue;
            const e = JSON.parse(data[1]);
            if (e.sequence <= previous || ids.has(e.eventId)) throw new Error('Duplicate or out-of-order replay event');
            previous = e.sequence; ids.add(e.eventId);
          }
        }
      } finally { await reader.cancel(); }
      setResult(verified); note(`LIVE E2E VERIFIED · ${ids.size} replayed events · ${verified.commitSha}`);
    } catch (error) { note(`FAILED: ${error instanceof Error ? error.message : String(error)}`); }
    finally { stream?.close(); setBusy(false); }
  }
  if (!enabled && !session) return null;
  return <section className="settings-group"><h2>Production verification</h2><div className="settings-row"><span><b>Authenticated live E2E</b><small>Creates a temporary file on an isolated orlynx-e2e branch. Keep this page open during the test.</small></span><button type="button" disabled={busy || !enabled} onClick={run}>{busy ? 'Verification running' : 'Run live E2E'}</button></div>{session && <button onClick={() => onOpen(session)}>Open verification session</button>}<div role="log" aria-label="Live E2E progress" aria-live="polite" style={{ maxHeight: 360, overflow: 'auto' }}>{progress.map((line, i) => <p key={i}>{line}</p>)}</div>{result && <pre>{JSON.stringify(result, null, 2)}</pre>}</section>;
}
