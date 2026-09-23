import React, { useEffect, useRef, useState } from 'react';
import './styles.css';
import { j } from './api';
import { Badge, Button, EmptyState } from './ui/primitives';
import { AgentApprovalCard, AgentErrorCard, CloudStatus, CloudWorkspaceButton, DiffSummary } from './ui/product';
import { AgentWorkStream, CloudTransition, LiveActivityPill } from './ui/workstream';
import { Lab } from './ui/lab';

type Tab = 'agent' | 'files' | 'changes' | 'preview' | 'more';

export default function App() {
  const [session, setSession] = useState<any>(null);
  const [project, setProject] = useState('demo');
  const [tab, setTab] = useState<Tab>('agent');
  const [msgs, setMsgs] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<any[]>([]);
  const [changes, setChanges] = useState<any[]>([]);
  const [cloud, setCloud] = useState<any>(null);
  const [termOut, setTermOut] = useState('');
  const [cmd, setCmd] = useState('echo hello-orlynx && ls');
  const lastSeq = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  async function boot(p = project) {
    const s = await j<any>(await fetch('/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: p, branch: 'main' }) }));
    setSession(s);
    await refresh(s.id);
    connect(s.id);
  }

  async function refresh(sid: string) {
    const [m, f, c, det] = await Promise.all([
      j<any[]>(await fetch(`/v1/sessions/${sid}/messages`)),
      j<any>(await fetch(`/v1/sessions/${sid}/files`)),
      j<any[]>(await fetch(`/v1/sessions/${sid}/changes`)),
      j<any>(await fetch(`/v1/sessions/${sid}`)),
    ]);
    setMsgs(m); setFiles(f.files || []); setChanges(c); setCloud(det.workspace);
  }

  function connect(sid: string) {
    esRef.current?.close();
    const es = new EventSource(`/v1/sessions/${sid}/events?after=${lastSeq.current}`);
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        lastSeq.current = Math.max(lastSeq.current, evt.sequence);
        setEvents((p) => [...p.slice(-200), evt]);
        if (['changes.updated', 'receipt.created', 'run.completed'].includes(evt.type)) {
          fetch(`/v1/sessions/${sid}/changes`).then((r) => r.json()).then(setChanges).catch(() => {});
          fetch(`/v1/sessions/${sid}/messages`).then((r) => r.json()).then(setMsgs).catch(() => {});
        }
        if (evt.type?.startsWith('workspace.')) {
          fetch(`/v1/sessions/${sid}`).then((r) => r.json()).then((d) => setCloud(d.workspace)).catch(() => {});
        }
      } catch {}
    };
    esRef.current = es;
  }

  useEffect(() => { boot(); return () => esRef.current?.close(); }, []);

  async function send() {
    if (!session || !input.trim()) return;
    const text = input; setInput('');
    await j(await fetch(`/v1/sessions/${session.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }));
    await refresh(session.id);
  }

  async function workOnCloud() {
    if (!session) return;
    await j(await fetch(`/v1/sessions/${session.id}/cloud`, { method: 'POST' }));
    await refresh(session.id);
  }

  async function runCmd() {
    if (!session) return;
    const r = await j<any>(await fetch(`/v1/sessions/${session.id}/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }) }));
    setTermOut(r.out || JSON.stringify(r));
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!session || !e.target.files?.[0]) return;
    const fd = new FormData(); fd.append('file', e.target.files[0]);
    await fetch(`/v1/sessions/${session.id}/attachments`, { method: 'POST', body: fd });
    alert('Uploaded — agent can now materialize it to cloud workspace');
  }

  const liveActivity = [...events].reverse().find((e) => e.type?.startsWith('activity.'));
  const runState = [...events].reverse().find((e) => e.type?.startsWith('run.'))?.type === 'run.started' ? 'running'
    : [...events].reverse().find((e) => e.type === 'run.failed') ? 'failed'
    : [...events].reverse().find((e) => e.type === 'run.completed') ? 'completed' : 'idle';
  const isWorking = events.length > 0 && runState === 'running';
  const cloudFailed = [...events].reverse().find((e) => e.type === 'workspace.reconnecting' || e.type === 'run.failed');

  if (typeof window !== 'undefined' && window.location.search.includes('lab=1')) return <Lab />;

  return (
    <>
      <header>
        <b>Orlynx</b>
        <Badge>{session?.project || project}</Badge>
        <Badge>{session?.branch || 'main'}</Badge>
        <CloudStatus state={cloud?.state} />
        <Badge tone={changes.filter((c: any) => c.reviewState === 'pending').length ? 'wait' : 'neutral'}>{changes.filter((c: any) => c.reviewState === 'pending').length} pending</Badge>
      </header>
      <LiveActivityPill active={isWorking} label={String(liveActivity?.payload?.text || 'Agent working')} onOpen={() => setTab('agent')} />
      <main>
        {tab === 'agent' && (
          <>
            <div className="card small">Choose project → Ask → {cloud?.state === 'ready' ? 'Agent works on cloud' : 'Work on cloud only when needed'} → Review → Commit. Infrastructure stays invisible.</div>
            {cloud?.state === 'preparing' && <CloudTransition state="preparing" />}
            {msgs.map((m) => (<div key={m.id} className="card"><div className="small">{m.role}</div><div>{m.text}</div></div>))}
            <AgentWorkStream events={events} />
            {cloudFailed && runState === 'failed' && (
              <AgentErrorCard title="Work could not finish." hint="The workspace or run hit a problem." onReconnect={workOnCloud} onRetry={() => refresh(session.id)} />
            )}
            {!cloud && <div className="row"><CloudWorkspaceButton state={cloud?.state} onStart={workOnCloud} /><span className="small">Attaches compute to this same conversation</span></div>}
          </>
        )}
        {tab === 'files' && (
          <div className="card">
            <div className="row"><input value={project} onChange={(e) => setProject(e.target.value)} /><button className="gho" onClick={() => boot(project)}>Open</button></div>
            {files.map((f: any) => (<div key={f.name} className="row">📁 {f.name}{f.dir ? '/' : ''}</div>))}
          </div>
        )}
        {tab === 'changes' && (
          <>
            {changes.length === 0 && <EmptyState title="No changes" hint="Ask the agent to edit. Review appears here before anything commits." />}
            {changes.map((c: any) => (
              <div key={c.id} className="card">
                <div className="row"><b>{c.id}</b><Badge tone={c.reviewState === 'committed' ? 'ok' : c.reviewState === 'pending' ? 'wait' : 'neutral'}>{c.reviewState}</Badge><span className="small">base {c.baseSha?.slice(0, 7)}</span></div>
                <DiffSummary files={(c.files || []).map((f: any) => ({ path: f.path, action: f.action }))} />
                {c.files?.map((f: any, i: number) => (<pre key={i}>{f.path}\n{(f.after || '').slice(0, 2000)}</pre>))}
                <div className="row">
                  {c.reviewState === 'pending' && (
                    <AgentApprovalCard title={`Push ${c.files?.length || 0} changed file${(c.files?.length || 0) === 1 ? '' : 's'}?`} detail="Review the diff above. Nothing commits without approval." onApprove={async () => { await j(await fetch(`/v1/changes/${c.id}/approve`, { method: 'POST' })); await refresh(session.id); }} onCancel={() => {}} />
                  )}
                  {c.reviewState === 'approved' && <Button onClick={async () => { await j(await fetch(`/v1/changes/${c.id}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Orlynx update' }) })); await refresh(session.id); }}>Commit & push</Button>}
                  {c.reviewState === 'committed' && <span className="small">✔ {c.commitSha?.slice(0, 7)}</span>}
                </div>
              </div>
            ))}
          </>
        )}
        {tab === 'preview' && (<div className="card"><p>Open preview</p><p className="small">Private by default. Start a dev server via terminal, then preview appears here without port mechanics.</p><input placeholder="preview URL (e.g. /)" id="pv" /><button className="gho" onClick={() => { const v = (document.getElementById('pv') as HTMLInputElement).value; if (v) window.open(v, '_blank'); }}>Open preview</button></div>)}
        {tab === 'more' && (
          <>
            <div className="card"><h4>Terminal (expert)</h4><div className="row"><input value={cmd} onChange={(e) => setCmd(e.target.value)} /><button className="gho" onClick={runCmd}>Run</button></div><pre>{termOut || 'no output yet'}</pre></div>
            <div className="card"><h4>Attach</h4><input type="file" onChange={upload} /><div className="small">Files / Photos / Camera via picker. Bytes reach cloud only when required.</div></div>
            <div className="card"><div className="row"><button className="gho" onClick={async () => { await fetch(`/v1/sessions/${session.id}/cloud/stop`, { method: 'POST' }); await refresh(session.id); }}>Stop cloud</button></div></div>
          </>
        )}
      </main>
      {tab === 'agent' && (
        <div className="composer">
          <label className="gho" style={{ padding: '10px' }}>+<input type="file" hidden onChange={upload} /></label>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Describe the work…" onKeyDown={(e) => e.key === 'Enter' && send()} />
          <button className="pri" onClick={send}>Send</button>
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Primary">
        {(['agent', 'files', 'changes', 'preview', 'more'] as Tab[]).map((t) => (<button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>))}
      </div>
    </>
  );
}
