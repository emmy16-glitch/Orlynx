import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';
import { j } from './api';
import { Badge, Button, EmptyState, Icon, Input, Spinner } from './ui/primitives';
import { AgentApprovalCard, AgentErrorCard, AttachmentChip, CloudStatus, CloudWorkspaceButton, DiffSummary } from './ui/product';
import { AgentWorkStream, CloudTransition, LiveActivityPill } from './ui/workstream';
import { toActivities } from './ui/mapping';
import { Lab } from './ui/lab';

type Tab = 'agent' | 'files' | 'changes' | 'preview' | 'terminal' | 'more';
type Page = 'welcome' | 'home' | 'projects' | 'github' | 'agents' | 'cloud' | 'settings' | 'search' | 'tasks' | 'workspace';
type GithubRepo = { full: string; name: string; owner: string; ownerType: string; private: boolean; defaultBranch: string; language: string | null; updatedAt: string; url: string };

const LS_SESSION = 'orlynx:lastSession';
const projectSessionKey = (project: string) => `orlynx:projectSession:${project}`;
const seqKey = (sid: string) => `orlynx:seq:${sid}`;
const draftKey = (sid: string) => `orlynx:draft:${sid}`;
const RECENTS = 'orlynx:recentProjects';
const THEME = 'orlynx:theme';
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
type LiveReply = { id: string; text: string; complete: boolean };

function loadSeq(sid: string): number {
  try { return Number(localStorage.getItem(seqKey(sid)) || 0); } catch { return 0; }
}

