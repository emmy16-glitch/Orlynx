import { Router } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { store } from './store.js';
import { emit, history, subscribe } from './events.js';
import { acceptGitHubWebhook, completeGitHubInstallation, githubBranches, githubConnectionStatus, githubInstallUrl, githubListRepos, headSha, importGitHubRepository, importedRepositoryBranch, importedRepositoryRoot, listFiles, readFile, status } from './github.js';
import { approve, commit, createChangeSet, currentChanges, push } from './changes.js';
import { saveAttachment } from './attachments.js';
import { getWorkspace } from './workspaces.js';
import { cancelRun, currentRuns, startRun } from './agents.js';
import { getOpenCodeSessionId, openCodeStatus, runOpenCodeShell } from './opencode.js';

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
  res.json({ ...s, head: headSha(s.project), workspace: getWorkspace(s.id) || null });
});

// POST /v1/sessions/{id}/messages — send user task (idempotent via clientId)
router.post('/sessions/:id/messages', async (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { text = '', clientId = '' } = req.body || {};
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
  try { run = await startRun(s.id, s.project, text, 'opencode'); }
  catch (error) {
    store.db.messages[s.id] = (store.db.messages[s.id] || []).filter((message) => message.id !== msg.id);
    store.save();
    return res.status(503).json({ error: error instanceof Error ? error.message : 'OpenCode could not accept this task.' });
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
  const { cmd = 'echo ok' } = req.body || {};
  const openCodeSession = getOpenCodeSessionId(s.id);
  if (!openCodeSession) return res.status(503).json({ error: 'OpenCode has not opened this project session yet.' });
  runOpenCodeShell(s.project, openCodeSession, String(cmd)).then((result) => {
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
  try { const run = await startRun(s.id, s.project, String(req.body?.text || 'continue'), 'opencode'); res.json(run); }
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
  try { res.json(await push(sid, session.project, session.branch, req.params.changeId)); }
  catch (error) { res.status(409).json({ error: (error as Error).message }); }
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
router.get('/github/setup', async (req, res) => {
  try {
    const redirect = await completeGitHubInstallation(String(req.query.installation_id || ''), String(req.query.state || ''), String(req.query.setup_action || ''));
    res.redirect(302, redirect);
  } catch (error) { res.status(400).send(`GitHub connection failed: ${error instanceof Error ? error.message : 'invalid setup callback'}`); }
});
router.post('/github/webhook', async (req, res) => {
  if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'Expected a signed GitHub JSON webhook.' });
  try {
    await acceptGitHubWebhook(req.body, String(req.header('x-hub-signature-256') || ''), String(req.header('x-github-event') || ''));
    res.status(204).end();
  } catch (error) { res.status(401).json({ error: error instanceof Error ? error.message : 'GitHub webhook verification failed.' }); }
});
router.get('/agents', async (_req, res) => res.json(await openCodeStatus()));
router.get('/integrations/status', async (_req, res) => {
  const [github, opencode] = await Promise.all([githubConnectionStatus(), openCodeStatus()]);
  res.json({ github, agent: opencode, cloud: { configured: false, connected: false, message: 'A Codespaces execution bridge is not configured.' } });
});
router.get('/repos/:owner/:name/branches', async (req, res) => {
  const branches = await githubBranches(`${req.params.owner}/${req.params.name}`);
  if (!branches.length && !(await githubConnectionStatus()).connected) return res.status(503).json({ error: 'GitHub access is not configured.' });
  res.json({ branches });
});
router.post('/repos/import', async (req, res) => {
  const { repository = '', branch = 'main' } = req.body || {};
  try { res.json({ project: await importGitHubRepository(String(repository), String(branch)), branch }); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); }
});
