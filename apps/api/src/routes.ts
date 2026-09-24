import { Router } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { store } from './store.js';
import { emit, history, subscribe } from './events.js';
import { acceptGitHubWebhook, completeGitHubInstallation, completeGitHubOAuth, disconnectGitHub, githubBranches, githubCallbackErrorUrl, githubConnectionStatus, githubHealth, githubInstallUrl, githubListRepos, githubManageUrl, githubOAuthUrl, githubPlatformHealth, githubRepositoryAuthorized, headSha, importGitHubRepository, importedRepositoryBranch, importedRepositoryRoot, listFiles, readFile, restoreGitHubInstallation, status } from './github.js';
import { approve, commit, createChangeSet, currentChanges, push } from './changes.js';
import { saveAttachment } from './attachments.js';
import { getWorkspace } from './workspaces.js';
import { cancelRun, currentRuns, startRun } from './agents.js';
import { getOpenCodeSessionId, openCodeStatus, runOpenCodeShell } from './opencode.js';
import { aiStatus, canPerform, getSessionPrefs, listProviderConnections, setProjectDefaults, setSessionPrefs } from './ai.js';
import { MANIFEST_APP_FALLBACKS, MANIFEST_APP_NAME, buildManifest, exchangeManifestCode, persistCredentialsToVercel, setupAccess, setupAuthorized, signManifestState, verifyManifestState } from './manifest.js';
import { publicSiteUrl } from './site.js';
import { clearOAuthStateCookie, clearSessionCookie, installationIdFor, oauthStateFor, requestInstallationId, requireSession, setOAuthStateCookie, setSessionCookie } from './auth.js';
import type { Request } from 'express';

export const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.ORLYNX_MAX_UPLOAD_MB || 15) * 1024 * 1024, files: 1 },
});

const publicEndpoint = (req: Request) => (
  (req.method === 'GET' && ['/github/install', '/github/setup', '/github/status', '/integrations/status'].includes(req.path))
  || req.path.startsWith('/setup/github-app')
  || (req.method === 'POST' && req.path === '/github/webhook')
);

router.use(async (req, res, next) => {
  const installationId = installationIdFor(req);
  if (installationId) {
    try {
      await restoreGitHubInstallation(installationId);
      (req as Request & { orlynxInstallationId?: number }).orlynxInstallationId = installationId;
    } catch {
      clearSessionCookie(res);
      if (!publicEndpoint(req)) return res.status(401).json({ error: 'Reconnect GitHub to continue.', code: 'AUTH_EXPIRED' });
    }
  }
  if (publicEndpoint(req)) return next();
  return requireSession(req, res, next);
});

function ownedSession(req: Request, id: string) {
  const session = store.db.sessions[id];
  return session && session.installationId === requestInstallationId(req) ? session : undefined;
}

function ownedChangeSession(req: Request, changeId: string): string {
  const installationId = requestInstallationId(req);
  for (const [sessionId, list] of Object.entries(store.db.changes)) {
    if (store.db.sessions[sessionId]?.installationId === installationId && list.some((change) => change.id === changeId)) return sessionId;
  }
  return '';
}

// POST /v1/sessions — create/resume project session (§14.1)
router.post('/sessions', async (req, res) => {
  const { project = '', branch = '', owner = '' } = req.body || {};
  const installationId = requestInstallationId(req);
  if (!project || !branch || !owner || owner === 'local') return res.status(400).json({ error: 'Open an imported GitHub repository and branch to create a project session.' });
  if (!await githubRepositoryAuthorized(String(project), installationId)) return res.status(403).json({ error: 'This repository is not available to your GitHub connection.' });
  if (!importedRepositoryRoot(String(project))) return res.status(409).json({ error: 'Import this repository through the connected GitHub App before opening a project.' });
  if (importedRepositoryBranch(String(project)) !== String(branch)) return res.status(409).json({ error: 'The selected branch is not checked out locally. Import the branch again.' });
  const id = `ses_${uuid().slice(0, 8)}`;
  const now = new Date().toISOString();
  store.db.sessions[id] = { id, installationId, project, owner, branch, mode: 'repository', workspaceId: null, createdAt: now, updatedAt: now };
  store.save();
  emit(id, 'state.snapshot', { project, branch, mode: 'repository' });
  res.json(store.db.sessions[id]);
});