export default function App() {
  const [session, setSession] = useState<any>(null);
  const [project, setProject] = useState('demo');
  const [page, setPage] = useState<Page>('welcome');
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
  const [booting, setBooting] = useState(true);
  const [github, setGithub] = useState<any>({ connected: false, auth: 'not-configured' });
  const [repoLoading, setRepoLoading] = useState(false);
  const [repositories, setRepositories] = useState<GithubRepo[]>([]);
  const [repoQuery, setRepoQuery] = useState('');
  const [repoFilter, setRepoFilter] = useState<'all' | 'personal' | 'organizations' | 'recent'>('all');
  const [selectedRepo, setSelectedRepo] = useState<GithubRepo | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState('main');
  const [projectName, setProjectName] = useState('');
  const [recentProjects, setRecentProjects] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(RECENTS) || '[]'); } catch { return []; } });
  const [filePath, setFilePath] = useState('');
  const [fileQuery, setFileQuery] = useState('');
  const [openedFile, setOpenedFile] = useState<any>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem(THEME) || 'light'; } catch { return 'light'; } });
  const [commitMessage, setCommitMessage] = useState('Orlynx update');
  const [pushTarget, setPushTarget] = useState<any>(null);
  const [dismissedApprovals, setDismissedApprovals] = useState<Record<string, boolean>>({});
  const [screenError, setScreenError] = useState('');

  const lastSeq = useRef(0);
  const seenIds = useRef(new Set<string>());
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const sessionRef = useRef<any>(null);
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
    sessionRef.current = s;
    setProject(s.project);
    setPage('workspace');
    setFilePath(''); setOpenedFile(null);
    setMsgs([]); setChanges([]); setAttachments([]); setCloud(null); setLastRun(null); setLiveReplies({}); setPushTarget(null);
    try { localStorage.setItem(projectSessionKey(s.project), s.id); } catch {}
    setRecentProjects((previous) => {
      const next = [s.project, ...previous.filter((item) => item !== s.project)].slice(0, 8);
      try { localStorage.setItem(RECENTS, JSON.stringify(next)); } catch {}
      return next;
    });
    try { localStorage.setItem(LS_SESSION, JSON.stringify({ id: s.id, project: s.project })); } catch {}
    try {
      const d = localStorage.getItem(draftKey(s.id));
      if (d) setInput(d);
    } catch {}
    await refresh(s.id);
    setBooting(false);
    connect(s.id);
  }, [connect, refresh]);

  const boot = useCallback(async () => {
    // Restore last session instead of forging a fresh one (continuity).
    try {
      const saved = localStorage.getItem(LS_SESSION);
      if (saved) {
        const { id } = JSON.parse(saved);
        const existing = await j<any>(await fetch(`/v1/sessions/${id}`));
        if (existing?.id) { setProject(existing.project); await openSession(existing); return; }
      }
    } catch {}
    setPage('welcome');
    setBooting(false);
  }, [openSession]);

  async function openLocalProject(name: string) {
    const normalized = name.trim();
    if (!normalized) return;
    setScreenError('');
    try {
      const savedId = localStorage.getItem(projectSessionKey(normalized));
      if (savedId) {
        const saved = await fetch(`/v1/sessions/${savedId}`);
        if (saved.ok) { await openSession(await saved.json()); return; }
      }
      const s = await j<any>(await fetch('/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: normalized, branch: 'main', owner: 'local' }) }));
      await openSession(s);
    } catch (error: any) { setScreenError(error.message || 'The local project could not be opened.'); }
  }

  async function loadGithubRepositories() {
    setScreenError('');
    setRepoLoading(true);
    try {
      const result = await j<any>(await fetch('/v1/repos'));
      setGithub(result.connection);
      setRepositories(result.github || []);
      setSelectedRepo(null); setBranches([]);
    } catch (error: any) { setScreenError(error.message || 'GitHub repositories could not be loaded.'); }
    finally { setRepoLoading(false); }
  }

  async function chooseRepository(repository: GithubRepo) {
    setSelectedRepo(repository);
    setBranch(repository.defaultBranch || 'main');
    try {
      const result = await j<any>(await fetch(`/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/branches`));
      setBranches(result.branches?.length ? result.branches : [repository.defaultBranch || 'main']);
    } catch { setBranches([repository.defaultBranch || 'main']); }
  }

  async function importRepository() {
    if (!selectedRepo) return;
    setScreenError('');
    try {
      await j(await fetch('/v1/repos/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: selectedRepo.full, branch }) }));
      const s = await j<any>(await fetch('/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: selectedRepo.full, owner: selectedRepo.owner, branch }) }));
      await openSession(s);
    } catch (error: any) { setScreenError(error.message || 'Repository import failed. Your GitHub repository was not changed.'); }
  }

  async function openFolder(path: string) {
    if (!session) return;
    setFilePath(path);
    try {
      const result = await j<any>(await fetch(`/v1/sessions/${session.id}/files?path=${encodeURIComponent(path)}`));
      setFiles(result.files || []);
    } catch (error: any) { setScreenError(error.message || 'This folder could not be opened.'); }
  }

  async function viewFile(path: string) {
    if (!session) return;
    try { setOpenedFile(await j<any>(await fetch(`/v1/sessions/${session.id}/file?path=${encodeURIComponent(path)}`))); }
    catch (error: any) { setScreenError(error.message || 'This file could not be opened.'); }
  }

  async function commitChange(changeId: string) {
    setBusyChange(changeId); setScreenError('');
    try {
      await j(await fetch(`/v1/changes/${changeId}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: commitMessage }) }));
      if (session) await refresh(session.id);
    } catch (error: any) { setScreenError(error.message || 'The local commit could not be created.'); }
    finally { setBusyChange(null); }
  }

  async function pushChange(change: any) {
    setBusyChange(change.id); setScreenError('');
    try {
      await j(await fetch(`/v1/changes/${change.id}/push`, { method: 'POST' }));
      setPushTarget(null);
      if (session) await refresh(session.id);
    } catch (error: any) { setScreenError(error.message || 'Push failed. The local commit is safe.'); }
    finally { setBusyChange(null); }
  }

  useEffect(() => {
    boot();
    fetch('/v1/github/status').then((r) => r.json()).then(setGithub).catch(() => setGithub({ connected: false, auth: 'unavailable' }));
    const onOnline = () => { setOnline(true); if (sessionRef.current) connect(sessionRef.current.id); };
    const onOffline = () => { setOnline(false); setStreamState('offline'); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { esRef.current?.close(); if (retryTimer.current) clearTimeout(retryTimer.current); if (eventFrame.current !== null) cancelAnimationFrame(eventFrame.current); if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme; };
    apply();
    if (theme === 'system') media.addEventListener('change', apply);
    try { localStorage.setItem(THEME, theme); } catch {}
    return () => media.removeEventListener('change', apply);
  }, [theme]);

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
  const visibleRepos = repositories.filter((repo) => {
    const matches = `${repo.full} ${repo.language || ''}`.toLowerCase().includes(repoQuery.toLowerCase());
    if (!matches) return false;
    if (repoFilter === 'recent') return recentProjects.includes(repo.full);
    if (repoFilter === 'organizations') return repo.ownerType === 'Organization';
    if (repoFilter === 'personal') return repo.ownerType !== 'Organization';
    return true;
  });
  const displayProject = session?.project || project;
  const projectTab = (next: Tab) => { setTab(next); setOpenedFile(null); setScreenError(''); };
  const globalNav: { page: Page; label: string; icon: 'home' | 'folder' | 'agents' | 'cloud' | 'settings' }[] = [
    { page: 'home', label: 'Home', icon: 'home' }, { page: 'projects', label: 'Projects', icon: 'folder' },
    { page: 'agents', label: 'Agents', icon: 'agents' }, { page: 'cloud', label: 'Cloud', icon: 'cloud' }, { page: 'settings', label: 'Settings', icon: 'settings' },
  ];
  const projectTabs: { id: Tab; label: string; icon: 'inbox' | 'folder' | 'commit' | 'preview' | 'terminal' | 'more' }[] = [
    { id: 'agent', label: 'Chat', icon: 'inbox' }, { id: 'files', label: 'Files', icon: 'folder' },
    { id: 'changes', label: `Changes${changes.length ? ` ${changes.filter((c: any) => c.reviewState === 'pending').length || ''}` : ''}`.trim(), icon: 'commit' },
    { id: 'preview', label: 'Preview', icon: 'preview' }, { id: 'terminal', label: 'Terminal', icon: 'terminal' }, { id: 'more', label: 'More', icon: 'more' },
  ];

  return (
    <div className={`orlynx-app ${page === 'workspace' ? 'is-workspace' : ''}`}>
      <aside className="sidebar">
        <button className="brand-lockup" onClick={() => setPage(session ? 'home' : 'welcome')} aria-label="Orlynx home"><span className="brand-mark" /><span><b>Orlynx</b><small>Build from anywhere.</small></span></button>
        <nav className="side-nav" aria-label="Main navigation">
          {globalNav.map((item) => <button key={item.page} className={page === item.page ? 'selected' : ''} onClick={() => setPage(item.page)}><Icon name={item.icon} />{item.label}{item.page === 'cloud' && cloud?.state === 'ready' && <i className="nav-live-dot" />}</button>)}
        </nav>
        <div className="sidebar-section"><div className="sidebar-title">Recent projects</div>
          {recentProjects.slice(0, 5).map((name) => <button className={`recent-project ${session?.project === name ? 'selected' : ''}`} key={name} onClick={() => openLocalProject(name)}><span className="repo-avatar"><Icon name="repo" size={15} /></span><span className="recent-project-copy"><b>{name.split('/').pop()}</b><small><Icon name="branch" size={12} /> {session?.project === name ? session.branch : 'main'}</small></span><i className="repo-presence" /></button>)}
          <button className="side-link" onClick={() => setPage('projects')}>View all projects <Icon name="arrow" size={14} /></button>
        </div>
        <div className="sidebar-account"><span className="account-avatar"><Icon name="agents" /></span><span><b>Local workspace</b><small>{github.connected ? 'GitHub connected' : 'GitHub not connected'}</small></span><button className="icon-button" aria-label="Account and settings" onClick={() => setPage('settings')}><Icon name="more" /></button></div>
      </aside>

      <div className="app-main">
        {page === 'workspace' && session ? <>
          <header className="project-header">
            <div className="repo-identity"><span className="repo-avatar large"><Icon name={session.owner === 'local' ? 'repo' : 'github'} size={18} /></span><div><b>{session.project.split('/').pop()}</b><span><Icon name="branch" size={13} />{session.branch}</span></div><button className="icon-button header-chevron" aria-label="Switch project" onClick={() => setPage('projects')}><Icon name="chevron" /></button></div>
            <button className="global-search" onClick={() => setPage('search')}><Icon name="search" /><span>Search files, commands, or anything…</span><kbd>⌘ K</kbd></button>
            <div className="header-actions"><Button className="cloud-action" onClick={cloud?.state === 'ready' ? () => setPage('cloud') : workOnCloud}><Icon name="cloud" />{cloud?.state === 'ready' ? 'Cloud ready' : 'Work on cloud'}</Button><button className="icon-button" aria-label="More project options" onClick={() => setPage('settings')}><Icon name="more" /></button><span className="account-avatar small-avatar"><Icon name="agents" /></span></div>
          </header>
          <nav className="project-tabs" role="tablist" aria-label="Project workspace">
            {projectTabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'selected' : ''} onClick={() => projectTab(item.id)}><Icon name={item.icon} size={16} /><span>{item.label}</span></button>)}
          </nav>
          {streamState === 'offline' && <div className="offline-banner"><Icon name="cloud" /> Offline. Your conversation and draft are saved on this device.</div>}
          {screenError && <div className="screen-alert" role="alert"><span>{screenError}</span><button onClick={() => setScreenError('')} aria-label="Dismiss"><Icon name="close" /></button></div>}
          {sendError && <div className="screen-alert" role="alert"><span>{sendError}</span><button onClick={() => setSendError('')} aria-label="Dismiss"><Icon name="close" /></button></div>}
          <div className={`workspace-layout ${tab === 'agent' ? 'chat-layout' : ''}`}>
            <main className="workspace-main" ref={scrollRef as any}>
              {tab === 'agent' && <section className="conversation" aria-label="Project conversation">
                {showCloudError && streamState === 'reconnecting' && <AgentErrorCard title="Connection interrupted. Reconnecting…" hint="Your conversation and changes are safe." onRetry={() => connect(session.id)} />}
                {!msgs.length && !Object.keys(liveReplies).length && <div className="conversation-intro"><span className="agent-avatar"><Icon name="agents" size={19} /></span><div><h2>What would you like to build?</h2><p>Ask Orlynx to explore this repository, make a change, or explain how something works.</p></div></div>}
                {msgs.map((message) => <article key={message.id} className={`message-row ${message.role === 'user' ? 'user-message' : 'assistant-message'}`}><span className={message.role === 'user' ? 'user-avatar' : 'agent-avatar'}>{message.role === 'user' ? <Icon name="agents" size={15} /> : <Icon name="agents" size={17} />}</span><div className="message-content"><div className="message-meta"><b>{message.role === 'user' ? 'You' : 'Orlynx Agent'}</b><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><div className="message-text">{message.text}</div></div></article>)}
                {Object.values(liveReplies).filter((reply) => reply.text && !msgs.some((message) => message.id === reply.id)).map((reply) => <article key={reply.id} className="message-row assistant-message"><span className="agent-avatar"><Icon name="agents" size={17} /></span><div className="message-content"><div className="message-meta"><b>Orlynx Agent</b><span className="live-reply-indicator">{reply.complete ? 'Just now' : 'Writing'}</span></div><div className="message-text">{reply.text}{!reply.complete && <span className="stream-caret" aria-hidden />}</div></div></article>)}
                {!!attachments.length && <div className="chat-attachments">{attachments.map((attachment: any) => <AttachmentChip key={attachment.id} name={attachment.filename} state={cloud?.state === 'ready' ? 'agent' : 'attached'} />)}</div>}
                {uploads.filter((item) => !attachments.some((attachment) => attachment.filename === item.name && item.state !== 'failed')).map((item) => <div className="upload-state" key={item.id}><Icon name="file" />{item.name}<Badge tone={item.state === 'failed' ? 'fail' : item.state === 'uploading' ? 'work' : 'ok'}>{item.state}</Badge></div>)}
                {(isWorking || events.length > 0) && <div className="workstream-wrap"><AgentWorkStream events={events} /></div>}
                {runState === 'failed' && <AgentErrorCard title="The run needs attention." hint="Your conversation and saved changes are preserved." onReconnect={workOnCloud} onRetry={() => refresh(session.id)} />}
                {cloud?.state === 'preparing' && <CloudTransition state="preparing" />}
              </section>}

              {tab === 'files' && <section className="screen-section files-screen"><div className="screen-heading"><div><p className="eyebrow">PROJECT FILES</p><h1>Files</h1><p className="screen-subtitle">Browse and read files in {displayProject}.</p></div><label className="search-field"><Icon name="search" /><input placeholder="Filter files" value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} /></label></div>
                {openedFile ? <div className="code-viewer"><div className="code-titlebar"><button className="text-button" onClick={() => setOpenedFile(null)}>‹ All files</button><span><Icon name="file" />{openedFile.path}</span></div><pre>{openedFile.content}</pre></div> : <><div className="breadcrumbs"><button onClick={() => openFolder('')}>{session.project}</button>{filePath.split('/').filter(Boolean).map((part, index, parts) => <React.Fragment key={`${part}-${index}`}><Icon name="chevron" size={12} /><button onClick={() => openFolder(parts.slice(0, index + 1).join('/'))}>{part}</button></React.Fragment>)}</div>
                  <div className="file-list">{files.filter((file: any) => file.name.toLowerCase().includes(fileQuery.toLowerCase())).map((file: any) => <button className="file-row" key={file.name} onClick={() => file.dir ? openFolder([filePath, file.name].filter(Boolean).join('/')) : viewFile([filePath, file.name].filter(Boolean).join('/'))}><span className={`file-kind ${file.dir ? 'folder-kind' : ''}`}><Icon name={file.dir ? 'folder' : 'file'} /></span><span>{file.name}{file.dir ? '/' : ''}</span><Icon name="chevron" size={14} /></button>)}{!files.length && <EmptyState title="No files here yet" hint="This repository folder is empty." />}</div></>}
              </section>}

              {tab === 'changes' && <section className="screen-section changes-screen"><div className="screen-heading"><div><p className="eyebrow">REVIEW BEFORE SHARING</p><h1>Changes <span className="heading-count">{changes.reduce((sum: number, item: any) => sum + (item.files?.length || 0), 0)}</span></h1><p className="screen-subtitle">Inspect the work before creating a commit or pushing it.</p></div></div>
                {!changes.length && <EmptyState title="No changes yet" hint="Ask the agent to update a file. Its proposal will appear here for review." />}
                {changes.map((change: any) => <section key={change.id} className="change-set"><div className="change-set-heading"><div><b>{change.files?.length || 0} file{change.files?.length === 1 ? '' : 's'} changed</b><span className="small">Base {change.baseSha?.slice(0, 7)}</span></div><Badge tone={change.reviewState === 'committed' ? 'ok' : change.reviewState === 'pending' ? 'wait' : change.reviewState === 'stale' ? 'fail' : 'neutral'}>{change.pushedAt ? 'Pushed' : change.reviewState}</Badge></div>
                  <DiffSummary files={(change.files || []).map((file: any) => ({ path: file.path, action: file.action }))} />
                  <div className="diff-files">{change.files?.map((file: any, index: number) => <details className="diff-file" key={`${change.id}-${file.path}`}><summary><span><Icon name="file" />{file.path}</span><span className="diff-stats"><i>+{(file.after || '').split('\n').filter(Boolean).length}</i><i>−{(file.before || '').split('\n').filter(Boolean).length}</i></span></summary><div className="diff-explanation">{file.action === 'create' ? 'Added by the agent' : file.action === 'delete' ? 'Removed by the agent' : 'Updated by the agent'}</div><pre>{(file.after || file.before || '').slice(0, 12000)}</pre></details>)}</div>
                  {change.reviewState === 'pending' && (dismissedApprovals[change.id] ? <Button tone="ghost" onClick={() => setDismissedApprovals((current) => ({ ...current, [change.id]: false }))}>Review proposed changes</Button> : <AgentApprovalCard busy={busyChange === change.id} title={`Review ${change.files?.length || 0} proposed file changes`} detail="Approving allows a local commit. Pushing to GitHub remains a separate confirmed step." onApprove={async () => { setBusyChange(change.id); try { await j(await fetch(`/v1/changes/${change.id}/approve`, { method: 'POST' })); await refresh(session.id); } catch (error: any) { setScreenError(error.message); } finally { setBusyChange(null); } }} onCancel={() => setDismissedApprovals((current) => ({ ...current, [change.id]: true }))} />)}
                  {change.reviewState === 'approved' && <div className="commit-form"><label>Commit message<input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} /></label><Button onClick={() => commitChange(change.id)} disabled={busyChange === change.id}>{busyChange === change.id ? 'Committing…' : 'Create local commit'}</Button><span className="small">Creates a local Git commit; no remote push yet.</span></div>}
                  {change.reviewState === 'committed' && <div className="commit-success"><Icon name="check" /><span>Local commit {change.commitSha?.slice(0, 7)} is ready.</span>{!change.pushedAt && session.owner !== 'local' && <Button tone="ghost" onClick={() => setPushTarget(change)}>Review push</Button>}{!change.pushedAt && session.owner === 'local' && <span className="small">Local-only project · no remote configured</span>}{change.pushedAt && <Badge tone="ok">Pushed to {session.branch}</Badge>}</div>}
                  {change.reviewState === 'stale' && <AgentErrorCard title="The repository changed since this work started." hint="The commit was blocked. Refresh and review the updated files." onRetry={() => refresh(session.id)} />}
                  {pushTarget?.id === change.id && <div className="push-confirm" role="group" aria-label="Confirm push"><b>Ready to push {change.files?.length || 0} changed files to:</b><code>{session.project} · {session.branch}</code><p>This sends the reviewed local commit to the connected GitHub repository.</p><div className="action-row"><Button tone="ghost" onClick={() => setPushTarget(null)}>Cancel</Button><Button onClick={() => pushChange(change)} disabled={busyChange === change.id}>{busyChange === change.id ? 'Pushing…' : 'Approve & push'}</Button></div></div>}
                </section>)}
              </section>}

              {tab === 'preview' && <section className="screen-section preview-screen"><div className="screen-heading"><div><p className="eyebrow">PRIVATE BY DEFAULT</p><h1>Preview</h1><p className="screen-subtitle">Open a development preview when you have a local preview URL.</p></div></div><form className="preview-form" onSubmit={(event) => { event.preventDefault(); setPreviewUrl((event.currentTarget.elements.namedItem('preview-url') as HTMLInputElement).value); }}><label>Preview address<input name="preview-url" type="url" placeholder="http://localhost:3000" defaultValue={previewUrl} required /></label><Button><Icon name="external" />Open preview</Button></form>{previewUrl ? <div className="preview-panel"><div className="preview-toolbar"><Badge tone="ok">Preview open</Badge><span>{previewUrl}</span><button className="icon-button" aria-label="Reload preview" onClick={() => setPreviewUrl(`${previewUrl.split('#')[0]}#orlynx-reload=${Date.now()}`)}><Icon name="refresh" /></button><button className="text-button" onClick={() => window.open(previewUrl, '_blank', 'noopener,noreferrer')}>Open externally <Icon name="external" size={13} /></button></div><iframe title="Application preview" src={previewUrl} sandbox="allow-forms allow-scripts allow-same-origin" /></div> : <EmptyState title="No preview open" hint="Start your app in the configured workspace, then enter its private preview address." />}</section>}

              {(tab === 'terminal' || tab === 'more') && <section className="screen-section tools-screen"><div className="screen-heading"><div><p className="eyebrow">ADVANCED TOOLS</p><h1>{tab === 'terminal' ? 'Terminal' : 'More'}</h1><p className="screen-subtitle">Developer tools stay secondary to your conversation.</p></div></div>{tab === 'more' && <div className="more-grid"><button onClick={() => projectTab('terminal')}><Icon name="terminal" /><b>Terminal</b><span>Run a local command</span></button><button onClick={() => setPage('cloud')}><Icon name="cloud" /><b>Cloud workspace</b><span>Workspace details and controls</span></button><button onClick={() => setPage('tasks')}><Icon name="clock" /><b>Task history</b><span>Runs from this conversation</span></button><button onClick={() => setPage('settings')}><Icon name="settings" /><b>Preferences</b><span>Appearance and product settings</span></button></div>}{tab === 'terminal' && <div className="terminal-panel"><div className="terminal-note"><Icon name="monitor" />Local development shell adapter · output is shown only in this panel.</div><form className="terminal-command" onSubmit={(event) => { event.preventDefault(); runCmd(); }}><label htmlFor="command-input">Command</label><div><span>$</span><input id="command-input" value={cmd} onChange={(event) => setCmd(event.target.value)} aria-label="Command" /><Button>Run</Button></div></form><pre className="terminal-output">{termOut || 'No command has been run in this session.'}</pre><div className="terminal-keys">{['Ctrl', 'Tab', 'Esc', '↑', '↓', '←', '→'].map((key) => <kbd key={key}>{key}</kbd>)}</div></div>}</section>}
            </main>

            <aside className="context-panel" aria-label="Project context">
              <section className="context-card cloud-context"><div className="context-heading"><span className="context-icon cloud-icon"><Icon name="cloud" size={19} /></span><div><b>Cloud Workspace</b><small>{cloud?.provider === 'codespaces' ? 'GitHub Codespaces' : cloud?.state === 'ready' ? 'Local development provider' : 'Optional compute'}</small></div><Badge tone={cloud?.state === 'ready' ? 'ok' : cloud?.state === 'preparing' ? 'work' : 'neutral'}>{cloud?.state === 'ready' ? 'Active' : cloud?.state === 'preparing' ? 'Starting' : 'Off'}</Badge></div><div className="context-action-row"><span>{cloud?.state === 'ready' ? `Branch ${session.branch}` : 'Same project, optional compute'}</span>{cloud?.state === 'ready' ? <Button tone="ghost" onClick={() => setPage('cloud')}>Manage</Button> : <Button tone="ghost" onClick={workOnCloud}>Work on cloud</Button>}</div></section>
              <section className="context-card"><button className="context-title" onClick={() => setPage('projects')}>Project context <Icon name="chevron" size={14} /></button><dl className="context-list"><div><dt><Icon name="repo" />Repository</dt><dd>{session.project}</dd></div><div><dt><Icon name="branch" />Branch</dt><dd>{session.branch}</dd></div><div><dt><Icon name="commit" />Last commit</dt><dd>{changes.find((item: any) => item.commitSha)?.commitSha?.slice(0, 7) || '—'}</dd></div></dl></section>
              <section className="context-card"><button className="context-title" onClick={() => projectTab('changes')}>Recent changes <span className="heading-count">{changes.reduce((sum: number, item: any) => sum + (item.files?.length || 0), 0)}</span><Icon name="chevron" size={14} /></button>{changes[0]?.files?.length ? changes[0].files.slice(0, 4).map((file: any) => <div className="mini-change" key={file.path}><span className="mini-file"><Icon name="file" size={14} /></span><span>{file.path.split('/').pop()}</span><i className={`action-${file.action}`}>{file.action === 'create' ? '+' : file.action === 'delete' ? '−' : '~'}</i></div>) : <p className="context-empty">Changes appear here when the agent updates files.</p>}<button className="context-link" onClick={() => projectTab('changes')}>View all changes <Icon name="arrow" size={13} /></button></section>
              <section className="context-card preview-context"><button className="context-title" onClick={() => projectTab('preview')}>Preview <Badge tone={previewUrl ? 'ok' : 'neutral'}>{previewUrl ? 'Open' : 'Not running'}</Badge></button>{previewUrl ? <div className="preview-mini"><Icon name="preview" /><span>{previewUrl}</span></div> : <div className="context-empty">Run your app and add its preview URL to open it here.</div>}<Button tone="ghost" onClick={() => projectTab('preview')}>{previewUrl ? 'Open preview' : 'Set up preview'} <Icon name="arrow" size={13} /></Button></section>
            </aside>
          </div>
          {showLatest && tab === 'agent' && <div className="new-activity"><Button tone="ghost" onClick={jumpToLatest}>↓ New activity</Button></div>}
          {tab === 'agent' && <form className="composer" onSubmit={(event) => { event.preventDefault(); send(); }}><label className="attach-button" aria-label="Attach a device file"><Icon name="paperclip" /><input type="file" hidden onChange={upload} /></label><input value={input} onChange={(event) => { setInput(event.target.value); try { session && localStorage.setItem(draftKey(session.id), event.target.value); } catch {} }} placeholder={online ? 'Message Orlynx…' : 'Offline — draft saved'} aria-label="Message Orlynx" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} /><span className="model-indicator"><span className="model-spark">✳</span> Orlynx Agent</span>{isWorking ? <Button type="button" tone="ghost" onClick={cancelRun}>Stop</Button> : <Button type="submit" disabled={sending || !input.trim()} aria-label="Send message"><Icon name="send" /></Button>}</form>}
          <nav className="mobile-project-nav" role="tablist" aria-label="Project workspace">{projectTabs.filter((item) => item.id !== 'terminal').map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id || (item.id === 'more' && tab === 'terminal')} className={tab === item.id || (item.id === 'more' && tab === 'terminal') ? 'selected' : ''} onClick={() => projectTab(item.id)}><Icon name={item.icon} size={17} /><span>{item.id === 'agent' ? 'Chat' : item.id === 'more' ? 'More' : item.label}</span></button>)}</nav>
        </> : <>
          <header className="simple-header"><button className="brand-lockup compact" onClick={() => setPage(session ? 'home' : 'welcome')}><span className="brand-mark" /><b>Orlynx</b></button><div className="simple-header-actions">{github.connected ? <Badge tone="ok"><Icon name="github" /> GitHub connected</Badge> : <Badge><Icon name="github" /> GitHub not connected</Badge>}<button className="icon-button" aria-label="Settings" onClick={() => setPage('settings')}><Icon name="settings" /></button></div></header>
          <main className="page-body">
            {screenError && <div className="screen-alert" role="alert"><span>{screenError}</span><button onClick={() => setScreenError('')} aria-label="Dismiss"><Icon name="close" /></button></div>}
            {sendError && <div className="screen-alert" role="alert"><span>{sendError}</span><button onClick={() => setSendError('')} aria-label="Dismiss"><Icon name="close" /></button></div>}
            {booting ? <div className="loading-screen"><Spinner label="Restoring your Orlynx workspace" /><p>Restoring your workspace…</p></div> : null}
            {page === 'github' && repoLoading && <div className="repo-loading"><Spinner label="Checking GitHub access" /><span>Checking GitHub access…</span></div>}
            {!booting && page === 'welcome' && <section className="welcome-screen"><div className="welcome-mark"><span className="brand-mark" /></div><p className="eyebrow">YOUR DEVELOPMENT WORKSPACE</p><h1>Build from anywhere.</h1><p className="welcome-copy">One conversation. Your entire development workspace.</p><div className="welcome-actions"><Button onClick={() => { setPage('github'); loadGithubRepositories(); }}><Icon name="github" />Connect GitHub</Button><button className="text-button" onClick={() => openLocalProject('demo')}>Explore a local demo <Icon name="arrow" size={14} /></button></div><p className="setup-note">GitHub connects through your organization’s configured Orlynx server. No personal access token is requested here.</p><div className="welcome-capabilities"><span><Icon name="repo" />Import repositories</span><span><Icon name="agents" />Work with an agent</span><span><Icon name="cloud" />Optional cloud compute</span></div></section>}
            {!booting && page === 'home' && <section className="home-screen"><div className="home-greeting"><p className="eyebrow">ORLYNX WORKSPACE</p><h1>Welcome back.</h1><p>Pick up where you left off, or open a project to start something new.</p></div><div className="home-primary-actions"><Button onClick={() => setPage('projects')}><Icon name="plus" />Open a project</Button><Button tone="ghost" onClick={() => { setPage('github'); loadGithubRepositories(); }}><Icon name="github" />Browse GitHub</Button></div><div className="home-grid"><section className="home-section"><div className="section-title"><h2>Recent projects</h2><button className="text-button" onClick={() => setPage('projects')}>View all <Icon name="arrow" size={13} /></button></div>{recentProjects.length ? recentProjects.map((name) => <button className="project-list-row" key={name} onClick={() => openLocalProject(name)}><span className="repo-avatar"><Icon name={name.includes('/') ? 'github' : 'repo'} /></span><span><b>{name.split('/').pop()}</b><small>{name.includes('/') ? name : 'Local project'} · main</small></span><Icon name="chevron" /></button>) : <EmptyState title="No recent projects" hint="Open a local workspace or import a GitHub repository." />}</section><section className="home-section connect-summary"><div className="section-title"><h2>GitHub</h2><Badge tone={github.connected ? 'ok' : 'neutral'}>{github.connected ? 'Connected' : 'Not connected'}</Badge></div><p>{github.connected ? `${repositories.length || 'Your'} repositories are available to this server.` : 'Connect GitHub through your Orlynx server to browse and import repositories.'}</p><Button tone="ghost" onClick={() => { setPage('github'); loadGithubRepositories(); }}>{github.connected ? 'Choose a repository' : 'Connection details'} <Icon name="arrow" size={14} /></Button></section></div></section>}
            {!booting && page === 'projects' && <section className="screen-section projects-screen"><div className="screen-heading"><div><p className="eyebrow">YOUR WORKSPACES</p><h1>Projects</h1><p className="screen-subtitle">Open a recent project or bring a repository into Orlynx.</p></div></div><form className="new-project-form" onSubmit={(event) => { event.preventDefault(); openLocalProject(projectName); }}><div><label htmlFor="new-project">Open local project</label><p>Creates or resumes an Orlynx-managed local Git repository.</p></div><div><Input id="new-project" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Project name" required /><Button><Icon name="plus" />Open project</Button></div></form><div className="section-title"><h2>Recent</h2><button className="text-button" onClick={() => { setPage('github'); loadGithubRepositories(); }}>Browse GitHub <Icon name="arrow" size={13} /></button></div>{recentProjects.length ? <div className="project-grid">{recentProjects.map((name) => <button className="project-card" key={name} onClick={() => openLocalProject(name)}><span className="repo-avatar"><Icon name={name.includes('/') ? 'github' : 'repo'} /></span><span><b>{name.split('/').pop()}</b><small>{name.includes('/') ? name : 'Local repository'}</small></span><Icon name="chevron" /></button>)}</div> : <EmptyState title="No projects yet" hint="Open a local project or connect a GitHub repository to get started." />}</section>}
            {!booting && page === 'github' && <section className="screen-section github-screen"><button className="back-link" onClick={() => setPage(session ? 'workspace' : 'welcome')}>‹ Back</button><div className="screen-heading"><div><p className="eyebrow">REPOSITORY ACCESS</p><h1>Connect GitHub</h1><p className="screen-subtitle">Choose repositories this Orlynx server is authorized to access.</p></div><span className="github-mark"><Icon name="github" size={28} /></span></div><div className="github-connection"><span className={`connection-indicator ${github.connected ? 'is-connected' : ''}`} /><div><b>{github.connected ? 'GitHub access is configured' : 'GitHub is not connected'}</b><p>{github.connected ? 'Repository access uses credentials configured securely by your Orlynx administrator.' : 'GitHub App / OAuth authorization is not configured for this server. Contact your administrator to enable it.'}</p></div><Button tone="ghost" onClick={loadGithubRepositories}><Icon name="refresh" />Check again</Button></div>{!github.connected ? <div className="secure-note"><Icon name="shield" /><div><b>Credentials stay server-side</b><p>Orlynx never asks you to paste a personal access token into this screen. Once GitHub authorization is enabled, repository access appears here.</p></div></div> : <><div className="repo-picker-heading"><div><h2>Choose a repository</h2><p>Private, personal, and organization repositories available to this connection.</p></div><label className="search-field"><Icon name="search" /><input placeholder="Search repositories…" value={repoQuery} onChange={(event) => setRepoQuery(event.target.value)} /></label></div><div className="filter-row">{(['all', 'personal', 'organizations', 'recent'] as const).map((filter) => <button className={repoFilter === filter ? 'active' : ''} key={filter} onClick={() => setRepoFilter(filter)}>{filter === 'all' ? 'All' : filter === 'personal' ? 'Personal' : filter === 'organizations' ? 'Organizations' : 'Recently used'}</button>)}</div><div className="repo-picker">{visibleRepos.map((repo) => <button className={`github-repo-row ${selectedRepo?.full === repo.full ? 'selected' : ''}`} key={repo.full} onClick={() => chooseRepository(repo)}><span className="repo-avatar"><Icon name="github" /></span><span className="github-repo-copy"><b>{repo.full}</b><small>{repo.ownerType || 'Owner'}{repo.language ? ` · ${repo.language}` : ''} · Updated {new Date(repo.updatedAt).toLocaleDateString()}</small></span><Badge>{repo.private ? 'Private' : 'Public'}</Badge><Icon name="chevron" /></button>)}{!visibleRepos.length && <EmptyState title="No repositories found" hint={repositories.length ? 'Try another filter or search term.' : 'This GitHub connection has no repository access yet.'} />}</div>{selectedRepo && <div className="selected-repository"><div><b>{selectedRepo.full}</b><small>Choose a branch to import.</small></div><select aria-label="Repository branch" value={branch} onChange={(event) => setBranch(event.target.value)}>{branches.map((name) => <option key={name} value={name}>{name}</option>)}</select><Button onClick={importRepository}>Import & open project <Icon name="arrow" size={14} /></Button></div>}</>}</section>}
            {!booting && page === 'agents' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">AGENT WORKSPACE</p><h1>Agents</h1><p className="screen-subtitle">The current server runs Orlynx’s native demonstration adapter.</p></div></div><section className="agent-config-row"><span className="agent-avatar"><Icon name="agents" /></span><div><b>Orlynx Agent</b><p>Native local adapter · available</p></div><Badge tone="ok">Available</Badge><Button onClick={() => session ? setPage('workspace') : openLocalProject('demo')}>Open chat</Button></section><section className="provider-notice"><h2>Other agent providers</h2><p>OpenCode and Cline process connections are not configured in this build. They are listed as integration seams and are not presented as active agents.</p><Button tone="ghost" onClick={() => setPage('settings')}>Provider details</Button></section>{session && <section className="home-section"><div className="section-title"><h2>Recent tasks</h2><button className="text-button" onClick={() => setPage('tasks')}>View history</button></div><div className="task-row" onClick={() => setPage('workspace')} role="button" tabIndex={0}><Icon name="clock" /><span><b>{session.checkpoint?.goal || 'Current project conversation'}</b><small>{session.project} · {lastRun?.state || 'ready'}</small></span><Badge tone={lastRun?.state === 'failed' ? 'fail' : lastRun?.state === 'running' ? 'work' : 'neutral'}>{lastRun?.state || 'idle'}</Badge></div></section>}</section>}
            {!booting && page === 'cloud' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">OPTIONAL COMPUTE</p><h1>Cloud workspace</h1><p className="screen-subtitle">Add compute to the same conversation when your task needs it.</p></div></div>{!session ? <EmptyState title="Open a project first" hint="Cloud workspaces attach to a project conversation." /> : <><section className="cloud-detail-card"><div className="cloud-detail-top"><span className="context-icon cloud-icon"><Icon name="cloud" size={24} /></span><div><h2>{cloud?.state === 'ready' ? 'Workspace active' : cloud?.state === 'preparing' ? 'Preparing workspace…' : 'No cloud workspace'}</h2><p>{cloud?.provider === 'codespaces' ? 'GitHub Codespaces provider' : 'Local provider'} · {session.project} · {session.branch}</p></div><Badge tone={cloud?.state === 'ready' ? 'ok' : cloud?.state === 'preparing' ? 'work' : 'neutral'}>{cloud?.state || 'stopped'}</Badge></div>{cloud?.state === 'preparing' ? <CloudTransition state="preparing" /> : <p className="cloud-description">Your conversation, files, and changes stay in this project. The current local workspace adapter simulates readiness; remote Codespaces provisioning is not enabled.</p>}<div className="cloud-controls">{cloud?.state === 'ready' ? <><Button tone="ghost" onClick={() => refresh(session.id)}><Icon name="refresh" />Refresh status</Button><Button tone="danger" onClick={async () => { await fetch(`/v1/sessions/${session.id}/cloud/stop`, { method: 'POST' }); await refresh(session.id); }}><Icon name="close" />Stop workspace</Button></> : <Button onClick={workOnCloud}><Icon name="cloud" />Work on cloud</Button>}<Button tone="ghost" onClick={() => { setPage('workspace'); projectTab('agent'); }}>Return to conversation</Button></div></section>{cloud?.state === 'failed' && <AgentErrorCard title="Cloud workspace disconnected." hint="Your conversation and changes are safe." onReconnect={workOnCloud} onRetry={() => refresh(session.id)} />}</>}</section>}
            {!booting && page === 'settings' && <section className="screen-section settings-screen"><div className="screen-heading"><div><p className="eyebrow">ORLYNX PREFERENCES</p><h1>Settings</h1><p className="screen-subtitle">Manage account connections and the way Orlynx looks.</p></div></div><section className="settings-group"><h2>Account</h2><div className="settings-row"><span className="settings-icon"><Icon name="agents" /></span><span><b>Local workspace</b><small>Local development profile · no email configured</small></span><Badge>Local</Badge></div></section><section className="settings-group"><h2>GitHub</h2><div className="settings-row"><span className="settings-icon"><Icon name="github" /></span><span><b>{github.connected ? 'Server connection active' : 'Not connected'}</b><small>{github.connected ? 'Credentials are managed by the Orlynx server.' : 'GitHub App authorization is not configured on this server.'}</small></span><Button tone="ghost" onClick={() => { setPage('github'); loadGithubRepositories(); }}>{github.connected ? 'Repositories' : 'Details'}</Button></div></section><section className="settings-group"><h2>AI providers</h2><div className="settings-row"><span className="settings-icon"><Icon name="agents" /></span><span><b>Orlynx native adapter</b><small>Local demonstration engine · configured by this server</small></span><Badge tone="ok">Available</Badge></div><p className="settings-footnote">OpenAI, Anthropic, Gemini, OpenCode, Cline, and local model credentials are not configurable in this build.</p></section><section className="settings-group"><h2>Cloud</h2><div className="settings-row"><span className="settings-icon"><Icon name="cloud" /></span><span><b>{cloud?.state === 'ready' ? 'Workspace ready' : 'Optional workspace'}</b><small>{cloud?.provider === 'codespaces' ? 'GitHub Codespaces' : 'Local provider adapter'}</small></span><Button tone="ghost" onClick={() => setPage('cloud')}>Manage</Button></div></section><section className="settings-group"><h2>Appearance</h2><div className="settings-row"><span><b>Theme</b><small>Warm light is the Orlynx reference appearance.</small></span><select value={theme} onChange={(event) => setTheme(event.target.value)} aria-label="Appearance theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div></section><section className="settings-group"><h2>Agent defaults</h2><div className="settings-row"><span><b>Default agent</b><small>Orlynx Agent · native demo adapter</small></span><Badge>Agent</Badge></div></section><section className="settings-group"><h2>Notifications & security</h2><div className="settings-row"><span><b>Meaningful milestones</b><small>Live updates announce completion and failures, not log lines.</small></span><Icon name="shield" /></div></section><section className="settings-group"><h2>Advanced</h2><div className="settings-row"><span><b>Session data</b><small>Stored by the local API in its ignored runtime data directory.</small></span><button className="text-button" onClick={() => session ? setPage('tasks') : setPage('projects')}>View session <Icon name="arrow" size={13} /></button></div></section></section>}
            {!booting && page === 'tasks' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">CONVERSATION HISTORY</p><h1>Recent tasks</h1><p className="screen-subtitle">Runs available in the current project session.</p></div></div>{session && lastRun ? <button className="task-row" onClick={() => setPage('workspace')}><Icon name="clock" /><span><b>{session.checkpoint?.goal || 'Project conversation'}</b><small>{session.project} · {lastRun.engine || 'Orlynx Agent'} · {new Date(lastRun.startedAt).toLocaleString()}</small></span><Badge tone={lastRun.state === 'failed' ? 'fail' : lastRun.state === 'running' ? 'work' : 'ok'}>{lastRun.state}</Badge></button> : <EmptyState title="No tasks yet" hint="Start a conversation in a project and its work will appear here." />}</section>}
            {!booting && page === 'search' && <section className="screen-section search-screen"><button className="back-link" onClick={() => setPage(session ? 'workspace' : 'home')}>‹ Back</button><div className="screen-heading"><div><p className="eyebrow">SEARCH ORLYNX</p><h1>Find something</h1></div></div><label className="global-search search-page-input"><Icon name="search" /><input autoFocus placeholder="Search projects, files, tasks…" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} /></label><div className="search-results">{recentProjects.filter((item) => item.toLowerCase().includes(searchQuery.toLowerCase())).map((item) => <button className="project-list-row" key={item} onClick={() => openLocalProject(item)}><Icon name="repo" /><span><b>{item}</b><small>Project</small></span><Icon name="chevron" /></button>)}{session && files.filter((file: any) => file.name.toLowerCase().includes(searchQuery.toLowerCase())).map((file: any) => <button className="project-list-row" key={file.name} onClick={() => { setPage('workspace'); projectTab('files'); if (!file.dir) viewFile(file.name); }}><Icon name={file.dir ? 'folder' : 'file'} /><span><b>{file.name}</b><small>File in {session.project}</small></span><Icon name="chevron" /></button>)}{!searchQuery && <p className="screen-subtitle">Search your recent projects and the currently open project’s files.</p>}</div></section>}
          </main>
          {!['welcome', 'github'].includes(page) && <nav className="mobile-global-nav" aria-label="Main navigation">{globalNav.map((item) => <button className={page === item.page ? 'selected' : ''} key={item.page} onClick={() => setPage(item.page)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav>}
        </>}
      </div>
    </div>
  );
}
