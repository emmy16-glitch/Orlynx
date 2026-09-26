import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';
import { j } from './api';
import { Badge, Button, EmptyState, Icon, Input, Spinner } from './ui/primitives';
import { AgentApprovalCard, AgentErrorCard, AttachmentChip, DiffSummary, TaskActivityRow } from './ui/product';
import { ActivityDetailToggle, useActivityDetailMode } from './ui/workstream';
import { toActivities, chatActivities } from './ui/mapping';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('markdown', markdown);

type Page = 'welcome' | 'home' | 'projects' | 'github' | 'settings' | 'tasks' | 'search' | 'workspace' | 'setup';
type Tab = 'chat' | 'files' | 'changes' | 'preview' | 'terminal' | 'more';
type Repo = { full: string; owner: string; name: string; ownerType: string; private: boolean; defaultBranch: string; language?: string | null; updatedAt?: string; installationId?: number };
const LAST_SESSION = 'orlynx:lastSession';
const RECENTS = 'orlynx:recentProjects';
const THEME = 'orlynx:theme';
const PENDING_REPO = 'orlynx:pendingRepository';
const PENDING_CLOUD_RETRY = 'orlynx:pendingCloudRetry';
const sessionKey = (project: string) => `orlynx:projectSession:${project}`;
const seqKey = (sessionId: string) => `orlynx:seq:${sessionId}`;
const draftKey = (sessionId: string) => `orlynx:draft:${sessionId}`;
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
function repoUpdatedLabel(value?: string) {
  if (!value) return 'Recently updated';
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) return 'Recently updated';
  const delta = Math.max(0, Date.now() - stamp);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `Updated ${days}d ago`;
  return `Updated ${new Date(stamp).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function visibleChatText(role: string, text: string): string {
  if (role !== 'assistant') return text;
  const marker = 'Respond naturally to the latest user message. Do not repeat the transcript.';
  const index = text.lastIndexOf(marker);
  return index >= 0 ? text.slice(index + marker.length).trim() : text;
}

export default function ProductionApp() {
  const [page, setPage] = useState<Page>('welcome');
  const [tab, setTab] = useState<Tab>('chat');
  const [session, setSession] = useState<any>(null);
  const [lastRun, setLastRun] = useState<any>(null);
  const [integration, setIntegration] = useState<any>({ github: {}, githubAvailable: true, ai: { available: false }, workspace: { terminalAvailable: false, cloudAvailable: false, previewAvailable: false } });
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoQuery, setRepoQuery] = useState('');
  const [repoExpanded, setRepoExpanded] = useState(false);
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
  const [attachmentLink, setAttachmentLink] = useState('');
  const [composer, setComposer] = useState('');
  const [sending, setSending] = useState(false);
  const [online, setOnline] = useState(typeof navigator === 'undefined' || navigator.onLine);
  const [streamStatus, setStreamStatus] = useState('live');
  const [repoBusy, setRepoBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [error, setError] = useState('');
  const [recentProjects, setRecentProjects] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(RECENTS) || '[]').filter((name: string) => name.includes('/')); } catch { return []; } });
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem(THEME) || 'system'; } catch { return 'system'; } });
  const [command, setCommand] = useState('');
  const [terminalOutput, setTerminalOutput] = useState('');
  const [search, setSearch] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [busyChange, setBusyChange] = useState<string | null>(null);
  const [pushReview, setPushReview] = useState<any>(null);
  const [githubNotice, setGithubNotice] = useState<{ tone: 'ok' | 'fail' | 'neutral'; text: string } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [ai, setAi] = useState<any>({ state: 'disconnected', adapterId: 'opencode', adapters: [], mode: 'build', permission: 'ask-first', providers: { connected: 0, total: 0 } });
  const [aiModels, setAiModels] = useState<any[]>([]);
  const [aiModelError, setAiModelError] = useState('');
  const [aiProviders, setAiProviders] = useState<any[]>([]);
  const [showConnectAI, setShowConnectAI] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [tempFullAccess, setTempFullAccess] = useState(false);
  const [connectingGithub, setConnectingGithub] = useState(false);
  const [syncingGithub, setSyncingGithub] = useState(false);
  const [syncStep, setSyncStep] = useState('');
  const manageOpenedAt = useRef(0);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [workspaceClock, setWorkspaceClock] = useState(Date.now());
  const [cloudIssue, setCloudIssue] = useState<'permissions' | 'failed' | null>(null);
  const [workspaceReadNotice, setWorkspaceReadNotice] = useState('');
  const workspaceReconnectRef = useRef(new Set<string>());
  const [previewPorts, setPreviewPorts] = useState<any[]>([]);

  async function connectGitHub() {
    // User flow only: navigate straight to the backend, which owns the GitHub
    // URL and redirects there. (A fetch-probe breaks on some mobile browsers,
    // which follow the redirect into a CORS failure instead of reporting 302.)
    // If the platform is known to be unready, say so without a round trip.
    if (integration.githubAvailable === false) {
      setGithubNotice({ tone: 'fail', text: 'GitHub connection is temporarily unavailable. Please try again.' });
      setPage('github');
      return;
    }
    setConnectingGithub(true);
    window.location.assign('/v1/github/install');
  }
  const [newActivity, setNewActivity] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const seqRef = useRef(0);
  const seenRef = useRef(new Set<string>());
  const currentSessionRef = useRef<any>(null);
  const pendingRef = useRef<any[]>([]);
  const rafRef = useRef<number | null>(null);
  const runRef = useRef<any>(null);
  const partialCutoffRef = useRef(0);
  const ptyRef = useRef<string | null>(null);
  const nearBottomRef = useRef(true);
  const repoLoadAttempt = useRef(false);

  const refreshIntegrations = useCallback(async () => {
    const id = currentSessionRef.current?.id;
    try { setIntegration(await j<any>(await fetch(`/v1/integrations/status${id ? `?sessionId=${encodeURIComponent(id)}` : ''}`))); }
    catch { setIntegration({ github: { connected: false }, githubAvailable: false, ai: { available: false }, workspace: { terminalAvailable: false, cloudAvailable: false, previewAvailable: false } }); }
  }, []);

  const refreshAi = useCallback(async (sessionId?: string) => {
    const catalogRequest = fetch('/v1/ai/catalog').then((response) => j<any>(response));
    const overviewRequest = fetch(`/v1/ai/overview${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`).then((response) => j<any>(response));
    const [catalogResult, overviewResult] = await Promise.allSettled([catalogRequest, overviewRequest]);

    const catalogModels = catalogResult.status === 'fulfilled' ? (catalogResult.value.models || []) : [];
    const overview = overviewResult.status === 'fulfilled' ? overviewResult.value : null;
    const overviewModels = overview?.models || [];

    const merged = new Map<string, any>();
    for (const model of catalogModels) merged.set(String(model.id).toLowerCase(), model);
    for (const model of overviewModels) merged.set(String(model.id).toLowerCase(), model);
    const models = [...merged.values()];

    setAiModels(models);
    if (overview) {
      setAi((current: any) => {
        const overviewModelId = overview.model?.id;
        const currentModelId = current?.model?.id;
        const wantedId = overviewModelId || currentModelId;
        const retained = wantedId
          ? models.find((model: any) => String(model.id).toLowerCase() === String(wantedId).toLowerCase() && model.status === 'available')
          : undefined;
        return {
          ...overview,
          model: retained,
        };
      });
      setAiProviders(overview.providerConnections || []);
    }

    if (models.length) {
      setAiModelError('');
      return;
    }

    const catalogError = catalogResult.status === 'rejected' ? catalogResult.reason?.message : '';
    const overviewError = overviewResult.status === 'rejected' ? overviewResult.reason?.message : '';
    setAiModelError(catalogError || overviewError || 'Models could not be loaded. Try again.');
  }, []);

  async function reconnectStaleWorkspace(id: string) {
    if (workspaceReconnectRef.current.has(id)) return;
    workspaceReconnectRef.current.add(id);
    setWorkspaceReadNotice('Cloud workspace connection was interrupted. Showing the GitHub version while Orlynx reconnects.');
    try {
      const response = await fetch(`/v1/sessions/${id}/cloud/reconnect`, { method: 'POST' });
      if (response.ok) {
        setWorkspaceReadNotice('Reconnecting cloud workspace…');
        refreshIntegrations().catch(() => {});
      } else {
        const body = await response.json().catch(() => ({}));
        setWorkspaceReadNotice(String(body.error || 'Cloud workspace needs attention. GitHub files remain available.'));
      }
    } catch {
      setWorkspaceReadNotice('Cloud workspace needs attention. GitHub files remain available.');
    } finally {
      window.setTimeout(() => workspaceReconnectRef.current.delete(id), 10_000);
    }
  }

  const refreshSession = useCallback(async (id: string) => {
    const [messageData, changeData, details, runData, attachmentData] = await Promise.all([
      fetch(`/v1/sessions/${id}/messages`).then((response) => j<any[]>(response)),
      fetch(`/v1/sessions/${id}/changes`).then((response) => j<any[]>(response)),
      fetch(`/v1/sessions/${id}`).then((response) => j<any>(response)),
      fetch(`/v1/sessions/${id}/runs`).then((response) => j<any[]>(response)),
      fetch(`/v1/sessions/${id}/attachments`).then((response) => j<any[]>(response)),
    ]);
    setMessages(messageData); setChanges(changeData); setAttachments(attachmentData);
    const latestRun = runData.slice(-1)[0] || null;
    setLastRun(latestRun); runRef.current = latestRun;
    if (['running', 'failed', 'cancelled'].includes(latestRun?.state) && latestRun?.partialText) {
      setDraftReply(String(latestRun.partialText));
      partialCutoffRef.current = Date.parse(latestRun.partialUpdatedAt || '') || 0;
    } else if (latestRun?.state !== 'running') {
      setDraftReply('');
      partialCutoffRef.current = 0;
    }
    setSession(details); currentSessionRef.current = details;
    refreshIntegrations().catch(() => {});
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
      const textEvents = batch.filter((item) => item.type === 'message.delta' && (Date.parse(item.timestamp || '') || 0) > partialCutoffRef.current);
      if (textEvents.length) setDraftReply((previous) => previous + textEvents.map((item) => String(item.payload?.delta || '')).join(''));
      const terminalEvents = batch.filter((item) => item.payload?.sourceType === 'pty.output');
      if (terminalEvents.length) setTerminalOutput((previous) => `${previous}${terminalEvents.map((item) => String(item.payload?.data || '')).join('')}`.slice(-100_000));
      for (const item of batch) {
        if (['run.completed', 'run.failed', 'receipt.created', 'changes.updated', 'workspace.ready'].includes(item.type)) refreshSession(sessionId).catch(() => {});
        if (item.type === 'state.delta' && item.payload?.scope === 'agent-adapter') {
          refreshAi(sessionId).catch(() => {});
          if (item.payload?.state === 'ready') {
            setWorkspaceReadNotice((current) => /OpenCode|AI|agent|runtime/i.test(current) ? '' : current);
          }
        }
        if (item.type === 'workspace.preparing' && item.payload?.message) setWorkspaceReadNotice(String(item.payload.message));
        if (item.type === 'workspace.ready') setWorkspaceReadNotice('');
        if (item.type === 'run.started') {
          setDraftReply('');
          partialCutoffRef.current = 0;
          setLastRun({ id: item.runId, state: 'running', plane: item.payload?.plane, model: item.payload?.model, engine: item.payload?.engine || item.payload?.adapterId || 'opencode', startedAt: item.timestamp });
        }
        if (!nearBottomRef.current) setNewActivity(true);
      }
      try { localStorage.setItem(seqKey(sessionId), String(seqRef.current)); } catch {}
    });
  }, [refreshAi, refreshSession]);

  const connectEvents = useCallback((sessionId: string) => {
    sourceRef.current?.close();
    if (retryRef.current) clearTimeout(retryRef.current);
    const attempt = () => {
      const source = new EventSource(`/v1/sessions/${sessionId}/events?after=${seqRef.current}`);
      sourceRef.current = source;
      source.onopen = () => { retryAttemptRef.current = 0; setStreamStatus('live'); };
      source.onmessage = (message) => {
        retryAttemptRef.current = 0;
        setStreamStatus('live');
        try { ingest(sessionId, JSON.parse(message.data)); }
        catch { setError('Orlynx received an invalid activity event.'); }
      };
      source.onerror = () => {
        source.close();
        setStreamStatus(navigator.onLine ? 'reconnecting' : 'offline');
        const delays = [1000, 2000, 4000, 8000];
        const delay = delays[Math.min(retryAttemptRef.current, delays.length - 1)];
        retryAttemptRef.current += 1;
        retryRef.current = setTimeout(attempt, delay);
      };
    };
    attempt();
  }, [ingest]);

  const openSession = useCallback(async (record: any) => {
    sourceRef.current?.close();
    seqRef.current = 0;
    seenRef.current = new Set(); pendingRef.current = []; setEvents([]); setDraftReply(''); setPushReview(null);
    setFolder(''); setOpenedFile(null); setError(''); setTab('chat'); setPage('workspace');
    setSession(record); currentSessionRef.current = record;
    try {
      localStorage.setItem(LAST_SESSION, JSON.stringify({ id: record.id, project: record.project }));
      localStorage.setItem(sessionKey(record.project), record.id);
    } catch {}
    setRecentProjects((previous) => { const next = [record.project, ...previous.filter((item) => item !== record.project)].filter((name) => name.includes('/')).slice(0, 8); try { localStorage.setItem(RECENTS, JSON.stringify(next)); } catch {} return next; });
    await refreshSession(record.id);
    try {
      const history = await j<any[]>(await fetch(`/v1/sessions/${record.id}/activity?limit=300`));
      const ordered = [...history].filter((item) => item?.eventId).sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
      setEvents(ordered);
      seenRef.current = new Set(ordered.map((item) => item.eventId));
      seqRef.current = ordered.reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0);
      try { localStorage.setItem(seqKey(record.id), String(seqRef.current)); } catch {}
    } catch {
      seqRef.current = Number(localStorage.getItem(seqKey(record.id)) || 0);
    }
    setRestoring(false); connectEvents(record.id);
  }, [connectEvents, refreshSession]);

  useEffect(() => {
    refreshIntegrations();
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
      if (callback === 'connected') {
        setPage('github');
        setError('');
        // Mockup screen 5: automatic redirect & sync. The session cookie was
        // just issued by /v1/github/setup, so re-read integrations, force a
        // live re-verification, then list repositories — no manual step.
        setSyncingGithub(true);
        setSyncStep('Verifying installation');
        setGithubNotice({ tone: 'neutral', text: 'Connecting your GitHub account…' });
        void (async () => {
          try {
            await refreshIntegrations();
            setSyncStep('Fetching repositories');
            try { await fetch('/v1/github/sync', { method: 'POST' }); } catch { /* sync is best-effort; status refresh below still applies */ }
            await refreshIntegrations();
            setSyncStep('Finishing setup');
            const response = await fetch('/v1/repos');
            if (response.ok) {
              const result = await j<any>(response);
              setIntegration((current: any) => ({ ...current, github: result.connection }));
              setRepos(result.github || []);
              setSelectedRepo(null); setBranches([]);
              repoLoadAttempt.current = true;
              setError('');
              setGithubNotice(result.github?.length ? null : { tone: 'neutral', text: 'No repositories are available yet. Choose repositories on GitHub, then refresh.' });
              // If project opening had to finish OAuth after durable storage
              // was enabled, continue the user's original action automatically.
              const pendingFull = sessionStorage.getItem(PENDING_REPO);
              const pendingRepo = pendingFull ? (result.github || []).find((repo: Repo) => repo.full === pendingFull) : null;
              if (pendingRepo) {
                sessionStorage.removeItem(PENDING_REPO);
                await openRepository(pendingRepo);
              }

              const pendingCloud = sessionStorage.getItem(PENDING_CLOUD_RETRY);
              if (pendingCloud) {
                const pendingResponse = await fetch(`/v1/sessions/${encodeURIComponent(pendingCloud)}`);
                if (pendingResponse.ok) {
                  await openSession(await pendingResponse.json());
                  await startCloud(false, pendingCloud);
                } else {
                  sessionStorage.removeItem(PENDING_CLOUD_RETRY);
                }
              }
            } else {
              setGithubNotice({ tone: 'ok', text: 'GitHub connected. Choose a repository to open.' });
            }
          } catch {
            setGithubNotice({ tone: 'fail', text: 'GitHub connected, but repositories could not be listed yet. Use Refresh below.' });
          } finally {
            setSyncStep('');
            setSyncingGithub(false);
            setRestoring(false);
          }
        })();
      }
      else if (callback === 'disconnected') { setPage('github'); setGithubNotice({ tone: 'neutral', text: 'GitHub disconnected. Your Orlynx sessions are preserved.' }); }
      else if (callback === 'error') { setPage('github'); setGithubNotice({ tone: 'fail', text: params.get('reason') || 'GitHub connection was not completed. No repository access was granted.' }); }
      else setPage('github');
    }
    const boot = async () => {
      let restored = false;
      try {
        const stored = localStorage.getItem(LAST_SESSION);
        if (stored) {
          const { id } = JSON.parse(stored);
          const response = await fetch(`/v1/sessions/${id}`);
          if (response.ok) {
            const project = await response.json();
            if (project.owner !== 'local' && project.owner) { await openSession(project); restored = true; }
          }
        }
        // localStorage is only a convenience pointer. Always refresh recent
        // projects from durable identity-owned sessions so a second phone does
        // not look empty merely because its local cache is new.
        const response = await fetch('/v1/sessions?limit=8');
        if (response.ok) {
          const sessions = await response.json() as any[];
          const durableNames = sessions.map((item) => String(item.project || '')).filter((name) => name.includes('/'));
          if (durableNames.length) {
            setRecentProjects((previous) => {
              const next = [...durableNames, ...previous].filter((name, index, all) => all.indexOf(name) === index).slice(0, 8);
              try { localStorage.setItem(RECENTS, JSON.stringify(next)); } catch {}
              return next;
            });
          }
          if (!restored) {
            const project = sessions[0];
            if (project?.owner && project.owner !== 'local') { await openSession(project); restored = true; }
          }
        }
      } catch {
        // A missing/expired account session should fall through to normal
        // Connect GitHub onboarding rather than claiming local data was lost.
      }
      setRestoring(false);
    };
    // OAuth recovery owns the screen until its pending repository/workspace
    // action completes. Restoring the last session in parallel overwrites it.
    if (callback !== 'connected') void boot();
    const onOnline = () => { setOnline(true); retryAttemptRef.current = 0; if (currentSessionRef.current) connectEvents(currentSessionRef.current.id); };
    const onOffline = () => { setOnline(false); setStreamStatus('offline'); sourceRef.current?.close(); };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && currentSessionRef.current) {
        retryAttemptRef.current = 0;
        connectEvents(currentSessionRef.current.id);
        refreshSession(currentSessionRef.current.id).then(() => setOnline(true)).catch(() => {});
      }
    };
    const onFocus = () => { if (currentSessionRef.current && document.visibilityState === 'visible') onVisible(); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      sourceRef.current?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [connectEvents, openSession, refreshIntegrations, refreshAi]);

  // Android can keep navigator.onLine false after connectivity returns. A
  // successful request to our API is a better signal than that browser hint.
  useEffect(() => {
    if (online) return;
    let cancelled = false;
    const probe = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const response = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (response.ok && !cancelled) {
          setOnline(true);
          if (currentSessionRef.current) connectEvents(currentSessionRef.current.id);
        }
      } catch { /* the next probe checks again */ }
    };
    void probe();
    const timer = window.setInterval(probe, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [online, connectEvents]);

  // A backgrounded mobile tab can outlive the request that started a Codespace.
  // Poll only the small session record until the agent reports ready or failed.
  useEffect(() => {
    const workspace = session?.workspace;
    if (!session?.id || !workspace || !['creating', 'starting', 'bootstrapping', 'connecting'].includes(workspace.state)) return;
    const tick = window.setInterval(async () => {
      setWorkspaceClock(Date.now());
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      try {
        const next = await j<any>(await fetch(`/v1/sessions/${encodeURIComponent(session.id)}`));
        setSession(next); currentSessionRef.current = next;
        if (next.workspace?.state === 'ready' || next.workspace?.state === 'failed') {
          await refreshSession(session.id);
          if (next.workspace?.state === 'failed') setCloudIssue('failed');
        }
      } catch { /* the next tick retries without replacing the current screen */ }
    }, 4000);
    return () => window.clearInterval(tick);
  }, [session?.id, session?.workspace?.state, refreshSession]);

  // AI routes are protected by the signed GitHub installation session. Do not
  // issue guaranteed-to-fail requests while the visitor is still signed out.
  // Once integration status confirms the session, load the available runtime.
  useEffect(() => {
    if (integration.github?.connected) {
      refreshAi().catch(() => {});
      return;
    }
    setAi({ state: 'disconnected', adapterId: 'opencode', adapters: [], mode: 'build', permission: 'ask-first', providers: { connected: 0, total: 0 } });
    setAiModels([]);
    setAiModelError('');
    setAiProviders([]);
  }, [integration.github?.connected, refreshAi]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme; };
    apply(); if (theme === 'system') media.addEventListener('change', apply);
    try { localStorage.setItem(THEME, theme); } catch {}
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    const onScroll = () => { const distance = document.documentElement.scrollHeight - innerHeight - scrollY; const atBottom = distance < 140; nearBottomRef.current = atBottom; if (atBottom) setNewActivity(false); };
    addEventListener('scroll', onScroll, { passive: true }); return () => removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!nearBottomRef.current || tab !== 'chat' || page !== 'workspace') return;
    const frame = requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
    return () => cancelAnimationFrame(frame);
  }, [messages.length, draftReply, events.length, tab, page]);

  useEffect(() => {
    if (tab !== 'preview' || !session?.id || !integration.workspace?.previewAvailable) return;
    fetch(`/v1/sessions/${session.id}/ports`).then((response) => j<any>(response)).then((result) => setPreviewPorts(result.ports || [])).catch(() => setPreviewPorts([]));
  }, [tab, session?.id, integration.workspace?.previewAvailable]);

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
    setSelectedRepo(repo); setBranch(repo.defaultBranch); setError('');
    try { const result = await j<any>(await fetch(`/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/branches`)); const available = result.branches?.length ? result.branches : [repo.defaultBranch]; setBranches(available); setBranch(available.includes(repo.defaultBranch) ? repo.defaultBranch : available[0]); }
    catch (error: any) { setBranches([]); setError(error.message || 'Branches could not be loaded.'); }
  }

  async function openRepository(repo: Repo) {
    setRepoBusy(true); setError(''); setSelectedRepo(repo);
    try {
      const branchResult = await j<any>(await fetch(`/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/branches`));
      const available = branchResult.branches?.length ? branchResult.branches : [repo.defaultBranch];
      const chosenBranch = available.includes(repo.defaultBranch) ? repo.defaultBranch : available[0];
      if (!chosenBranch) throw new Error('This repository does not have a branch to open yet.');
      setBranches(available); setBranch(chosenBranch);
      await j(await fetch('/v1/repos/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: repo.full, branch: chosenBranch }) }));
      const record = await j<any>(await fetch('/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: repo.full, owner: repo.owner, branch: chosenBranch }) }));
      await openSession(record);
    } catch (error: any) {
      const message = String(error?.message || '');
      if (message.includes('Reconnect GitHub before creating a durable project session')) {
        try { sessionStorage.setItem(PENDING_REPO, repo.full); } catch {}
        setGithubNotice({ tone: 'neutral', text: 'Finishing your secure GitHub connection…' });
        window.location.assign('/v1/github/install');
        return;
      }
      setError(message.includes('workspace storage') || message.includes('STORAGE_REQUIRED') || message.includes('durable storage')
        ? 'This project cannot open yet because the Orlynx workspace service is still being prepared.'
        : message || 'This repository could not be opened.');
    } finally {
      setRepoBusy(false);
    }
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
    // GitHub-native consent happens on GitHub. Keep Orlynx open so returning
    // from the GitHub tab can refresh permissions and continue automatically.
    manageOpenedAt.current = Date.now();
    if (cloudIssue === 'permissions' && session?.id) {
      try { sessionStorage.setItem(PENDING_CLOUD_RETRY, session.id); } catch {}
      setGithubNotice({ tone: 'neutral', text: 'GitHub opened in another tab. Approve the requested access there, then return to Orlynx. We will continue automatically.' });
    }
    const opened = window.open('/v1/github/manage', 'orlynx-github-access', 'noopener,noreferrer');
    if (!opened) window.location.assign('/v1/github/manage');
  }

  // When the user returns from the GitHub management tab, refresh access
  // automatically so the updated repositories appear without manual steps.
  useEffect(() => {
    const onFocus = () => {
      if (!manageOpenedAt.current || Date.now() - manageOpenedAt.current > 10 * 60_000) return;
      manageOpenedAt.current = 0;
      void refreshAfterManage();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') onFocus(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    // Mobile browsers sometimes discard the original tab while GitHub is
    // open. Resume the saved approval flow when that tab is recreated.
    if (sessionStorage.getItem(PENDING_CLOUD_RETRY) && !new URLSearchParams(window.location.search).has('github')) {
      manageOpenedAt.current = Date.now();
      onFocus();
    }
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisible); };
  }, [session?.id, cloudIssue]);

  async function refreshAfterManage() {
    setSyncingGithub(true); setSyncStep('Fetching repositories'); setError('');
    try {
      // Live re-verification first: drops cached tokens/listings and re-reads
      // the authoritative repository set from GitHub for this installation.
      try { await j(await fetch('/v1/github/sync', { method: 'POST' })); } catch { /* fall through to status refresh */ }
      await refreshIntegrations();
      repoLoadAttempt.current = false;
      const response = await fetch('/v1/repos');
      if (response.ok) {
        const result = await j<any>(response);
        setIntegration((current: any) => ({ ...current, github: result.connection }));
        setRepos(result.github || []);
        setSelectedRepo(null); setBranches([]);
        repoLoadAttempt.current = true;
        if (!result.github?.length) setGithubNotice({ tone: 'neutral', text: 'No repositories are selected for Orlynx yet. Add some on GitHub, then refresh again.' });
        else setGithubNotice({ tone: 'ok', text: 'Repository access refreshed.' });
      } else {
        await refreshIntegrations();
      }

      if (cloudIssue === 'permissions' && session?.id) {
        const permissionStatus = await j<any>(await fetch('/v1/github/status'));
        const appCaps = permissionStatus.appCapabilities || {};
        if (!appCaps.codespaces || !appCaps.codespacesLifecycle) {
          setGithubNotice({ tone: 'fail', text: 'The Orlynx GitHub App itself still needs Codespaces permissions enabled by the app owner. Repository approval alone cannot start the workspace yet.' });
          return;
        }
        if (!permissionStatus.permissionStatus?.workspaceReady) {
          setGithubNotice({ tone: 'neutral', text: 'GitHub is still waiting for the requested Codespaces permission update to be approved. Finish the approval on GitHub, then return here.' });
          return;
        }

        // Installation permissions are now approved. Refresh the user-scoped
        // GitHub authorization so the Codespaces API receives the new grant.
        const pendingSession = sessionStorage.getItem(PENDING_CLOUD_RETRY);
        if (pendingSession) {
          window.location.assign('/v1/github/reauthorize');
        } else {
          setGithubNotice({ tone: 'ok', text: 'GitHub access refreshed. Your repositories are ready.' });
        }
        return;
      }
    } catch (error: any) { setError(error.message || 'GitHub repositories could not be refreshed.'); }
    finally { setSyncingGithub(false); setSyncStep(''); }
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
      if (id) {
        const response = await fetch(`/v1/sessions/${id}`);
        if (response.ok) { await openSession(await response.json()); return; }
      }
      // New device/browser: resolve the project from server-owned session
      // history instead of requiring a localStorage mapping.
      const response = await fetch('/v1/sessions?limit=50');
      if (response.ok) {
        const sessions = await response.json() as any[];
        const durable = sessions.find((item) => item.project === project);
        if (durable) { await openSession(durable); return; }
      }
      throw new Error('No saved Orlynx conversation exists for this repository. Open the repository to start one.');
    } catch (error: any) { setError(error.message || 'Project could not be opened.'); }
  }

  async function setAiPrefs(patch: { adapterId?: string; modelId?: string; mode?: string; permission?: string }) {
    if (!session) return;
    setError('');
    try {
      const result = await j<any>(await fetch(`/v1/ai/session/${session.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }));

      if (result.prefs?.adapterId) {
        setAi((current: any) => ({ ...current, adapterId: result.prefs.adapterId }));
      }

      if (result.prefs?.modelId) {
        const selected = aiModels.find((model: any) =>
          String(model.id).toLowerCase() === String(result.prefs.modelId).toLowerCase() &&
          model.status === 'available'
        );
        if (selected) {
          setAi((current: any) => ({
            ...current,
            model: selected,
            state: 'ready',
            message: 'Ready.',
          }));
        }
      }

      if (result.prefs?.mode || result.prefs?.permission) {
        setAi((current: any) => ({
          ...current,
          ...(result.prefs.mode ? { mode: result.prefs.mode } : {}),
          ...(result.prefs.permission ? { permission: result.prefs.permission } : {}),
        }));
      }

      if (result.appliesTo === 'next-turn') setError('A task is running. Your selection applies to the next turn.');
      await refreshAi(session.id);
    } catch (error: any) { setError(error.message || 'AI preference could not be saved.'); }
  }

  const submittingRef = useRef(false);
  async function sendMessage() {
    if (!session || !composer.trim() || submittingRef.current || sending || !online) return;
    if (!ai.model?.id) { setShowConnectAI(true); setError('Choose a model before sending your message.'); return; }
    submittingRef.current = true;
    setSending(true); setError('');
    const text = composer.trim(); const clientId = uid();
    try {
      const result = await j<any>(await fetch(`/v1/sessions/${session.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, clientId, adapterId: ai.adapterId || 'opencode', modelId: ai.model.id, mode: ai.mode, fullAccessForThisTask: ai.mode === 'build' && tempFullAccess }) }));
      setComposer(''); setDraftReply(''); setTempFullAccess(false); try { localStorage.removeItem(draftKey(session.id)); } catch {}
      setLastRun(result.run); runRef.current = result.run;
      if (result.plane === 'direct') setWorkspaceReadNotice('');
      await refreshSession(session.id);
    } catch (error: any) { setError((error.message || 'Orlynx AI could not accept the task. The draft is preserved.').replace(/OpenCode/g, 'Orlynx AI')); }
    finally { submittingRef.current = false; setSending(false); }
  }

  async function startCloud(reconnect = false, targetSessionId?: string) {
    const sessionId = targetSessionId || session?.id;
    if (!sessionId || cloudBusy) return;
    setCloudBusy(true); setError(''); setCloudIssue(null);
    try {
      let workspace = await j<any>(await fetch(`/v1/sessions/${sessionId}/cloud${reconnect ? '/reconnect' : ''}`, { method: 'POST' }));
      const deadline = Date.now() + 3 * 60_000;
      while (workspace?.state !== 'ready' && workspace?.state !== 'failed' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const details = await j<any>(await fetch(`/v1/sessions/${sessionId}`));
        workspace = details.workspace; setSession(details); currentSessionRef.current = details;
        if (workspace?.state === 'creating' || workspace?.state === 'starting') {
          workspace = await j<any>(await fetch(`/v1/sessions/${sessionId}/cloud`, { method: 'POST' }));
        }
      }
      if (workspace?.state !== 'ready') {
        const failure = String(workspace?.failureCode || '');
        const permission = /codespaces.*(permission|403|forbidden)|HTTP 403/i.test(failure);
        const next = new Error(permission ? 'GitHub Codespaces access needs approval before this workspace can start.' : workspace?.state === 'failed' ? "The workspace couldn't start." : 'Workspace is taking longer than expected. Reconnect to continue.') as Error & { code?: string };
        next.code = permission ? 'CODESPACES_PERMISSION_REQUIRED' : 'WORKSPACE_START_FAILED';
        throw next;
      }
      setCloudIssue(null);
      try { sessionStorage.removeItem(PENDING_CLOUD_RETRY); } catch {}
      await refreshSession(sessionId);
    } catch (error: any) {
      if (error?.code === 'CODESPACES_PERMISSION_REQUIRED' || error?.code === 'GITHUB_PERMISSION_UPDATE_REQUIRED' || /Codespaces.*(permission|approval)/i.test(String(error?.message || ''))) {
        setCloudIssue('permissions');
        setError('');
        try { sessionStorage.setItem(PENDING_CLOUD_RETRY, sessionId); } catch {}
      } else {
        setCloudIssue('failed');
        setError(error.message || (reconnect ? 'Workspace connection interrupted.' : "The workspace couldn't start."));
      }
      try { await refreshSession(sessionId); } catch {}
    } finally { setCloudBusy(false); }
  }

  async function stopRun() {
    const running = events.slice().reverse().find((event) => event.type === 'run.started')?.runId || lastRun?.id;
    if (!session || !running) return;
    try { await j(await fetch(`/v1/agent-runs/${running}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id }) })); await refreshSession(session.id); }
    catch (error: any) { setError(error.message || 'The current task could not be stopped.'); }
  }

  useEffect(() => {
    if (tab !== 'files' || !session?.id) return;
    void openFolder('');
  }, [tab, session?.id]);

  async function openFolder(path: string) {
    if (!session) return; setFileBusy(true); setFolder(path); setOpenedFile(null);
    try { const result = await j<any>(await fetch(`/v1/sessions/${session.id}/files?path=${encodeURIComponent(path)}`)); setFiles(result.files || []); }
    catch (error: any) { setError(error.message || 'Folder could not be read.'); }
    finally { setFileBusy(false); }
  }

  async function openFile(path: string) {
    if (!session) return;
    try {
      const result = await j<any>(await fetch(`/v1/sessions/${session.id}/file?path=${encodeURIComponent(path)}`));
      setOpenedFile(result);
      if (result.warning) setWorkspaceReadNotice(String(result.warning));
      if (result.workspaceStale) void reconnectStaleWorkspace(session.id);
    }
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

  function addAttachmentLink() {
    try {
      const url = new URL(attachmentLink.trim());
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      const next = [composer.trim(), url.toString()].filter(Boolean).join('\n');
      setComposer(next); setAttachmentLink('');
      if (session) try { localStorage.setItem(draftKey(session.id), next); } catch {}
    } catch { setError('Enter a valid http or https link.'); }
  }

  async function runTerminalCommand() {
    if (!session || !command.trim()) return;
    try {
      if (!ptyRef.current) { const opened = await j<any>(await fetch(`/v1/sessions/${session.id}/terminal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cols: 100, rows: 30 }) })); ptyRef.current = opened.ptyId; setTerminalOutput(''); }
      await j(await fetch(`/v1/sessions/${session.id}/terminal/${encodeURIComponent(ptyRef.current!)}/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: `${command}\r` }) }));
      setCommand('');
    }
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

  async function pushChange(change: any, strategy: 'direct' | 'pull-request' = 'direct') {
    setBusyChange(change.id); setError('');
    try {
      await j(await fetch(`/v1/changes/${change.id}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy, ...(strategy === 'pull-request' ? { title: `Orlynx: ${commitMessage.trim() || 'reviewed changes'}` } : {}) }),
      }));
      setPushReview(null);
      await refreshSession(session.id);
    }
    catch (error: any) { setError(error.message || 'GitHub publish failed. Your commit remains safe in the workspace.'); }
    finally { setBusyChange(null); }
  }

  const filteredRepos = repos.filter((repo) => {
    const matches = `${repo.full} ${repo.language || ''}`.toLowerCase().includes(repoQuery.toLowerCase());
    if (!matches) return false;
    if (repoFilter === 'organizations') return repo.ownerType === 'Organization';
    if (repoFilter === 'personal') return repo.ownerType !== 'Organization';
    if (repoFilter === 'recent') return recentProjects.includes(repo.full);
    return true;
  }).sort((a, b) => {
    const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bTime - aTime;
  });
  const visibleRepos = repoQuery.trim() || repoExpanded ? filteredRepos : filteredRepos.slice(0, 6);
  const openCodeConnection = aiProviders.find((provider: any) => provider.id === 'opencode' && provider.state === 'connected');
  const selectedAgentAdapter = (ai.adapters || []).find((adapter: any) => adapter.id === (ai.adapterId || 'opencode'));
  const publicFreeModelsAvailable = aiModels.some((model: any) => model.free && model.status === 'available');
  const aiAccountConnected = Boolean(openCodeConnection || publicFreeModelsAvailable);
  const workspaceReady = session?.workspace?.state === 'ready';
  const workspaceDisconnected = session?.workspace?.state === 'connecting' && session.workspace.bridgeState === 'disconnected' && Boolean(session.workspace.connectionId);
  const workspacePreparing = Boolean(session?.workspace && !['ready', 'failed'].includes(session.workspace.state) && !workspaceDisconnected);
  const workspaceSeconds = session?.workspace?.updatedAt ? Math.max(0, Math.floor((workspaceClock - Date.parse(session.workspace.updatedAt)) / 1000)) : 0;
  const workspaceStalled = workspacePreparing && workspaceSeconds >= 180;
  const activities = useMemo(() => toActivities(events), [events]);
  const currentChatActivities = useMemo(() => {
    if (!lastRun?.id) return [];
    const current = chatActivities(activities).filter((item: any) => item.runId === lastRun.id);
    if (lastRun.plane === 'direct') {
      if (draftReply || lastRun.state === 'completed') return [];
      return current.filter((item: any) => item.state === 'running' || item.state === 'waiting' || item.state === 'queued');
    }
    return current;
  }, [activities, draftReply, lastRun?.id, lastRun?.plane, lastRun?.state]);
  const running = lastRun?.state === 'running' || activities.some((event) => event.state === 'running');
  const globalNav = [
    ['home', 'Home', 'home'], ['projects', 'Projects', 'folder'], ['settings', 'Settings', 'settings'],
  ] as const;
  const tabs = [
    ['chat', 'Chat', 'inbox'], ['files', 'Files', 'folder'], ['changes', `Changes${changes.length ? ` ${changes.reduce((sum: number, change: any) => sum + (change.files?.length || 0), 0)}` : ''}`, 'commit'], ['preview', 'Preview', 'preview'], ['terminal', 'Terminal', 'terminal'], ['more', 'More', 'more'],
  ] as const;

  const onboarded = Boolean(session || integration.github?.connected || recentProjects.length);
  const renderAiSwitcher = () => session ? <ConnectAiSheet
    models={aiModels}
    providers={aiProviders}
    adapters={ai.adapters || []}
    selectedAdapterId={ai.adapterId || 'opencode'}
    selectedModelId={ai.model?.id || ''}
    modelError={aiModelError}
    search={modelSearch}
    setSearch={setModelSearch}
    onRefresh={async () => { await refreshAi(session.id); }}
    onSelectAdapter={(id) => {
      const adapter = (ai.adapters || []).find((candidate: any) => candidate.id === id);
      if (!adapter) return;
      setAi((current: any) => ({ ...current, adapterId: id }));
      if (lastRun?.state === 'failed') { setLastRun(null); runRef.current = null; }
      setError('');
      void setAiPrefs({ adapterId: id });
    }}
    onSelectModel={(id) => {
      const chosen = aiModels.find((model: any) => model.id === id);
      if (!chosen || chosen.status !== 'available') return;
      setAi((current: any) => ({ ...current, model: chosen, state: 'ready', message: 'Ready.' }));
      if (lastRun?.state === 'failed') { setLastRun(null); runRef.current = null; }
      setError('');
      setShowConnectAI(false);
      void setAiPrefs({ modelId: id });
    }}
    onClose={() => setShowConnectAI(false)}
  /> : null;
  return (
    <div className={`orlynx-app ${page === 'workspace' ? 'is-workspace' : ''} ${page === 'welcome' ? 'is-welcome' : ''} ${page === 'github' ? 'is-github' : ''}`}>
      {page !== 'welcome' && page !== 'github' && page !== 'workspace' && onboarded && <aside className="sidebar">
        <button className="brand-lockup" onClick={() => setPage(session ? 'home' : 'github')}><span className="brand-mark" /><span><b>Orlynx</b><small>Your development workspace</small></span></button>
        <nav className="side-nav" aria-label="Main navigation">{globalNav.map(([id, label, icon]) => <button key={id} className={page === id ? 'selected' : ''} onClick={() => setPage(id)}><Icon name={icon} />{label}</button>)}</nav>
        <div className="sidebar-section"><div className="sidebar-title">Recent repositories</div>{recentProjects.slice(0, 5).map((name) => <button className={`recent-project ${session?.project === name ? 'selected' : ''}`} key={name} onClick={() => openRecentProject(name)}><span className="repo-avatar"><Icon name="github" size={15} /></span><span className="recent-project-copy"><b>{name.split('/').pop()}</b><small><Icon name="branch" size={12} />{session?.project === name ? session.branch : 'Imported'}</small></span></button>)}<button className="side-link" onClick={() => setPage('projects')}>View repositories <Icon name="arrow" size={14} /></button></div>
        <div className="sidebar-account"><span className="account-avatar"><Icon name="github" /></span><span><b>{integration.github?.login || integration.github?.installations?.[0]?.account || 'GitHub account'}</b><small>{integration.github?.connected ? 'Connected' : 'Not connected'}</small></span><button className="icon-button" aria-label="Account settings" onClick={() => setPage('settings')}><Icon name="more" /></button></div>
      </aside>}
      <div className="app-main">
        {page === 'workspace' && session ? <>
          <header className="project-header"><div className="repo-identity"><span className="repo-avatar large"><Icon name="github" size={18} /></span><div><b>{session.project.split('/').pop()}</b><span><Icon name="branch" size={13} />{session.branch}</span></div><button className="icon-button" aria-label="Switch repository" onClick={() => setPage('projects')}><Icon name="chevron" /></button></div><button className="global-search" onClick={() => setPage('search')}><Icon name="search" /><span>Search this repository…</span><kbd>⌘ K</kbd></button><div className="header-actions"><button className="icon-button" aria-label="More project options" onClick={() => setTab('more')}><Icon name="more" /></button></div></header>
          <nav className="project-tabs" role="tablist" aria-label="Project workspace">{tabs.filter(([id]) => ['chat', 'files', 'changes', 'more'].includes(id)).map(([id, label, icon]) => <button role="tab" key={id} aria-selected={tab === id || (id === 'more' && (tab === 'terminal' || tab === 'preview'))} className={tab === id || (id === 'more' && (tab === 'terminal' || tab === 'preview')) ? 'selected' : ''} onClick={() => { setTab(id); setOpenedFile(null); }}><Icon name={icon} size={16} /><span>{label}</span></button>)}</nav>
          {!online && <div className="offline-banner"><Icon name="cloud" />Offline. Drafts remain on this device; no task was sent.</div>}
          {session?.githubAccess === 'disconnected' && <div className="screen-alert" role="alert"><span>GitHub access to {session.project} was removed. Your Orlynx conversation is preserved.</span><button className="text-button" onClick={() => setPage('github')}>Manage GitHub access</button></div>}
          {workspaceReadNotice && (!lastRun || lastRun?.plane === 'workspace' || tab === 'files' || cloudBusy) && <div className="screen-alert" role="status"><span>{workspaceReadNotice}</span><button aria-label="Dismiss" onClick={() => setWorkspaceReadNotice('')}><Icon name="close" /></button></div>}
          {error && !(cloudBusy && workspacePreparing) && <div className="screen-alert" role="alert"><span>{error}</span><button aria-label="Dismiss" onClick={() => setError('')}><Icon name="close" /></button></div>}
          <div className="workspace-layout">
            <main className="workspace-main">
              {tab === 'chat' && <section className="conversation">
                {workspacePreparing && (cloudBusy || lastRun?.plane === 'workspace') && <div className="screen-alert" role="status"><span><b>Development environment</b> {workspaceReadNotice || (lastRun?.state === 'queued' ? 'This task needs runtime tools. Your message is saved and will start automatically.' : 'Starting only for the work that needs it…')}</span></div>}
                {cloudIssue === 'permissions' && (cloudBusy || lastRun?.plane === 'workspace') && <div className="workspace-recovery-card" role="alert"><span className="recovery-icon"><Icon name="github" /></span><div><b>Allow GitHub Codespaces to continue</b><p>Approve the requested GitHub access in the new tab, then return to this Orlynx tab. Orlynx will check the permission and continue. If GitHub stays open, switch back to Orlynx yourself.</p><div className="recovery-actions"><Button tone="ghost" onClick={openManageRepositories}>Review GitHub access</Button><Button onClick={() => startCloud()} disabled={cloudBusy}>{cloudBusy ? 'Checking…' : 'Retry workspace'}</Button></div></div></div>}
                {cloudIssue === 'failed' && session.workspace?.state === 'failed' && (cloudBusy || lastRun?.plane === 'workspace') && <AgentErrorCard title="Workspace couldn't start." hint={session.workspace?.failureCode?.startsWith('OpenCode') ? session.workspace.failureCode : "Your conversation is preserved. You can retry without reopening the project."} onRetry={() => startCloud()} />}
                {session.workspace?.state === 'connecting' && session.workspace?.bridgeState === 'disconnected' && session.workspace?.connectionId && (cloudBusy || lastRun?.plane === 'workspace') && <AgentErrorCard title="Workspace connection interrupted." hint="The Codespace remains available." onReconnect={() => startCloud(true)} />}
                {!messages.length && <div className="conversation-intro setup-aware"><span className="agent-avatar"><span className="brand-mark small-mark" /></span><div>
                  <p className="setup-kicker">{!aiAccountConnected ? 'CONNECT AI' : ai.model ? 'READY TO CHAT' : 'CHOOSE MODEL'}</p>
                  <h2>{!aiAccountConnected ? 'Connect AI' : ai.model ? 'What should we work on?' : 'Choose your model'}</h2>
                  <p>{aiAccountConnected
                    ? ai.model
                      ? `Ready with ${ai.model.displayName}.`
                      : 'Pick a model to start.'
                    : 'Connect OpenCode to start.'}</p>
                  <div className="setup-actions">
                    {!aiAccountConnected && <Button onClick={() => setShowConnectAI(true)}>Connect OpenCode <Icon name="arrow" /></Button>}
                    <Button tone="ghost" onClick={() => setTab('files')}><Icon name="folder" />Browse files</Button>
                  </div>
                </div></div>}
                {messages.map((message) => <article className={`message-row ${message.role === 'user' ? 'user-message' : 'assistant-message'}`} key={message.id}><span className={message.role === 'user' ? 'user-avatar' : 'agent-avatar'}><Icon name={message.role === 'user' ? 'github' : 'agents'} size={16} /></span><div className="message-content"><div className="message-meta"><b>{message.role === 'user' ? 'You' : 'Orlynx AI'}</b><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><div className="message-text">{visibleChatText(message.role, message.text)}</div></div></article>)}
                {draftReply && <article className="message-row assistant-message"><span className="agent-avatar"><Icon name="agents" /></span><div className="message-content"><div className="message-meta"><b>Orlynx AI</b><span className="live-reply-indicator">{lastRun?.state === 'running' ? 'Responding…' : 'Partial response'}</span></div><div className="message-text">{draftReply}{lastRun?.state === 'running' && <span className="stream-caret" />}</div></div></article>}
                {!!attachments.length && <div className="chat-attachments">{attachments.map((item: any) => <AttachmentChip key={item.id} name={item.filename} state="agent" />)}</div>}
                {uploads.map((item) => <div className="upload-state" key={item.id}><Icon name="file" />{item.name}<Badge tone={item.status === 'failed' ? 'fail' : 'ok'}>{item.status}</Badge></div>)}
                {!!currentChatActivities.length && <div className="workstream-wrap"><ActivityList activities={currentChatActivities} agentMode={ai.mode} /></div>}
                {lastRun?.state === 'queued' && <p className="run-receipt">{lastRun?.plane === 'workspace' ? 'Task saved · development environment starts automatically for this work.' : 'Queued · Orlynx will respond automatically.'}</p>}
                {lastRun?.state === 'completed' && lastRun?.plane === 'workspace' && <p className="run-receipt">Development work completed.</p>}
                {lastRun?.state === 'failed' && ai.model?.id && lastRun?.model === ai.model.id && (() => {
                  const failure = [...activities].reverse().find((item: any) => item.state === 'failed' && (!lastRun?.id || item.runId === lastRun.id));
                  const failureSummary = String(failure?.summary || '');
                  const runtimeRecovered = selectedAgentAdapter?.state === 'ready'
                    && /AI is not ready|OpenCode adapter is not ready|AI runtime unavailable|workspace connection interrupted/i.test(failureSummary);
                  if (runtimeRecovered) return null;
                  const modelProblem = lastRun?.errorKind === 'rate_limit' || lastRun?.errorKind === 'quota' || lastRun?.errorKind === 'model' || /model|rate limit|quota/i.test(failureSummary);
                  return <AgentErrorCard
                    title={failure?.title || (modelProblem ? 'This model could not respond.' : 'Orlynx needs attention.')}
                    hint={failureSummary || 'Your conversation is preserved.'}
                    onRetry={() => {
                      if (modelProblem) {
                        setShowConnectAI(true);
                      } else {
                        void refreshSession(session.id);
                      }
                    }}
                    retryLabel={modelProblem ? 'Change model' : 'Refresh'}
                  />;
                })()}
              </section>}
              {tab === 'files' && <section className="screen-section files-screen"><div className="screen-heading"><div><p className="eyebrow">REPOSITORY</p><h1>Files</h1><p className="screen-subtitle">Browse {session.project} on {session.branch}.</p></div><label className="search-field"><Icon name="search" /><input value={fileFilter} onChange={(event) => setFileFilter(event.target.value)} placeholder="Filter this folder" /></label></div>{openedFile ? <CodeViewer file={openedFile} onBack={() => setOpenedFile(null)} /> : <><div className="breadcrumbs"><button onClick={() => openFolder('')}>{session.project}</button>{folder.split('/').filter(Boolean).map((part, index, parts) => <React.Fragment key={`${part}-${index}`}><Icon name="chevron" size={12} /><button onClick={() => openFolder(parts.slice(0, index + 1).join('/'))}>{part}</button></React.Fragment>)}</div><div className="file-list">{fileBusy ? <div className="loading-screen"><Spinner /><p>Loading files…</p></div> : files.filter((item: any) => item.name.toLowerCase().includes(fileFilter.toLowerCase())).map((item: any) => <button className="file-row" key={item.name} onClick={() => item.dir ? openFolder([folder, item.name].filter(Boolean).join('/')) : openFile([folder, item.name].filter(Boolean).join('/'))}><span className="file-kind"><Icon name={item.dir ? 'folder' : 'file'} /></span><span>{item.name}{item.dir ? '/' : ''}</span>{item.modified && <span className="modified-indicator">Modified</span>}<Icon name="chevron" size={14} /></button>)}</div></>}</section>}
              {tab === 'changes' && <section className="screen-section changes-screen">
                {changes.length > 0 && changes.every((change: any) => Boolean(change.pushedAt)) ? <div className="push-success-screen">
                  <span className="success-check"><Icon name="check" size={28} /></span>
                  <h1>{changes.some((change: any) => change.pullRequestUrl) ? 'Pull request created!' : 'Changes published!'}</h1>
                  <p>{changes.reduce((sum: number, change: any) => sum + (change.files?.length || 0), 0)} files have been published safely to GitHub.</p>
                  {changes.find((change: any) => change.pullRequestUrl)?.pullRequestUrl
                    ? <a className="success-github-link" href={changes.find((change: any) => change.pullRequestUrl).pullRequestUrl} target="_blank" rel="noreferrer">Review pull request <Icon name="external" /></a>
                    : <a className="success-github-link" href={`https://github.com/${session.project}/tree/${encodeURIComponent(session.branch)}`} target="_blank" rel="noreferrer">View on GitHub <Icon name="external" /></a>}
                  <div className="success-next"><b>What's next?</b><button onClick={() => setTab('chat')}><Icon name="inbox" /><span>Continue working</span><Icon name="chevron" /></button>{integration.workspace?.previewAvailable && <button onClick={() => setTab('preview')}><Icon name="preview" /><span>Open preview</span><Icon name="chevron" /></button>}<a href={`https://github.com/${session.project}/compare/${encodeURIComponent(session.branch)}?expand=1`} target="_blank" rel="noreferrer"><Icon name="branch" /><span>Create pull request</span><Icon name="chevron" /></a></div>
                </div> : <>
                  <div className="changes-topbar"><button className="icon-button" onClick={() => setTab('chat')} aria-label="Back to chat">‹</button><h1>Changes ({changes.reduce((sum: number, change: any) => sum + (change.files?.length || 0), 0)} files)</h1></div>
                  {!changes.length && <EmptyState title="No changes to review" hint="Changes will appear here after Orlynx updates the repository." />}
                  {changes.map((change: any) => <section className="change-set" key={change.id}>
                    <div className="change-set-heading"><div><b>{change.files.length} changed file{change.files.length === 1 ? '' : 's'}</b><span className="small">Base {change.baseSha?.slice(0, 7)}</span></div><Badge tone={change.pushedAt ? 'ok' : change.reviewState === 'pending' ? 'wait' : 'neutral'}>{change.pushedAt ? 'Pushed' : change.reviewState}</Badge></div>
                    <DiffSummary files={change.files.map((file: any) => ({ path: file.path, action: file.action }))} />
                    {change.files.map((file: any) => <details className="diff-file" key={file.path}><summary>{file.path}</summary><p className="diff-explanation">Exact diff</p><pre>{file.diff || file.after || file.before || '(binary or empty file)'}</pre></details>)}
                    {change.reviewState === 'pending' && <AgentApprovalCard title="Approve these changes" detail="Review the exact files above before continuing." busy={busyChange === change.id} onApprove={() => reviewChange(change)} />}
                    {change.reviewState === 'approved' && <div className="commit-form premium"><div><h2>Ready to commit changes</h2><p>Write the message that will appear in Git history.</p></div><label>Commit message<input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Describe this change" /></label><div className="commit-branch"><span>Push to branch</span><b><Icon name="branch" />{session.branch}</b></div><Button disabled={!commitMessage.trim() || busyChange === change.id} onClick={() => commitChange(change)}>{busyChange === change.id ? 'Committing…' : 'Create commit'}</Button></div>}
                    {change.reviewState === 'committed' && !change.pushedAt && <div className="ready-to-push"><div><h2>Ready to publish changes</h2><p>{change.files.length} files are committed and ready for GitHub.</p></div><DiffSummary files={change.files.map((file: any) => ({ path: file.path, action: file.action }))} /><div className="commit-branch"><span>{['main', 'master'].includes(session.branch) ? 'Review target' : 'Push to branch'}</span><b><Icon name="branch" />{session.branch}</b></div><Button onClick={() => setPushReview(change)}>Review publish</Button></div>}
                    {pushReview?.id === change.id && <div className="push-confirm"><b>Publish ${change.files.length} changed files to ${session.project}?</b><p>{['main', 'master'].includes(session.branch) ? `Choose whether to push the approved commit directly to ${session.branch} or publish it through a pull request.` : `This publishes the approved commit to ${session.branch}.`}</p><div className="action-row"><Button tone="ghost" onClick={() => setPushReview(null)}>Cancel</Button>{['main', 'master'].includes(session.branch) && <Button tone="ghost" onClick={() => pushChange(change, 'pull-request')} disabled={busyChange === change.id}>Create PR</Button>}<Button onClick={() => pushChange(change, 'direct')} disabled={busyChange === change.id}>{['main', 'master'].includes(session.branch) ? `Push to ${session.branch}` : 'Approve & push'}</Button></div></div>}
                  </section>)}
                </>}
              </section>}
              {tab === 'preview' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">PROJECT</p><h1>Preview</h1><p className="screen-subtitle">Apps running in this workspace appear here.</p></div></div>{previewPorts.length ? <div className="project-grid">{previewPorts.map((item: any) => <a className="project-card" key={item.port} href={item.url} target="_blank" rel="noreferrer"><Icon name="preview" /><span><b>Open preview</b><small>Workspace port {item.port} · {item.visibility}</small></span><Icon name="external" /></a>)}</div> : <EmptyState title="No preview is running" hint="Start a development server in the terminal, then return here." />}</section>}
              {(tab === 'terminal' || tab === 'more') && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">PROJECT</p><h1>{tab === 'terminal' ? 'Terminal' : 'More'}</h1><p className="screen-subtitle">{tab === 'terminal' ? 'Run a command in this repository.' : 'Project tools and preferences.'}</p></div></div>{tab === 'more' ? <div className="more-grid"><button onClick={() => setTab('terminal')} disabled={!integration.workspace?.terminalAvailable}><Icon name="terminal" /><b>Terminal</b><span>{integration.workspace?.terminalAvailable ? 'Run a project command' : 'Unavailable for this workspace'}</span></button><button onClick={() => setTab('preview')} disabled={!integration.workspace?.previewAvailable}><Icon name="preview" /><b>Preview</b><span>{integration.workspace?.previewAvailable ? 'Open the running app' : 'No running app detected'}</span></button><button onClick={() => startCloud(session.workspace?.state === 'connecting')} disabled={!integration.workspace?.cloudAvailable || cloudBusy || session.workspace?.state === 'ready'}><Icon name="cloud" /><b>{session.workspace?.state === 'ready' ? 'Cloud ready' : cloudBusy ? 'Preparing workspace…' : session.workspace?.state === 'connecting' ? 'Reconnect workspace' : 'Work on cloud'}</b><span>{integration.workspace?.cloudAvailable ? session.workspace?.state === 'ready' ? 'GitHub Codespace connected' : 'Start or reconnect the cloud workspace' : 'Unavailable in this deployment'}</span></button><button onClick={() => setShowConnectAI(true)}><Icon name="agents" /><b>Orlynx AI</b><span>{ai?.state === 'ready' || ai?.state === 'working' ? 'Ready' : 'Unavailable'}</span></button><button onClick={() => setPage('projects')}><Icon name="github" /><b>Switch repository</b><span>Choose another project</span></button><button onClick={() => setPage('settings')}><Icon name="settings" /><b>Settings</b><span>Connections and appearance</span></button></div> : <Terminal command={command} setCommand={setCommand} output={terminalOutput} run={runTerminalCommand} connected={integration.workspace?.terminalAvailable} />}</section>}
            </main>
            <aside className="context-panel"><section className="context-card"><div className="context-heading"><span className="context-icon"><Icon name="agents" /></span><div><b>Orlynx AI</b><small>{ai.model ? `${selectedAgentAdapter?.displayName || 'Agent'} · ${ai.model.displayName} · ${ai.mode === 'build' ? 'Build' : ai.mode === 'plan' ? 'Plan' : 'Ask'}` : `${selectedAgentAdapter?.displayName || 'Agent'} · No model selected`}</small></div><Badge tone={ai.state === 'ready' ? 'ok' : ai.state === 'working' ? 'wait' : 'fail'}>{ai.state === 'ready' ? 'Ready' : ai.state === 'working' ? 'Working' : ai.state === 'needs_attention' ? 'Needs attention' : ai.state === 'error' ? 'Unavailable' : 'Not connected'}</Badge></div><p className="context-empty">{ai.message || 'Connect an AI account to start working.'}</p><button className="context-link" onClick={() => setShowConnectAI(true)}>Manage AI <Icon name="arrow" /></button></section><section className="context-card"><button className="context-title" onClick={() => setPage('projects')}>Repository <Icon name="chevron" /></button><dl className="context-list"><div><dt><Icon name="github" />Project</dt><dd>{session.project}</dd></div><div><dt><Icon name="branch" />Branch</dt><dd>{session.branch}</dd></div><div><dt><Icon name="commit" />Commit</dt><dd>{changes.find((item: any) => item.commitSha)?.commitSha?.slice(0, 7) || '—'}</dd></div></dl></section><section className="context-card"><button className="context-title" onClick={() => setTab('changes')}>Recent changes <Icon name="chevron" /></button>{changes.slice(0, 1).flatMap((change: any) => change.files.slice(0, 4)).map((file: any) => <div className="mini-change" key={file.path}><Icon name="file" /><span>{file.path.split('/').pop()}</span></div>)}{!changes.length && <p className="context-empty">No changes yet.</p>}</section></aside>
          </div>
          {newActivity && tab === 'chat' && <div className="new-activity"><Button tone="ghost" onClick={() => { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); setNewActivity(false); }}>↓ New activity</Button></div>}
              {tab === 'chat' && <form className="composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}><details className="attachment-menu"><summary className="attach-button" aria-label="Add attachment"><Icon name="paperclip" /></summary><div className="attachment-popover"><label><Icon name="file" />Files<input type="file" hidden onChange={uploadFile} /></label><label><Icon name="preview" />Photos<input type="file" accept="image/*" hidden onChange={uploadFile} /></label><label><Icon name="camera" />Camera<input type="file" accept="image/*" capture="environment" hidden onChange={uploadFile} /></label><button type="button" onClick={() => setTab('files')}><Icon name="folder" />Repository file</button><div className="attachment-link"><input type="url" value={attachmentLink} onChange={(event) => setAttachmentLink(event.target.value)} placeholder="https://…" aria-label="Link to attach" /><button type="button" onClick={addAttachmentLink}>Add link</button></div></div></details><div className="composer-body"><textarea
  value={composer}
  onChange={(event) => { setComposer(event.target.value); try { localStorage.setItem(draftKey(session.id), event.target.value); } catch {} }}
  onKeyDown={(event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
      event.preventDefault();
      if (composer.trim() && !sending && aiAccountConnected && ai.model && online) void sendMessage();
    }
  }}
  placeholder={!online ? 'Offline — draft saved' : !aiAccountConnected ? 'Connect AI to start' : !ai.model ? 'Choose a model to start' : `Ask Orlynx anything about this repository…`}
  aria-label="Message Orlynx AI"
  disabled={!aiAccountConnected || !ai.model || !online}
/><div className="composer-controls">{aiAccountConnected
  ? <button type="button" className="ai-control-trigger" onClick={() => setShowConnectAI((current) => !current)} aria-expanded={showConnectAI} aria-label="Choose AI agent and model">
      <span className="ai-control-icon"><Icon name="agents" size={14} /></span>
      <span className="ai-control-copy"><b>{selectedAgentAdapter?.displayName || 'Orlynx AI'}</b><small>{ai.model?.displayName || 'Choose model'}</small></span>
      <span className={`ai-control-state state-${selectedAgentAdapter?.state || ai.state || 'idle'}`} aria-hidden="true" />
      <Icon name="chevron" size={12} />
    </button>
  : <button type="button" className="ai-control-trigger connect" onClick={() => setShowConnectAI(true)} aria-label="Connect AI"><span className="ai-control-icon"><Icon name="agents" size={14} /></span><span className="ai-control-copy"><b>Connect AI</b><small>Choose an agent and model</small></span><Icon name="chevron" size={12} /></button>}
  <details className="composer-options">
    <summary aria-label="Mode and access">{ai.mode === 'build'
      ? `Build · ${ai.permission === 'ask-first' ? 'Ask first' : ai.permission === 'read-only' ? 'Read only' : 'Full access'}`
      : ai.mode === 'plan' ? 'Plan · No project changes' : 'Ask · Read only'} <Icon name="chevron" size={12} /></summary>
    <div className="composer-options-panel">
      <div className="option-group"><span className="option-heading">Mode</span><div className="option-grid" role="group" aria-label="Mode">
        {[
          ['build', 'Build', 'Uses the Codespace only when the request needs execution or file changes'],
          ['plan', 'Plan', 'Chats and plans directly; never changes files or starts cloud work'],
          ['ask', 'Ask', 'Answers directly; never changes files or starts cloud work'],
        ].map(([value, label, hint]) => <button key={value} type="button" className={ai.mode === value ? 'selected' : ''} aria-pressed={ai.mode === value} onClick={() => { if (value !== 'build') setTempFullAccess(false); void setAiPrefs({ mode: value }); }} disabled={!online}><span><b>{label}</b><small>{hint}</small></span>{ai.mode === value && <Icon name="check" size={14} />}</button>)}
      </div></div>
      {ai.mode === 'build'
        ? <div className="option-group"><span className="option-heading">Access</span><div className="option-grid" role="group" aria-label="Access level">
            {[
              ['full', 'Full project access', 'Can make project changes'],
              ['ask-first', 'Ask first', 'Requests permission before changes'],
              ['read-only', 'Read only', 'Cannot change project files'],
            ].map(([value, label, hint]) => <button key={value} type="button" className={ai.permission === value ? 'selected' : ''} aria-pressed={ai.permission === value} onClick={() => { setTempFullAccess(false); void setAiPrefs({ permission: value }); }} disabled={!online}><span><b>{label}</b><small>{hint}</small></span>{ai.permission === value && <Icon name="check" size={14} />}</button>)}
          </div></div>
        : <div className="mode-readonly-note"><Icon name="shield" size={14} /><span><b>{ai.mode === 'plan' ? 'Plan is chat-only.' : 'Ask is chat-only.'}</b><small>Your Build access setting is preserved for when you switch back.</small></span></div>}
    </div>
  </details></div>{ai.mode === 'build' && ai.permission === 'ask-first' && aiAccountConnected && <label className="temp-access"><input type="checkbox" checked={tempFullAccess} onChange={(event) => setTempFullAccess(event.target.checked)} /> Allow project changes for this task</label>}</div>{(lastRun?.state === 'running' || lastRun?.state === 'queued') && <Button type="button" tone="ghost" onClick={stopRun}>Cancel</Button>}<Button className="composer-send" type="submit" disabled={!composer.trim() || sending || !aiAccountConnected || !ai.model || !online} aria-label={running || lastRun?.state === 'queued' ? 'Queue task' : 'Send task'}><Icon name="send" /></Button>{showConnectAI && <div className="composer-ai-dropdown">{renderAiSwitcher()}</div>}</form>}
          <nav className="mobile-project-nav" role="tablist" aria-label="Project workspace">{tabs.filter(([id]) => ['chat', 'files', 'more'].includes(id) || (id === 'changes' && changes.length > 0)).map(([id, label, icon]) => <button role="tab" key={id} aria-selected={tab === id || (id === 'more' && (tab === 'terminal' || tab === 'preview'))} className={tab === id || (id === 'more' && (tab === 'terminal' || tab === 'preview')) ? 'selected' : ''} onClick={() => setTab(id)}><Icon name={icon} /><span>{label.split(' ')[0]}</span></button>)}</nav>
        </> : <>
          {page !== 'github' && <header className="simple-header"><button className="brand-lockup compact" onClick={() => setPage(integration.github?.connected ? 'github' : 'welcome')}><span className="brand-mark" /><b>Orlynx</b></button>{onboarded && <div className="simple-header-actions"><Badge tone={integration.github?.connected ? 'ok' : 'neutral'}><Icon name="github" />{integration.github?.connected ? 'Connected' : 'Reconnect'}</Badge><button className="icon-button" onClick={() => setPage('settings')} aria-label="Settings"><Icon name="settings" /></button></div>}</header>}
          <main className="page-body">
            {error && page !== 'github' && <div className="screen-alert" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><Icon name="close" /></button></div>}
            {restoring && !session && <div className="loading-screen"><Spinner label="Restoring repository session" /><p>Checking imported repositories…</p></div>}
            {!restoring && page === 'welcome' && <section className="welcome-screen">
              <div className="welcome-brand"><span className="brand-mark" /><b>Orlynx</b></div>
              <div className="welcome-hero">
                <h1>Build from<br />anywhere.</h1>
                <p className="welcome-copy">Connect GitHub and start working with your repositories using Orlynx AI.</p>
                <Button className="welcome-github-button" onClick={connectGitHub} disabled={connectingGithub || integration.githubAvailable === false}><Icon name="github" size={20} />{connectingGithub ? 'Opening GitHub…' : integration.githubAvailable === false ? 'GitHub is temporarily unavailable' : integration.github?.connected ? 'Choose a repository' : 'Continue with GitHub'}<Icon name="arrow" /></Button>
                <p className="welcome-trust">Your repositories stay under your GitHub permissions.</p>
              </div>
              <div className="welcome-landscape" aria-hidden="true">
                <span className="sun" />
                <span className="ridge ridge-one" />
                <span className="ridge ridge-two" />
                <span className="ridge ridge-three" />
                <div className="welcome-values">
                  <span><Icon name="github" /><small>GitHub native</small></span>
                  <span><Icon name="shield" /><small>Your code stays yours</small></span>
                  <span><Icon name="code" /><small>Built for real work</small></span>
                </div>
              </div>
            </section>}
            {!restoring && page === 'home' && <section className="home-screen"><div className="home-greeting"><p className="eyebrow">YOUR REPOSITORIES</p><h1>{integration.github?.connected && integration.github?.login ? `Welcome, ${integration.github.login}.` : 'Welcome to Orlynx.'}</h1><p>{integration.github?.connected ? 'Choose a repository to start working.' : 'Connect GitHub to start building with your repositories.'}</p></div><div className="home-primary-actions">{integration.github?.connected ? <Button onClick={() => { setPage('github'); loadRepositories(); }}><Icon name="github" />Browse repositories</Button> : <Button onClick={connectGitHub} disabled={connectingGithub}><Icon name="github" />{connectingGithub ? 'Opening GitHub…' : 'Continue with GitHub'}</Button>}</div><div className="home-grid"><section className="home-section"><div className="section-title"><h2>Recent projects</h2><button className="text-button" onClick={() => setPage('projects')}>View all</button></div>{recentProjects.length ? recentProjects.filter((name) => name.includes('/')).map((name) => <button className="project-list-row" key={name} onClick={() => openRecentProject(name)}><span className="repo-avatar"><Icon name="github" /></span><span><b>{name}</b><small>GitHub repository</small></span><Icon name="chevron" /></button>) : <EmptyState title="No repositories yet" hint={integration.github?.connected ? 'Choose a repository above to open your first project.' : 'Your repositories will appear here after connecting GitHub.'} />}</section></div></section>}
            {!restoring && page === 'projects' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">REPOSITORIES</p><h1>Projects</h1><p className="screen-subtitle">Open one of your connected repositories.</p></div><Button disabled={!integration.github?.connected} onClick={() => { setPage('github'); loadRepositories(); }}>Browse repositories</Button></div>{recentProjects.length ? <div className="project-grid">{recentProjects.filter((name) => name.includes('/')).map((name) => <button className="project-card" key={name} onClick={() => openRecentProject(name)}><span className="repo-avatar"><Icon name="github" /></span><span><b>{name}</b><small>GitHub repository</small></span><Icon name="chevron" /></button>)}</div> : <EmptyState title="No repositories imported" hint="Connect GitHub and choose a repository to open your first project." />}</section>}
            {!restoring && page === 'github' && (syncingGithub ? <section className="github-sync-screen" role="status" aria-live="polite">
              <div className="flow-brand"><span className="brand-mark" /><b>Orlynx</b></div>
              <div className="sync-visual" aria-hidden="true"><span className="sync-orbit" /><span className="sync-dot" /></div>
              <h1>Connecting your GitHub account…</h1>
              <p>We're verifying your access and bringing your repositories into Orlynx.</p>
              <ul className="sync-steps premium">
                <li className={syncStep === 'Verifying installation' ? 'active' : 'done'}><span>{syncStep === 'Verifying installation' ? '●' : '✓'}</span>Verifying installation</li>
                <li className={syncStep === 'Fetching repositories' ? 'active' : syncStep === 'Finishing setup' || !syncStep ? 'done' : ''}><span>{syncStep === 'Fetching repositories' ? '●' : syncStep === 'Finishing setup' || !syncStep ? '✓' : '○'}</span>Fetching repositories</li>
                <li className={syncStep === 'Finishing setup' ? 'active' : ''}><span>{syncStep === 'Finishing setup' ? '●' : '○'}</span>Preparing Orlynx</li>
              </ul>
            </section> : <section className="repo-flow-screen">
              <header className="repo-flow-header"><div className="flow-brand"><span className="brand-mark" /><b>Orlynx</b></div><button className="icon-button" onClick={() => setPage('settings')} aria-label="Settings"><Icon name="settings" /></button></header>
              {!integration.github?.connected ? <div className="github-connect-empty">
                <span className="github-connect-icon"><Icon name="github" size={34} /></span>
                <h1>{integration.github?.needsAttention ? 'Reconnect GitHub' : 'Connect GitHub'}</h1>
                <p>{integration.github?.needsAttention ? 'Reconnect to continue with your repositories.' : 'Authorize Orlynx on GitHub, choose the repositories you want to use, and come straight back here.'}</p>
                {githubNotice && <div className={`screen-alert tone-${githubNotice.tone}`} role={githubNotice.tone === 'fail' ? 'alert' : 'status'}><span>{githubNotice.text}</span></div>}
                <Button className="welcome-github-button" disabled={repoBusy || connectingGithub || integration.githubAvailable === false} onClick={connectGitHub}><Icon name="github" />{connectingGithub ? 'Opening GitHub…' : 'Continue with GitHub'}<Icon name="arrow" /></Button>
              </div> : <>
                <div className="repo-flow-intro"><h1>Welcome back!</h1><p>Choose a repository to start working with Orlynx.</p></div>
                {githubNotice && githubNotice.tone !== 'ok' && <div className={`screen-alert repo-inline-alert tone-${githubNotice.tone}`} role={githubNotice.tone === 'fail' ? 'alert' : 'status'}><span>{githubNotice.text}</span><button onClick={() => setGithubNotice(null)} aria-label="Dismiss"><Icon name="close" /></button></div>}
                {error && <div className="screen-alert repo-inline-alert" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><Icon name="close" /></button></div>}
                <label className="repo-search"><Icon name="search" /><input value={repoQuery} onChange={(event) => { setRepoQuery(event.target.value); if (event.target.value) setRepoExpanded(true); }} placeholder="Search repositories…" aria-label="Search repositories" /></label>
                <div className="repo-list-heading"><span>{repoQuery.trim() ? 'Search results' : repoExpanded ? 'All repositories' : 'Recently updated'}</span><button className="repo-refresh-button" onClick={() => void refreshAfterManage()} disabled={repoBusy} aria-label="Refresh repositories" title="Refresh repositories"><Icon name="refresh" /></button></div>
                <div className="repo-flow-list">
                  {repoBusy && !repos.length ? <div className="repo-loading premium"><Spinner /><span>Loading your repositories…</span></div> : visibleRepos.map((repo) => <div className="repo-flow-row" key={`${repo.installationId}:${repo.full}`}>
                    <span className="repo-flow-icon"><Icon name="repo" /></span>
                    <span className="repo-flow-copy"><b>{repo.name}</b><small>{repo.private ? 'Private' : 'Public'} · {repoUpdatedLabel(repo.updatedAt)}</small></span>
                    <Button className="repo-open-button" disabled={repoBusy} onClick={() => void openRepository(repo)}>Open</Button>
                  </div>)}
                  {!repoBusy && !visibleRepos.length && <div className="repo-empty"><span className="repo-flow-icon"><Icon name="repo" /></span><h2>No repositories yet</h2><p>Choose repositories on GitHub, then come back here.</p><Button tone="ghost" onClick={openManageRepositories}>Choose repositories on GitHub</Button></div>}
                </div>
                {!repoQuery.trim() && filteredRepos.length > 6 && <button className="view-all-repositories" onClick={() => setRepoExpanded((value) => !value)}>{repoExpanded ? 'Show recent repositories' : 'View all repositories'} <Icon name={repoExpanded ? 'chevron' : 'arrow'} /></button>}
                <button className="manage-access-link" onClick={openManageRepositories}><Icon name="github" />Manage GitHub access</button>
              </>}
            </section>)}
            {!restoring && page === 'setup' && <SetupScreen notice={githubNotice} clearNotice={() => setGithubNotice(null)} />}
            {!restoring && page === 'settings' && <SettingsScreen integration={integration} theme={theme} setTheme={setTheme} reload={refreshIntegrations} ai={ai} providers={aiProviders} onManageAi={() => setShowConnectAI(true)} onOpenGithub={() => setPage('github')} />}
            {!restoring && page === 'tasks' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">CURRENT PROJECT</p><h1>Tasks</h1><p className="screen-subtitle">Recent work in this project.</p></div></div>{session && lastRun ? <button className="task-row" onClick={() => setPage('workspace')}><Icon name="clock" /><span><b>{session.checkpoint?.goal || 'Project task'}</b><small>{session.project} · {new Date(lastRun.startedAt).toLocaleString()}</small></span><Badge>{lastRun.state}</Badge></button> : <EmptyState title="No task history" hint="Start a task in this project." />}</section>}
            {!restoring && page === 'search' && <section className="screen-section"><div className="screen-heading"><div><p className="eyebrow">SEARCH PROJECT</p><h1>Find files</h1></div></div><label className="global-search search-page-input"><Icon name="search" /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search current files…" /></label>{files.filter((file: any) => file.name.toLowerCase().includes(search.toLowerCase())).map((file: any) => <button key={file.name} className="project-list-row" onClick={() => { setPage('workspace'); setTab('files'); if (!file.dir) openFile(file.name); }}><Icon name={file.dir ? 'folder' : 'file'} /><span><b>{file.name}</b><small>{session?.project}</small></span><Icon name="chevron" /></button>)}</section>}
          </main>
          {onboarded && page !== 'github' && <nav className="mobile-global-nav" aria-label="Main navigation">{globalNav.map(([id, label, icon]) => <button key={id} className={page === id ? 'selected' : ''} onClick={() => setPage(id)}><Icon name={icon} /><span>{label}</span></button>)}</nav>}
        </>}
        {showConnectAI && session && page !== 'workspace' && <div className="ai-settings-switcher-anchor">{renderAiSwitcher()}</div>}
      </div>
    </div>
  );
}

function ConnectAiSheet({ models, providers, adapters, selectedAdapterId, selectedModelId, modelError, search, setSearch, onRefresh, onSelectAdapter, onSelectModel, onClose }: {
  models: any[]; providers: any[]; adapters: any[]; selectedAdapterId: string; selectedModelId: string;
  modelError: string; search: string; setSearch: (v: string) => void;
  onRefresh: () => Promise<void>; onSelectAdapter: (id: string) => void; onSelectModel: (id: string) => void; onClose: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState('');
  const popoverRef = useRef<HTMLElement | null>(null);
  const openCode = providers.find((provider: any) => provider.id === 'opencode');
  const accountConnected = openCode?.state === 'connected';
  const available = models.filter((m) => m.status === 'available');
  const publicModelsAvailable = available.some((m) => m.free ?? /-free$/i.test(m.id));
  const connected = accountConnected || publicModelsAvailable;
  const query = search.toLowerCase().trim();
  const filtered = available.filter((m) => `${m.displayName} ${m.providerName} ${m.family}`.toLowerCase().includes(query));

  useEffect(() => {
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const closeOnPointer = (event: PointerEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', closeOnKey);
    window.addEventListener('pointerdown', closeOnPointer);
    return () => {
      window.removeEventListener('keydown', closeOnKey);
      window.removeEventListener('pointerdown', closeOnPointer);
    };
  }, [onClose]);

  async function connectOpenCode(event: React.FormEvent) {
    event.preventDefault();
    if (!apiKey.trim() || busy) return;
    setBusy(true); setSheetError('');
    try {
      await j(await fetch('/v1/ai/providers/connect-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: 'opencode', apiKey: apiKey.trim() }) }));
      setApiKey('');
      await onRefresh();
    } catch (error: any) {
      setSheetError(error.message || 'OpenCode could not be connected.');
    } finally { setBusy(false); }
  }

  return <aside ref={popoverRef} className="ai-switcher-popover" role="dialog" aria-modal="false" aria-label="Agent and model switcher">
    <div className="ai-switcher-header">
      <div><b>AI</b><small>{connected ? 'Choose agent and model' : 'Connect AI to continue'}</small></div>
      <button type="button" className="icon-button compact-icon" aria-label="Close AI switcher" onClick={onClose}><Icon name="close" size={15} /></button>
    </div>

    {sheetError && <div className="screen-alert tone-fail ai-sheet-alert" role="alert"><span>{sheetError}</span></div>}

    {!connected ? <form className="ai-quick-connect" onSubmit={connectOpenCode}>
      <div><b>OpenCode</b><small>Paste your API key, or use the public models when available.</small></div>
      <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="OpenCode API key" autoComplete="off" spellCheck={false} />
      <Button disabled={!apiKey.trim() || busy}>{busy ? 'Connecting…' : 'Connect'}</Button>
    </form> : <>
      <section className="ai-switcher-section">
        <span className="ai-switcher-label">Agent</span>
        <div className="ai-agent-pills" role="list">
          {adapters.length ? adapters.map((adapter: any) => {
            const selected = adapter.id === selectedAdapterId;
            const unavailable = adapter.state === 'failed';
            return <button key={adapter.id} type="button" className={selected ? 'ai-agent-pill selected' : 'ai-agent-pill'} onClick={() => onSelectAdapter(adapter.id)} disabled={unavailable}>
              <span className={`ai-control-state state-${adapter.state || 'available'}`} />
              <span><b>{adapter.displayName}</b><small>{unavailable ? 'Unavailable' : adapter.state === 'starting' || adapter.state === 'installing' ? 'Starting' : 'Ready'}</small></span>
              {selected && <Icon name="check" size={13} />}
            </button>;
          }) : <span className="small">Loading agent…</span>}
        </div>
      </section>

      <section className="ai-switcher-section model-section">
        <div className="ai-switcher-label-row"><span className="ai-switcher-label">Model</span><small>{filtered.length} available</small></div>
        {available.length > 6 && <label className="search-field ai-switcher-search"><Icon name="search" /><input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search models…" /></label>}
        {available.length
          ? <div className="ai-model-compact-list">
              {filtered.slice(0, 50).map((m: any) => <button key={m.id} type="button" className={m.id === selectedModelId ? 'ai-model-compact selected' : 'ai-model-compact'} onClick={() => onSelectModel(m.id)}>
                <span><b>{m.displayName}</b><small>{m.family}{m.free ? ' · Free' : ''}</small></span>
                {m.id === selectedModelId ? <Icon name="check" size={13} /> : null}
              </button>)}
              {!filtered.length && <p className="ai-switcher-empty">No matching models.</p>}
            </div>
          : <div className="ai-model-wait compact"><div><b>{modelError ? 'Couldn’t load models' : 'Loading models…'}</b>{modelError && <Button tone="ghost" onClick={() => void onRefresh()}>Try again</Button>}</div></div>}
      </section>
    </>}
  </aside>;
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
    {status?.mode === 'bootstrap' && <div className="card"><p>This creates the GitHub App <b>{status.appName}</b> for <b>{status.publicUrl}</b> with the permissions needed for repository changes, pull-request publishing, and Codespaces execution.</p><form method="post" action={`${status.manifestEndpoint}?state=${encodeURIComponent(status.state)}`}><input type="hidden" name="manifest" value={JSON.stringify(status.manifest)} /><Button>{busy ? 'Opening GitHub…' : 'Create GitHub App'}</Button></form><p className="settings-footnote">GitHub will ask you to confirm. After approval you return here automatically and Orlynx stores the credentials itself.</p></div>}
  </section>;
}

function ActivityList({ activities, agentMode }: { activities: any[]; agentMode?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [detailMode, setDetailMode] = useActivityDetailMode(agentMode === 'build' ? 'code' : 'summary');
  const currentIndex = activities.reduce((current: number, item: any, index: number) => item.state === 'running' || item.state === 'waiting' ? index : current, -1);
  const startAt = expanded ? 0 : Math.max(0, Math.min(activities.length - 7, currentIndex >= 0 ? currentIndex - 3 : activities.length - 7));
  const visible = expanded ? activities.slice(-50) : activities.slice(startAt, Math.max(startAt + 7, currentIndex + 1));
  const hidden = Math.max(0, activities.length - visible.length);
  return <div className="card">
    <div className="ox-workstream-toolbar"><span className="small">{agentMode === 'build' ? 'Build activity' : 'Activity'}</span><ActivityDetailToggle mode={detailMode} onChange={setDetailMode} /></div>
    <div className="ox-stream">{visible.map((item: any) => <TaskActivityRow key={item.key} item={item} detailMode={detailMode} isCurrent={activities.indexOf(item) === currentIndex} />)}</div>
    {(hidden > 0 || expanded) && <Button tone="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show recent activity' : `Show ${hidden} earlier updates`}</Button>}
  </div>;
}

function CodeViewer({ file, onBack }: { file: { path: string; content: string }; onBack: () => void }) {
  const html = useMemo(() => {
    const extension = file.path.split('.').pop()?.toLowerCase() || '';
    const language = ({ js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', css: 'css', html: 'xml', svg: 'xml', xml: 'xml', sh: 'bash', bash: 'bash', md: 'markdown' } as Record<string, string>)[extension];
    try { return language ? hljs.highlight(file.content, { language }).value : hljs.highlightAuto(file.content).value; }
    catch { return file.content.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char] || char)); }
  }, [file.content, file.path]);
  return <div className="code-viewer"><div className="code-titlebar"><button className="text-button" onClick={onBack}>‹ Files</button><span><Icon name="file" />{file.path}</span></div><pre><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre></div>;
}

function Terminal({ command, setCommand, output, run, connected }: { command: string; setCommand: (value: string) => void; output: string; run: () => void; connected: boolean }) {
  return <div className="terminal-panel"><div className="terminal-note"><Icon name="terminal" />Project terminal</div><form className="terminal-command" onSubmit={(event) => { event.preventDefault(); run(); }}><label>Command</label><div><span>$</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="git status --short" /><Button disabled={!connected || !command.trim()}>Run</Button></div></form><pre className="terminal-output">{output || 'No command has been run.'}</pre></div>;
}

function SettingsScreen({ integration, theme, setTheme, reload, ai, providers, onManageAi, onOpenGithub }: { integration: any; theme: string; setTheme: (theme: string) => void; reload: () => void; ai?: any; providers?: any[]; onManageAi?: () => void; onOpenGithub?: () => void }) {
  const openCode = (providers || []).find((provider: any) => provider.id === 'opencode' && provider.state === 'connected');
  const aiLabel = ai?.state === 'ready' ? `Ready${ai?.model ? ` · ${ai.model.displayName}` : ''}` : ai?.state === 'working' ? 'Working' : openCode ? 'AI connected' : 'Connect AI';
  void reload;
  return <section className="screen-section settings-screen"><div className="screen-heading"><div><p className="eyebrow">ORLYNX</p><h1>Settings</h1><p className="screen-subtitle">Connections and appearance.</p></div></div><section className="settings-group"><h2>GitHub</h2><div className="settings-row"><span className="settings-icon"><Icon name="github" /></span><span><b>{integration.github?.connected ? `Connected${integration.github?.login ? ` as ${integration.github.login}` : ''}` : 'Reconnect GitHub'}</b><small>{integration.github?.connected ? `${integration.github?.authorizedRepositories ?? 0} repositories available${integration.github?.repositorySelection === 'all' ? ' · All repositories' : integration.github?.repositorySelection === 'selected' ? ' · Selected repositories' : ''}` : 'Reconnect to work with your repositories'}</small></span><Button tone="ghost" onClick={onOpenGithub}>{integration.github?.connected ? 'Manage' : 'Reconnect'}</Button></div></section><section className="settings-group"><h2>AI</h2><div className="settings-row"><span className="settings-icon"><Icon name="agents" /></span><span><b>{aiLabel}</b><small>{openCode ? 'Your AI account is connected to Orlynx' : 'Connect an AI account to start working'}</small></span><Button tone="ghost" onClick={onManageAi}>{openCode ? 'Manage' : 'Connect'}</Button></div></section><section className="settings-group"><h2>Appearance</h2><div className="settings-row theme-settings-row"><span className="settings-icon"><Icon name="monitor" /></span><span><b>Theme</b><small>Choose the appearance for every Orlynx screen.</small></span><div className="theme-switcher" role="group" aria-label="Theme">
    {[
      ['system', 'System'],
      ['light', 'Light'],
      ['dark', 'Dark'],
    ].map(([value, label]) => <button key={value} type="button" className={theme === value ? 'selected' : ''} aria-pressed={theme === value} onClick={() => setTheme(value)}>{label}{theme === value && <Icon name="check" size={12} />}</button>)}
  </div></div></section></section>;
}