router.get('/sessions/:id', (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s || !importedRepositoryRoot(s.project)) return res.status(404).json({ error: 'imported project session not found' });
  const githubAccess = store.db.githubInstallations.some((item) => (item.status || 'active') !== 'suspended')
    ? 'connected'
    : 'disconnected';
  res.json({ ...s, head: headSha(s.project), workspace: getWorkspace(s.id) || null, githubAccess });
});

// POST /v1/sessions/{id}/messages — send user task (idempotent via clientId)
router.post('/sessions/:id/messages', async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { text = '', clientId = '', modelId = '', mode = '', fullAccessForThisTask = false } = req.body || {};
  if (!String(text).trim()) return res.status(400).json({ error: 'empty message' });
  if (clientId) {
    const dup = (store.db.messages[s.id] || []).find((m: { id: string }) => m.id === clientId);
    if (dup) {
      const run = (store.db.runs[s.id] || []).filter((r) => r.sessionId === s.id).slice(-1)[0] || null;
      console.info(`[orlynx] sid=${s.id} duplicate message ignored clientId=${clientId}`);
      return res.json({ message: dup, run, deduplicated: true });
    }
  }
  const agent = await openCodeStatus(s.project);
  if (!agent.connected) return res.status(503).json({ error: 'AI is not available for this workspace yet. No message was sent.' });
  const msg = { id: (clientId as string) || uuid(), sessionId: s.id, role: 'user' as const, text, createdAt: new Date().toISOString() };
  (store.db.messages[s.id] ||= []).push(msg);
  s.checkpoint = { ...(s.checkpoint || { decisions: [], branch: s.branch, filesTouched: [], pendingIssues: [] }), goal: text.slice(0, 200), branch: s.branch, updatedAt: new Date().toISOString() };
  store.save();
  console.info(`[orlynx] sid=${s.id} message received len=${String(text).length}`);
  let run;
  try {
    run = await startRun(s.id, s.project, text, 'opencode', {
      ...(modelId ? { modelId: String(modelId) } : {}),
      ...(mode ? { mode: String(mode) as 'build' | 'plan' | 'ask' } : {}),
      // Temporary elevation: full access for this task only, expires with the run.
      ...(fullAccessForThisTask ? { tempPermission: 'full' as const } : {}),
    });
  }
  catch (error) {
    store.db.messages[s.id] = (store.db.messages[s.id] || []).filter((message) => message.id !== msg.id);
    store.save();
    const kind = (error as { errorKind?: string }).errorKind;
    const detail = error instanceof Error ? error.message : '';
    return res.status(kind === 'permission' ? 403 : 503).json({ error: kind === 'permission' ? detail : 'Orlynx AI could not accept this task.' });
  }
  console.info(`[orlynx] sid=${s.id} run=${run.id} state=${run.state}`);
  res.json({ message: msg, run });
});

router.get('/sessions/:id/messages', (req, res) => {
  if (!ownedSession(req, req.params.id)) return res.status(404).json({ error: 'session not found' });
  res.json(store.db.messages[req.params.id] || []);
});

// GET /v1/sessions/{id}/events — SSE stream with ?after=seq (§14.2 reconnect)
router.get('/sessions/:id/events', (req, res) => {
  const id = req.params.id;
  if (!ownedSession(req, id)) return res.status(404).json({ error: 'session not found' });
  const after = Number(req.query.after || 0);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // replay missed events first
  for (const e of history(id, after, 2000)) res.write(`id: ${e.sequence}\ndata: ${JSON.stringify(e)}\n\n`);
  const off = subscribe(id, res);
  req.on('close', off);
});

// attachments
router.post('/sessions/:id/attachments', upload.single('file'), (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const { meta } = saveAttachment(s.id, req.file.originalname, req.file.mimetype, req.file.buffer);
  emit(s.id, 'state.delta', { attachment: meta.id });
  res.json(meta);
});

router.get('/sessions/:id/attachments', (req, res) => {
  if (!ownedSession(req, req.params.id)) return res.status(404).json({ error: 'session not found' });
  res.json(store.db.attachments[req.params.id] || []);
});

