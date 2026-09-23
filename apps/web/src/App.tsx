import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';
import { j } from './api';
import { Badge, Button, EmptyState } from './ui/primitives';
import { AgentApprovalCard, AgentErrorCard, AttachmentChip, CloudStatus, CloudWorkspaceButton, DiffSummary } from './ui/product';
import { AgentWorkStream, CloudTransition, LiveActivityPill } from './ui/workstream';
import { toActivities } from './ui/mapping';
import { Lab } from './ui/lab';

type Tab = 'agent' | 'files' | 'changes' | 'preview' | 'more';

const LS_SESSION = 'orlynx:lastSession';
const seqKey = (sid: string) => `orlynx:seq:${sid}`;
const draftKey = (sid: string) => `orlynx:draft:${sid}`;
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
type LiveReply = { id: string; text: string; complete: boolean };

function loadSeq(sid: string): number {
  try { return Number(localStorage.getItem(seqKey(sid)) || 0); } catch { return 0; }
}

export default function App() {
  const [session, setSession] = useState<any>(null);
  const [project, setProject] = useState('demo');
  const [tab, setTab] = useState<Tab>('agent');
  const [msgs, setMsgs] = useState<any[]>([]);
  const [liveReplies, setLiveReplies] = useState<Record<string, LiveReply>>({});
  const [events, setEvents] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<any[]>([]);
  const [changes, setChanges] = useState<any[]>([]);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [cloud, setCloud] = useState<any>(null);
  const [termOut, setTermOut] = useState('');
  const [cmd, setCmd] = useState('echo hello-orlynx && ls');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [streamState, setStreamState] = useState<'live' | 'reconnecting' | 'offline'>('live');
  const [uploads, setUploads] = useState<{ id: string; name: string; state: string }[]>([]);
  const [busyChange, setBusyChange] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);

  const lastSeq = useRef(0);
  const seenIds = useRef(new Set<string>());
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const nearBottom = useRef(true);
  const pendingEvents = useRef<any[]>([]);
  const eventFrame = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);

  if (typeof window !== 'undefined' && window.location.search.includes('lab=1')) return <Lab />;

  const ingest = useCallback((sid: string, raw: any) => {
    // Reconcile stable ids immediately, then batch React updates to one paint frame.
    const list = Array.isArray(raw) ? raw : [raw];
    const fresh = list.filter((e) => e && e.eventId && !seenIds.current.has(e.eventId));
    if (!fresh.length) return;
    fresh.forEach((e) => { seenIds.current.add(e.eventId); pendingEvents.current.push(e); });
    const maxSeq = fresh.reduce((m, e) => Math.max(m, e.sequence || 0), lastSeq.current);
    lastSeq.current = maxSeq;
    if (eventFrame.current === null) eventFrame.current = requestAnimationFrame(() => {
      eventFrame.current = null;
      const batch = pendingEvents.current.splice(0);
      // Persist the replay cursor only after the corresponding batch is handed to UI state.
      try { localStorage.setItem(seqKey(sid), String(lastSeq.current)); } catch {}
      setEvents((prev) => [...prev, ...batch].sort((a, b) => a.sequence - b.sequence).slice(-300));
      const replyEvents = batch.filter((e) => e.type === 'message.start' || e.type === 'message.delta' || e.type === 'message.end');
      if (replyEvents.length) setLiveReplies((prev) => {
        const next = { ...prev };
        for (const evt of replyEvents) {
          const key = String(evt.runId || 'current');
          const current = next[key] || { id: `msg_${key}`, text: '', complete: false };
          if (evt.type === 'message.start') next[key] = { ...current, text: '', complete: false };
          else if (evt.type === 'message.delta' && typeof evt.payload?.delta === 'string') next[key] = { ...current, text: current.text + evt.payload.delta };
          else if (evt.type === 'message.end') next[key] = { ...current, complete: true };
        }
        return next;
      });
      if (!nearBottom.current) setShowLatest(true);
    });
    for (const evt of fresh) {
      if (!evt) continue;
      if (['changes.updated', 'receipt.created', 'run.completed', 'run.failed'].includes(evt.type)) {
        fetch(`/v1/sessions/${sid}/changes`).then((r) => r.json()).then(setChanges).catch(() => {});
        fetch(`/v1/sessions/${sid}/messages`).then((r) => r.json()).then(setMsgs).catch(() => {});
        fetch(`/v1/sessions/${sid}/runs`).then((r) => r.json()).then((runs) => setLastRun(runs.slice(-1)[0] || null)).catch(() => {});
      }
      if (evt.type?.startsWith('workspace.')) {
        fetch(`/v1/sessions/${sid}`).then((r) => r.json()).then((d) => setCloud(d.workspace)).catch(() => {});
      }
    }
  }, []);

  useEffect(() => {
    const persisted = new Set(msgs.map((m) => m.id));
    setLiveReplies((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([, reply]) => !persisted.has(reply.id)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [msgs]);

  const [lastRun, setLastRun] = useState<any>(null);

  const connect = useCallback((sid: string) => {
    esRef.current?.close();
    if (retryTimer.current) clearTimeout(retryTimer.current);
    const attempt = () => {
      if (!navigator.onLine) { setStreamState('offline'); retryTimer.current = setTimeout(attempt, 3000); return; }
      setStreamState(retryRef.current > 0 ? 'reconnecting' : 'live');
      const es = new EventSource(`/v1/sessions/${sid}/events?after=${lastSeq.current}`);
      esRef.current = es;
      es.onmessage = (e) => {
        retryRef.current = 0;
        setStreamState('live');
        try { ingest(sid, JSON.parse(e.data)); } catch {}
      };
      es.onerror = () => {
        es.close();
        setStreamState('reconnecting');
        retryRef.current += 1;
        const backoff = Math.min(1000 * 2 ** Math.min(retryRef.current, 3), 8000);
        retryTimer.current = setTimeout(attempt, backoff);
      };
    };
    attempt();
  }, [ingest]);

  const refresh = useCallback(async (sid: string) => {
    const [m, f, c, det, runs, atts] = await Promise.all([
      j<any[]>(await fetch(`/v1/sessions/${sid}/messages`)),
      j<any>(await fetch(`/v1/sessions/${sid}/files`)),
      j<any[]>(await fetch(`/v1/sessions/${sid}/changes`)),
      j<any>(await fetch(`/v1/sessions/${sid}`)),
      j<any[]>(await fetch(`/v1/sessions/${sid}/runs`).catch(() => ({ json: async () => [] } as any))).catch(() => []),
      j<any[]>(await fetch(`/v1/sessions/${sid}/attachments`)),
    ]);
    setMsgs(m); setFiles(f.files || []); setChanges(c); setCloud(det.workspace);
    setLastRun((runs || []).slice(-1)[0] || null);
    setAttachments(atts || []);
  }, []);

  const openSession = useCallback(async (s: any) => {
    if (eventFrame.current !== null) cancelAnimationFrame(eventFrame.current);
    eventFrame.current = null;
    pendingEvents.current = [];
    lastSeq.current = loadSeq(s.id);
    seenIds.current = new Set();
    setEvents([]);
    setSession(s);
    try { localStorage.setItem(LS_SESSION, JSON.stringify({ id: s.id, project: s.project })); } catch {}
    try {
      const d = localStorage.getItem(draftKey(s.id));
      if (d) setInput(d);
    } catch {}
    await refresh(s.id);
    connect(s.id);
  }, [connect, refresh]);

  const boot = useCallback(async (p = project) => {
    // Restore last session instead of forging a fresh one (continuity).
    try {
      const saved = localStorage.getItem(LS_SESSION);
      if (saved && p === project) {
        const { id } = JSON.parse(saved);
        const existing = await j<any>(await fetch(`/v1/sessions/${id}`));
        if (existing?.id) { setProject(existing.project); await openSession(existing); return; }
      }
    } catch {}
    const s = await j<any>(await fetch('/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: p, branch: 'main' }) }));
    await openSession(s);
  }, [openSession, project]);

  useEffect(() => {
    boot();
    const onOnline = () => { setOnline(true); if (session) connect(session.id); };
    const onOffline = () => { setOnline(false); setStreamState('offline'); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { esRef.current?.close(); if (retryTimer.current) clearTimeout(retryTimer.current); if (eventFrame.current !== null) cancelAnimationFrame(eventFrame.current); if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow only while the reader was already at the latest content. Never pull a
  // reader back down after they have moved upward; resize/keyboard changes stay native.
  useEffect(() => {
    if (!nearBottom.current || tab !== 'agent') return;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      if (nearBottom.current) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    });
  }, [events, msgs, tab]);

  // Scroll tracking on window (chat scrolls with page).
  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      const dist = doc.scrollHeight - window.innerHeight - window.scrollY;
      nearBottom.current = dist < 140;
      if (nearBottom.current) setShowLatest(false);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const jumpToLatest = () => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    setShowLatest(false);
  };

  async function send() {
    if (!session || !input.trim() || sending) return;
    if (!online) { setSendError('You are offline. Draft saved — send when reconnected.'); return; }
    const text = input;
    const clientId = uid();
    setSending(true); setSendError('');
    try {
      // Idempotent send: same clientId never creates a duplicate run.
      const r = await j<any>(await fetch(`/v1/sessions/${session.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, clientId }) }));
      setInput('');
      try { localStorage.removeItem(draftKey(session.id)); } catch {}
      if (r.run) setLastRun(r.run);
      await refresh(session.id);
      requestAnimationFrame(() => { if (nearBottom.current) jumpToLatest(); });
    } catch (e: any) {
      setSendError(e.message || 'Send failed. Draft preserved.');
    } finally { setSending(false); }
  }

  async function cancelRun() {
    if (!session || !lastRun) return;
    await fetch(`/v1/agent-runs/${lastRun.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id }) }).catch(() => {});
    await refresh(session.id);
  }

  async function workOnCloud() {
    if (!session) return;
    await j(await fetch(`/v1/sessions/${session.id}/cloud`, { method: 'POST' }));
    await refresh(session.id);
  }

  async function runCmd() {
    if (!session) return;
    try {
      const r = await j<any>(await fetch(`/v1/sessions/${session.id}/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }) }));
      setTermOut(r.out || JSON.stringify(r));
    } catch (e: any) { setTermOut(`Denied: ${e.message}`); }
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!session || !file) return;
    const id = uid();
    setUploads((u) => [...u, { id, name: file.name, state: 'uploading' }]);
    try {
      const fd = new FormData(); fd.append('file', file);
      await j(await fetch(`/v1/sessions/${session.id}/attachments`, { method: 'POST', body: fd }));
      setUploads((u) => u.map((x) => x.id === id ? { ...x, state: cloud?.state === 'ready' ? 'ready for agent' : 'available' } : x));
      const atts = await j<any[]>(await fetch(`/v1/sessions/${session.id}/attachments`));
      setAttachments(atts);
    } catch {
      setUploads((u) => u.map((x) => x.id === id ? { ...x, state: 'failed' } : x));
    }
  }

  const runState: string = useMemo(() => {
    if (lastRun?.state === 'running' || lastRun?.state === 'queued') return lastRun.state;
    const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
    const last = ordered.reverse().find((e) => e.type === 'run.started' || e.type === 'run.completed' || e.type === 'run.failed');
    if (!last) return lastRun?.state || 'idle';
    if (last.type === 'run.started') {
      const done = ordered.find((e) => (e.type === 'run.completed' || e.type === 'run.failed') && (e.sequence > last.sequence) && e.runId === last.runId);
      return done ? (done.type === 'run.completed' ? 'completed' : 'failed') : 'running';
    }
    return last.type === 'run.completed' ? 'completed' : 'failed';
  }, [events, lastRun]);

  const liveActivity = useMemo(() => [...toActivities(events)].reverse().find((e) => e.state === 'running' || e.state === 'waiting'), [events]);
  const isWorking = runState === 'running' || runState === 'queued';
  const showCloudError = cloud?.state === 'failed' || streamState === 'reconnecting';

  return (
    <>
      <header>
        <b>Orlynx</b>
        <Badge>{session?.project || project}</Badge>
        <Badge>{session?.branch || 'main'}</Badge>
        {streamState === 'reconnecting' ? <Badge tone="wait">Reconnecting</Badge>
          : streamState === 'offline' ? <Badge tone="fail">Offline</Badge>
          : <CloudStatus state={cloud?.state} />}
        <Badge tone={changes.filter((c: any) => c.reviewState === 'pending').length ? 'wait' : 'neutral'}>{changes.filter((c: any) => c.reviewState === 'pending').length} pending</Badge>
        <LiveActivityPill active={isWorking && streamState === 'live'} status={streamState === 'reconnecting' || streamState === 'offline' ? 'interrupted' : runState} label={streamState === 'reconnecting' || streamState === 'offline' ? 'Reconnecting to Orlynx' : liveActivity?.title || (runState === 'completed' ? 'Ready for review' : runState === 'failed' ? 'Needs attention' : 'Ready when you are')} onOpen={() => setTab('agent')} onStop={cancelRun} />
      </header>
      <main ref={scrollRef as any}>
        {tab === 'agent' && (
          <>
            <div className="card small">Choose project → Ask → {cloud?.state === 'ready' ? 'Agent works on cloud' : 'Work on cloud only when needed'} → Review → Commit. Infrastructure stays invisible.</div>
            {(cloud?.state === 'preparing') && <CloudTransition state="preparing" />}
            {showCloudError && streamState === 'reconnecting' && (
              <AgentErrorCard title="Connection interrupted. Reconnecting…" hint="Your conversation and changes are safe." onRetry={() => session && connect(session.id)} />
            )}
            {msgs.map((m) => (<div key={m.id} className="card"><div className="small">{m.role}</div><div>{m.text}</div></div>))}
            {Object.values(liveReplies).filter((reply) => reply.text && !msgs.some((m) => m.id === reply.id)).map((reply) => <div key={reply.id} className="card" aria-label={reply.complete ? 'Assistant response' : 'Assistant response streaming'}><div className="small">assistant</div><div>{reply.text}</div></div>)}
            <AgentWorkStream events={events} />
            {runState === 'failed' && (
              <AgentErrorCard title="Work could not finish." hint="The workspace or run hit a problem." onReconnect={workOnCloud} onRetry={() => session && refresh(session.id)} />
            )}
            {!cloud && !isWorking && <div className="row"><CloudWorkspaceButton state={cloud?.state} onStart={workOnCloud} /><span className="small">Attaches compute to this same conversation</span></div>}
            {!!attachments.length && (
              <div className="card"><div className="ox-row">{attachments.map((a: any) => <AttachmentChip key={a.id} name={a.filename} state={cloud?.state === 'ready' ? 'agent' : 'attached'} />)}</div></div>
            )}
          </>
        )}
        {tab === 'files' && (
          <div className="card">
            <div className="row"><input value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project name" /><button className="gho" onClick={() => boot(project)}>Open</button></div>
            {files.length === 0 && <div className="small">Empty repository.</div>}
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
                {c.files?.map((f: any, i: number) => (<pre key={i}>{f.path}{'\n'}{(f.after || '').slice(0, 2000)}</pre>))}
                <div className="row">
                  {c.reviewState === 'pending' && (
                    <AgentApprovalCard busy={busyChange === c.id} title={`Push ${c.files?.length || 0} changed file${(c.files?.length || 0) === 1 ? '' : 's'}?`} detail="Review the diff above. Nothing commits without approval." onApprove={async () => { setBusyChange(c.id); try { await j(await fetch(`/v1/changes/${c.id}/approve`, { method: 'POST' })); await refresh(session.id); } finally { setBusyChange(null); } }} onCancel={() => {}} />
                  )}
                  {c.reviewState === 'approved' && <Button disabled={busyChange === c.id} onClick={async () => { setBusyChange(c.id); try { await j(await fetch(`/v1/changes/${c.id}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Orlynx update' }) })); await refresh(session.id); } catch (e: any) { setSendError(e.message); } finally { setBusyChange(null); } }}>{busyChange === c.id ? 'Working…' : 'Commit & push'}</Button>}
                  {c.reviewState === 'committed' && <span className="small">✔ {c.commitSha?.slice(0, 7)}</span>}
                  {c.reviewState === 'stale' && <AgentErrorCard title="Repository changed since this work started." hint="Refresh and review before committing." onRetry={() => refresh(session.id)} />}
                </div>
              </div>
            ))}
          </>
        )}
        {tab === 'preview' && (<div className="card"><p>Open preview</p><p className="small">Private by default. Start a dev server via terminal, then preview appears here without port mechanics.</p><input placeholder="preview URL (e.g. /)" id="pv" aria-label="Preview URL" /><button className="gho" onClick={() => { const v = (document.getElementById('pv') as HTMLInputElement).value; if (v) window.open(v, '_blank'); }}>Open preview</button></div>)}
        {tab === 'more' && (
          <>
            <div className="card"><h4>Terminal (expert)</h4><div className="row"><input value={cmd} onChange={(e) => setCmd(e.target.value)} aria-label="Command" /><button className="gho" onClick={runCmd}>Run</button></div><pre>{termOut || 'no output yet'}</pre><div className="ox-row" style={{ marginTop: 8 }}>{['Ctrl', 'Tab', 'Esc', '↑', '↓', '←', '→'].map((k) => <Badge key={k}>{k}</Badge>)}</div></div>
            <div className="card"><h4>Attach</h4><input type="file" onChange={upload} aria-label="Upload file" /><div className="small">Files / Photos / Camera via picker. Bytes reach cloud only when required.</div>
              {uploads.map((u) => <div key={u.id} className="small">{u.name} · {u.state}</div>)}
            </div>
            <div className="card"><div className="row"><button className="gho" onClick={async () => { await fetch(`/v1/sessions/${session.id}/cloud/stop`, { method: 'POST' }); await refresh(session.id); }}>Stop cloud</button><span className="small">Conversation and changes are kept.</span></div></div>
          </>
        )}
      </main>
      {showLatest && tab === 'agent' && (
        <div style={{ position: 'fixed', bottom: 150, left: 0, right: 0, display: 'flex', justifyContent: 'center', zIndex: 15 }}>
          <Button tone="ghost" onClick={jumpToLatest}>↓ New activity</Button>
        </div>
      )}
      {tab === 'agent' && (
        <div className="composer">
          <label className="gho" style={{ padding: '10px' }} aria-label="Attach file">+<input type="file" hidden onChange={upload} /></label>
          <input
            value={input}
            onChange={(e) => { setInput(e.target.value); try { session && localStorage.setItem(draftKey(session.id), e.target.value); } catch {} }}
            placeholder={online ? 'Describe the work…' : 'Offline — draft will be kept…'}
            aria-label="Message the agent"
            onKeyDown={(e) => e.key === 'Enter' && send()}
          />
          {isWorking
            ? <button className="gho" onClick={cancelRun} aria-label="Stop agent">Stop</button>
            : <button className="pri" onClick={send} disabled={sending} aria-label="Send message">{sending ? '…' : 'Send'}</button>}
        </div>
      )}
      {sendError && <div role="alert" className="small" style={{ textAlign: 'center', padding: 4 }}>{sendError}</div>}
      <div className="tabs" role="tablist" aria-label="Primary">
        {(['agent', 'files', 'changes', 'preview', 'more'] as Tab[]).map((t) => (<button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>))}
      </div>
    </>
  );
}
