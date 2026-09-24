import { Router } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { store } from './store.js';
import { emit, history, subscribe } from './events.js';
import { acceptGitHubWebhook, completeGitHubInstallation, disconnectGitHub, githubBranches, githubCallbackErrorUrl, githubConnectionStatus, githubHealth, githubInstallUrl, githubListRepos, githubManageUrl, githubPlatformHealth, headSha, importGitHubRepository, importedRepositoryBranch, importedRepositoryRoot, listFiles, readFile, status } from './github.js';
import { approve, commit, createChangeSet, currentChanges, push } from './changes.js';
import { saveAttachment } from './attachments.js';
import { getWorkspace } from './workspaces.js';
import { cancelRun, currentRuns, startRun } from './agents.js';
import { getOpenCodeSessionId, openCodeStatus, runOpenCodeShell } from './opencode.js';
import { aiStatus, canPerform, connectProviderKey, disconnectProvider, getSessionPrefs, listProviderConnections, setProjectDefaults, setSessionPrefs, supportedProviderIds } from './ai.js';
import { MANIFEST_APP_FALLBACKS, MANIFEST_APP_NAME, buildManifest, exchangeManifestCode, persistCredentialsToVercel, setupAccess, setupAuthorized, signManifestState, verifyManifestState } from './manifest.js';
import { publicSiteUrl } from './site.js';
import { moduleLoadSnapshot } from './github.js';

export const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /v1/sessions — create/resume project session (§14.1)
router.post('/sessions', (req, res) => {
  const { project = '', branch = '', owner = '' } = req.body || {};
  if (!project || !branch || !owner || owner === 'local') return res.status(400).json({ error: 'Open an imported GitHub repository and branch to create a project session.' });
  if (!importedRepositoryRoot(String(project))) return res.status(409).json({ error: 'Import this repository through the connected GitHub App before opening a project.' });
  if (importedRepositoryBranch(String(project)) !== String(branch)) return res.status(409).json({ error: 'The selected branch is not checked out locally. Import the branch again.' });
  const id = `ses_${uuid().slice(0, 8)}`;
  const now = new Date().toISOString();
  store.db.sessions[id] = { id, project, owner, branch, mode: 'repository', workspaceId: null, createdAt: now, updatedAt: now };
  store.save();
  emit(id, 'state.snapshot', { project, branch, mode: 'repository' });
  res.json(store.db.sessions[id]);
});

router.get('/sessions/:id', (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s || !importedRepositoryRoot(s.project)) return res.status(404).json({ error: 'imported project session not found' });
  const githubAccess = store.db.githubInstallations.some((item) => (item.status || 'active') !== 'suspended')
    ? 'connected'
    : 'disconnected';
  res.json({ ...s, head: headSha(s.project), workspace: getWorkspace(s.id) || null, githubAccess });
});

// POST /v1/sessions/{id}/messages — send user task (idempotent via clientId)
router.post('/sessions/:id/messages', async (req, res) => {
  const s = store.db.sessions[req.params.id];
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
  if (!agent.connected) return res.status(503).json({ error: agent.message || 'OpenCode is unavailable. No message was sent.' });
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
    return res.status(kind === 'permission' ? 403 : 503).json({ error: error instanceof Error ? error.message : 'OpenCode could not accept this task.' });
  }
  console.info(`[orlynx] sid=${s.id} run=${run.id} state=${run.state}`);
  res.json({ message: msg, run });
});

router.get('/sessions/:id/messages', (req, res) => {
  res.json(store.db.messages[req.params.id] || []);
});

// GET /v1/sessions/{id}/events — SSE stream with ?after=seq (§14.2 reconnect)
router.get('/sessions/:id/events', (req, res) => {
  const id = req.params.id;
  const after = Number(req.query.after || 0);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // replay missed events first
  for (const e of history(id, after)) res.write(`id: ${e.sequence}\ndata: ${JSON.stringify(e)}\n\n`);
  const off = subscribe(id, res);
  req.on('close', off);
});