// cloud lifecycle
router.post('/sessions/:id/cloud', (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  return res.status(503).json({ error: 'Cloud workspaces are not available yet.' });
});

router.post('/sessions/:id/cloud/stop', (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  return res.status(503).json({ error: 'This project does not have a cloud workspace.' });
});

router.post('/sessions/:id/exec', (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { cmd = 'echo ok', approved = false } = req.body || {};
  const gate = canPerform(s.id, 'terminal.exec', { cmd: String(cmd) });
  if (!gate.allowed) return res.status(403).json({ error: gate.reason });
  if (gate.needsApproval && !approved) {
    emit(s.id, 'approval.required', { action: 'terminal.exec', cmd: String(cmd).slice(0, 200) });
    return res.status(409).json({ error: 'Approval required before running this command.', approvalRequired: true, cmd: String(cmd).slice(0, 200) });
  }
  const openCodeSession = getOpenCodeSessionId(s.id);
  if (!openCodeSession) return res.status(503).json({ error: 'The project workspace is not ready yet.' });
  const prefs = getSessionPrefs(s.id, s.project);
  runOpenCodeShell(s.project, openCodeSession, String(cmd), prefs.modelId ? { model: { providerID: prefs.modelId.split('/')[0], modelID: prefs.modelId.split('/').slice(1).join('/') } } : {}).then((result) => {
    const parts = Array.isArray(result.parts) ? result.parts : [];
    const out = parts.filter((part: any) => part.type === 'text').map((part: any) => part.text || '').join('\n');
    emit(s.id, 'receipt.created', { cmd: String(cmd).slice(0, 200), code: result.info?.error ? 1 : 0, out });
    res.json({ code: result.info?.error ? 1 : 0, out });
  }).catch(() => res.status(502).json({ error: 'The terminal command could not be completed.' }));
});

// agent runs
router.post('/sessions/:id/agent-runs', async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  try {
    const run = await startRun(s.id, s.project, String(req.body?.text || 'continue'), 'opencode', {
      ...(req.body?.modelId ? { modelId: String(req.body.modelId) } : {}),
      ...(req.body?.mode ? { mode: String(req.body.mode) as 'build' | 'plan' | 'ask' } : {}),
      ...(req.body?.fullAccessForThisTask ? { tempPermission: 'full' as const } : {}),
    });
    res.json(run);
  }
  catch (error) { res.status(503).json({ error: (error as { errorKind?: string }).errorKind === 'permission' && error instanceof Error ? error.message : 'Orlynx AI is not available for this task.' }); }
});
router.post('/agent-runs/:runId/cancel', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!ownedSession(req, String(sessionId))) return res.status(404).json({ error: 'session not found' });
  console.info(`[orlynx] sid=${sessionId} cancel run=${req.params.runId}`);
  res.json(await cancelRun(String(sessionId), req.params.runId) || { error: 'not found' });
});

// runs — snapshot for session restore ("agent still working" / receipts)
router.get('/sessions/:id/runs', (req, res) => {
  if (!ownedSession(req, req.params.id)) return res.status(404).json({ error: 'session not found' });
  res.json(currentRuns(req.params.id));
});

// files
router.get('/sessions/:id/files', (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  res.json({ files: listFiles(s.project, String(req.query.path || '')), head: headSha(s.project), status: status(s.project) });
});
router.get('/sessions/:id/file', (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  try { res.json({ path: req.query.path, content: readFile(s.project, String(req.query.path || 'README.md')) }); }
  catch (e: unknown) { res.status(400).json({ error: (e as Error).message }); }
});

// changes
router.get('/sessions/:id/changes', (req, res) => {
  if (!ownedSession(req, req.params.id)) return res.status(404).json({ error: 'session not found' });
  res.json(currentChanges(req.params.id));
});
router.post('/changes/:changeId/approve', (req, res) => {
  if (!ownedChangeSession(req, req.params.changeId)) return res.status(404).json({ error: 'not found' });
  const c = approve(req.params.changeId);
  if (!c) return res.status(404).json({ error: 'not found' });
  emit(c.sessionId, 'approval.resolved', { changeId: c.id, approved: true });
  res.json(c);
});
router.post('/changes/:changeId/commit', (req, res) => {
  const sid = ownedChangeSession(req, req.params.changeId);
  const s = store.db.sessions[sid];
  if (!s) return res.status(404).json({ error: 'session not found' });
  const gate = canPerform(sid, 'git.commit');
  if (!gate.allowed) return res.status(403).json({ error: gate.reason });
  try {
    const c = commit(sid, s.project, req.params.changeId, String(req.body?.message || 'Orlynx update'));
    res.json(c);
  } catch (e: unknown) { res.status(409).json({ error: (e as Error).message }); }
});

