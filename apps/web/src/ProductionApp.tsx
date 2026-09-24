import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';
import { j } from './api';
import { Badge, Button, EmptyState, Icon, Input, Spinner } from './ui/primitives';
import { AgentApprovalCard, AgentErrorCard, AttachmentChip, DiffSummary, TaskActivityRow } from './ui/product';
import { toActivities } from './ui/mapping';

type Page = 'welcome' | 'home' | 'projects' | 'github' | 'settings' | 'tasks' | 'search' | 'workspace' | 'setup';
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
  const [githubNotice, setGithubNotice] = useState<{ tone: 'ok' | 'fail' | 'neutral'; text: string } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [ai, setAi] = useState<any>({ state: 'disconnected', engine: 'OpenCode', mode: 'build', permission: 'ask-first', providers: { connected: 0, total: 0 } });
  const [aiModels, setAiModels] = useState<any[]>([]);
  const [aiProviders, setAiProviders] = useState<any[]>([]);
  const [aiSupported, setAiSupported] = useState<string[]>([]);
  const [showConnectAI, setShowConnectAI] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [keyForm, setKeyForm] = useState<{ providerId: string; apiKey: string }>({ providerId: '', apiKey: '' });
  const [aiBusy, setAiBusy] = useState(false);
  const [tempFullAccess, setTempFullAccess] = useState(false);
  const [connectingGithub, setConnectingGithub] = useState(false);
  const [cloudNotice, setCloudNotice] = useState(false);

  async function connectGitHub() {
    // User flow only: the backend owns the GitHub URL. If the platform is not
    // ready, say so plainly without exposing infrastructure details.
    setConnectingGithub(true); setGithubNotice(null);
    try {
      const res = await fetch('/v1/github/install', { redirect: 'manual' });
      if (res.status === 302) { window.location.assign('/v1/github/install'); return; }
      setGithubNotice({ tone: 'fail', text: 'GitHub connection is temporarily unavailable. Please try again.' });
      setPage('github');
    } catch {
      setGithubNotice({ tone: 'fail', text: 'GitHub connection is temporarily unavailable. Please try again.' });
      setPage('github');
    } finally { setConnectingGithub(false); }
  }
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

  const refreshAi = useCallback(async (sessionId?: string) => {
    try {
      const [status, models, providers] = await Promise.all([
        j<any>(await fetch(`/v1/ai/status${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`)),
        j<any>(await fetch('/v1/ai/models')).catch(() => ({ models: [] })),
        j<any>(await fetch('/v1/ai/providers')).catch(() => ({ providers: [], supported: [] })),
      ]);
      setAi(status); setAiModels(models.models || []);
      setAiProviders(providers.providers || []); setAiSupported(providers.supported || []);
    } catch { /* AI status stays fail-closed; composer shows unavailable */ }
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
    refreshAi(id).catch(() => {});
  }, [refreshAi]);

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
    refreshAi().catch(() => {});
    const params = new URLSearchParams(window.location.search);
    const callback = params.get('github');
    const setup = params.get('internal');
    if (setup === 'setup-github') {
      window.history.replaceState({}, '', '/');
      setPage('setup');
      const created = params.get('created');
      const setupError = params.get('error');
      const slug = params.get('slug');
      if (created === '1') setGithubNotice({ tone: 'ok', text: `GitHub App${slug ? ` (${slug})` : ''} created. Credentials stored, redeploy triggered — GitHub connection activates once the deployment is live.` });
      else if (setupError) setGithubNotice({ tone: 'fail', text: setupError });
    }
    if (callback) {
      window.history.replaceState({}, '', '/');
      if (callback === 'connected') { setPage('github'); setGithubNotice({ tone: 'ok', text: 'GitHub connected. Choose a repository to open.' }); }
      else if (callback === 'disconnected') { setPage('github'); setGithubNotice({ tone: 'neutral', text: 'GitHub disconnected. Your Orlynx sessions are preserved.' }); }
      else if (callback === 'error') { setPage('github'); setGithubNotice({ tone: 'fail', text: params.get('reason') || 'GitHub connection was not completed. No repository access was granted.' }); }
      else setPage('github');
    }
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
  }, [connectEvents, openSession, refreshIntegrations, refreshAi]);

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

  async function openManageRepositories() {
    // GitHub-native consent: add/remove repos or switch all/selected there,
    // then come back and refresh. No new Orlynx connection is needed.
    window.open('/v1/github/manage', '_blank', 'noopener,noreferrer');
  }

  async function refreshAfterManage() {
    await refreshIntegrations();
    repoLoadAttempt.current = false;
    if (integration.github?.connected) await loadRepositories();
  }

  async function disconnectGitHub() {
    setDisconnecting(true); setError('');
    try {
      const status = await j<any>(await fetch('/v1/github/disconnect', { method: 'POST' }));
      setIntegration((current: any) => ({ ...current, github: status }));
      setRepos([]); setSelectedRepo(null); setBranches([]);
      setConfirmDisconnect(false);
      setGithubNotice({ tone: 'neutral', text: 'GitHub disconnected. Your Orlynx conversations and local project history remain.' });
    } catch (error: any) { setError(error.message || 'Disconnect failed. GitHub access may still be active.'); }
    finally { setDisconnecting(false); }
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

  async function setAiPrefs(patch: { modelId?: string; mode?: string; permission?: string }) {
    if (!session) return;
    setError('');
    try {
      const result = await j<any>(await fetch(`/v1/ai/session/${session.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }));
      if (result.appliesTo === 'next-turn') setError('A task is running. Your selection applies to the next turn.');
      await refreshAi(session.id);
    } catch (error: any) { setError(error.message || 'AI preference could not be saved.'); }
  }

  async function connectAiKey() {
    if (!keyForm.providerId || !keyForm.apiKey) return;
    setAiBusy(true); setError('');
    try {
      await j(await fetch('/v1/ai/providers/connect-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(keyForm) }));
      setKeyForm({ providerId: '', apiKey: '' }); setModelSearch('');
      await refreshAi(session?.id); await refreshIntegrations();
    } catch (error: any) { setError(error.message || 'Connection failed. The key was not stored.'); }
    finally { setAiBusy(false); }
  }

  async function disconnectAiProvider(providerId: string) {
    setAiBusy(true); setError('');
    try {
      await j(await fetch(`/v1/ai/providers/${encodeURIComponent(providerId)}/disconnect`, { method: 'POST' }));
      await refreshAi(session?.id); await refreshIntegrations();
    } catch (error: any) { setError(error.message || 'Disconnect failed.'); }
    finally { setAiBusy(false); }
  }

  async function sendMessage() {
    if (!session || !composer.trim() || sending || !online) return;
    setSending(true); setError('');
    const text = composer.trim(); const clientId = uid();
    try {
      const result = await j<any>(await fetch(`/v1/sessions/${session.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, clientId, fullAccessForThisTask: tempFullAccess }) }));
      setComposer(''); setDraftReply(''); setTempFullAccess(false); try { localStorage.removeItem(draftKey(session.id)); } catch {}
      setLastRun(result.run); runRef.current = result.run;
      await refreshSession(session.id);
    } catch (error: any) { setError((error.message || 'Orlynx AI could not accept the task. The draft is preserved.').replace(/OpenCode/g, 'Orlynx AI')); }
    finally { setSending(false); }
  }

  async function stopRun() {
    const running = events.slice().reverse().find((event) => event.type === 'run.started')?.runId || lastRun?.id;
    if (!session || !running) return;
    try { await j(await fetch(`/v1/agent-runs/${running}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id }) })); await refreshSession(session.id); }
    catch (error: any) { setError(error.message || 'The current task could not be stopped.'); }
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
      setUploads((items) => items.map((item) => item.id === id ? { ...item, status: 'Attached' } : item));
      setAttachments(await j<any[]>(await fetch(`/v1/sessions/${session.id}/attachments`)));
    } catch (error: any) { setUploads((items) => items.map((item) => item.id === id ? { ...item, status: 'failed' } : item)); setError(error.message || 'Upload failed.'); }
  }

  async function runTerminalCommand() {
    if (!session || !command.trim()) return;
    try { const result = await j<any>(await fetch(`/v1/sessions/${session.id}/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: command }) })); setTerminalOutput(result.out || '(command produced no output)'); }
    catch (error: any) { setTerminalOutput(error.message || 'Terminal request failed.'); }
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
    ['home', 'Home', 'home'], ['projects', 'Projects', 'folder'], ['settings', 'Settings', 'settings'],
  ] as const;
  const tabs = [
    ['chat', 'Chat', 'inbox'], ['files', 'Files', 'folder'], ['changes', `Changes${changes.length ? ` ${changes.reduce((sum: number, change: any) => sum + (change.files?.length || 0), 0)}` : ''}`, 'commit'], ['preview', 'Preview', 'preview'], ['terminal', 'Terminal', 'terminal'], ['more', 'More', 'more'],
  ] as const;

  const onboarded = Boolean(session || integration.github?.connected || recentProjects.length);
  return (
    <div className={`orlynx-app ${page === 'workspace' ? 'is-workspace' : ''} ${page === 'welcome' ? 'is-welcome' : ''}`}>
      {page !== 'welcome' && onboarded && <aside className="sidebar">
        <button className="brand-lockup" onClick={() => setPage(session ? 'home' : 'github')}><span className="brand-mark" /><span><b>Orlynx</b><small>Your development workspace</small></span></button>
        <nav className="side-nav" aria-label="Main navigation">{globalNav.map(([id, label, icon]) => <button key={id} className={page === id ? 'selected' : ''} onClick={() => setPage(id)}><Icon name={icon} />{label}</button>)}</nav>
        <div className="sidebar-section"><div className="sidebar-title">Recent repositories</div>{recentProjects.slice(0, 5).map((name) => <button className={`recent-project ${session?.project === name ? 'selected' : ''}`} key={name} onClick={() => openRecentProject(name)}><span className="repo-avatar"><Icon name="github" size={15} /></span><span className="recent-project-copy"><b>{name.split('/').pop()}</b><small><Icon name="branch" size={12} />{session?.project === name ? session.branch : 'Imported'}</small></span></button>)}<button className="side-link" onClick={() => setPage('projects')}>View repositories <Icon name="arrow" size={14} /></button></div>
        <div className="sidebar-account"><span className="account-avatar"><Icon name="github" /></span><span><b>{integration.github?.login || integration.github?.installations?.[0]?.account || 'GitHub account'}</b><small>{integration.github?.connected ? 'Connected' : 'Not connected'}</small></span><button className="icon-button" aria-label="Account settings" onClick={() => setPage('settings')}><Icon name="more" /></button></div>
      </aside>}
      <div className="app-main">
        {page === 'workspace' && session ? <>
          <header className="project-header"><div className="repo-identity"><span className="repo-avatar large"><Icon name="github" size={18} /></span><div><b>{session.project.split('/').pop()}</b><span><Icon name="branch" size={13} />{session.branch}</span></div><button className="icon-button" aria-label="Repositories" onClick={() => setPage('projects')}><Icon name="chevron" /></button></div><button className="global-search" onClick={() => setPage('search')}><Icon name="search" /><span>Search files, commands, or tasks…</span><kbd>⌘ K</kbd></button><div className="header-actions">{integration.cloud?.connected ? <Button className="cloud-action" onClick={() => setTab('more')}><Icon name="cloud" />Cloud workspace</Button> : null}<button className="icon-button" aria-label="Project settings" onClick={() => setTab('more')}><Icon name="more" /></button></div></header>
          <nav className="project-tabs" role="tablist" aria-label="Project workspace">{tabs.filter(([id]) => ['chat', 'files', 'changes', 'more'].includes(id)).map(([id, label, icon]) => <button role="tab" key={id} aria-selected={tab === id || (id === 'more' && (tab === 'terminal' || tab === 'preview'))} className={tab === id || (id === 'more' && (tab === 'terminal' || tab === 'preview')) ? 'selected' : ''} onClick={() => { setTab(id); setOpenedFile(null); }}><Icon name={icon} size={16} /><span>{label}</span></button>)}</nav>
          {!online && <div className="offline-banner"><Icon name="cloud" />Offline. Drafts remain on this device; no task was sent.</div>}
          {session?.githubAccess === 'disconnected' && <div className="screen-alert" role="alert"><span>GitHub access to {session.project} was removed. Your Orlynx conversation is preserved.</span><button className="text-button" onClick={() => setPage('github')}>Manage GitHub access</button></div>}
          {error && <div className="screen-alert" role="alert"><span>{error}</span><button aria-label="Dismiss" onClick={() => setError('')}><Icon name="close" /></button></div>}
          <div className="workspace-layout">
            <main className="workspace-main">
              {tab === 'chat' && <section className="conversation">
                {!messages.length && <div className="conversation-intro"><span className="agent-avatar"><Icon name="agents" /></span><div><h2>{ai.state === 'ready' || ai.state === 'working' ? 'Work with Orlynx AI' : 'Connect AI to start'}</h2><p>{ai.state === 'ready' || ai.state === 'working' ? `Tasks run in this repository${ai.model ? ` with ${ai.model.displayName}` : ''}.` : `Connect an AI account to start working on this project. Your chat stays here.`}</p>{(ai.state === 'disconnected' || ai.state === 'needs_attention' || ai.state === 'error') && <Button onClick={() => setShowConnectAI(true)}><Icon name="agents" />{ai.state === 'error' ? 'AI unavailable — details' : 'Connect AI'}</Button>}</div></div>}
                {messages.map((message) => <article className={`message-row ${message.role === 'user' ? 'user-message' : 'assistant-message'}`} key={message.id}><span className={message.role === 'user' ? 'user-avatar' : 'agent-avatar'}><Icon name={message.role === 'user' ? 'github' : 'agents'} size={16} /></span><div className="message-content"><div className="message-meta"><b>{message.role === 'user' ? 'You' : 'Orlynx AI'}</b><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><div className="message-text">{message.text}</div></div></article>)}
                {draftReply && <article className="message-row assistant-message"><span className="agent-avatar"><Icon name="agents" /></span><div className="message-content"><div className="message-meta"><b>Orlynx AI</b><span className="live-reply-indicator">Working</span></div><div className="message-text">{draftReply}<span className="stream-caret" /></div></div></article>}
                {!!attachments.length && <div className="chat-attachments">{attachments.map((item: any) => <AttachmentChip key={item.id} name={item.filename} state="agent" />)}</div>}
                {uploads.map((item) => <div className="upload-state" key={item.id}><Icon name="file" />{item.name}<Badge tone={item.status === 'failed' ? 'fail' : 'ok'}>{item.status}</Badge></div>)}
                {!!events.length && <div className="workstream-wrap"><ActivityList activities={activities} /></div>}
                {lastRun?.state === 'completed' && lastRun?.model && <p className="run-receipt">Completed with {lastRun.model}</p>}
                {lastRun?.state === 'failed' && <AgentErrorCard title={lastRun?.errorKind === 'rate_limit' || lastRun?.errorKind === 'quota' ? 'The AI provider could not continue this request.' : lastRun?.errorKind === 'auth' ? 'The AI connection expired or was rejected.' : lastRun?.errorKind === 'model' ? 'The selected model is unavailable.' : 'Orlynx AI could not complete this task.'} hint={lastRun?.errorKind === 'rate_limit' ? 'Usage limit reached. Choose another model or retry shortly.' : lastRun?.errorKind === 'quota' ? 'Quota or billing issue on the provider account.' : lastRun?.errorKind === 'auth' ? 'Reconnect the provider, then continue in this same chat.' : 'The repository and local changes remain available.'} onRetry={() => refreshSession(session.id)} />}
              </section>}
              {tab === 'files' && <section className="screen-section files-screen"><div className="screen-heading"><div><p className="eyebrow">REPOSITORY</p><h1>Files</h1><p className="screen-subtitle">Read files from {session.project} at {session.branch}.</p></div><label className="search-field"><Icon name="search" /><input value={fileFilter} onChange={(event) => setFileFilter(event.target.value)} placeholder="Filter current folder" /></label></div>{openedFile ? <div className="code-viewer"><div className="code-titlebar"><button className="text-button" onClick={() => setOpenedFile(null)}>‹ Files</button><span><Icon name="file" />{openedFile.path}</span></div><pre>{openedFile.content}</pre></div> : <><div className="breadcrumbs"><button onClick={() => openFolder('')}>{session.project}</button>{folder.split('/').filter(Boolean).map((part, index, parts) => <React.Fragment key={`${part}-${index}`}><Icon name="chevron" size={12} /><button onClick={() => openFolder(parts.slice(0, index + 1).join('/'))}>{part}</button></React.Fragment>)}</div><div className="file-list">{fileBusy ? <div className="loading-screen"><Spinner /><p>Loading repository files…</p></div> : files.filter((item: any) => item.name.toLowerCase().includes(fileFilter.toLowerCase())).map((item: any) => <button className="file-row" key={item.name} onClick={() => item.dir ? openFolder([folder, item.name].filter(Boolean).join('/')) : openFile([folder, item.name].filter(Boolean).join('/'))}><span className="file-kind"><Icon name={item.dir ? 'folder' : 'file'} /></span><span>{item.name}{item.dir ? '/' : ''}</span><Icon name="chevron" size={14} /></button>)}</div></>}</section>}
              {tab === 'changes' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">REVIEW BEFORE PUSHING</p><h1>Changes</h1><p className="screen-subtitle">Review the changes made to this repository.</p></div></div>{!changes.length && <EmptyState title="No changes to review" hint="Changes will appear here after your task reports back." />}{changes.map((change: any) => <section className="change-set" key={change.id}><div className="change-set-heading"><div><b>{change.files.length} changed file{change.files.length === 1 ? '' : 's'}</b><span className="small">Base {change.baseSha?.slice(0, 7)}</span></div><Badge tone={change.pushedAt ? 'ok' : change.reviewState === 'pending' ? 'wait' : 'neutral'}>{change.pushedAt ? 'Pushed' : change.reviewState}</Badge></div><DiffSummary files={change.files.map((file: any) => ({ path: file.path, action: file.action }))} />{change.files.map((file: any) => <details className="diff-file" key={file.path}><summary>{file.path}</summary><p className="diff-explanation">Workspace diff</p><pre>{file.diff || file.after || file.before || '(binary or empty file)'}</pre></details>)}{change.reviewState === 'pending' && <AgentApprovalCard title="Approve this local commit" detail="Review every file above. Push is a separate action." busy={busyChange === change.id} onCancel={() => {}} onApprove={() => reviewChange(change)} />}{change.reviewState === 'approved' && <div className="commit-form"><label>Commit message<input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Describe this change" /></label><Button disabled={!commitMessage.trim() || busyChange === change.id} onClick={() => commitChange(change)}>{busyChange === change.id ? 'Committing…' : 'Create commit'}</Button></div>}{change.reviewState === 'committed' && !change.pushedAt && <div className="commit-success"><Icon name="check" />Commit {change.commitSha?.slice(0, 7)} is local and ready.<Button tone="ghost" onClick={() => setPushReview(change)}>Review push</Button></div>}{change.pushedAt && <Badge tone="ok">Pushed to {session.branch}</Badge>}{pushReview?.id === change.id && <div className="push-confirm"><b>Push {change.files.length} files to {session.project} · {session.branch}?</b><p>This writes the approved commit to GitHub.</p><div className="action-row"><Button tone="ghost" onClick={() => setPushReview(null)}>Cancel</Button><Button onClick={() => pushChange(change)} disabled={busyChange === change.id}>Approve & push</Button></div></div>}</section>)}</section>}
              {tab === 'preview' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">CONNECTED APP</p><h1>Preview</h1><p className="screen-subtitle">Open a development URL for this project.</p></div></div><form className="preview-form" onSubmit={(event) => { event.preventDefault(); setPreviewUrl((event.currentTarget.elements.namedItem('preview') as HTMLInputElement).value); }}><label>Preview URL<input name="preview" type="url" placeholder="https://your-forwarded-app.example" defaultValue={previewUrl} required /></label><Button>Open preview</Button></form>{previewUrl ? <div className="preview-panel"><div className="preview-toolbar"><span>{previewUrl}</span><button className="text-button" onClick={() => window.open(previewUrl, '_blank', 'noopener,noreferrer')}>Open externally <Icon name="external" /></button></div><iframe title="Connected application preview" src={previewUrl} sandbox="allow-forms allow-scripts" /></div> : <EmptyState title="No preview URL connected" hint="Start a service for this project and paste its URL above." />}</section>}
              {(tab === 'terminal' || tab === 'more') && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">PROJECT</p><h1>{tab === 'terminal' ? 'Terminal' : 'More'}</h1><p className="screen-subtitle">Run commands inside this project's workspace.</p></div></div>{tab === 'more' ? <div className="more-grid"><button onClick={() => setTab('terminal')}><Icon name="terminal" /><b>Terminal</b><span>Run in this project's workspace</span></button><button onClick={() => setTab('preview')}><Icon name="preview" /><b>Preview</b><span>Open the project preview</span></button><button onClick={() => { setCloudNotice(true); refreshIntegrations(); }}><Icon name="cloud" /><b>Work on cloud</b><span>{integration.cloud?.connected ? 'Connected' : 'Temporarily unavailable'}</span></button>{cloudNotice && !integration.cloud?.connected && <p className="settings-footnote">Cloud workspace is temporarily unavailable. Please try again shortly.</p>}<button onClick={() => setShowConnectAI(true)}><Icon name="agents" /><b>Orlynx AI</b><span>{ai?.state === 'ready' || ai?.state === 'working' ? 'Ready' : 'Connect'}</span></button><button onClick={() => setPage('settings')}><Icon name="settings" /><b>Settings</b><span>Connections and preferences</span></button></div> : <Terminal command={command} setCommand={setCommand} output={terminalOutput} run={runTerminalCommand} connected={integration.agent?.connected} />}</section>}
            </main>
            <aside className="context-panel"><section className="context-card"><div className="context-heading"><span className="context-icon"><Icon name="agents" /></span><div><b>Orlynx AI</b><small>{ai.model ? `${ai.model.displayName} · ${ai.mode === 'build' ? 'Build' : ai.mode === 'plan' ? 'Plan' : 'Ask'}` : 'No model selected'}</small></div><Badge tone={ai.state === 'ready' ? 'ok' : ai.state === 'working' ? 'wait' : 'fail'}>{ai.state === 'ready' ? 'Ready' : ai.state === 'working' ? 'Working' : ai.state === 'needs_attention' ? 'Needs attention' : ai.state === 'error' ? 'Unavailable' : 'Not connected'}</Badge></div><p className="context-empty">{ai.message || 'Connect an AI account to start working.'}</p><button className="context-link" onClick={() => setShowConnectAI(true)}>Manage AI <Icon name="arrow" /></button></section><section className="context-card"><button className="context-title" onClick={() => setPage('projects')}>Repository <Icon name="chevron" /></button><dl className="context-list"><div><dt><Icon name="github" />Project</dt><dd>{session.project}</dd></div><div><dt><Icon name="branch" />Branch</dt><dd>{session.branch}</dd></div><div><dt><Icon name="commit" />Commit</dt><dd>{changes.find((item: any) => item.commitSha)?.commitSha?.slice(0, 7) || '—'}</dd></div></dl></section><section className="context-card"><button className="context-title" onClick={() => setTab('changes')}>Recent changes <Icon name="chevron" /></button>{changes.slice(0, 1).flatMap((change: any) => change.files.slice(0, 4)).map((file: any) => <div className="mini-change" key={file.path}><Icon name="file" /><span>{file.path.split('/').pop()}</span></div>)}{!changes.length && <p className="context-empty">No changes yet.</p>}</section></aside>
          </div>
          {newActivity && tab === 'chat' && <div className="new-activity"><Button tone="ghost" onClick={() => { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); setNewActivity(false); }}>↓ New activity</Button></div>}
          {tab === 'chat' && <form className="composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}><label className="attach-button" aria-label="Attach file"><Icon name="paperclip" /><input type="file" hidden onChange={uploadFile} /></label><div className="composer-body"><textarea value={composer} onChange={(event) => { setComposer(event.target.value); try { localStorage.setItem(draftKey(session.id), event.target.value); } catch {} }} placeholder={!online ? 'Offline — draft saved' : ai.state === 'ready' || ai.state === 'working' ? `Ask Orlynx anything about this repo…` : ai.state === 'needs_attention' ? 'AI needs attention — choose another model' : 'Connect AI to start working'} aria-label="Message Orlynx AI" disabled={(ai.state !== 'ready' && ai.state !== 'working') || !online} /><div className="composer-controls"><select aria-label="Model" value={ai.model?.id || ''} onChange={(event) => { const value = event.target.value; if (value === '__connect') setShowConnectAI(true); else setAiPrefs({ modelId: value }); }} disabled={!online}>{ai.model ? <option value={ai.model.id}>{ai.model.displayName}</option> : <option value="">Select model</option>}{aiModels.filter((m) => m.status === 'available' && m.id !== ai.model?.id).map((m: any) => <option key={m.id} value={m.id}>{m.displayName}</option>)}<option value="__connect">Connect another AI…</option></select><select aria-label="Mode" value={ai.mode || 'build'} onChange={(event) => setAiPrefs({ mode: event.target.value })} disabled={!online}><option value="build">Build</option><option value="plan">Plan</option><option value="ask">Ask</option></select><select aria-label="Access level" value={ai.permission || 'ask-first'} onChange={(event) => setAiPrefs({ permission: event.target.value })} disabled={!online}><option value="full">Full access</option><option value="ask-first">Ask first</option><option value="read-only">Read only</option></select></div>{ai.permission !== 'full' && (ai.state === 'ready') && <label className="temp-access"><input type="checkbox" checked={tempFullAccess} onChange={(event) => setTempFullAccess(event.target.checked)} /> Allow full access for this task</label>}</div>{running ? <Button type="button" tone="ghost" onClick={stopRun}>Stop</Button> : <Button type="submit" disabled={!composer.trim() || sending || (ai.state !== 'ready' && ai.state !== 'working') || !online} aria-label="Send task"><Icon name="send" /></Button>}</form>}
          {showConnectAI && <ConnectAiSheet models={aiModels} providers={aiProviders} supported={aiSupported} search={modelSearch} setSearch={setModelSearch} keyForm={keyForm} setKeyForm={setKeyForm} busy={aiBusy} onConnect={connectAiKey} onDisconnect={disconnectAiProvider} onSelectModel={(id) => { setShowConnectAI(false); setAiPrefs({ modelId: id }); }} onClose={() => setShowConnectAI(false)} />}
          <nav className="mobile-project-nav" role="tablist" aria-label="Project workspace">{tabs.filter(([id]) => ['chat', 'files', 'changes', 'more'].includes(id)).map(([id, label, icon]) => <button role="tab" key={id} aria-selected={tab === id || (id === 'more' && (tab === 'terminal' || tab === 'preview'))} className={tab === id || (id === 'more' && (tab === 'terminal' || tab === 'preview')) ? 'selected' : ''} onClick={() => setTab(id)}><Icon name={icon} /><span>{label.split(' ')[0]}</span></button>)}</nav>
        </> : <>
          <header className="simple-header"><button className="brand-lockup compact" onClick={() => setPage('home')}><span className="brand-mark" /><b>Orlynx</b></button><div className="simple-header-actions"><Badge tone={integration.github?.connected ? 'ok' : 'fail'}><Icon name="github" />{integration.github?.connected ? 'Connected' : 'Not connected'}</Badge><button className="icon-button" onClick={() => setPage('settings')} aria-label="Settings"><Icon name="settings" /></button></div></header>
          <main className="page-body">
            {error && <div className="screen-alert" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><Icon name="close" /></button></div>}
            {restoring && !session && <div className="loading-screen"><Spinner label="Restoring repository session" /><p>Checking imported repositories…</p></div>}
            {!restoring && page === 'welcome' && <section className="welcome-screen"><div className="welcome-mark"><span className="brand-mark" /></div><p className="eyebrow">ORLYNX</p><h1>Build from anywhere.</h1><p className="welcome-copy">Connect GitHub to start building with your repositories.</p><div className="welcome-actions"><Button onClick={connectGitHub} disabled={connectingGithub}><Icon name="github" />{connectingGithub ? 'Opening GitHub…' : integration.github?.connected ? 'Browse repositories' : 'Continue with GitHub'}</Button></div><button className="text-button" onClick={() => setPage('home')}>Learn more</button></section>}
            {!restoring && page === 'home' && <section className="home-screen"><div className="home-greeting"><p className="eyebrow">YOUR REPOSITORIES</p><h1>{integration.github?.connected && integration.github?.login ? `Welcome, ${integration.github.login}.` : 'Welcome to Orlynx.'}</h1><p>{integration.github?.connected ? 'Choose a repository to start working.' : 'Connect GitHub to start building with your repositories.'}</p></div><div className="home-primary-actions">{integration.github?.connected ? <Button onClick={() => { setPage('github'); loadRepositories(); }}><Icon name="github" />Browse repositories</Button> : <Button onClick={connectGitHub} disabled={connectingGithub}><Icon name="github" />{connectingGithub ? 'Opening GitHub…' : 'Continue with GitHub'}</Button>}</div><div className="home-grid"><section className="home-section"><div className="section-title"><h2>Recent projects</h2><button className="text-button" onClick={() => setPage('projects')}>View all</button></div>{recentProjects.length ? recentProjects.filter((name) => name.includes('/')).map((name) => <button className="project-list-row" key={name} onClick={() => openRecentProject(name)}><span className="repo-avatar"><Icon name="github" /></span><span><b>{name}</b><small>GitHub repository</small></span><Icon name="chevron" /></button>) : <EmptyState title="No repositories yet" hint={integration.github?.connected ? 'Choose a repository above to open your first project.' : 'Your repositories will appear here after connecting GitHub.'} />}</section></div></section>}
            {!restoring && page === 'projects' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">REPOSITORIES</p><h1>Projects</h1><p className="screen-subtitle">Open one of your connected repositories.</p></div><Button disabled={!integration.github?.connected} onClick={() => { setPage('github'); loadRepositories(); }}>Browse repositories</Button></div>{recentProjects.length ? <div className="project-grid">{recentProjects.filter((name) => name.includes('/')).map((name) => <button className="project-card" key={name} onClick={() => openRecentProject(name)}><span className="repo-avatar"><Icon name="github" /></span><span><b>{name}</b><small>GitHub repository</small></span><Icon name="chevron" /></button>)}</div> : <EmptyState title="No repositories imported" hint="Connect GitHub and choose a repository to open your first project." />}</section>}
            {!restoring && page === 'github' && <section className="screen-section github-screen"><button className="back-link" onClick={() => setPage('home')}>‹ Back</button><div className="screen-heading"><div><p className="eyebrow">GITHUB</p><h1>Repository access</h1><p className="screen-subtitle">Choose repositories and branches to work with.</p></div><span className="github-mark"><Icon name="github" size={28} /></span></div><div className="github-connection"><span className={`connection-indicator ${integration.github?.connected ? 'is-connected' : ''}`} /><div><b>{integration.github?.connected ? `Connected${integration.github?.login ? ` as ${integration.github.login}` : ''}` : integration.github?.needsAttention ? 'GitHub needs attention' : 'Not connected'}</b><p>{integration.github?.connected ? `${integration.github.authorizedRepositories ?? repos.length} ${integration.github.authorizedRepositories === 1 ? 'repository' : 'repositories'} available` : integration.github?.needsAttention ? 'Your previous repositories are safe. Reconnect to continue.' : 'Connect GitHub to choose which repositories Orlynx can access.'}</p></div>{!integration.github?.connected ? <Button disabled={repoBusy || connectingGithub} onClick={connectGitHub}>{connectingGithub ? 'Opening GitHub…' : integration.github?.needsAttention ? 'Reconnect GitHub' : 'Connect GitHub'}</Button> : <div className="action-row"><Button tone="ghost" onClick={openManageRepositories}>Manage repositories</Button>{!confirmDisconnect ? <Button tone="ghost" onClick={() => setConfirmDisconnect(true)}>Disconnect</Button> : <><Button tone="ghost" onClick={() => setConfirmDisconnect(false)}>Cancel</Button><Button disabled={disconnecting} onClick={disconnectGitHub}>{disconnecting ? 'Disconnecting…' : 'Disconnect GitHub'}</Button></>}</div>}</div>{confirmDisconnect && integration.github?.connected && <div className="screen-alert" role="alert"><span>Disconnect GitHub? Orlynx will no longer access your GitHub repositories. Your conversations and Orlynx project history will remain.</span></div>}{githubNotice && <div className={`screen-alert tone-${githubNotice.tone}`} role={githubNotice.tone === 'fail' ? 'alert' : 'status'}><span>{githubNotice.text}</span><button onClick={() => setGithubNotice(null)} aria-label="Dismiss"><Icon name="close" /></button></div>}{integration.github?.connected && <div className="manage-hint"><span>Added or removed repositories on GitHub?</span><button className="text-button" onClick={refreshAfterManage}>Refresh repositories</button></div>}{integration.github?.connected && <><div className="repo-picker-heading"><div><h2>Choose a repository</h2><p>Only repositories you've allowed are listed.</p></div><label className="search-field"><Icon name="search" /><input value={repoQuery} onChange={(event) => setRepoQuery(event.target.value)} placeholder="Search repositories" /></label></div><div className="filter-row">{['all', 'personal', 'organizations', 'recent'].map((filter) => <button key={filter} className={repoFilter === filter ? 'active' : ''} onClick={() => setRepoFilter(filter)}>{filter === 'all' ? 'All' : filter === 'personal' ? 'Personal' : filter === 'organizations' ? 'Organizations' : 'Recently used'}</button>)}</div><div className="repo-picker">{repoBusy ? <div className="repo-loading"><Spinner /><span>Loading repositories…</span></div> : filteredRepos.map((repo) => <button className={`github-repo-row ${selectedRepo?.full === repo.full ? 'selected' : ''}`} key={`${repo.installationId}:${repo.full}`} onClick={() => selectRepository(repo)}><span className="repo-avatar"><Icon name="github" /></span><span className="github-repo-copy"><b>{repo.full}</b><small>{repo.ownerType}{repo.language ? ` · ${repo.language}` : ''} · {repo.private ? 'Private' : 'Public'}</small></span><Icon name="chevron" /></button>)}{!repoBusy && !filteredRepos.length && <EmptyState title="No repositories available" hint="Orlynx doesn't currently have access to any repositories." />}{!repoBusy && !filteredRepos.length && <Button tone="ghost" onClick={openManageRepositories}>Choose repositories on GitHub</Button>}</div>{selectedRepo && <div className="selected-repository"><div><b>{selectedRepo.full}</b><small>Select an available branch to clone.</small></div><select value={branch} onChange={(event) => setBranch(event.target.value)} aria-label="Repository branch">{branches.map((item) => <option key={item} value={item}>{item}</option>)}</select><Button onClick={importSelectedRepository} disabled={repoBusy || !branches.length}>{repoBusy ? 'Importing…' : 'Import & open'}</Button></div>}</>}</section>}
            {!restoring && page === 'setup' && <SetupScreen notice={githubNotice} clearNotice={() => setGithubNotice(null)} />}
            {!restoring && page === 'settings' && <SettingsScreen integration={integration} theme={theme} setTheme={setTheme} reload={refreshIntegrations} ai={ai} providers={aiProviders} onManageAi={() => setShowConnectAI(true)} onOpenGithub={() => setPage('github')} />}
            {!restoring && page === 'tasks' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">CURRENT PROJECT</p><h1>Tasks</h1><p className="screen-subtitle">Recent work in this project.</p></div></div>{session && lastRun ? <button className="task-row" onClick={() => setPage('workspace')}><Icon name="clock" /><span><b>{session.checkpoint?.goal || 'Project task'}</b><small>{session.project} · {new Date(lastRun.startedAt).toLocaleString()}</small></span><Badge>{lastRun.state}</Badge></button> : <EmptyState title="No task history" hint="Start a task in this project." />}</section>}
            {!restoring && page === 'search' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">SEARCH PROJECT</p><h1>Find files</h1></div></div><label className="global-search search-page-input"><Icon name="search" /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search current files…" /></label>{files.filter((file: any) => file.name.toLowerCase().includes(search.toLowerCase())).map((file: any) => <button key={file.name} className="project-list-row" onClick={() => { setPage('workspace'); setTab('files'); if (!file.dir) openFile(file.name); }}><Icon name={file.dir ? 'folder' : 'file'} /><span><b>{file.name}</b><small>{session?.project}</small></span><Icon name="chevron" /></button>)}</section>}
          </main>
          <nav className="mobile-global-nav" aria-label="Main navigation">{globalNav.map(([id, label, icon]) => <button key={id} className={page === id ? 'selected' : ''} onClick={() => setPage(id)}><Icon name={icon} /><span>{label}</span></button>)}</nav>
        </>}
      </div>
    </div>
  );
}

function ConnectAiSheet({ models, providers, supported, search, setSearch, keyForm, setKeyForm, busy, onConnect, onDisconnect, onSelectModel, onClose }: {
  models: any[]; providers: any[]; supported: string[]; search: string; setSearch: (v: string) => void;
  keyForm: { providerId: string; apiKey: string }; setKeyForm: (v: { providerId: string; apiKey: string }) => void;
  busy: boolean; onConnect: () => void; onDisconnect: (id: string) => void; onSelectModel: (id: string) => void; onClose: () => void;
}) {
  const available = models.filter((m) => m.status === 'available');
  const query = search.toLowerCase();
  const filtered = available.filter((m) => `${m.displayName} ${m.providerName} ${m.family}`.toLowerCase().includes(query));
  const byProvider = new Map<string, any>();
  for (const p of providers) byProvider.set(p.id, p);
  const connectable = supported.filter((id) => byProvider.get(id)?.state !== 'connected');
  return <div className="sheet-backdrop" onClick={onClose}><div className="sheet" role="dialog" aria-label="Connect AI" onClick={(e) => e.stopPropagation()}>
    <div className="sheet-heading"><div><p className="eyebrow">ORLYNX AI</p><h2>Connect AI</h2><p className="screen-subtitle">Choose how Orlynx works. Keys stay on the Orlynx server — never in this browser.</p></div><button className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" /></button></div>
    <label className="search-field"><Icon name="search" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search models…" /></label>
    <div className="sheet-list">{filtered.slice(0, 50).map((m: any) => <button key={m.id} className="project-list-row" onClick={() => onSelectModel(m.id)}><Icon name="agents" /><span><b>{m.displayName}</b><small>{m.providerName} · Connected</small></span><Icon name="chevron" /></button>)}
      {!filtered.length && <EmptyState title="No models available" hint="Connect an AI account below. Models appear here automatically." />}</div>
    <h3>AI accounts</h3>
    {providers.filter((p) => p.state === 'connected').map((p: any) => <div className="settings-row" key={p.id}><span className="settings-icon"><Icon name="agents" /></span><span><b>{p.name}</b><small>Connected{p.keyEnding ? ` · key ending in ${p.keyEnding}` : ''} · {p.modelsAvailable} models</small></span><Badge tone="ok">Connected</Badge><Button tone="ghost" disabled={busy} onClick={() => onDisconnect(p.id)}>Disconnect</Button></div>)}
    {providers.filter((p) => p.state === 'key-stored').map((p: any) => <div className="settings-row" key={p.id}><span className="settings-icon"><Icon name="agents" /></span><span><b>{p.name}</b><small>Key stored{p.keyEnding ? ` (${p.keyEnding})` : ''} — waiting for the engine to pick it up</small></span><Badge tone="wait">Needs attention</Badge><Button tone="ghost" disabled={busy} onClick={() => onDisconnect(p.id)}>Remove</Button></div>)}
    <div className="connect-key-form"><label>Provider<select value={keyForm.providerId} onChange={(e) => setKeyForm({ ...keyForm, providerId: e.target.value })}><option value="">Choose provider…</option>{connectable.map((id) => <option key={id} value={id}>{byProvider.get(id)?.name || id}</option>)}</select></label><label>API key<input type="password" value={keyForm.apiKey} onChange={(e) => setKeyForm({ ...keyForm, apiKey: e.target.value })} placeholder="••••••••••••••••" autoComplete="off" /></label><Button disabled={busy || !keyForm.providerId || !keyForm.apiKey} onClick={onConnect}>{busy ? 'Connecting…' : 'Connect'}</Button></div>
  </div></div>;
}

function SetupScreen({ notice, clearNotice }: { notice: { tone: 'ok' | 'fail' | 'neutral'; text: string } | null; clearNotice: () => void }) {
  const [token, setToken] = useState(() => { try { return sessionStorage.getItem('orlynx:setupToken') || ''; } catch { return ''; } });
  const [status, setStatus] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(setupToken: string) {
    setBusy(true); setError('');
    try {
      const res = await fetch(`/v1/setup/github-app?setup_token=${encodeURIComponent(setupToken)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || body.reason || 'Setup is unavailable.');
      try { sessionStorage.setItem('orlynx:setupToken', setupToken); } catch {}
      setStatus(body);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">OWNER SETUP</p><h1>GitHub App</h1><p className="screen-subtitle">One-time setup. Creates the GitHub App that users install. Normal users never see this screen.</p></div></div>
    {notice && <div className={`screen-alert tone-${notice.tone}`} role="status"><span>{notice.text}</span><button onClick={clearNotice} aria-label="Dismiss"><Icon name="close" /></button></div>}
    {error && <div className="screen-alert" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><Icon name="close" /></button></div>}
    {status?.mode === 'complete' && <EmptyState title="Setup complete" hint="The production GitHub App is configured. This setup endpoint is now locked." />}
    {(!status || status.mode === 'unauthorized' || status.mode === 'unavailable') && status?.mode !== 'complete' && <form className="preview-form" onSubmit={(e) => { e.preventDefault(); load(token); }}><label>Setup token<input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ORLYNX_SETUP_TOKEN" autoComplete="off" /></label><Button disabled={busy || !token}>{busy ? 'Checking…' : 'Continue'}</Button></form>}
    {status?.mode === 'bootstrap' && <div className="card"><p>This creates the GitHub App <b>{status.appName}</b> for <b>{status.publicUrl}</b> with repository contents (write) and metadata (read) only — no extra permissions or event subscriptions.</p><form method="post" action={`${status.manifestEndpoint}?state=${encodeURIComponent(status.state)}`}><input type="hidden" name="manifest" value={JSON.stringify(status.manifest)} /><Button>{busy ? 'Opening GitHub…' : 'Create GitHub App'}</Button></form><p className="settings-footnote">GitHub will ask you to confirm. After approval you return here automatically and Orlynx stores the credentials itself.</p></div>}
  </section>;
}

function ActivityList({ activities }: { activities: any[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? activities.slice(-50) : activities.slice(-5);
  return <div className="card"><div className="ox-stream">{visible.map((item) => <TaskActivityRow key={item.key} item={item} />)}</div>{activities.length > 5 && <Button tone="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show recent activity' : 'Show earlier activity'}</Button>}</div>;
}

function Terminal({ command, setCommand, output, run, connected }: { command: string; setCommand: (value: string) => void; output: string; run: () => void; connected: boolean }) {
  return <div className="terminal-panel"><div className="terminal-note"><Icon name="terminal" />Project terminal</div><form className="terminal-command" onSubmit={(event) => { event.preventDefault(); run(); }}><label>Command</label><div><span>$</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="git status --short" /><Button disabled={!connected || !command.trim()}>Run</Button></div></form><pre className="terminal-output">{output || 'No command has been run.'}</pre></div>;
}

function SettingsScreen({ integration, theme, setTheme, reload, ai, providers, onManageAi, onOpenGithub }: { integration: any; theme: string; setTheme: (theme: string) => void; reload: () => void; ai?: any; providers?: any[]; onManageAi?: () => void; onOpenGithub?: () => void }) {
  const aiLabel = ai?.state === 'ready' ? `Ready${ai?.model ? ` · ${ai.model.displayName}` : ''}` : ai?.state === 'working' ? 'Working' : ai?.state === 'needs_attention' ? 'Needs attention' : 'Not connected';
  void reload;
  return <section className="screen-section settings-screen"><div className="screen-heading"><div><p className="eyebrow">ORLYNX</p><h1>Settings</h1><p className="screen-subtitle">Your connections and preferences.</p></div></div><section className="settings-group"><h2>GitHub</h2><div className="settings-row"><span className="settings-icon"><Icon name="github" /></span><span><b>{integration.github?.connected ? `Connected${integration.github?.login ? ` as ${integration.github.login}` : ''}` : 'Not connected'}</b><small>{integration.github?.connected ? `${integration.github?.authorizedRepositories ?? ''} repositories` : 'Connect to work with your repositories'}</small></span><Badge tone={integration.github?.connected ? 'ok' : 'fail'}>{integration.github?.connected ? 'Connected' : 'Not connected'}</Badge></div><div className="action-row"><Button tone="ghost" onClick={onOpenGithub}>{integration.github?.connected ? 'Manage' : 'Connect GitHub'}</Button></div></section><section className="settings-group"><h2>Orlynx AI</h2><div className="settings-row"><span className="settings-icon"><Icon name="agents" /></span><span><b>{aiLabel}</b><small>{(providers || []).filter((p: any) => p.state === 'connected').map((p: any) => p.name).join(', ') || 'No AI accounts connected'}</small></span><Badge tone={ai?.state === 'ready' ? 'ok' : 'fail'}>{ai?.state === 'ready' ? 'Ready' : ai?.state === 'working' ? 'Working' : 'Not connected'}</Badge></div><Button tone="ghost" onClick={onManageAi}>Manage AI</Button><details className="advanced-details"><summary>Advanced</summary><p>Engine status: {integration.agent?.connected ? 'online' : 'offline'}</p>{integration.agent?.agents?.length ? <p>Available assistants: {integration.agent.agents.map((a: any) => a.name).join(', ')}</p> : null}{integration.agent?.url ? <p>Engine endpoint: {integration.agent.url}</p> : null}</details></section><section className="settings-group"><h2>Appearance</h2><div className="settings-row"><span><b>Theme</b><small>Warm light is the Orlynx reference theme.</small></span><select value={theme} onChange={(event) => setTheme(event.target.value)} aria-label="Theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div></section></section>;
}
