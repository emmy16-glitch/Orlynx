import { Router } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { store } from './store.js';
import { emit, history, subscribe } from './events.js';
import { githubBranches, githubConnectionStatus, githubListRepos, headSha, importGitHubRepository, listFiles, readFile, repoRoot, status } from './github.js';
import { approve, commit, createChangeSet, currentChanges, push } from './changes.js';
import { materializeForRuntime, saveAttachment } from './attachments.js';
import { ensureWorkspace, execInWorkspace, getWorkspace, stopWorkspace } from './workspaces.js';
import { cancelRun, startRun } from './agents.js';

export const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /v1/sessions — create/resume project session (§14.1)
router.post('/sessions', (req, res) => {
  const { project = 'demo', branch = 'main', owner = 'local' } = req.body || {};
  const id = `ses_${uuid().slice(0, 8)}`;
  const now = new Date().toISOString();
  repoRoot(project);
  store.db.sessions[id] = { id, project, owner, branch, mode: 'repository', workspaceId: null, createdAt: now, updatedAt: now };
  store.save();
  emit(id, 'state.snapshot', { project, branch, mode: 'repository' });
  res.json(store.db.sessions[id]);
});

router.get('/sessions/:id', (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  res.json({ ...s, head: headSha(s.project), workspace: getWorkspace(s.id) || null });
});

// POST /v1/sessions/{id}/messages — send user task (idempotent via clientId)
router.post('/sessions/:id/messages', async (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { text = '', engine = 'native', clientId = '' } = req.body || {};
  if (!String(text).trim()) return res.status(400).json({ error: 'empty message' });
  if (clientId) {
    const dup = (store.db.messages[s.id] || []).find((m: { id: string }) => m.id === clientId);
    if (dup) {
      const run = (store.db.runs[s.id] || []).filter((r) => r.sessionId === s.id).slice(-1)[0] || null;
      console.info(`[orlynx] sid=${s.id} duplicate message ignored clientId=${clientId}`);
      return res.json({ message: dup, run, deduplicated: true });
    }
  }
  const msg = { id: (clientId as string) || uuid(), sessionId: s.id, role: 'user' as const, text, createdAt: new Date().toISOString() };
  (store.db.messages[s.id] ||= []).push(msg);
  s.checkpoint = { ...(s.checkpoint || { decisions: [], branch: s.branch, filesTouched: [], pendingIssues: [] }), goal: text.slice(0, 200), branch: s.branch, updatedAt: new Date().toISOString() };
  store.save();
  console.info(`[orlynx] sid=${s.id} message received len=${String(text).length}`);
  const run = await startRun(s.id, s.project, text, engine);
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
  const ws = ensureWorkspace(s.id, s.project, s.branch);
  s.mode = 'cloud'; s.workspaceId = ws.id; s.updatedAt = new Date().toISOString();
  store.save();
  console.info(`[orlynx] sid=${s.id} ws=${ws.id} cloud preparing`);
  emit(s.id, 'workspace.preparing', { workspaceId: ws.id });
  setTimeout(() => { emit(s.id, 'workspace.ready', { workspaceId: ws.id }); console.info(`[orlynx] sid=${s.id} ws=${ws.id} cloud ready`); }, 900);
  materializeForRuntime(s.id, s.project);
  res.json(ws);
});

router.post('/sessions/:id/cloud/stop', (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  const ws = stopWorkspace(s.id);
  s.mode = 'repository'; s.updatedAt = new Date().toISOString(); store.save();
  if (ws) emit(s.id, 'workspace.stopped', { workspaceId: ws.id });
  res.json(ws || { state: 'none' });
});

router.post('/sessions/:id/exec', (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { cmd = 'echo ok' } = req.body || {};
  try {
    const r = execInWorkspace(s.project, String(cmd));
    emit(s.id, 'receipt.created', { cmd: String(cmd).slice(0, 200), code: r.code });
    res.json(r);
  } catch (e: unknown) {
    res.status(403).json({ error: (e as Error).message });
  }
});

// agent runs
router.post('/sessions/:id/agent-runs', async (req, res) => {
  const s = store.db.sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  const run = await startRun(s.id, s.project, String(req.body?.text || 'continue'), req.body?.engine || 'native');
  res.json(run);
});
router.post('/agent-runs/:runId/cancel', (req, res) => {
  const { sessionId } = req.body || {};
  console.info(`[orlynx] sid=${sessionId} cancel run=${req.params.runId}`);
  res.json(cancelRun(String(sessionId), req.params.runId) || { error: 'not found' });
});

// runs — snapshot for session restore ("agent still working" / receipts)
router.get('/sessions/:id/runs', (req, res) => {
  res.json(store.db.runs[req.params.id] || []);
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

router.post('/changes/:changeId/push', (req, res) => {
  let sid = '';
  for (const [k, list] of Object.entries(store.db.changes)) if (list.some((change) => change.id === req.params.changeId)) sid = k;
  const session = store.db.sessions[sid];
  if (!session) return res.status(404).json({ error: 'changeset not found' });
  try { res.json(push(sid, session.project, session.branch, req.params.changeId)); }
  catch (error) { res.status(409).json({ error: (error as Error).message }); }
});

// repos
router.get('/github/status', async (_req, res) => res.json(await githubConnectionStatus()));
router.get('/repos', async (_req, res) => {
  const connection = await githubConnectionStatus();
  const github = connection.connected ? await githubListRepos() : [];
  res.json({ github, connection, localNote: 'Local-only projects are created in the ignored runtime data directory.' });
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