router.post('/changes/:changeId/push', async (req, res) => {
  const sid = ownedChangeSession(req, req.params.changeId);
  const session = store.db.sessions[sid];
  if (!session) return res.status(404).json({ error: 'changeset not found' });
  const gate = canPerform(sid, 'git.push');
  if (!gate.allowed) return res.status(403).json({ error: gate.reason });
  try { res.json(await push(sid, session.project, session.branch, req.params.changeId, requestInstallationId(req))); }
  catch (error) { res.status(409).json({ error: (error as Error).message }); }
});

// unified AI layer (engine underneath, one experience on top)
router.get('/ai/status', async (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  const s = sessionId ? ownedSession(req, sessionId) : undefined;
  if (sessionId && !s) return res.status(404).json({ error: 'session not found' });
  try {
    const status = await aiStatus(sessionId || undefined, s?.project);
    res.json({ state: status.state, message: status.engineConnected ? status.message : 'AI is not available for this workspace yet.', model: status.model, mode: status.mode, permission: status.permission, providers: status.providers });
  }
  catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'AI status is unavailable.' }); }
});
router.get('/ai/providers', async (req, res) => {
  try {
    const { engine, providers, models } = await listProviderConnections();
    res.json({ available: engine.connected, providers: providers.filter((provider) => provider.state === 'connected'), connectedModels: models.filter((m) => m.status === 'available').length });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Provider list is unavailable.' }); }
});
router.get('/ai/models', async (req, res) => {
  try {
    const { engine, models } = await listProviderConnections();
    res.json({ available: engine.connected, models });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Model list is unavailable.' }); }
});
router.post('/ai/providers/connect-key', async (req, res) => {
  res.status(501).json({ error: 'Connecting AI accounts is not available in this deployment.' });
});
router.post('/ai/providers/:id/disconnect', async (req, res) => {
  res.status(501).json({ error: 'Managing AI accounts is not available in this deployment.' });
});
router.get('/ai/session/:id', (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const activeRun = (store.db.runs[s.id] || []).some((r) => r.state === 'running');
  res.json({ prefs: getSessionPrefs(s.id, s.project), activeRun, appliesTo: activeRun ? 'next-turn' : 'next-task' });
});
router.put('/ai/session/:id', (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  try {
    const prefs = setSessionPrefs(s.id, {
      ...(req.body?.modelId !== undefined ? { modelId: String(req.body.modelId) } : {}),
      ...(req.body?.mode ? { mode: String(req.body.mode) as 'build' | 'plan' | 'ask' } : {}),
      ...(req.body?.permission ? { permission: String(req.body.permission) as 'full' | 'ask-first' | 'read-only' } : {}),
    });
    const activeRun = (store.db.runs[s.id] || []).some((r) => r.state === 'running');
    // Never interrupt an active run: changes apply to the next turn.
    res.json({ prefs, appliesTo: activeRun ? 'next-turn' : 'next-task' });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Preferences could not be saved.' }); }
});
router.put('/ai/project-defaults', (req, res) => {
  const { project = '', modelId, mode, permission } = req.body || {};
  const ownsProject = Object.values(store.db.sessions).some((session) => session.installationId === requestInstallationId(req) && session.project === project);
  if (!ownsProject) return res.status(404).json({ error: 'project not found' });
  try {
    setProjectDefaults(String(project), {
      ...(modelId !== undefined ? { modelId: String(modelId) || undefined } : {}),
      ...(mode ? { mode: String(mode) as 'build' | 'plan' | 'ask' } : {}),
      ...(permission ? { permission: String(permission) as 'full' | 'ask-first' | 'read-only' } : {}),
    });
    res.json({ project, saved: true });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Project defaults could not be saved.' }); }
});

// owner-only GitHub App bootstrap via the official manifest flow.
// Normal users never see this; they use Connect GitHub after setup completes.
router.get('/setup/github-app', (req, res) => {
  const access = setupAccess();
  if (access.locked) return res.json({ mode: 'complete', message: 'GitHub App already configured. Setup complete.' });
  if (!access.enabled) return res.status(503).json({ mode: 'unavailable', error: access.reason });
  if (!setupAuthorized(String(req.header('x-setup-token') || ''), String(req.query.setup_token || ''))) {
    return res.status(401).json({ mode: 'unauthorized', error: 'Owner setup token required.' });
  }
  try {
    res.json({
      mode: 'bootstrap',
      publicUrl: publicSiteUrl(),
      appName: MANIFEST_APP_NAME,
      nameFallbacks: MANIFEST_APP_FALLBACKS,
      manifest: buildManifest(MANIFEST_APP_NAME),
      manifestEndpoint: 'https://github.com/settings/apps/new',
      state: signManifestState(),
    });
  } catch (error) { res.status(503).json({ mode: 'unavailable', error: error instanceof Error ? error.message : 'Setup is unavailable.' }); }
});
router.get('/setup/github-app/diagnostics', (req, res) => {
  if (!setupAuthorized(String(req.header('x-setup-token') || ''), String(req.query.setup_token || ''))) {
    return res.status(401).json({ error: 'Owner setup token required.' });
  }
  const present = (name: string) => Boolean(process.env[name]);
  const key = process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_PRIVATE_KEY || '';
  res.json({
    build: 'env-names-004',
    presence: {
      ORLYNX_PUBLIC_URL: present('ORLYNX_PUBLIC_URL'),
      GITHUB_APP_ID: present('GITHUB_APP_ID'),
      GITHUB_APP_SLUG: present('GITHUB_APP_SLUG'),
      GITHUB_CLIENT_ID: present('GITHUB_CLIENT_ID'),
      GITHUB_APP_CLIENT_SECRET: present('GITHUB_APP_CLIENT_SECRET'),
      GITHUB_APP_PRIVATE_KEY: present('GITHUB_APP_PRIVATE_KEY'),
      GITHUB_PRIVATE_KEY_LEGACY: present('GITHUB_PRIVATE_KEY'),
      GITHUB_WEBHOOK_SECRET: present('GITHUB_WEBHOOK_SECRET'),
    },
    privateKeyLooksValid: key.includes('BEGIN') && key.includes('END'),
    vercel: process.env.VERCEL === '1',
  });
});
router.get('/setup/github-app/callback', async (req, res) => {
  const access = setupAccess();
  const fail = (reason: string) => res.redirect(302, `/?internal=setup-github&error=${encodeURIComponent(reason.slice(0, 160))}`);
  if (access.locked) return res.redirect(302, '/?internal=setup-github&created=0');
  if (!access.enabled) return fail(access.reason);
  try {
    verifyManifestState(String(req.query.state || ''));
    const conversion = await exchangeManifestCode(String(req.query.code || ''));
    const persistence = await persistCredentialsToVercel(conversion);
    // Only masked metadata is ever exposed. Secrets went straight to Vercel.
    console.info(`[orlynx] github app created id=${conversion.id} slug=${conversion.slug} stored=${persistence.stored} redeployed=${persistence.redeployed}`);
    if (!persistence.stored) return fail(persistence.detail);
    return res.redirect(302, `/?internal=setup-github&created=1&slug=${encodeURIComponent(conversion.slug)}`);
  } catch (error) { return fail(error instanceof Error ? error.message : 'Setup failed.'); }
});

// repos
router.get('/github/status', async (req, res) => res.json(await githubConnectionStatus(installationIdFor(req))));
router.get('/repos', async (req, res) => {
  const installationId = requestInstallationId(req);
  const connection = await githubConnectionStatus(installationId);
  const github = connection.connected ? await githubListRepos(installationId) : [];
  res.json({ github, connection });
});
router.get('/github/install', (_req, res) => {
  try { res.redirect(302, githubInstallUrl()); }
  catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'GitHub App is not configured.' }); }
});
router.get('/github/manage', (req, res) => {
  try {
    res.redirect(302, githubManageUrl(requestInstallationId(req)));
  } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'GitHub App is not configured.' }); }
});
router.post('/github/disconnect', async (req, res) => {
  // Orlynx-side disconnect. Sessions, messages, changes and local history are
  // preserved; only GitHub access metadata and cached tokens are dropped.
  await disconnectGitHub(requestInstallationId(req));
  clearSessionCookie(res);
  res.json({ disconnected: true, ...(await githubConnectionStatus(null)) });
});
router.get('/github/setup', async (req, res) => {
  try {
    if (req.query.code) {
      const state = String(req.query.state || '');
      if (!state || oauthStateFor(req) !== state) throw new Error('GitHub authorization could not be verified. Start the connection again.');
      const result = await completeGitHubOAuth(String(req.query.code), state);
      clearOAuthStateCookie(res);
      setSessionCookie(res, result.installationId);
      return res.redirect(302, `${publicSiteUrl()}/?github=connected`);
    }
    const result = await completeGitHubInstallation(String(req.query.installation_id || ''), String(req.query.state || ''), String(req.query.setup_action || ''));
    if (!result.installationId) {
      clearOAuthStateCookie(res);
      clearSessionCookie(res);
      return res.redirect(302, result.redirect);
    }
    const oauth = githubOAuthUrl(result.installationId);
    setOAuthStateCookie(res, oauth.state);
    return res.redirect(302, oauth.url);
  } catch (error) {
    clearOAuthStateCookie(res);
    const reason = error instanceof Error ? error.message : 'invalid setup callback';
    return res.redirect(302, githubCallbackErrorUrl(reason));
  }
});
router.post('/github/webhook', async (req, res) => {
  if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'Expected a signed GitHub JSON webhook.' });
  try {
    const summary = await acceptGitHubWebhook(req.body, String(req.header('x-hub-signature-256') || ''), String(req.header('x-github-event') || ''), String(req.header('x-github-delivery') || ''));
    res.status(204).end();
    void summary;
  } catch (error) { res.status(401).json({ error: error instanceof Error ? error.message : 'GitHub webhook verification failed.' }); }
});
router.get('/agents', (_req, res) => res.status(404).json({ error: 'Not found.' }));
router.get('/integrations/status', async (req, res) => {
  const installationId = installationIdFor(req);
  const [connection, opencode, platform] = await Promise.all([githubConnectionStatus(installationId), openCodeStatus(), githubPlatformHealth()]);
  const health = connection.connected || connection.needsAttention
    ? await githubHealth(installationId || undefined)
    : { healthy: false as boolean, authorizedRepositories: 0, message: platform.configured ? 'Connect GitHub to see your repositories.' : 'GitHub connection is temporarily unavailable.' };
  res.json({
    github: { connected: connection.connected, needsAttention: connection.needsAttention, login: connection.login, authorizedRepositories: health.authorizedRepositories, health: health.healthy ? 'healthy' : 'unavailable' },
    githubAvailable: platform.configured && platform.healthy,
    ai: { available: opencode.connected },
    workspace: { terminalAvailable: opencode.connected, cloudAvailable: false, previewAvailable: false },
  });
});
router.get('/repos/:owner/:name/branches', async (req, res) => {
  try {
    const branches = await githubBranches(`${req.params.owner}/${req.params.name}`, requestInstallationId(req));
    res.json({ branches });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GitHub access failed.';
    if (/not available through an installed GitHub App|not connected|requir|approv/i.test(message)) return res.status(403).json({ error: 'Repository is not authorized for this Orlynx installation.' });
    if (/not configured|settings are incomplete/i.test(message)) return res.status(503).json({ error: 'GitHub is temporarily unavailable.' });
    res.status(502).json({ error: message });
  }
});
router.post('/repos/import', async (req, res) => {
  const { repository = '', branch = 'main' } = req.body || {};
  try { res.json({ project: await importGitHubRepository(String(repository), String(branch), requestInstallationId(req)), branch }); }
  catch (error) {
    const message = (error as Error).message;
    if (/not available through an installed GitHub App|not connected|requir|approv/i.test(message)) return res.status(403).json({ error: 'Repository is not authorized for this Orlynx installation.' });
    if (/not configured|settings are incomplete/i.test(message)) return res.status(503).json({ error: 'GitHub is temporarily unavailable.' });
    res.status(400).json({ error: message });
  }
});
