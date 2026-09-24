import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';
import { j } from './api';
import { Badge, Button, EmptyState, Icon, Input, Spinner } from './ui/primitives';
import { AgentApprovalCard, AgentErrorCard, AttachmentChip, DiffSummary, TaskActivityRow } from './ui/product';
import { toActivities } from './ui/mapping';

type Page = 'welcome' | 'home' | 'projects' | 'github' | 'agents' | 'settings' | 'cloud' | 'tasks' | 'search' | 'workspace';
type Tab = 'chat' | 'files' | 'changes' | 'preview' | 'terminal' | 'more';
type Repo = { full: string; owner: string; name: string; ownerType: string; private: boolean; defaultBranch: string; language?: string | null; updatedAt?: string; installationId?: number };
const LAST_SESSION = 'orlynx:lastSession';
const RECENTS = 'orlynx:recentProjects';
const THEME = 'orlynx:theme';
const sessionKey = (project: string) => `orlynx:projectSession:${project}`;
const seqKey = (sessionId: string) => `orlynx:seq:${sessionId}`;
const draftKey = (sessionId: string) => `orlynx:draft:${sessionId}`;
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export default function ProductionApp() {
  const [page, setPage] = useState<Page>('welcome');
  const [tab, setTab] = useState<Tab>('chat');
  const [session, setSession] = useState<any>(null);
  const [lastRun, setLastRun] = useState<any>(null);
  const [integration, setIntegration] = useState<any>({ github: {}, agent: {}, cloud: {} });
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoQuery, setRepoQuery] = useState('');
  const [repoFilter, setRepoFilter] = useState('all');
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState('');
  const [messages, setMessages] = useState<any[]>([]);
  const [draftReply, setDraftReply] = useState('');
  const [events, setEvents] = useState<any[]>([]);
  const [files, setFiles] = useState<any[]>([]);
  const [folder, setFolder] = useState('');
  const [fileFilter, setFileFilter] = useState('');
  const [openedFile, setOpenedFile] = useState<any>(null);
  const [changes, setChanges] = useState<any[]>([]);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [uploads, setUploads] = useState<{ id: string; name: string; status: string }[]>([]);
  const [composer, setComposer] = useState('');
  const [sending, setSending] = useState(false);
  const [online, setOnline] = useState(typeof navigator === 'undefined' || navigator.onLine);
  const [streamStatus, setStreamStatus] = useState('live');
  const [repoBusy, setRepoBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [error, setError] = useState('');
  const [recentProjects, setRecentProjects] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(RECENTS) || '[]').filter((name: string) => name.includes('/')); } catch { return []; } });
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem(THEME) || 'light'; } catch { return 'light'; } });
  const [command, setCommand] = useState('');
  const [terminalOutput, setTerminalOutput] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [search, setSearch] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [busyChange, setBusyChange] = useState<string | null>(null);
  const [pushReview, setPushReview] = useState<any>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const [newActivity, setNewActivity] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  const seenRef = useRef(new Set<string>());
  const currentSessionRef = useRef<any>(null);
  const pendingRef = useRef<any[]>([]);
  const rafRef = useRef<number | null>(null);
  const runRef = useRef<any>(null);
  const repoLoadAttempt = useRef(false);

  const refreshIntegrations = useCallback(async () => {
    try { setIntegration(await j<any>(await fetch('/v1/integrations/status'))); }
    catch { setIntegration({ github: { configured: false, connected: false }, agent: { configured: false, connected: false }, cloud: { configured: false, connected: false } }); }
  }, []);

  const refreshSession = useCallback(async (id: string) => {
    const [messageData, fileData, changeData, details, runData, attachmentData] = await Promise.all([
      j<any[]>(await fetch(`/v1/sessions/${id}/messages`)),
      j<any>(await fetch(`/v1/sessions/${id}/files`)),
      j<any[]>(await fetch(`/v1/sessions/${id}/changes`)),
      j<any>(await fetch(`/v1/sessions/${id}`)),
      j<any[]>(await fetch(`/v1/sessions/${id}/runs`)),
      j<any[]>(await fetch(`/v1/sessions/${id}/attachments`)),
    ]);
    setMessages(messageData); setFiles(fileData.files || []); setChanges(changeData); setAttachments(attachmentData);
    setLastRun(runData.slice(-1)[0] || null); runRef.current = runData.slice(-1)[0] || null;
    setSession(details); currentSessionRef.current = details;
  }, []);

  const ingest = useCallback((sessionId: string, event: any) => {
    if (!event?.eventId || seenRef.current.has(event.eventId)) return;
    seenRef.current.add(event.eventId); pendingRef.current.push(event);
    seqRef.current = Math.max(seqRef.current, Number(event.sequence) || 0);
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const batch = pendingRef.current.splice(0);
      setEvents((previous) => [...previous, ...batch].sort((a, b) => a.sequence - b.sequence).slice(-300));
      const textEvents = batch.filter((item) => item.type === 'message.delta');
      if (textEvents.length) setDraftReply((previous) => previous + textEvents.map((item) => String(item.payload?.delta || '')).join(''));
      for (const item of batch) {
        if (['run.completed', 'run.failed', 'receipt.created', 'changes.updated'].includes(item.type)) refreshSession(sessionId).catch(() => {});
        if (item.type === 'run.started') setLastRun({ id: item.runId, state: 'running', engine: 'opencode', startedAt: item.timestamp });
        if (!nearBottom) setNewActivity(true);
      }
      try { localStorage.setItem(seqKey(sessionId), String(seqRef.current)); } catch {}
    });
  }, [nearBottom, refreshSession]);

  const connectEvents = useCallback((sessionId: string) => {
    sourceRef.current?.close();
    if (retryRef.current) clearTimeout(retryRef.current);
    const attempt = () => {
      if (!navigator.onLine) { setStreamStatus('offline'); retryRef.current = setTimeout(attempt, 3000); return; }
      const source = new EventSource(`/v1/sessions/${sessionId}/events?after=${seqRef.current}`);
      sourceRef.current = source;
      source.onmessage = (message) => { setStreamStatus('live'); try { ingest(sessionId, JSON.parse(message.data)); } catch { setError('Orlynx received an invalid activity event.'); } };
      source.onerror = () => { source.close(); setStreamStatus('reconnecting'); retryRef.current = setTimeout(attempt, 3000); };
    };
    attempt();
  }, [ingest]);

  const openSession = useCallback(async (record: any) => {
    sourceRef.current?.close();
    seqRef.current = Number(localStorage.getItem(seqKey(record.id)) || 0);
    seenRef.current = new Set(); pendingRef.current = []; setEvents([]); setDraftReply(''); setPushReview(null);
    setFolder(''); setOpenedFile(null); setError(''); setTab('chat'); setPage('workspace');
    setSession(record); currentSessionRef.current = record;
    try {
      localStorage.setItem(LAST_SESSION, JSON.stringify({ id: record.id, project: record.project }));
      localStorage.setItem(sessionKey(record.project), record.id);
    } catch {}
    setRecentProjects((previous) => { const next = [record.project, ...previous.filter((item) => item !== record.project)].filter((name) => name.includes('/')).slice(0, 8); try { localStorage.setItem(RECENTS, JSON.stringify(next)); } catch {} return next; });
    await refreshSession(record.id);
    setRestoring(false); connectEvents(record.id);
  }, [connectEvents, refreshSession]);

  useEffect(() => {
    refreshIntegrations();
    const callback = new URLSearchParams(window.location.search).get('github');
    if (callback) { setPage('github'); window.history.replaceState({}, '', '/'); }
    const boot = async () => {
      try {
        const stored = localStorage.getItem(LAST_SESSION);
        if (stored) {
          const { id } = JSON.parse(stored);
          const response = await fetch(`/v1/sessions/${id}`);
          if (response.ok) { const project = await response.json(); if (project.owner !== 'local' && project.owner) await openSession(project); }
        }
      } catch { setError('Your previous project could not be restored. Reconnect GitHub and import it again.'); }
      setRestoring(false);
    };
    boot();
    const onOnline = () => { setOnline(true); if (currentSessionRef.current) connectEvents(currentSessionRef.current.id); };
    const onOffline = () => { setOnline(false); setStreamStatus('offline'); };
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
    return () => { sourceRef.current?.close(); if (retryRef.current) clearTimeout(retryRef.current); if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, [connectEvents, openSession, refreshIntegrations]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme; };
    apply(); if (theme === 'system') media.addEventListener('change', apply);
    try { localStorage.setItem(THEME, theme); } catch {}
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    const onScroll = () => { const distance = document.documentElement.scrollHeight - innerHeight - scrollY; const atBottom = distance < 140; setNearBottom(atBottom); if (atBottom) setNewActivity(false); };
    addEventListener('scroll', onScroll, { passive: true }); return () => removeEventListener('scroll', onScroll);
  }, []);

  async function loadRepositories() {
    setRepoBusy(true); setError('');
    try { const response = await j<any>(await fetch('/v1/repos')); setIntegration((current: any) => ({ ...current, github: response.connection })); setRepos(response.github || []); setSelectedRepo(null); setBranches([]); }
    catch (error: any) { setError(error.message || 'GitHub repositories could not be loaded.'); }
    finally { setRepoBusy(false); }
  }

  useEffect(() => {
    if (!integration.github?.connected) { repoLoadAttempt.current = false; return; }
    if (page === 'github' && !repoLoadAttempt.current) { repoLoadAttempt.current = true; loadRepositories(); }
  }, [page, integration.github?.connected]);

  async function selectRepository(repo: Repo) {
    setSelectedRepo(repo); setBranch(repo.defaultBranch);
    try { const result = await j<any>(await fetch(`/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/branches`)); setBranches(result.branches?.length ? result.branches : [repo.defaultBranch]); }
    catch (error: any) { setBranches([]); setError(error.message || 'Branches could not be loaded.'); }
  }

  async function importSelectedRepository() {
    if (!selectedRepo || !branch) return;
    setRepoBusy(true); setError('');
    try {
      await j(await fetch('/v1/repos/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: selectedRepo.full, branch }) }));
      const record = await j<any>(await fetch('/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: selectedRepo.full, owner: selectedRepo.owner, branch }) }));
      await openSession(record);
    } catch (error: any) { setError(error.message || 'Import failed. GitHub was not changed.'); }
    finally { setRepoBusy(false); }
  }

  async function openRecentProject(project: string) {
    try {
      const id = localStorage.getItem(sessionKey(project));
      if (!id) throw new Error('No saved Orlynx conversation exists for this repository. Open the repository to start one.');
      const response = await fetch(`/v1/sessions/${id}`);
      if (!response.ok) throw new Error('The repository session is no longer available. Re-import the repository.');
      await openSession(await response.json());
    } catch (error: any) { setError(error.message || 'Project could not be opened.'); }
  }

  async function sendMessage() {
    if (!session || !composer.trim() || sending || !online) return;
    setSending(true); setError('');
    const text = composer.trim(); const clientId = uid();
    try {
      const result = await j<any>(await fetch(`/v1/sessions/${session.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, clientId }) }));
      setComposer(''); setDraftReply(''); try { localStorage.removeItem(draftKey(session.id)); } catch {}
      setLastRun(result.run); runRef.current = result.run;
      await refreshSession(session.id);
    } catch (error: any) { setError(error.message || 'OpenCode could not accept the task. The draft is preserved.'); }
    finally { setSending(false); }
  }

  async function stopRun() {
    const running = events.slice().reverse().find((event) => event.type === 'run.started')?.runId || lastRun?.id;
    if (!session || !running) return;
    try { await j(await fetch(`/v1/agent-runs/${running}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id }) })); await refreshSession(session.id); }
    catch (error: any) { setError(error.message || 'OpenCode could not stop the current task.'); }
  }

  async function openFolder(path: string) {
    if (!session) return; setFileBusy(true); setFolder(path); setOpenedFile(null);
    try { const result = await j<any>(await fetch(`/v1/sessions/${session.id}/files?path=${encodeURIComponent(path)}`)); setFiles(result.files || []); }
    catch (error: any) { setError(error.message || 'Folder could not be read.'); }
    finally { setFileBusy(false); }
  }

  async function openFile(path: string) {
    if (!session) return;
    try { setOpenedFile(await j<any>(await fetch(`/v1/sessions/${session.id}/file?path=${encodeURIComponent(path)}`))); }
    catch (error: any) { setError(error.message || 'File could not be read.'); }
  }

  async function uploadFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!session || !file) return;
    const id = uid(); setUploads((items) => [...items, { id, name: file.name, status: 'uploading' }]);
    try {
      const form = new FormData(); form.append('file', file);
      await j(await fetch(`/v1/sessions/${session.id}/attachments`, { method: 'POST', body: form }));
      setUploads((items) => items.map((item) => item.id === id ? { ...item, status: 'Available to OpenCode' } : item));
      setAttachments(await j<any[]>(await fetch(`/v1/sessions/${session.id}/attachments`)));
    } catch (error: any) { setUploads((items) => items.map((item) => item.id === id ? { ...item, status: 'failed' } : item)); setError(error.message || 'Upload failed.'); }
  }

  async function runTerminalCommand() {
    if (!session || !command.trim()) return;
    try { const result = await j<any>(await fetch(`/v1/sessions/${session.id}/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: command }) })); setTerminalOutput(result.out || '(command produced no output)'); }
    catch (error: any) { setTerminalOutput(error.message || 'OpenCode shell request failed.'); }
  }

  async function reviewChange(change: any) {
    setBusyChange(change.id); setError('');
    try { await j(await fetch(`/v1/changes/${change.id}/approve`, { method: 'POST' })); await refreshSession(session.id); }
    catch (error: any) { setError(error.message || 'Change approval failed.'); }
    finally { setBusyChange(null); }
  }

  async function commitChange(change: any) {
    setBusyChange(change.id); setError('');
    try { await j(await fetch(`/v1/changes/${change.id}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: commitMessage.trim() }) })); await refreshSession(session.id); }
    catch (error: any) { setError(error.message || 'Commit failed.'); }
    finally { setBusyChange(null); }
  }

  async function pushChange(change: any) {
    setBusyChange(change.id); setError('');
    try { await j(await fetch(`/v1/changes/${change.id}/push`, { method: 'POST' })); setPushReview(null); await refreshSession(session.id); }
    catch (error: any) { setError(error.message || 'Push failed. The local commit remains available.'); }
    finally { setBusyChange(null); }
  }

  const filteredRepos = repos.filter((repo) => {
    const matches = `${repo.full} ${repo.language || ''}`.toLowerCase().includes(repoQuery.toLowerCase());
    if (!matches) return false;
    if (repoFilter === 'organizations') return repo.ownerType === 'Organization';
    if (repoFilter === 'personal') return repo.ownerType !== 'Organization';
    if (repoFilter === 'recent') return recentProjects.includes(repo.full);
    return true;
  });
  const activities = useMemo(() => toActivities(events), [events]);
  const currentActivity = [...activities].reverse().find((event) => event.state === 'running' || event.state === 'waiting');
  const running = lastRun?.state === 'running' || lastRun?.state === 'queued' || activities.some((event) => event.state === 'running');
  const globalNav = [
    ['home', 'Home', 'home'], ['projects', 'Projects', 'folder'], ['agents', 'Agents', 'agents'], ['cloud', 'Cloud', 'cloud'], ['settings', 'Settings', 'settings'],
  ] as const;
  const tabs = [
    ['chat', 'Chat', 'inbox'], ['files', 'Files', 'folder'], ['changes', `Changes${changes.length ? ` ${changes.reduce((sum: number, change: any) => sum + (change.files?.length || 0), 0)}` : ''}`, 'commit'], ['preview', 'Preview', 'preview'], ['terminal', 'Terminal', 'terminal'], ['more', 'More', 'more'],
  ] as const;

  return (
    <div className={`orlynx-app ${page === 'workspace' ? 'is-workspace' : ''} ${page === 'welcome' ? 'is-welcome' : ''}`}>
      {page !== 'welcome' && <aside className="sidebar">
        <button className="brand-lockup" onClick={() => setPage(session ? 'home' : 'github')}><span className="brand-mark" /><span><b>Orlynx</b><small>Your development workspace</small></span></button>
        <nav className="side-nav" aria-label="Main navigation">{globalNav.map(([id, label, icon]) => <button key={id} className={page === id ? 'selected' : ''} onClick={() => setPage(id)}><Icon name={icon} />{label}</button>)}</nav>
        <div className="sidebar-section"><div className="sidebar-title">Recent repositories</div>{recentProjects.slice(0, 5).map((name) => <button className={`recent-project ${session?.project === name ? 'selected' : ''}`} key={name} onClick={() => openRecentProject(name)}><span className="repo-avatar"><Icon name="github" size={15} /></span><span className="recent-project-copy"><b>{name.split('/').pop()}</b><small><Icon name="branch" size={12} />{session?.project === name ? session.branch : 'Imported'}</small></span></button>)}<button className="side-link" onClick={() => setPage('projects')}>View repositories <Icon name="arrow" size={14} /></button></div>
        <div className="sidebar-account"><span className="account-avatar"><Icon name="github" /></span><span><b>{integration.github?.installations?.[0]?.account || 'GitHub account'}</b><small>{integration.github?.connected ? 'GitHub App installed' : 'GitHub App not connected'}</small></span><button className="icon-button" aria-label="Account settings" onClick={() => setPage('settings')}><Icon name="more" /></button></div>
      </aside>}
      <div className="app-main">
        {page === 'workspace' && session ? <>
          <header className="project-header"><div className="repo-identity"><span className="repo-avatar large"><Icon name="github" size={18} /></span><div><b>{session.project.split('/').pop()}</b><span><Icon name="branch" size={13} />{session.branch}</span></div><button className="icon-button" aria-label="Repositories" onClick={() => setPage('projects')}><Icon name="chevron" /></button></div><button className="global-search" onClick={() => setPage('search')}><Icon name="search" /><span>Search files, commands, or tasks…</span><kbd>⌘ K</kbd></button><div className="header-actions"><Button className="cloud-action" disabled={!integration.cloud?.connected} onClick={() => setPage('cloud')}><Icon name="cloud" />{integration.cloud?.connected ? 'Cloud workspace' : 'Cloud unavailable'}</Button><button className="icon-button" aria-label="Project settings" onClick={() => setPage('settings')}><Icon name="more" /></button></div></header>
          <nav className="project-tabs" role="tablist" aria-label="Project workspace">{tabs.map(([id, label, icon]) => <button role="tab" key={id} aria-selected={tab === id} className={tab === id ? 'selected' : ''} onClick={() => { setTab(id); setOpenedFile(null); }}><Icon name={icon} size={16} /><span>{label}</span></button>)}</nav>
          {!online && <div className="offline-banner"><Icon name="cloud" />Offline. Drafts remain on this device; no task was sent.</div>}
          {error && <div className="screen-alert" role="alert"><span>{error}</span><button aria-label="Dismiss" onClick={() => setError('')}><Icon name="close" /></button></div>}
          <div className="workspace-layout">
            <main className="workspace-main">
              {tab === 'chat' && <section className="conversation">
                {!messages.length && <div className="conversation-intro"><span className="agent-avatar"><Icon name="agents" /></span><div><h2>Work with OpenCode</h2><p>Tasks are sent to the connected OpenCode server operating on this imported repository.</p></div></div>}
                {messages.map((message) => <article className={`message-row ${message.role === 'user' ? 'user-message' : 'assistant-message'}`} key={message.id}><span className={message.role === 'user' ? 'user-avatar' : 'agent-avatar'}><Icon name={message.role === 'user' ? 'github' : 'agents'} size={16} /></span><div className="message-content"><div className="message-meta"><b>{message.role === 'user' ? 'You' : 'OpenCode'}</b><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><div className="message-text">{message.text}</div></div></article>)}
                {draftReply && <article className="message-row assistant-message"><span className="agent-avatar"><Icon name="agents" /></span><div className="message-content"><div className="message-meta"><b>OpenCode</b><span className="live-reply-indicator">Working</span></div><div className="message-text">{draftReply}<span className="stream-caret" /></div></div></article>}
                {!!attachments.length && <div className="chat-attachments">{attachments.map((item: any) => <AttachmentChip key={item.id} name={item.filename} state="agent" />)}</div>}
                {uploads.map((item) => <div className="upload-state" key={item.id}><Icon name="file" />{item.name}<Badge tone={item.status === 'failed' ? 'fail' : 'ok'}>{item.status}</Badge></div>)}
                {!!events.length && <div className="workstream-wrap"><ActivityList activities={activities} /></div>}
                {lastRun?.state === 'failed' && <AgentErrorCard title="OpenCode could not complete this task." hint="The repository and local changes remain available." onRetry={() => refreshSession(session.id)} />}
              </section>}
              {tab === 'files' && <section className="screen-section files-screen"><div className="screen-heading"><div><p className="eyebrow">IMPORTED REPOSITORY</p><h1>Files</h1><p className="screen-subtitle">Read files from {session.project} at {session.branch}.</p></div><label className="search-field"><Icon name="search" /><input value={fileFilter} onChange={(event) => setFileFilter(event.target.value)} placeholder="Filter current folder" /></label></div>{openedFile ? <div className="code-viewer"><div className="code-titlebar"><button className="text-button" onClick={() => setOpenedFile(null)}>‹ Files</button><span><Icon name="file" />{openedFile.path}</span></div><pre>{openedFile.content}</pre></div> : <><div className="breadcrumbs"><button onClick={() => openFolder('')}>{session.project}</button>{folder.split('/').filter(Boolean).map((part, index, parts) => <React.Fragment key={`${part}-${index}`}><Icon name="chevron" size={12} /><button onClick={() => openFolder(parts.slice(0, index + 1).join('/'))}>{part}</button></React.Fragment>)}</div><div className="file-list">{fileBusy ? <div className="loading-screen"><Spinner /><p>Loading repository files…</p></div> : files.filter((item: any) => item.name.toLowerCase().includes(fileFilter.toLowerCase())).map((item: any) => <button className="file-row" key={item.name} onClick={() => item.dir ? openFolder([folder, item.name].filter(Boolean).join('/')) : openFile([folder, item.name].filter(Boolean).join('/'))}><span className="file-kind"><Icon name={item.dir ? 'folder' : 'file'} /></span><span>{item.name}{item.dir ? '/' : ''}</span><Icon name="chevron" size={14} /></button>)}</div></>}</section>}
              {tab === 'changes' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">REVIEW BEFORE PUSHING</p><h1>Changes</h1><p className="screen-subtitle">Review the changes OpenCode made to this imported repository.</p></div></div>{!changes.length && <EmptyState title="No changes to review" hint="OpenCode changes will appear here after the server reports a diff." />}{changes.map((change: any) => <section className="change-set" key={change.id}><div className="change-set-heading"><div><b>{change.files.length} changed file{change.files.length === 1 ? '' : 's'}</b><span className="small">Base {change.baseSha?.slice(0, 7)}</span></div><Badge tone={change.pushedAt ? 'ok' : change.reviewState === 'pending' ? 'wait' : 'neutral'}>{change.pushedAt ? 'Pushed' : change.reviewState}</Badge></div><DiffSummary files={change.files.map((file: any) => ({ path: file.path, action: file.action }))} />{change.files.map((file: any) => <details className="diff-file" key={file.path}><summary>{file.path}</summary><p className="diff-explanation">OpenCode workspace diff</p><pre>{file.diff || file.after || file.before || '(binary or empty file)'}</pre></details>)}{change.reviewState === 'pending' && <AgentApprovalCard title="Approve this local commit" detail="Review every file above. Push is a separate action." busy={busyChange === change.id} onCancel={() => {}} onApprove={() => reviewChange(change)} />}{change.reviewState === 'approved' && <div className="commit-form"><label>Commit message<input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Describe this change" /></label><Button disabled={!commitMessage.trim() || busyChange === change.id} onClick={() => commitChange(change)}>{busyChange === change.id ? 'Committing…' : 'Create commit'}</Button></div>}{change.reviewState === 'committed' && !change.pushedAt && <div className="commit-success"><Icon name="check" />Commit {change.commitSha?.slice(0, 7)} is local and ready.<Button tone="ghost" onClick={() => setPushReview(change)}>Review push</Button></div>}{change.pushedAt && <Badge tone="ok">Pushed to {session.branch}</Badge>}{pushReview?.id === change.id && <div className="push-confirm"><b>Push {change.files.length} files to {session.project} · {session.branch}?</b><p>This writes the approved commit to GitHub.</p><div className="action-row"><Button tone="ghost" onClick={() => setPushReview(null)}>Cancel</Button><Button onClick={() => pushChange(change)} disabled={busyChange === change.id}>Approve & push</Button></div></div>}</section>)}</section>}
              {tab === 'preview' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">CONNECTED APP</p><h1>Preview</h1><p className="screen-subtitle">Open a real development URL exposed by your connected environment.</p></div></div><form className="preview-form" onSubmit={(event) => { event.preventDefault(); setPreviewUrl((event.currentTarget.elements.namedItem('preview') as HTMLInputElement).value); }}><label>Preview URL<input name="preview" type="url" placeholder="https://your-forwarded-app.example" defaultValue={previewUrl} required /></label><Button>Open preview</Button></form>{previewUrl ? <div className="preview-panel"><div className="preview-toolbar"><span>{previewUrl}</span><button className="text-button" onClick={() => window.open(previewUrl, '_blank', 'noopener,noreferrer')}>Open externally <Icon name="external" /></button></div><iframe title="Connected application preview" src={previewUrl} sandbox="allow-forms allow-scripts" /></div> : <EmptyState title="No preview URL connected" hint="Start a service through OpenCode and provide the URL forwarded by your environment." />}</section>}
              {(tab === 'terminal' || tab === 'more') && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">OPENCode SERVER</p><h1>{tab === 'terminal' ? 'Terminal' : 'More'}</h1><p className="screen-subtitle">Commands execute through OpenCode in the imported repository environment.</p></div></div>{tab === 'more' ? <div className="more-grid"><button onClick={() => setTab('terminal')}><Icon name="terminal" /><b>Terminal</b><span>Run in the connected OpenCode session</span></button><button onClick={() => setPage('agents')}><Icon name="agents" /><b>Agent connection</b><span>{integration.agent?.connected ? 'OpenCode online' : 'Setup required'}</span></button><button onClick={() => setPage('cloud')}><Icon name="cloud" /><b>Cloud workspace</b><span>{integration.cloud?.connected ? 'Connected' : 'Not configured'}</span></button><button onClick={() => setPage('settings')}><Icon name="settings" /><b>Settings</b><span>Integration status</span></button></div> : <Terminal command={command} setCommand={setCommand} output={terminalOutput} run={runTerminalCommand} connected={integration.agent?.connected} />}</section>}
            </main>
            <aside className="context-panel"><section className="context-card"><div className="context-heading"><span className="context-icon"><Icon name="agents" /></span><div><b>OpenCode Server</b><small>{integration.agent?.url || 'Endpoint not configured'}</small></div><Badge tone={integration.agent?.connected ? 'ok' : 'fail'}>{integration.agent?.connected ? 'Connected' : 'Offline'}</Badge></div><p className="context-empty">{integration.agent?.message || 'Real agent work requires the configured OpenCode server.'}</p><button className="context-link" onClick={() => setPage('agents')}>Connection details <Icon name="arrow" /></button></section><section className="context-card"><button className="context-title" onClick={() => setPage('projects')}>Repository <Icon name="chevron" /></button><dl className="context-list"><div><dt><Icon name="github" />Project</dt><dd>{session.project}</dd></div><div><dt><Icon name="branch" />Branch</dt><dd>{session.branch}</dd></div><div><dt><Icon name="commit" />Commit</dt><dd>{changes.find((item: any) => item.commitSha)?.commitSha?.slice(0, 7) || '—'}</dd></div></dl></section><section className="context-card"><button className="context-title" onClick={() => setTab('changes')}>Recent changes <Icon name="chevron" /></button>{changes.slice(0, 1).flatMap((change: any) => change.files.slice(0, 4)).map((file: any) => <div className="mini-change" key={file.path}><Icon name="file" /><span>{file.path.split('/').pop()}</span></div>)}{!changes.length && <p className="context-empty">No repository diff from OpenCode yet.</p>}</section></aside>
          </div>
          {newActivity && tab === 'chat' && <div className="new-activity"><Button tone="ghost" onClick={() => { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); setNewActivity(false); }}>↓ New activity</Button></div>}
          {tab === 'chat' && <form className="composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}><label className="attach-button" aria-label="Attach file"><Icon name="paperclip" /><input type="file" hidden onChange={uploadFile} /></label><textarea value={composer} onChange={(event) => { setComposer(event.target.value); try { localStorage.setItem(draftKey(session.id), event.target.value); } catch {} }} placeholder={!online ? 'Offline — draft saved' : integration.agent?.connected ? 'Message OpenCode…' : 'OpenCode server is not connected'} aria-label="Message OpenCode" disabled={!integration.agent?.connected || !online} /><span className="model-indicator">OpenCode</span>{running ? <Button type="button" tone="ghost" onClick={stopRun}>Stop</Button> : <Button type="submit" disabled={!composer.trim() || sending || !integration.agent?.connected || !online} aria-label="Send task"><Icon name="send" /></Button>}</form>}
          <nav className="mobile-project-nav" role="tablist" aria-label="Project workspace">{tabs.filter(([id]) => id !== 'terminal').map(([id, label, icon]) => <button role="tab" key={id} aria-selected={tab === id || (id === 'more' && tab === 'terminal')} className={tab === id || (id === 'more' && tab === 'terminal') ? 'selected' : ''} onClick={() => setTab(id)}><Icon name={icon} /><span>{id === 'more' ? 'More' : label.split(' ')[0]}</span></button>)}</nav>
        </> : <>
          <header className="simple-header"><button className="brand-lockup compact" onClick={() => setPage('home')}><span className="brand-mark" /><b>Orlynx</b></button><div className="simple-header-actions"><Badge tone={integration.github?.connected ? 'ok' : 'fail'}><Icon name="github" />{integration.github?.connected ? 'GitHub App installed' : 'GitHub setup required'}</Badge><button className="icon-button" onClick={() => setPage('settings')} aria-label="Settings"><Icon name="settings" /></button></div></header>
          <main className="page-body">
            {error && <div className="screen-alert" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><Icon name="close" /></button></div>}
            {restoring && !session && <div className="loading-screen"><Spinner label="Restoring repository session" /><p>Checking imported repositories…</p></div>}
            {!restoring && page === 'welcome' && <section className="welcome-screen"><div className="welcome-mark"><span className="brand-mark" /></div><p className="eyebrow">ORLYNX · GITHUB DEVELOPMENT WORKSPACE</p><h1>Build from anywhere.</h1><p className="welcome-copy">Connect your GitHub App installation and OpenCode server to start working with real repositories and a real agent.</p><div className="welcome-actions"><Button onClick={() => integration.github?.configured ? window.location.assign('/v1/github/install') : setPage('github')}><Icon name="github" />{integration.github?.connected ? 'Browse repositories' : integration.github?.configured ? 'Install GitHub App' : 'GitHub App setup required'}</Button><Button tone="ghost" onClick={() => setPage('agents')}>OpenCode connection status</Button></div><div className="secure-note"><Icon name="shield" /><div><b>No demo workspace or token entry</b><p>Access is provided through a GitHub App and an authenticated OpenCode server. Configure server secrets before creating a project.</p></div></div></section>}
            {!restoring && page === 'home' && <section className="home-screen"><div className="home-greeting"><p className="eyebrow">YOUR CONNECTED REPOSITORIES</p><h1>Welcome to Orlynx.</h1><p>Open an imported GitHub repository. Agent work runs through the configured OpenCode server.</p></div><div className="home-primary-actions"><Button disabled={!integration.github?.connected} onClick={() => { setPage('github'); loadRepositories(); }}><Icon name="github" />Browse repositories</Button></div><div className="home-grid"><section className="home-section"><div className="section-title"><h2>Recent projects</h2><button className="text-button" onClick={() => setPage('projects')}>View all</button></div>{recentProjects.length ? recentProjects.filter((name) => name.includes('/')).map((name) => <button className="project-list-row" key={name} onClick={() => openRecentProject(name)}><span className="repo-avatar"><Icon name="github" /></span><span><b>{name}</b><small>Imported GitHub repository</small></span><Icon name="chevron" /></button>) : <EmptyState title="No imported repositories" hint="Install the Orlynx GitHub App, then select a repository to import." />}</section><section className="home-section connect-summary"><div className="section-title"><h2>Required connections</h2></div><p>GitHub App: {integration.github?.connected ? 'installed' : 'not connected'}</p><p>OpenCode server: {integration.agent?.connected ? 'connected' : 'not connected'}</p><Button tone="ghost" onClick={() => setPage('settings')}>Connection settings</Button></section></div></section>}
            {!restoring && page === 'projects' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">GITHUB REPOSITORIES</p><h1>Projects</h1><p className="screen-subtitle">Projects must be imported from a repository allowed by the GitHub App.</p></div><Button disabled={!integration.github?.connected} onClick={() => { setPage('github'); loadRepositories(); }}>Browse repositories</Button></div>{recentProjects.length ? <div className="project-grid">{recentProjects.filter((name) => name.includes('/')).map((name) => <button className="project-card" key={name} onClick={() => openRecentProject(name)}><span className="repo-avatar"><Icon name="github" /></span><span><b>{name}</b><small>Imported repository</small></span><Icon name="chevron" /></button>)}</div> : <EmptyState title="No repositories imported" hint="Connect the GitHub App and import a repository before opening a project." />}</section>}
            {!restoring && page === 'github' && <section className="screen-section github-screen"><button className="back-link" onClick={() => setPage('home')}>‹ Back</button><div className="screen-heading"><div><p className="eyebrow">GITHUB APP</p><h1>Repository access</h1><p className="screen-subtitle">Install the Orlynx GitHub App to choose repositories and branches.</p></div><span className="github-mark"><Icon name="github" size={28} /></span></div><div className="github-connection"><span className={`connection-indicator ${integration.github?.connected ? 'is-connected' : ''}`} /><div><b>{integration.github?.connected ? 'GitHub App installed' : integration.github?.configured ? 'Install required' : 'GitHub App not configured'}</b><p>{integration.github?.connected ? `${integration.github.installations.length} installation(s) are available.` : 'GitHub App installation grants repository access. Credentials remain in server environment variables.'}</p></div><Button disabled={!integration.github?.configured || repoBusy} onClick={() => integration.github?.configured ? window.location.assign('/v1/github/install') : refreshIntegrations()}>{integration.github?.configured ? 'Install GitHub App' : 'Check server configuration'}</Button></div>{integration.github?.connected && <><div className="repo-picker-heading"><div><h2>Choose a repository</h2><p>Only repositories granted to the Orlynx GitHub App are listed.</p></div><label className="search-field"><Icon name="search" /><input value={repoQuery} onChange={(event) => setRepoQuery(event.target.value)} placeholder="Search repositories" /></label></div><div className="filter-row">{['all', 'personal', 'organizations', 'recent'].map((filter) => <button key={filter} className={repoFilter === filter ? 'active' : ''} onClick={() => setRepoFilter(filter)}>{filter === 'all' ? 'All' : filter === 'personal' ? 'Personal' : filter === 'organizations' ? 'Organizations' : 'Recently used'}</button>)}</div><div className="repo-picker">{repoBusy ? <div className="repo-loading"><Spinner /><span>Loading repositories…</span></div> : filteredRepos.map((repo) => <button className={`github-repo-row ${selectedRepo?.full === repo.full ? 'selected' : ''}`} key={`${repo.installationId}:${repo.full}`} onClick={() => selectRepository(repo)}><span className="repo-avatar"><Icon name="github" /></span><span className="github-repo-copy"><b>{repo.full}</b><small>{repo.ownerType}{repo.language ? ` · ${repo.language}` : ''} · {repo.private ? 'Private' : 'Public'}</small></span><Icon name="chevron" /></button>)}{!repoBusy && !filteredRepos.length && <EmptyState title="No repositories available" hint="Adjust the repository installation scope in GitHub, then refresh." />}</div>{selectedRepo && <div className="selected-repository"><div><b>{selectedRepo.full}</b><small>Select an available branch to clone.</small></div><select value={branch} onChange={(event) => setBranch(event.target.value)} aria-label="Repository branch">{branches.map((item) => <option key={item} value={item}>{item}</option>)}</select><Button onClick={importSelectedRepository} disabled={repoBusy || !branches.length}>{repoBusy ? 'Importing…' : 'Import & open'}</Button></div>}</>}</section>}
            {!restoring && page === 'agents' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">OPENCode CONNECTION</p><h1>Agents</h1><p className="screen-subtitle">Orlynx sends tasks to your configured OpenCode server. No built-in agent fallback is used.</p></div></div><section className="agent-config-row"><span className="agent-avatar"><Icon name="agents" /></span><div><b>OpenCode server</b><p>{integration.agent?.message || 'Checking server connection…'}</p></div><Badge tone={integration.agent?.connected ? 'ok' : 'fail'}>{integration.agent?.connected ? 'Connected' : 'Unavailable'}</Badge><Button tone="ghost" onClick={refreshIntegrations}>Refresh</Button></section>{integration.agent?.connected ? <section className="provider-notice"><h2>Server agents</h2>{integration.agent.agents.map((agent: any) => <p key={agent.name}>{agent.name} · {agent.description || agent.mode}</p>)}<h2>Connected model providers</h2>{integration.agent.connectedProviders.map((provider: string) => <Badge key={provider} tone="ok">{provider}</Badge>)}</section> : <EmptyState title="OpenCode is not connected" hint="Configure OPENCODE_BASE_URL and OPENCODE_SERVER_PASSWORD on the Orlynx API host, then check the connection again." />}{session && <Button onClick={() => setPage('workspace')}>Return to project</Button>}</section>}
            {!restoring && page === 'cloud' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">REMOTE EXECUTION</p><h1>Cloud workspace</h1><p className="screen-subtitle">A cloud workspace requires Codespaces provisioning and a remote OpenCode bridge.</p></div></div><EmptyState title="Cloud execution is not configured" hint="Orlynx will not mark a simulated local process as a cloud workspace. Configure the Codespaces OAuth permissions and remote OpenCode tunnel before enabling this action." />{session && <Button tone="ghost" onClick={() => setPage('workspace')}>Return to project</Button>}</section>}
            {!restoring && page === 'settings' && <SettingsScreen integration={integration} theme={theme} setTheme={setTheme} reload={refreshIntegrations} />}
            {!restoring && page === 'tasks' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">CURRENT REPOSITORY</p><h1>Tasks</h1><p className="screen-subtitle">Runs are scoped to this imported repository.</p></div></div>{session && lastRun ? <button className="task-row" onClick={() => setPage('workspace')}><Icon name="clock" /><span><b>{session.checkpoint?.goal || 'OpenCode task'}</b><small>{session.project} · {new Date(lastRun.startedAt).toLocaleString()}</small></span><Badge>{lastRun.state}</Badge></button> : <EmptyState title="No task history" hint="Start a task in an imported project." />}</section>}
            {!restoring && page === 'search' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">SEARCH IMPORTED REPOSITORY</p><h1>Find files</h1></div></div><label className="global-search search-page-input"><Icon name="search" /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search current files…" /></label>{files.filter((file: any) => file.name.toLowerCase().includes(search.toLowerCase())).map((file: any) => <button key={file.name} className="project-list-row" onClick={() => { setPage('workspace'); setTab('files'); if (!file.dir) openFile(file.name); }}><Icon name={file.dir ? 'folder' : 'file'} /><span><b>{file.name}</b><small>{session?.project}</small></span><Icon name="chevron" /></button>)}</section>}
          </main>
          <nav className="mobile-global-nav" aria-label="Main navigation">{globalNav.map(([id, label, icon]) => <button key={id} className={page === id ? 'selected' : ''} onClick={() => setPage(id)}><Icon name={icon} /><span>{label}</span></button>)}</nav>
        </>}
      </div>
    </div>
  );
}

function ActivityList({ activities }: { activities: any[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? activities.slice(-50) : activities.slice(-5);
  return <div className="card"><div className="ox-stream">{visible.map((item) => <TaskActivityRow key={item.key} item={item} />)}</div>{activities.length > 5 && <Button tone="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show recent activity' : 'Show earlier activity'}</Button>}</div>;
}

function Terminal({ command, setCommand, output, run, connected }: { command: string; setCommand: (value: string) => void; output: string; run: () => void; connected: boolean }) {
  return <div className="terminal-panel"><div className="terminal-note"><Icon name="terminal" />OpenCode shell · operates in the imported repository directory.</div><form className="terminal-command" onSubmit={(event) => { event.preventDefault(); run(); }}><label>Command</label><div><span>$</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="git status --short" /><Button disabled={!connected || !command.trim()}>Run</Button></div></form><pre className="terminal-output">{output || 'No command has been run.'}</pre></div>;
}

function SettingsScreen({ integration, theme, setTheme, reload }: { integration: any; theme: string; setTheme: (theme: string) => void; reload: () => void }) {
  return <section className="screen-section settings-screen"><div className="screen-heading"><div><p className="eyebrow">ORLYNX CONFIGURATION</p><h1>Settings</h1><p className="screen-subtitle">Connections are configured server-side; secrets are never entered here.</p></div></div><section className="settings-group"><h2>GitHub App</h2><div className="settings-row"><span className="settings-icon"><Icon name="github" /></span><span><b>{integration.github?.connected ? 'Installed' : integration.github?.configured ? 'Install required' : 'Not configured'}</b><small>{integration.github?.installations?.map((item: any) => item.account).join(', ') || 'Installations and repository permissions'}</small></span><Badge tone={integration.github?.connected ? 'ok' : 'fail'}>{integration.github?.auth || 'unknown'}</Badge></div>{integration.github?.configured && <div className="settings-help"><p>GitHub App setup callback</p><code>{integration.github.setupCallbackUrl}</code><p>Webhook endpoint</p><code>{integration.github.webhookUrl}</code></div>}</section><section className="settings-group"><h2>OpenCode server</h2><div className="settings-row"><span className="settings-icon"><Icon name="agents" /></span><span><b>{integration.agent?.connected ? 'Connected' : 'Unavailable'}</b><small>{integration.agent?.url || 'Configure OPENCODE_BASE_URL and server authentication'}</small></span><Button tone="ghost" onClick={reload}>Check connection</Button></div><p className="settings-footnote">The server must be able to access OPENCODE_PROJECTS_ROOT, where GitHub App repositories are imported.</p></section><section className="settings-group"><h2>Cloud</h2><div className="settings-row"><span className="settings-icon"><Icon name="cloud" /></span><span><b>Not configured</b><small>Codespaces creation, lifecycle, and OpenCode remote execution tunnel are required.</small></span><Badge>Unavailable</Badge></div></section><section className="settings-group"><h2>Appearance</h2><div className="settings-row"><span><b>Theme</b><small>Warm light is the Orlynx reference theme.</small></span><select value={theme} onChange={(event) => setTheme(event.target.value)} aria-label="Theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div></section></section>;
}