// attachments
router.post('/sessions/:id/attachments', upload.single('file'), (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const { meta } = saveAttachment(s.id, req.file.originalname, req.file.mimetype, req.file.buffer);
  emit(s.id, 'state.delta', { attachment: meta.id });
  res.json(meta);
});

router.get('/sessions/:id/attachments', (req, res) => {
  res.json(store.db.attachments[req.params.id] || []);
});

// cloud lifecycle
router.post('/sessions/:id/cloud', (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  return res.status(503).json({ error: 'Codespaces execution is not configured. Orlynx will not start a simulated workspace.' });
});

router.post('/sessions/:id/cloud/stop', (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  return res.status(503).json({ error: 'This session has no connected Codespaces workspace.' });
});

router.post('/sessions/:id/exec', (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { cmd = 'echo ok', approved = false } = req.body || {};
  const gate = canPerform(s.id, 'terminal.exec', { cmd: String(cmd) });
  if (!gate.allowed) return res.status(403).json({ error: gate.reason });
  if (gate.needsApproval && !approved) {
    emit(s.id, 'approval.required', { action: 'terminal.exec', cmd: String(cmd).slice(0, 200) });
    return res.status(409).json({ error: 'Approval required before running this command.', approvalRequired: true, cmd: String(cmd).slice(0, 200) });
  }
  const openCodeSession = getOpenCodeSessionId(s.id);
  if (!openCodeSession) return res.status(503).json({ error: 'OpenCode has not opened this project session yet.' });
  const prefs = getSessionPrefs(s.id, s.project);
  runOpenCodeShell(s.project, openCodeSession, String(cmd), prefs.modelId ? { model: { providerID: prefs.modelId.split('/')[0], modelID: prefs.modelId.split('/').slice(1).join('/') } } : {}).then((result) => {
    const parts = Array.isArray(result.parts) ? result.parts : [];
    const out = parts.filter((part: any) => part.type === 'text').map((part: any) => part.text || '').join('\n');
    emit(s.id, 'receipt.created', { cmd: String(cmd).slice(0, 200), code: result.info?.error ? 1 : 0, out });
    res.json({ code: result.info?.error ? 1 : 0, out });
  }).catch((error) => res.status(502).json({ error: error instanceof Error ? error.message : 'OpenCode shell failed.' }));
});

// agent runs
router.post('/sessions/:id/agent-runs', async (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  try {
    const run = await startRun(s.id, s.project, String(req.body?.text || 'continue'), 'opencode', {
      ...(req.body?.modelId ? { modelId: String(req.body.modelId) } : {}),
      ...(req.body?.mode ? { mode: String(req.body.mode) as 'build' | 'plan' | 'ask' } : {}),
      ...(req.body?.fullAccessForThisTask ? { tempPermission: 'full' as const } : {}),
    });
    res.json(run);
  }
  catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'OpenCode is unavailable.' }); }
});
router.post('/agent-runs/:runId/cancel', async (req, res) => {
  const { sessionId } = req.body || {};
  console.info(`[orlynx] sid=${sessionId} cancel run=${req.params.runId}`);
  res.json(await cancelRun(String(sessionId), req.params.runId) || { error: 'not found' });
});

// runs — snapshot for session restore ("agent still working" / receipts)
router.get('/sessions/:id/runs', (req, res) => {
  res.json(currentRuns(req.params.id));
});

// files
router.get('/sessions/:id/files', (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  res.json({ files: listFiles(s.project, String(req.query.path || '')), head: headSha(s.project), status: status(s.project) });
});
router.get('/sessions/:id/file', (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  try { res.json({ path: req.query.path, content: readFile(s.project, String(req.query.path || 'README.md')) }); }
  catch (e: unknown) { res.status(400).json({ error: (e as Error).message }); }
});

// changes
router.get('/sessions/:id/changes', (req, res) => res.json(currentChanges(req.params.id)));
router.post('/changes/:changeId/approve', (req, res) => {
  const c = approve(req.params.changeId);
  if (!c) return res.status(404).json({ error: 'not found' });
  emit(c.sessionId, 'approval.resolved', { changeId: c.id, approved: true });
  res.json(c);
});
router.post('/changes/:changeId/commit', (req, res) => {
  // locate session via changeset
  let sid = '';
  for (const [k, v] of Object.entries(store.db.changes)) if (v.some((c) => c.id === req.params.changeId)) sid = k;
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
  let sid = '';
  for (const [k, list] of Object.entries(store.db.changes)) if (list.some((change) => change.id === req.params.changeId)) sid = k;
  const session = store.db.sessions[sid];
  if (!session) return res.status(404).json({ error: 'changeset not found' });
  const gate = canPerform(sid, 'git.push');
  if (!gate.allowed) return res.status(403).json({ error: gate.reason });
  try { res.json(await push(sid, session.project, session.branch, req.params.changeId)); }
  catch (error) { res.status(409).json({ error: (error as Error).message }); }
});

// unified AI layer (engine underneath, one experience on top)
router.get('/ai/status', async (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  const s = sessionId ? store.db.sessions[sessionId] : undefined;
  try { res.json(await aiStatus(sessionId || undefined, s?.project)); }
  catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'AI status is unavailable.' }); }
});
router.get('/ai/providers', async (req, res) => {
  try {
    const { engine, providers, models } = await listProviderConnections();
    res.json({ engine: 'OpenCode', engineConnected: engine.connected, engineMessage: engine.message, supported: supportedProviderIds(), providers, connectedModels: models.filter((m) => m.status === 'available').length });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Provider list is unavailable.' }); }
});
router.get('/ai/models', async (req, res) => {
  try {
    const { engine, models } = await listProviderConnections();
    res.json({ engineConnected: engine.connected, engineMessage: engine.message, models });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Model list is unavailable.' }); }
});
router.post('/ai/providers/connect-key', async (req, res) => {
  const { providerId = '', apiKey = '' } = req.body || {};
  if (!providerId || !apiKey) return res.status(400).json({ error: 'Choose a provider and enter its API key.' });
  try { res.json(await connectProviderKey(String(providerId), String(apiKey))); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Connection failed. The key was not stored.' }); }
});
router.post('/ai/providers/:id/disconnect', async (req, res) => {
  await disconnectProvider(String(req.params.id));
  res.json({ disconnected: true, providerId: String(req.params.id) });
});
router.get('/ai/session/:id', (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  const activeRun = (store.db.runs[s.id] || []).some((r) => r.state === 'running');
  res.json({ prefs: getSessionPrefs(s.id, s.project), activeRun, appliesTo: activeRun ? 'next-turn' : 'next-task' });
});
router.put('/ai/session/:id', (req, res) => {
  const s = store.db.sessions[req.params.id];
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
  const key = process.env.GITHUB_PRIVATE_KEY || '';
  res.json({
    build: 'lazy-env-002',
    presence: {
      ORLYNX_PUBLIC_URL: present('ORLYNX_PUBLIC_URL'),
      GITHUB_APP_ID: present('GITHUB_APP_ID'),
      GITHUB_APP_SLUG: present('GITHUB_APP_SLUG'),
      GITHUB_CLIENT_ID: present('GITHUB_CLIENT_ID'),
      GITHUB_APP_CLIENT_SECRET: present('GITHUB_APP_CLIENT_SECRET'),
      GITHUB_PRIVATE_KEY: present('GITHUB_PRIVATE_KEY'),
      GITHUB_WEBHOOK_SECRET: present('GITHUB_WEBHOOK_SECRET'),
    },
    privateKeyLooksValid: key.includes('BEGIN') && key.includes('END'),
    vercel: process.env.VERCEL === '1',
    moduleLoad: moduleLoadSnapshot(),
    check: {
      appId: Boolean(process.env.GITHUB_APP_ID),
      appSlug: Boolean(process.env.GITHUB_APP_SLUG),
      publicUrl: process.env.ORLYNX_PUBLIC_URL || null,
      clientSecret: Boolean(process.env.GITHUB_APP_CLIENT_SECRET),
      privateKey: Boolean(process.env.GITHUB_PRIVATE_KEY),
      webhookSecret: Boolean(process.env.GITHUB_WEBHOOK_SECRET),
    },
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
router.get('/github/status', async (_req, res) => res.json(await githubConnectionStatus()));
router.get('/repos', async (_req, res) => {
  const connection = await githubConnectionStatus();
  const github = connection.connected ? await githubListRepos() : [];
  res.json({ github, connection, localNote: 'Projects are imported GitHub App repositories only. No local demo projects are created.' });
});
router.get('/github/install', (_req, res) => {
  try { res.redirect(302, githubInstallUrl()); }
  catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'GitHub App is not configured.' }); }
});
router.get('/github/manage', (_req, res) => {
  try {
    const first = store.db.githubInstallations[0]?.id;
    res.redirect(302, githubManageUrl(first));
  } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'GitHub App is not configured.' }); }
});
router.post('/github/disconnect', async (_req, res) => {
  // Orlynx-side disconnect. Sessions, messages, changes and local history are
  // preserved; only GitHub access metadata and cached tokens are dropped.
  await disconnectGitHub();
  res.json({ disconnected: true, ...(await githubConnectionStatus()) });
});
router.get('/github/setup', async (req, res) => {
  try {
    const redirect = await completeGitHubInstallation(String(req.query.installation_id || ''), String(req.query.state || ''), String(req.query.setup_action || ''));
    res.redirect(302, redirect);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid setup callback';
    res.redirect(302, githubCallbackErrorUrl(reason));
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
router.get('/agents', async (_req, res) => res.json(await openCodeStatus()));
router.get('/integrations/status', async (_req, res) => {
  const [connection, opencode, platform] = await Promise.all([githubConnectionStatus(), openCodeStatus(), githubPlatformHealth()]);
  const health = connection.connected || connection.needsAttention
    ? await githubHealth()
    : { healthy: false as boolean, authorizedRepositories: 0, message: platform.configured ? 'Connect GitHub to see your repositories.' : 'GitHub connection is temporarily unavailable.' };
  res.json({
    github: { ...connection, health: health.healthy ? 'healthy' : 'unhealthy', healthMessage: health.message, authorizedRepositories: health.authorizedRepositories },
    // Platform vs user-connection split: operators read githubPlatform,
    // the public UI reads github.connected.
    githubPlatform: { configured: platform.configured, healthy: platform.healthy, appId: platform.appId, slug: platform.slug, name: platform.name, message: platform.message },
    agent: opencode,
    ai: await aiStatus().catch(() => ({ state: 'error' as const, engine: 'OpenCode', engineConnected: false, message: 'AI status is unavailable.', mode: 'build' as const, permission: 'ask-first' as const, providers: { connected: 0, total: 0 } })),
    cloud: { configured: false, connected: false, message: 'Cloud workspace is temporarily unavailable.' },
  });
});
router.get('/repos/:owner/:name/branches', async (req, res) => {
  try {
    const branches = await githubBranches(`${req.params.owner}/${req.params.name}`);
    res.json({ branches });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GitHub access failed.';
    if (/not available through an installed GitHub App|not connected|requir|approv/i.test(message)) return res.status(403).json({ error: 'Repository is not authorized for this Orlynx installation.' });
    if (/not configured/i.test(message)) return res.status(503).json({ error: message });
    res.status(502).json({ error: message });
  }
});
router.post('/repos/import', async (req, res) => {
  const { repository = '', branch = 'main' } = req.body || {};
  try { res.json({ project: await importGitHubRepository(String(repository), String(branch)), branch }); }
  catch (error) {
    const message = (error as Error).message;
    if (/not available through an installed GitHub App|not connected|requir|approv/i.test(message)) return res.status(403).json({ error: 'Repository is not authorized for this Orlynx installation.' });
    res.status(400).json({ error: message });
  }
});
