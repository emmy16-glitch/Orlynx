import { Router } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { store } from './store.js';
import { durableHistory, emit, recentHistory, subscribe, subscribeEvents } from './events.js';
import { acceptGitHubWebhook, completeGitHubInstallation, completeGitHubOAuth, createGitHubPullRequest, disconnectGitHub, githubBranches, githubCallbackErrorUrl, githubConnectionStatus, githubHealth, githubInstallUrl, githubListRepos, githubManageUrl, githubOAuthUrl, githubPlatformHealth, githubRepositoryAuthorized, githubRepositoryFile, githubRepositoryFiles, headSha, importGitHubRepository, importedRepositoryBranch, importedRepositoryRoot, listFiles, readFile, refreshGitHubInstallation, restoreGitHubInstallation, status } from './github.js';
import { approve, commit, createChangeSet, currentChanges, push } from './changes.js';
import { saveAttachment } from './attachments.js';
import { ensureWorkspaceRecord, getWorkspace, markWorkspaceConnectionLost, prepareWorkspace, stopWorkspace, workspaceNeedsRuntimeRefresh } from './workspaces.js';
import { cancelRun, currentRuns, promoteNextQueuedRun, recoverInterruptedDirectRuns, startRun } from './agents.js';
import { getOpenCodeSessionId, openCodeStatus, runOpenCodeShell } from './opencode.js';
import { aiStatus, canPerform, connectProviderKey, disconnectProvider, getSessionPrefs, hydrateSessionPrefs, listProviderConnections, setProjectDefaults, setSessionPrefs } from './ai.js';
import { MANIFEST_APP_FALLBACKS, MANIFEST_APP_NAME, buildManifest, exchangeManifestCode, persistCredentialsToVercel, setupAccess, setupAuthorized, signManifestState, verifyManifestState } from './manifest.js';
import { publicSiteUrl } from './site.js';
import { clearOAuthStateCookie, clearSessionCookie, installationIdFor, oauthStateFor, requestInstallationId, requireSession, setOAuthStateCookie, setSessionCookie } from './auth.js';
import type { Request } from 'express';
import crypto from 'node:crypto';
import { safeName } from '@orlynx/shared';
import { controlPlaneRepository, durableStorageConfigured } from './storage.js';
import { bridgeRequest, queueBridgeCommand } from './bridge-rpc.js';
import { encryptCredential } from './credentials.js';
import { executionPlaneFor, executionPlaneWithExistingWorkspace } from './direct-chat.js';
import { getAgentAdapter, listAgentAdapters } from './agent-runtime.js';

export const router = Router();

const webhookRateBuckets = new Map<string, { count: number; resetAt: number }>();
function allowWebhookRequest(req: Request): boolean {
  const now = Date.now();
  const key = req.ip || String(req.header('x-forwarded-for') || 'unknown').split(',')[0].trim();
  const current = webhookRateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    webhookRateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  current.count += 1;
  if (webhookRateBuckets.size > 500) {
    for (const [bucketKey, value] of webhookRateBuckets) if (value.resetAt <= now) webhookRateBuckets.delete(bucketKey);
  }
  return current.count <= 240;
}

async function requestUserId(req: Request): Promise<string | null> {
  if (!durableStorageConfigured()) return null;
  const installationId = requestInstallationId(req);
  if (!installationId) return null;
  return (await controlPlaneRepository().getGitHubConnectionByInstallation(installationId))?.userId || null;
}

async function recordAudit(req: Request, sessionId: string | undefined, action: string, outcome: string, detail: Record<string, unknown> = {}): Promise<void> {
  if (!durableStorageConfigured()) return;
  try {
    const repository = controlPlaneRepository();
    const userId = await requestUserId(req);
    if (!userId) return;
    const session = sessionId ? await repository.getSession(sessionId) : null;
    await repository.recordAudit({
      id: `audit_${uuid()}`, userId, sessionId,
      projectId: session?.projectId, action, outcome, detail,
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Auditing must never turn a completed user action into a failed response.
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.ORLYNX_MAX_UPLOAD_MB || 15) * 1024 * 1024, files: 1 },
});

const publicEndpoint = (req: Request) => (
  (req.method === 'GET' && ['/github/install', '/github/setup', '/github/status', '/integrations/status', '/ai/catalog'].includes(req.path))
  || req.path.startsWith('/setup/github-app')
  || (req.method === 'POST' && req.path === '/github/webhook')
);

const storageOptionalEndpoint = (req: Request) => (
  (req.method === 'GET' && ['/github/manage', '/repos'].includes(req.path))
  || (req.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/branches$/.test(req.path))
  || (req.method === 'POST' && ['/github/sync', '/github/disconnect'].includes(req.path))
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
  if (req.path === '/integrations/status' && req.query.sessionId && installationId && durableStorageConfigured()) {
    const session = await controlPlaneRepository().getSession(String(req.query.sessionId));
    if (session?.installationId === installationId) store.db.sessions[session.id] = session;
  }
  if (publicEndpoint(req)) return next();
  if ((process.env.VERCEL === '1' || process.env.ORLYNX_HOSTED_PRODUCTION === '1') && !durableStorageConfigured() && !storageOptionalEndpoint(req)) {
    return res.status(503).json({ error: 'This project is not ready to open yet. Please try again shortly.', code: 'STORAGE_REQUIRED' });
  }
  return requireSession(req, res, async () => {
    if (durableStorageConfigured()) {
      const pathMatch = req.path.match(/^\/sessions\/([^/]+)/) || req.path.match(/^\/ai\/session\/([^/]+)/);
      const querySessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
      const sessionId = pathMatch?.[1] || querySessionId;
      if (sessionId && !store.db.sessions[sessionId]) {
        const session = await controlPlaneRepository().getSession(sessionId);
        if (session?.installationId === requestInstallationId(req)) store.db.sessions[session.id] = session;
      }
    }
    next();
  });
});

function ownedSession(req: Request, id: string) {
  const session = store.db.sessions[id];
  return session && session.installationId === requestInstallationId(req) ? session : undefined;
}

async function persistRecoveredBranch(session: any, branch: string): Promise<void> {
  if (!branch || session.branch === branch) return;
  const previous = session.branch;
  session.branch = branch;
  session.updatedAt = new Date().toISOString();
  store.save();
  if (durableStorageConfigured()) {
    const durable = await controlPlaneRepository().getSession(session.id);
    if (durable) await controlPlaneRepository().putSession({ ...session, userId: durable.userId, projectId: durable.projectId });
  }
  console.info(`[orlynx] sid=${session.id} recovered missing branch ${previous} -> ${branch}`);
}

async function githubFilesSnapshot(req: Request, session: any, directory: string) {
  const installationId = requestInstallationId(req);
  try {
    return { files: await githubRepositoryFiles(session.project, session.branch, directory, installationId), source: 'github', branch: session.branch };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GitHub files are unavailable.';
    if (!/HTTP 404/.test(message)) throw error;

    // A saved session can outlive a short-lived review branch. Distinguish a
    // deleted branch from a missing nested path before recovering.
    const branches = await githubBranches(session.project, installationId);
    if (branches.includes(session.branch)) throw error;
    const repo = (await githubListRepos(installationId)).find((item) => item.full.toLowerCase() === session.project.toLowerCase());
    const fallback = repo && branches.includes(repo.defaultBranch) ? repo.defaultBranch : branches[0];
    if (!fallback) throw error;

    const previous = session.branch;
    const files = await githubRepositoryFiles(session.project, fallback, directory, installationId);
    await persistRecoveredBranch(session, fallback);
    return {
      files,
      source: 'github',
      branch: fallback,
      branchRecovered: true,
      warning: `Branch ${previous} is no longer available. Orlynx returned to ${fallback}.`,
    };
  }
}

async function githubFileSnapshot(req: Request, session: any, filename: string) {
  const installationId = requestInstallationId(req);
  try {
    return { path: filename, content: await githubRepositoryFile(session.project, session.branch, filename, installationId), source: 'github', branch: session.branch };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GitHub file is unavailable.';
    if (!/HTTP 404/.test(message)) throw error;
    const branches = await githubBranches(session.project, installationId);
    if (branches.includes(session.branch)) throw error;
    const repo = (await githubListRepos(installationId)).find((item) => item.full.toLowerCase() === session.project.toLowerCase());
    const fallback = repo && branches.includes(repo.defaultBranch) ? repo.defaultBranch : branches[0];
    if (!fallback) throw error;

    const previous = session.branch;
    const content = await githubRepositoryFile(session.project, fallback, filename, installationId);
    await persistRecoveredBranch(session, fallback);
    return {
      path: filename,
      content,
      source: 'github',
      branch: fallback,
      branchRecovered: true,
      warning: `Branch ${previous} is no longer available. Orlynx returned to ${fallback}.`,
    };
  }
}

async function ownedChangeSession(req: Request, changeId: string): Promise<string> {
  const installationId = requestInstallationId(req);
  for (const [sessionId, list] of Object.entries(store.db.changes)) {
    if (store.db.sessions[sessionId]?.installationId === installationId && list.some((change) => change.id === changeId)) return sessionId;
  }
  if (durableStorageConfigured()) {
    const change = await controlPlaneRepository().getChangeSet(changeId);
    if (change) {
      const session = await controlPlaneRepository().getSession(change.sessionId);
      if (session?.installationId === installationId) { store.db.sessions[session.id] = session; (store.db.changes[session.id] ||= []).push(change); return session.id; }
    }
  }
  return '';
}

// GET /v1/sessions — identity-based restore across phones/laptops.
router.get('/sessions', async (req, res) => {
  if (!durableStorageConfigured()) return res.json([]);
  const userId = await requestUserId(req);
  if (!userId) return res.status(401).json({ error: 'Reconnect GitHub to continue.' });
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
  res.json(await controlPlaneRepository().listSessionsByUser(userId, limit));
});

// POST /v1/sessions — create/resume project session (§14.1)
router.post('/sessions', async (req, res) => {
  const { project = '', branch = '', owner = '' } = req.body || {};
  const installationId = requestInstallationId(req);
  if (!project || !branch || !owner || owner === 'local') return res.status(400).json({ error: 'Open an imported GitHub repository and branch to create a project session.' });
  if (!await githubRepositoryAuthorized(String(project), installationId)) return res.status(403).json({ error: 'This repository is not available to your GitHub connection.' });
  if (!durableStorageConfigured() && !importedRepositoryRoot(String(project))) return res.status(409).json({ error: 'Import this repository through the connected GitHub App before opening a project.' });
  if (!durableStorageConfigured() && importedRepositoryBranch(String(project)) !== String(branch)) return res.status(409).json({ error: 'The selected branch is not checked out locally. Import the branch again.' });
  const id = `ses_${uuid().slice(0, 8)}`;
  const now = new Date().toISOString();
  store.db.sessions[id] = { id, installationId, project, owner, branch, mode: 'repository', workspaceId: null, createdAt: now, updatedAt: now };
  store.save();
  if (durableStorageConfigured()) {
    const repository = controlPlaneRepository();
    const connection = await repository.getGitHubConnectionByInstallation(installationId);
    const githubRepo = (await githubListRepos(installationId)).find((item) => item.full.toLowerCase() === String(project).toLowerCase());
    if (!connection || !githubRepo) return res.status(409).json({ error: 'Reconnect GitHub before creating a durable project session.' });
    const projectId = `prj_${connection.userId}_${githubRepo.id}`;
    await repository.upsertProject({ id: projectId, userId: connection.userId, installationId, repositoryId: githubRepo.id, fullName: githubRepo.full, defaultBranch: githubRepo.defaultBranch });
    await repository.putSession({ ...store.db.sessions[id], userId: connection.userId, projectId });
  }
  emit(id, 'state.snapshot', { project, branch, mode: 'repository' });
  res.json(store.db.sessions[id]);
});

router.get('/sessions/:id', async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s || (!durableStorageConfigured() && !importedRepositoryRoot(s.project))) return res.status(404).json({ error: 'project session not found' });
  const githubAccess = store.db.githubInstallations.some((item) => (item.status || 'active') !== 'suspended')
    ? 'connected'
    : 'disconnected';
  const workspace = durableStorageConfigured() ? await getWorkspace(s.id) : null;
  res.json({ ...s, head: durableStorageConfigured() ? null : headSha(s.project), workspace, githubAccess });
});

// POST /v1/sessions/{id}/messages — send user task (idempotent via clientId)
router.post('/sessions/:id/messages', async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { text = '', clientId = '', adapterId = '', modelId = '', mode = '', fullAccessForThisTask = false } = req.body || {};
  if (!String(text).trim()) return res.status(400).json({ error: 'empty message' });

  if (clientId) {
    const existingMessages = durableStorageConfigured()
      ? await controlPlaneRepository().listMessages(s.id)
      : (store.db.messages[s.id] || []);
    const dup = existingMessages.find((m: { id: string }) => m.id === clientId);
    if (dup) {
      let run: any = null;
      if (durableStorageConfigured()) {
        const task = (await controlPlaneRepository().listTasks(s.id)).find((item) => item.messageId === clientId);
        if (task) run = {
          id: task.runId || task.id,
          sessionId: task.sessionId,
          engine: task.adapterId || 'opencode',
          plane: task.plane || 'workspace',
          state: task.state,
          model: task.modelId,
          mode: task.mode,
          permission: task.permission,
          partialText: task.partialText,
          activity: task.state === 'running' ? 'Working' : task.state === 'queued' ? 'Queued' : task.state,
          startedAt: task.createdAt,
          finishedAt: ['completed','failed','cancelled'].includes(task.state) ? task.updatedAt : undefined,
        };
      } else {
        run = (store.db.runs[s.id] || []).filter((r) => r.sessionId === s.id).slice(-1)[0] || null;
      }
      console.info(`[orlynx] sid=${s.id} duplicate message ignored clientId=${clientId}`);
      return res.json({ message: dup, run, deduplicated: true });
    }
  }

  const prefs = durableStorageConfigured()
    ? await hydrateSessionPrefs(s.id, s.project)
    : getSessionPrefs(s.id, s.project);
  const effectiveMode = (mode ? String(mode) : prefs.mode) as 'build' | 'plan' | 'ask';
  const selectedAdapterId = adapterId ? String(adapterId) : prefs.adapterId || 'opencode';
  const selectedAdapter = getAgentAdapter(selectedAdapterId);
  let plane = executionPlaneFor(String(text), effectiveMode);
  if (plane === 'direct' && !selectedAdapter.capabilities.directChat) plane = 'workspace';
  const selectedModel = modelId ? String(modelId) : prefs.modelId;
  if (!selectedModel) return res.status(409).json({ error: 'Choose a model before sending a message.', code: 'MODEL_REQUIRED' });

  const msg = { id: (clientId as string) || uuid(), sessionId: s.id, role: 'user' as const, text, createdAt: new Date().toISOString() };
  s.checkpoint = { ...(s.checkpoint || { decisions: [], branch: s.branch, filesTouched: [], pendingIssues: [] }), goal: text.slice(0,200), branch: s.branch, updatedAt: new Date().toISOString() };
  (store.db.messages[s.id] ||= []).push(msg);
  store.save();

  let workspaceId: string | undefined;
  let automaticWorkspaceInput: { sessionId: string; userId: string; projectId: string; repositoryId: number; branch: string } | undefined;

  if (durableStorageConfigured()) {
    const repository = controlPlaneRepository();
    await repository.putMessage(msg);
    const durableSession = await repository.getSession(s.id);
    if (!durableSession) return res.status(404).json({ error: 'session not found' });
    await repository.putSession({ ...s, userId: durableSession.userId, projectId: durableSession.projectId });

    // Once a project has a real development environment, reuse that project's
    // selected agent adapter for conversational turns too. Projects that have
    // never started a workspace can still use an adapter's direct-chat path.
    let workspace = await repository.getWorkspaceBySession(s.id);
    plane = executionPlaneWithExistingWorkspace(plane, Boolean(workspace));

    if (plane === 'workspace') {
      if (!workspace) {
        const githubRepo = (await githubListRepos(requestInstallationId(req))).find((item) => item.full.toLowerCase() === s.project.toLowerCase());
        if (!githubRepo) return res.status(403).json({ error: 'Repository authorization could not be verified.' });
        workspace = await ensureWorkspaceRecord({
          sessionId: s.id,
          userId: durableSession.userId,
          projectId: durableSession.projectId,
          repositoryId: githubRepo.id,
          branch: s.branch,
        });
      }

      // Durable workspace state can outlive a dropped WebSocket. Verify the
      // actual bridge transport before admitting work so a stale "ready" row
      // becomes a recoverable connecting workspace instead of a stranded task.
      if (workspace.state === 'ready' && workspace.bridgeState === 'ready') {
        try {
          const health = await bridgeRequest<{ bridge?: string }>(workspace.id, 'health', {}, 3_000);
          if (health.bridge !== 'ready') throw new Error('workspace transport unhealthy');
        } catch {
          workspace = (await markWorkspaceConnectionLost(workspace.id)) || workspace;
          emit(s.id, 'workspace.reconnecting', {
            workspaceId: workspace.id,
            automatic: true,
            message: 'Reconnecting to the development environment…',
          });
        }
      }

      if (workspaceNeedsRuntimeRefresh(workspace)) {
        workspace = {
          ...workspace,
          state: 'connecting',
          bridgeState: 'disconnected',
          connectionId: undefined,
          updatedAt: new Date().toISOString(),
        };
        await repository.putWorkspace(workspace);
        emit(s.id, 'workspace.preparing', {
          stage: 'agent.refresh',
          automatic: true,
          message: 'Updating the Orlynx workspace runtime before starting this task…',
        });
      }

      workspaceId = workspace.id;
      automaticWorkspaceInput = {
        sessionId: s.id,
        userId: durableSession.userId,
        projectId: durableSession.projectId,
        repositoryId: workspace.repositoryId,
        branch: workspace.branch,
      };
    }
  }

  console.info(`[orlynx] sid=${s.id} message received plane=${plane} len=${String(text).length}`);
  let run;
  try {
    run = await startRun(s.id, s.project, text, selectedAdapterId, {
      modelId: selectedModel,
      mode: effectiveMode,
      plane,
      ...(workspaceId ? { workspaceId } : {}),
      ...(fullAccessForThisTask ? { tempPermission: 'full' as const } : {}),
      messageId: msg.id,
    });
  } catch (error) {
    store.db.messages[s.id] = (store.db.messages[s.id] || []).filter((message) => message.id !== msg.id);
    store.save();
    if (durableStorageConfigured()) await controlPlaneRepository().deleteMessage(msg.id, s.id);
    const kind = (error as { errorKind?: string }).errorKind;
    const detail = error instanceof Error ? error.message : '';
    const visible = kind === 'permission' || kind === 'model' || kind === 'queue_full'
      ? detail
      : plane === 'workspace' && /not ready|unavailable|interrupted|timed out/i.test(detail)
        ? 'The development environment needs attention. Your message was not lost.'
        : 'Orlynx AI could not accept this message.';
    return res.status(kind === 'permission' ? 403 : kind === 'queue_full' ? 429 : kind === 'model' ? 409 : 503).json({ error: visible });
  }

  console.info(`[orlynx] sid=${s.id} run=${run.id} plane=${run.plane || plane} state=${run.state}`);

  if (automaticWorkspaceInput && run.plane === 'workspace') {
    const current = await getWorkspace(s.id);
    if (!current || current.state !== 'ready' || current.bridgeState !== 'ready') {
      emit(s.id, 'workspace.preparing', {
        state: current?.state || 'creating',
        automatic: true,
        message: 'Starting the development environment for this task.',
      });
      void prepareWorkspace(automaticWorkspaceInput)
        .then(async (workspace) => {
          if (workspace.state === 'ready' && workspace.bridgeState === 'ready') {
            emit(s.id, 'workspace.ready', { workspaceId: workspace.id, automatic: true });
            await promoteNextQueuedRun(s.id);
          }
        })
        .catch(async (error) => {
          console.warn(`[workspace] automatic preparation failed session=${s.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
          await promoteNextQueuedRun(s.id).catch((promotionError) => {
            console.warn(`[workspace] queue recovery failed session=${s.id}: ${promotionError instanceof Error ? promotionError.message : 'unknown error'}`);
          });
        });
    }
  }

  res.json({
    message: msg,
    run,
    plane,
    workspaceStarting: Boolean(plane === 'workspace' && automaticWorkspaceInput && run.state === 'queued'),
  });
});
router.get('/sessions/:id/messages', async (req, res) => {
  if (!ownedSession(req, req.params.id)) return res.status(404).json({ error: 'session not found' });
  res.json(durableStorageConfigured() ? await controlPlaneRepository().listMessages(req.params.id) : store.db.messages[req.params.id] || []);
});

// GET /v1/sessions/{id}/activity — recent durable activity used to rebuild the
// workspace timeline after navigation/reload without replaying chat deltas.
router.get('/sessions/:id/activity', async (req, res) => {
  const id = req.params.id;
  if (!ownedSession(req, id)) return res.status(404).json({ error: 'session not found' });
  const requested = Number(req.query.limit || 300);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(500, Math.floor(requested))) : 300;
  res.json(await recentHistory(id, limit));
});

// GET /v1/sessions/{id}/events — SSE stream with ?after=seq (§14.2 reconnect)
router.get('/sessions/:id/events', async (req, res) => {
  const id = req.params.id;
  if (!ownedSession(req, id)) return res.status(404).json({ error: 'session not found' });
  const after = Number(req.query.after || 0);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders?.();

  // Replay missed events first. Every event has a durable session sequence, so
  // a phone can reconnect after sleeping or changing networks without gaps.
  const replay = await durableHistory(id, after, 2000);
  for (const event of replay) res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);

  if (durableStorageConfigured()) {
    let cursor = replay.at(-1)?.sequence || after;
    let busy = false;
    let closed = false;
    res.write('retry: 1500\n\n');

    // Fresh events from this control-plane process are pushed immediately.
    const offEvents = subscribeEvents(id, (event) => {
      if (closed || event.sequence <= cursor) return;
      cursor = event.sequence;
      res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // Keep a slower durable catch-up for process restarts, multiple instances,
    // or the tiny replay→subscribe race. This is recovery, not the hot path.
    const poll = setInterval(async () => {
      if (busy || closed) return;
      busy = true;
      try {
        const events = await durableHistory(id, cursor, 200);
        for (const event of events) {
          if (event.sequence <= cursor) continue;
          cursor = event.sequence;
          res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch {} finally { busy = false; }
    }, 5_000);

    const heartbeat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 10_000);

    // Only serverless Vercel needs proactive recycling. A persistent Render
    // service keeps the stream open until the client or network closes it.
    const recycle = process.env.VERCEL === '1'
      ? setTimeout(() => { if (!closed) res.end(); }, 240_000)
      : undefined;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      offEvents();
      clearInterval(poll);
      clearInterval(heartbeat);
      if (recycle) clearTimeout(recycle);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return;
  }

  const off = subscribe(id, res);
  req.on('close', off);
});

// attachments
router.post('/sessions/:id/attachments', upload.single('file'), async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  if (durableStorageConfigured()) {
    const id = `att_${uuid().slice(0, 8)}`; const now = new Date().toISOString(); const name = safeName(req.file.originalname);
    const meta = { id, sessionId: s.id, filename: req.file.originalname, safeName: name, mime: req.file.mimetype, size: req.file.size, hash: crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16), createdAt: now };
    const contentBase64 = req.file.buffer.toString('base64');
    await controlPlaneRepository().putAttachment({ ...meta, contentBase64: encryptCredential(contentBase64) });
    const workspace = await getWorkspace(s.id); if (workspace?.state === 'ready') await bridgeRequest(workspace.id, 'fs.write-attachment', { name: `${id}__${name}`, contentBase64 });
    emit(s.id, 'state.delta', { attachment: meta.id }); return res.json(meta);
  }
  const { meta } = saveAttachment(s.id, req.file.originalname, req.file.mimetype, req.file.buffer);
  emit(s.id, 'state.delta', { attachment: meta.id });
  res.json(meta);
});

router.get('/sessions/:id/attachments', async (req, res) => {
  if (!ownedSession(req, req.params.id)) return res.status(404).json({ error: 'session not found' });
  res.json(durableStorageConfigured() ? await controlPlaneRepository().listAttachments(req.params.id) : store.db.attachments[req.params.id] || []);
});

router.get('/sessions/:id/audit', async (req, res) => {
  if (!ownedSession(req, req.params.id)) return res.status(404).json({ error: 'session not found' });
  if (!durableStorageConfigured()) return res.json([]);
  res.json(await controlPlaneRepository().listAudit(req.params.id, Number(req.query.limit) || 100));
});

// cloud lifecycle
router.post('/sessions/:id/cloud', async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (!durableStorageConfigured()) return res.status(503).json({ error: 'Durable workspace storage is not configured.' });
  try {
    const permissionCheck = await githubConnectionStatus(requestInstallationId(req));
    if (permissionCheck.permissionStatus && !permissionCheck.permissionStatus.workspaceReady) {
      return res.status(409).json({
        error: 'Approve the pending GitHub permission update before starting this development environment.',
        code: 'GITHUB_PERMISSION_UPDATE_REQUIRED',
        missingPermissions: permissionCheck.permissionStatus.missingWorkspace,
        retryable: true,
      });
    }

    const repository = controlPlaneRepository();
    const durable = await repository.getSession(s.id);
    const githubRepo = (await githubListRepos(requestInstallationId(req))).find((item) => item.full.toLowerCase() === s.project.toLowerCase());
    if (!durable || !githubRepo) return res.status(403).json({ error: 'Repository authorization could not be verified.' });

    const current = await ensureWorkspaceRecord({
      sessionId: s.id,
      userId: durable.userId,
      projectId: durable.projectId,
      repositoryId: githubRepo.id,
      branch: s.branch,
    });

    s.mode = 'cloud';
    s.workspaceId = current.id;
    s.updatedAt = new Date().toISOString();
    store.save();
    await repository.putSession({ ...s, userId: durable.userId, projectId: durable.projectId });

    emit(s.id, 'workspace.preparing', {
      state: current.state,
      stage: 'accepted',
      message: current.codespaceName ? 'Waking the existing development environment…' : 'Starting a development environment only for this task…',
    });
    void prepareWorkspace({
      sessionId: s.id,
      userId: durable.userId,
      projectId: durable.projectId,
      repositoryId: githubRepo.id,
      branch: s.branch,
    }).then(async (workspace) => {
      if (workspace.state === 'ready' && workspace.bridgeState === 'ready') {
        await promoteNextQueuedRun(s.id);
      }
    }).catch((error) => {
      console.warn(`[workspace] background start failed session=${s.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
    });

    await recordAudit(req, s.id, 'workspace.start', 'accepted', { workspaceId: current.id, state: current.state, provider: current.provider });
    return res.status(current.state === 'ready' ? 200 : 202).json(current);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : 'Development environment start failed.';
    const permission = /codespaces.*(permission|403|forbidden)|HTTP 403/i.test(diagnostic);
    return res.status(permission ? 409 : 502).json({
      error: permission ? 'GitHub Codespaces access needs approval before this development environment can start.' : "Development environment couldn't start.",
      code: permission ? 'CODESPACES_PERMISSION_REQUIRED' : 'WORKSPACE_START_FAILED',
      retryable: true,
      diagnostic,
    });
  }
});
router.post('/sessions/:id/cloud/stop', async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  try { const workspace = await stopWorkspace(s.id); emit(s.id, 'workspace.stopped', { workspaceId: workspace.id }); await recordAudit(req, s.id, 'workspace.stop', 'completed', { workspaceId: workspace.id }); return res.json(workspace); }
  catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : 'Workspace could not be stopped.' }); }
});

router.post('/sessions/:id/cloud/reconnect', async (req, res) => {
  const s = ownedSession(req, req.params.id); if (!s) return res.status(404).json({ error: 'session not found' });
  if (!durableStorageConfigured()) return res.status(503).json({ error: 'Durable workspace storage is not configured.' });
  try {
    const repository = controlPlaneRepository(); const current = await repository.getWorkspaceBySession(s.id); const durable = await repository.getSession(s.id);
    const githubRepo = (await githubListRepos(requestInstallationId(req))).find((item) => item.full.toLowerCase() === s.project.toLowerCase());
    if (!current || !durable || !githubRepo) return res.status(404).json({ error: 'Cloud workspace not found.' });
    await repository.putWorkspace({ ...current, state: 'connecting', bridgeState: 'disconnected' , connectionId: undefined, updatedAt: new Date().toISOString() });
    emit(s.id, 'workspace.reconnecting', { workspaceId: current.id });
    return res.status(202).json(await prepareWorkspace({ sessionId: s.id, userId: durable.userId, projectId: durable.projectId, repositoryId: githubRepo.id, branch: s.branch }));
  } catch (error) { return res.status(502).json({ error: 'Workspace connection interrupted.', retryable: true, diagnostic: error instanceof Error ? error.message : 'Reconnect failed.' }); }
});

router.post('/sessions/:id/exec', async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { cmd = 'echo ok', approved = false } = req.body || {};
  if (durableStorageConfigured()) await hydrateSessionPrefs(s.id, s.project);
  const gate = canPerform(s.id, 'terminal.exec', { cmd: String(cmd) });
  if (!gate.allowed) return res.status(403).json({ error: gate.reason });
  if (gate.needsApproval && !approved) {
    emit(s.id, 'approval.required', { action: 'terminal.exec', cmd: String(cmd).slice(0, 200) });
    if (durableStorageConfigured()) { const now = new Date().toISOString(); await controlPlaneRepository().putApproval({ id: `approval_${uuid()}`, sessionId: s.id, action: 'terminal.exec', state: 'pending', context: { cmd: String(cmd).slice(0, 200) }, createdAt: now }); }
    return res.status(409).json({ error: 'Approval required before running this command.', approvalRequired: true, cmd: String(cmd).slice(0, 200) });
  }
  if (durableStorageConfigured()) {
    const workspace = await getWorkspace(s.id);
    if (!workspace || workspace.state !== 'ready' || workspace.bridgeState !== 'ready') return res.status(503).json({ error: 'The project workspace is not ready yet.' });
    const parts = String(cmd).trim().split(/\s+/);
    try { const result = await bridgeRequest(workspace.id, 'command.exec', { command: parts.shift(), args: parts }); emit(s.id, 'receipt.created', { cmd: String(cmd).slice(0, 200), ...result }); return res.json(result); }
    catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : 'The terminal command could not be completed.' }); }
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
    const prefs = durableStorageConfigured() ? await hydrateSessionPrefs(s.id, s.project) : getSessionPrefs(s.id, s.project);
    const run = await startRun(s.id, s.project, String(req.body?.text || 'continue'), req.body?.adapterId ? String(req.body.adapterId) : prefs.adapterId || 'opencode', {
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
  if (durableStorageConfigured()) {
    const repository = controlPlaneRepository();
    const task = (await repository.listTasks(String(sessionId))).find((item) => item.runId === req.params.runId);
    if (!task) return res.status(404).json({ error: 'run not found' });
    if (task.state === 'running') {
      if (task.plane !== 'direct') {
        try {
          const adapter = getAgentAdapter(task.adapterId || 'opencode');
          await bridgeRequest(task.workspaceId, adapter.bridgeCancelCommand, { adapterId: adapter.id, taskId: task.id, runId: task.runId }, 15_000);
        }
        catch (error) { return res.status(503).json({ error: error instanceof Error ? error.message : 'The running task could not be stopped.' }); }
      }
    }
    if (task.state === 'running' || task.state === 'queued') {
      task.state = 'cancelled';
      task.updatedAt = new Date().toISOString();
      await repository.putTask(task);
      const memoryRun = (store.db.runs[String(sessionId)] || []).find((item) => item.id === task.runId);
      if (memoryRun) { memoryRun.state = 'cancelled'; memoryRun.finishedAt = task.updatedAt; memoryRun.activity = 'Stopped'; store.save(); }
      if (task.plane === 'direct') {
        try { getAgentAdapter(task.adapterId || 'opencode').cancelDirectRun?.(task.runId || req.params.runId); } catch {}
      }
      emit(task.sessionId, 'run.failed', { cancelled: true, taskId: task.id }, task.runId);
      await promoteNextQueuedRun(task.sessionId).catch(() => null);
    }
    return res.json({ id: task.runId, sessionId: task.sessionId, plane: task.plane || 'workspace', state: task.state, engine: task.adapterId || 'opencode', model: task.modelId, mode: task.mode, startedAt: task.createdAt, finishedAt: task.updatedAt });
  }
  res.json(await cancelRun(String(sessionId), req.params.runId) || { error: 'not found' });
});

// runs — snapshot for session restore ("agent still working" / receipts)
router.get('/sessions/:id/runs', async (req, res) => {
  if (!ownedSession(req, req.params.id)) return res.status(404).json({ error: 'session not found' });
  if (durableStorageConfigured()) {
    await recoverInterruptedDirectRuns(req.params.id);
    // Opening/reloading a conversation is also a safe recovery point for
    // durable queued work admitted before a previous disconnect or deploy.
    await promoteNextQueuedRun(req.params.id).catch(() => null);
    const tasks = await controlPlaneRepository().listTasks(req.params.id);
    return res.json(tasks.map((task) => ({
      id: task.runId || task.id,
      sessionId: task.sessionId,
      engine: task.adapterId || 'opencode',
      plane: task.plane || 'workspace',
      state: task.state,
      model: task.modelId,
      mode: task.mode,
      permission: task.permission,
      partialText: task.partialText,
      partialUpdatedAt: task.partialText ? task.updatedAt : undefined,
      activity: task.state === 'running'
        ? (task.plane === 'direct' ? 'Streaming response' : 'Working')
        : task.state === 'queued'
          ? (task.plane === 'direct' ? 'Waiting to respond' : 'Waiting for development environment')
          : task.state === 'completed' ? 'Ready' : task.state,
      startedAt: task.createdAt,
      finishedAt: ['completed','failed','cancelled'].includes(task.state) ? task.updatedAt : undefined,
    })));
  }
  res.json(currentRuns(req.params.id));
});

// files
router.get('/sessions/:id/files', async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const directory = String(req.query.path || '');
  if (durableStorageConfigured()) {
    const workspace = await getWorkspace(s.id);
    if (!workspace || workspace.state !== 'ready') {
      try { return res.json(await githubFilesSnapshot(req, s, directory)); }
      catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        console.warn(`[orlynx] sid=${s.id} github files unavailable: ${message}`);
        const permissionCheck = await githubConnectionStatus(requestInstallationId(req)).catch(() => null);
        if (permissionCheck?.permissionStatus && permissionCheck.permissionStatus.granted.contents !== 'write') {
          return res.status(409).json({
            error: 'Approve the pending GitHub code-access update, then return to Orlynx.',
            code: 'GITHUB_PERMISSION_UPDATE_REQUIRED',
            missingPermissions: ['contents'],
            retryable: true,
          });
        }
        return res.status(502).json({ error: 'Repository files are temporarily unavailable.', code: 'GITHUB_FILES_UNAVAILABLE', retryable: true });
      }
    }
    try {
      return res.json({ ...(await bridgeRequest(workspace.id, 'fs.list', { path: directory || '.' })), source: 'workspace' });
    } catch (error) {
      console.warn(`[orlynx] sid=${s.id} workspace file listing failed workspace=${workspace.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
      try {
        const snapshot = await githubFilesSnapshot(req, s, directory);
        return res.json({ ...snapshot, warning: 'Workspace files are temporarily unavailable. Showing the GitHub version.' });
      } catch {
        return res.status(503).json({ error: 'Workspace files are temporarily unavailable.', code: 'WORKSPACE_FILES_UNAVAILABLE', retryable: true });
      }
    }
  }
  res.json({ files: listFiles(s.project, directory), head: headSha(s.project), status: status(s.project) });
});
router.get('/sessions/:id/file', async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const filename = String(req.query.path || 'README.md');
  try {
    if (durableStorageConfigured()) {
      const workspace = await getWorkspace(s.id);
      if (!workspace || workspace.state !== 'ready') return res.json(await githubFileSnapshot(req, s, filename));
      try {
        return res.json({ ...(await bridgeRequest(workspace.id, 'fs.read', { path: filename })), source: 'workspace' });
      } catch (error) {
        console.warn(`[orlynx] sid=${s.id} workspace file read failed workspace=${workspace.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
        try {
          const snapshot = await githubFileSnapshot(req, s, filename);
          return res.json({ ...snapshot, warning: 'Workspace file is temporarily unavailable. Showing the GitHub version.' });
        } catch {
          return res.status(503).json({ error: 'Workspace file is temporarily unavailable.', code: 'WORKSPACE_FILE_UNAVAILABLE', retryable: true });
        }
      }
    }
    return res.json({ path: filename, content: readFile(s.project, filename) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'File could not be read.';
    const permissionCheck = durableStorageConfigured()
      ? await githubConnectionStatus(requestInstallationId(req)).catch(() => null)
      : null;
    if (permissionCheck?.permissionStatus && permissionCheck.permissionStatus.granted.contents !== 'write') {
      return res.status(409).json({
        error: 'Approve the pending GitHub code-access update, then return to Orlynx.',
        code: 'GITHUB_PERMISSION_UPDATE_REQUIRED',
        missingPermissions: ['contents'],
        retryable: true,
      });
    }
    const statusCode = /not available through an installed GitHub App|not connected|authorized/i.test(message) ? 403 : /HTTP 404|cannot be displayed|path escape/i.test(message) ? 404 : 502;
    return res.status(statusCode).json({ error: statusCode === 502 ? 'Repository file is temporarily unavailable.' : message, retryable: statusCode === 502 });
  }
});

router.get('/sessions/:id/git/status', async (req, res) => {
  const s = ownedSession(req, req.params.id); if (!s) return res.status(404).json({ error: 'session not found' });
  const workspace = durableStorageConfigured() ? await getWorkspace(s.id) : null;
  if (!workspace || workspace.state !== 'ready') return res.status(503).json({ error: 'Workspace is not ready.' });
  try { res.json(await bridgeRequest(workspace.id, 'git.status')); } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Git status failed.' }); }
});
router.get('/sessions/:id/git/diff', async (req, res) => {
  const s = ownedSession(req, req.params.id); if (!s) return res.status(404).json({ error: 'session not found' });
  const workspace = durableStorageConfigured() ? await getWorkspace(s.id) : null;
  if (!workspace || workspace.state !== 'ready') return res.status(503).json({ error: 'Workspace is not ready.' });
  try { res.json(await bridgeRequest(workspace.id, 'git.diff', { path: String(req.query.path || '.') })); } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Git diff failed.' }); }
});
router.post('/sessions/:id/git/e2e-branch', async (req, res) => {
  const s = ownedSession(req, req.params.id); if (!s) return res.status(404).json({ error: 'session not found' });
  if (process.env.ORLYNX_E2E_ENABLED !== 'true') return res.status(404).json({ error: 'Not found.' });
  const workspace = durableStorageConfigured() ? await getWorkspace(s.id) : null; if (!workspace || workspace.state !== 'ready') return res.status(503).json({ error: 'Workspace is not ready.' });
  try { const result = await bridgeRequest(workspace.id, 'git.branch.create', { branch: String(req.body?.branch || '') }); s.branch = String(result.branch); s.updatedAt = new Date().toISOString(); const durable = await controlPlaneRepository().getSession(s.id); if (durable) await controlPlaneRepository().putSession({ ...s, userId: durable.userId, projectId: durable.projectId }); return res.json(result); }
  catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : 'Test branch could not be created.' }); }
});
router.post('/sessions/:id/terminal', async (req, res) => {
  const s = ownedSession(req, req.params.id); if (!s) return res.status(404).json({ error: 'session not found' });
  const workspace = durableStorageConfigured() ? await getWorkspace(s.id) : null;
  if (!workspace || workspace.state !== 'ready') return res.status(503).json({ error: 'Workspace is not ready.' });
  try { res.json(await bridgeRequest(workspace.id, 'pty.open', { ptyId: `pty_${uuid()}`, cols: req.body?.cols, rows: req.body?.rows })); } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Terminal could not start.' }); }
});
router.post('/sessions/:id/terminal/:ptyId/input', async (req, res) => {
  const s = ownedSession(req, req.params.id); if (!s) return res.status(404).json({ error: 'session not found' }); const workspace = durableStorageConfigured() ? await getWorkspace(s.id) : null;
  if (!workspace || workspace.state !== 'ready') return res.status(503).json({ error: 'Workspace is not ready.' });
  try { res.json(await bridgeRequest(workspace.id, 'pty.input', { ptyId: req.params.ptyId, data: String(req.body?.data || '') })); } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Terminal input failed.' }); }
});
router.get('/sessions/:id/ports', async (req, res) => {
  const s = ownedSession(req, req.params.id); if (!s) return res.status(404).json({ error: 'session not found' }); const workspace = durableStorageConfigured() ? await getWorkspace(s.id) : null;
  if (!workspace || workspace.state !== 'ready') return res.status(503).json({ error: 'Workspace is not ready.' });
  try { res.json(await bridgeRequest(workspace.id, 'ports.list')); } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Preview ports are unavailable.' }); }
});

// changes
router.get('/sessions/:id/changes', async (req, res) => {
  if (!ownedSession(req, req.params.id)) return res.status(404).json({ error: 'session not found' });
  if (durableStorageConfigured()) { const values = await controlPlaneRepository().listChangeSets(req.params.id); store.db.changes[req.params.id] = values; return res.json(values); }
  res.json(currentChanges(req.params.id));
});
router.post('/changes/:changeId/approve', async (req, res) => {
  if (!await ownedChangeSession(req, req.params.changeId)) return res.status(404).json({ error: 'not found' });
  const c = approve(req.params.changeId);
  if (!c) return res.status(404).json({ error: 'not found' });
  emit(c.sessionId, 'approval.resolved', { changeId: c.id, approved: true });
  if (durableStorageConfigured()) { const now = new Date().toISOString(); await controlPlaneRepository().putApproval({ id: `approval_${c.id}`, sessionId: c.sessionId, action: 'changes.approve', state: 'approved', context: { changeId: c.id }, createdAt: now, resolvedAt: now }); await controlPlaneRepository().putChangeSet(c); }
  await recordAudit(req, c.sessionId, 'changes.approve', 'approved', { changeId: c.id, files: c.files.length });
  res.json(c);
});
router.post('/changes/:changeId/commit', async (req, res) => {
  const sid = await ownedChangeSession(req, req.params.changeId);
  const s = store.db.sessions[sid];
  if (!s) return res.status(404).json({ error: 'session not found' });
  const gate = canPerform(sid, 'git.commit');
  if (!gate.allowed) return res.status(403).json({ error: gate.reason });
  try {
    if (durableStorageConfigured()) {
      const c = currentChanges(sid).find((item) => item.id === req.params.changeId);
      if (!c || c.reviewState !== 'approved') return res.status(409).json({ error: 'approve before commit (safe-by-default)' });
      const workspace = await getWorkspace(sid); if (!workspace || workspace.state !== 'ready') return res.status(503).json({ error: 'Workspace is not ready.' });
      const result = await bridgeRequest<{ sha: string }>(workspace.id, 'git.commit', { message: String(req.body?.message || 'Orlynx update') });
      c.reviewState = 'committed'; c.commitSha = result.sha; c.currentHead = result.sha; store.save(); await controlPlaneRepository().putChangeSet(c); emit(sid, 'receipt.created', { changeId: c.id, commitSha: result.sha }); await recordAudit(req, sid, 'git.commit', 'completed', { changeId: c.id, commitSha: result.sha }); return res.json(c);
    }
    const c = commit(sid, s.project, req.params.changeId, String(req.body?.message || 'Orlynx update'));
    await recordAudit(req, sid, 'git.commit', 'completed', { changeId: c.id, commitSha: c.commitSha });
    res.json(c);
  } catch (e: unknown) { res.status(409).json({ error: (e as Error).message }); }
});

router.post('/changes/:changeId/push', async (req, res) => {
  const sid = await ownedChangeSession(req, req.params.changeId);
  const session = store.db.sessions[sid];
  if (!session) return res.status(404).json({ error: 'changeset not found' });
  const gate = canPerform(sid, 'git.push');
  if (!gate.allowed) return res.status(403).json({ error: gate.reason });
  try {
    if (durableStorageConfigured()) {
      const c = currentChanges(sid).find((item) => item.id === req.params.changeId);
      if (!c || c.reviewState !== 'committed') return res.status(409).json({ error: 'commit and approve this changeset before publishing' });
      const workspace = await getWorkspace(sid);
      if (!workspace || workspace.state !== 'ready') return res.status(503).json({ error: 'Workspace is not ready.' });

      const explicitStrategy = String(req.body?.strategy || '');
      const originalBranch = session.branch;
      if (['main', 'master'].includes(originalBranch) && !['direct', 'pull-request'].includes(explicitStrategy)) {
        return res.status(400).json({ error: 'Choose whether to push directly to the default branch or create a pull request.' });
      }
      const publishAsPullRequest = explicitStrategy === 'pull-request';
      let publishedBranch = originalBranch;
      let pullRequest: { number: number; url: string } | undefined;

      if (publishAsPullRequest) {
        const gitStatus = await bridgeRequest<{ branch?: string }>(workspace.id, 'git.status');
        if (gitStatus.branch && /^orlynx\/[a-zA-Z0-9._-]+$/.test(gitStatus.branch)) {
          publishedBranch = gitStatus.branch;
        } else {
          publishedBranch = `orlynx/${c.id.replace(/^chg_/, '')}`;
          await bridgeRequest(workspace.id, 'git.branch.create', { branch: publishedBranch });
        }
        await bridgeRequest(workspace.id, 'git.push', { approved: true });
        pullRequest = await createGitHubPullRequest(
          session.project,
          originalBranch,
          publishedBranch,
          String(req.body?.title || 'Orlynx changes'),
          String(req.body?.body || `Changes prepared and reviewed in Orlynx.\n\nCommit: ${c.commitSha || 'pending'}`),
          requestInstallationId(req),
        );
        c.pullRequestUrl = pullRequest.url;
        c.pullRequestNumber = pullRequest.number;

        // The real workspace is now on the published branch. Keep Orlynx
        // session state aligned with Git instead of telling the next task it is
        // still on main/master while the Codespace is actually elsewhere.
        session.branch = publishedBranch;
        session.updatedAt = new Date().toISOString();
        const durableSession = await controlPlaneRepository().getSession(sid);
        if (durableSession) {
          await controlPlaneRepository().putSession({
            ...session,
            userId: durableSession.userId,
            projectId: durableSession.projectId,
          });
        }
      } else {
        const result = await bridgeRequest<{ branch?: string }>(workspace.id, 'git.push', { approved: true });
        publishedBranch = result.branch || session.branch;
      }

      c.pushedAt = new Date().toISOString();
      c.pushedBranch = publishedBranch;
      store.save();
      await controlPlaneRepository().putChangeSet(c);
      emit(sid, 'receipt.created', { changeId: c.id, pushedAt: c.pushedAt, branch: publishedBranch, pullRequestUrl: c.pullRequestUrl, pullRequestNumber: c.pullRequestNumber });
      await recordAudit(req, sid, pullRequest ? 'git.pull_request' : 'git.push', 'completed', { changeId: c.id, branch: publishedBranch, baseBranch: pullRequest ? originalBranch : session.branch, commitSha: c.commitSha, pullRequestNumber: c.pullRequestNumber });
      return res.json(c);
    }
    const pushed = await push(sid, session.project, session.branch, req.params.changeId, requestInstallationId(req));
    await recordAudit(req, sid, 'git.push', 'completed', { changeId: pushed.id, branch: session.branch, commitSha: pushed.commitSha });
    res.json(pushed);
  }
  catch (error) { res.status(409).json({ error: (error as Error).message }); }
});

// unified AI layer (engine underneath, one experience on top)
router.get('/ai/catalog', async (_req, res) => {
  try {
    const { models } = await listProviderConnections('', undefined, undefined);
    const catalogModels = models.filter((model) => model.providerId === 'opencode');
    console.info(`[ai-catalog] models=${catalogModels.length} available=${catalogModels.filter((model) => model.status === 'available').length}`);
    return res.json({
      models: catalogModels,
      available: catalogModels.some((model) => model.status === 'available'),
    });
  } catch (error) {
    console.warn(`[ai-catalog] failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return res.status(500).json({ error: 'The model catalog is temporarily unavailable.' });
  }
});

router.get('/ai/overview', async (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  const s = sessionId ? ownedSession(req, sessionId) : undefined;
  if (sessionId && !s) return res.status(404).json({ error: 'session not found' });
  try {
    const userId = await requestUserId(req) || undefined;
    const snapshot = await listProviderConnections(s?.project, userId, sessionId || undefined);
    const status = await aiStatus(sessionId || undefined, s?.project, userId, snapshot);
    const prefs = sessionId && s
      ? (durableStorageConfigured() ? await hydrateSessionPrefs(s.id, s.project) : getSessionPrefs(s.id, s.project))
      : undefined;
    const workspace = durableStorageConfigured() && s
      ? await controlPlaneRepository().getWorkspaceBySession(s.id)
      : null;
    const persistedAdapters = workspace
      ? await controlPlaneRepository().listWorkspaceAgentAdapters(workspace.id)
      : [];
    const persistedById = new Map(persistedAdapters.map((adapter) => [adapter.adapterId, adapter]));
    const adapters = listAgentAdapters().map((adapter) => {
      const persisted = persistedById.get(adapter.id);
      return {
        id: adapter.id,
        displayName: adapter.displayName,
        state: persisted?.state || (adapter.capabilities.directChat ? 'available' : 'not_installed'),
        reason: persisted?.reason,
        capabilities: adapter.capabilities,
      };
    });
    const adapterId = prefs?.adapterId || adapters[0]?.id || 'opencode';
    console.info(`[ai-overview] session=${sessionId || '-'} user=${userId ? 'resolved' : 'missing'} adapter=${adapterId} models=${snapshot.models.length} available=${snapshot.models.filter((model) => model.status === 'available').length} providers=${snapshot.providers.length}`);
    res.json({
      state: status.state,
      message: status.message,
      model: status.model,
      adapterId,
      adapters,
      mode: status.mode,
      permission: status.permission,
      providers: status.providers,
      available: snapshot.models.some((model) => model.status === 'available'),
      models: snapshot.models,
      providerConnections: snapshot.providers,
    });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'AI status is unavailable.' });
  }
});
router.get('/ai/status', async (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  const s = sessionId ? ownedSession(req, sessionId) : undefined;
  if (sessionId && !s) return res.status(404).json({ error: 'session not found' });
  try {
    const status = await aiStatus(sessionId || undefined, s?.project, await requestUserId(req) || undefined);
    res.json({ state: status.state, message: status.message, model: status.model, mode: status.mode, permission: status.permission, providers: status.providers });
  }
  catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'AI status is unavailable.' }); }
});
router.get('/ai/providers', async (req, res) => {
  try {
    const session = req.query.sessionId ? ownedSession(req, String(req.query.sessionId)) : undefined;
    const sessionId = String(req.query.sessionId || '');
    const { engine, providers, models } = await listProviderConnections(session?.project, await requestUserId(req) || undefined, sessionId || undefined);
    res.json({ available: models.some((m) => m.status === 'available'), providers, connectedModels: models.filter((m) => m.status === 'available').length });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Provider list is unavailable.' }); }
});
router.get('/ai/models', async (req, res) => {
  try {
    const session = req.query.sessionId ? ownedSession(req, String(req.query.sessionId)) : undefined;
    const sessionId = String(req.query.sessionId || '');
    const { engine, models } = await listProviderConnections(session?.project, await requestUserId(req) || undefined, sessionId || undefined);
    res.json({ available: models.some((m) => m.status === 'available'), models });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Model list is unavailable.' }); }
});
router.post('/ai/providers/connect-key', async (req, res) => {
  try {
    const userId = await requestUserId(req);
    if (!userId) return res.status(401).json({ error: 'Reconnect GitHub before connecting AI.', code: 'AUTH_REQUIRED' });
    const providerId = String(req.body?.providerId || '');
    const apiKey = String(req.body?.apiKey || '');
    const provider = await connectProviderKey(providerId, apiKey, userId);
    return res.json({ provider });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'AI account could not be connected.' });
  }
});
router.post('/ai/providers/:id/disconnect', async (req, res) => {
  try {
    const userId = await requestUserId(req);
    if (!userId) return res.status(401).json({ error: 'Reconnect GitHub before managing AI.', code: 'AUTH_REQUIRED' });
    await disconnectProvider(req.params.id, userId);
    return res.json({ disconnected: true });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'AI account could not be disconnected.' });
  }
});
router.get('/ai/session/:id', async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const prefs = durableStorageConfigured() ? await hydrateSessionPrefs(s.id, s.project) : getSessionPrefs(s.id, s.project);
  const activeRun = durableStorageConfigured()
    ? (await controlPlaneRepository().listTasks(s.id)).some((r) => r.state === 'running')
    : (store.db.runs[s.id] || []).some((r) => r.state === 'running');
  res.json({ prefs, activeRun, appliesTo: activeRun ? 'next-turn' : 'next-task' });
});
router.put('/ai/session/:id', async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  try {
    if (durableStorageConfigured()) await hydrateSessionPrefs(s.id, s.project);
    if (req.body?.adapterId !== undefined) getAgentAdapter(String(req.body.adapterId));
    const prefs = setSessionPrefs(s.id, {
      ...(req.body?.adapterId !== undefined ? { adapterId: String(req.body.adapterId) || 'opencode' } : {}),
      ...(req.body?.modelId !== undefined ? { modelId: String(req.body.modelId) } : {}),
      ...(req.body?.mode ? { mode: String(req.body.mode) as 'build' | 'plan' | 'ask' } : {}),
      ...(req.body?.permission ? { permission: String(req.body.permission) as 'full' | 'ask-first' | 'read-only' } : {}),
    });
    if (durableStorageConfigured()) await controlPlaneRepository().putAISessionPrefs(prefs);
    const activeRun = durableStorageConfigured()
      ? (await controlPlaneRepository().listTasks(s.id)).some((r) => r.state === 'running')
      : (store.db.runs[s.id] || []).some((r) => r.state === 'running');
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
router.get('/github/status', async (req, res) => {
  const connection = await githubConnectionStatus(installationIdFor(req));
  const platform = await githubPlatformHealth();
  res.json({
    ...connection,
    appPermissions: platform.permissions,
    appCapabilities: {
      contents: platform.permissions.contents === 'write',
      pullRequests: platform.permissions.pull_requests === 'write',
      codespaces: platform.permissions.codespaces === 'write',
      codespacesLifecycle: platform.permissions.codespaces_lifecycle_admin === 'write',
      leastPrivilege: Object.entries(platform.permissions).every(([permission, level]) =>
        ['contents', 'metadata', 'pull_requests', 'codespaces', 'codespaces_lifecycle_admin'].includes(permission)
          ? ['read', 'write'].includes(level)
          : level === 'none'
      ),
    },
  });
});
router.get('/repos', async (req, res) => {
  const installationId = requestInstallationId(req);
  const connection = await githubConnectionStatus(installationId);
  const github = connection.connected ? await githubListRepos(installationId) : [];
  res.json({ github, connection });
});
router.get('/github/install', (_req, res) => {
  try {
    // OAuth first. If Orlynx is already installed, GitHub can identify the
    // user's accessible installation and return directly to Orlynx. If there
    // is no installation yet, the callback continues to the install screen.
    const oauth = githubOAuthUrl();
    setOAuthStateCookie(res, oauth.state);
    res.redirect(302, oauth.url);
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'GitHub App is not configured.' });
  }
});
router.get('/github/manage', (req, res) => {
  try {
    res.redirect(302, githubManageUrl(requestInstallationId(req)));
  } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'GitHub App is not configured.' }); }
});
router.get('/github/reauthorize', (req, res) => {
  try {
    const installationId = requestInstallationId(req);
    if (!installationId) return res.status(401).json({ error: 'Connect GitHub to continue.', code: 'AUTH_REQUIRED' });
    const oauth = githubOAuthUrl(installationId);
    setOAuthStateCookie(res, oauth.state);
    return res.redirect(302, oauth.url);
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : 'GitHub authorization could not start.' });
  }
});
router.post('/github/disconnect', async (req, res) => {
  // Orlynx-side disconnect. Sessions, messages, changes and local history are
  // preserved; only GitHub access metadata and cached tokens are dropped.
  await disconnectGitHub(requestInstallationId(req));
  clearSessionCookie(res);
  res.json({ disconnected: true, ...(await githubConnectionStatus(null)) });
});
// POST /v1/github/sync — re-verify repository access after the user changes
// it on GitHub (Manage repositories / Redirect on update). Authenticated by
// the signed session cookie; every check hits the live GitHub API.
router.post('/github/sync', async (req, res) => {
  const installationId = requestInstallationId(req);
  if (!installationId) return res.status(401).json({ error: 'Connect GitHub to continue.', code: 'AUTH_REQUIRED' });
  try {
    const { authorizedRepositories } = await refreshGitHubInstallation(installationId);
    const [connection, health] = await Promise.all([githubConnectionStatus(installationId), githubHealth(installationId)]);
    return res.json({ ...connection, authorizedRepositories, healthy: health.healthy, message: health.message });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : 'GitHub repositories could not be refreshed.' });
  }
});
router.get('/github/setup', async (req, res) => {
  try {
    if (req.query.code) {
      const state = String(req.query.state || '');
      if (!state || oauthStateFor(req) !== state) throw new Error('GitHub authorization could not be verified. Start the connection again.');
      const result = await completeGitHubOAuth(String(req.query.code), state);
      clearOAuthStateCookie(res);
      if (result.needsInstall || !result.installationId) {
        // First-time user: authorization succeeded but the App is not installed
        // yet. Continue directly into GitHub's official install/repo picker.
        return res.redirect(302, githubInstallUrl());
      }
      setSessionCookie(res, result.installationId);
      return res.redirect(302, `${publicSiteUrl()}/?github=connected`);
    }
    if (!req.query.installation_id) {
      // Manual return (e.g. Redirect on update left the user on GitHub and
      // they came back themselves): recover via the signed session cookie.
      const existing = installationIdFor(req);
      if (existing) {
        try { await restoreGitHubInstallation(existing); return res.redirect(302, `${publicSiteUrl()}/?github=connected`); }
        catch { /* fall through to the error route below */ }
      }
      throw new Error('GitHub did not return an installation. Start the connection again.');
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
  if (!allowWebhookRequest(req)) return res.status(429).json({ error: 'Too many webhook requests.' });
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
  const requestedSession = String(req.query.sessionId || '');
  const session = requestedSession ? ownedSession(req, requestedSession) : undefined;
  const userId = await requestUserId(req);
  const [connection, opencode, platform, directAi] = await Promise.all([
    githubConnectionStatus(installationId),
    openCodeStatus(session?.project, requestedSession || undefined),
    githubPlatformHealth(),
    userId ? controlPlaneRepository().getProviderConnection(userId, 'opencode') : Promise.resolve(null),
  ]);
  const health = connection.connected || connection.needsAttention
    ? await githubHealth(installationId || undefined)
    : { healthy: false as boolean, authorizedRepositories: 0, message: platform.configured ? 'Connect GitHub to see your repositories.' : 'GitHub connection is temporarily unavailable.' };
  const workspace = session && durableStorageConfigured() ? await getWorkspace(session.id) : null;
  const bootstrapAvailable = process.env.VERCEL === '1' || process.env.ORLYNX_BOOTSTRAP_MODE === 'sandbox' || process.env.ORLYNX_BOOTSTRAP_MODE === 'local' || Boolean(process.env.ORLYNX_RUNTIME_WORKER_URL && process.env.ORLYNX_RUNTIME_WORKER_TOKEN);
  const infrastructure = durableStorageConfigured() && bootstrapAvailable && Boolean(process.env.ORLYNX_BRIDGE_SIGNING_SECRET);
  res.json({
    github: {
      connected: connection.connected,
      needsAttention: connection.needsAttention,
      login: connection.login,
      repositorySelection: connection.repositorySelection,
      authorizedRepositories: health.authorizedRepositories,
      health: health.healthy ? 'healthy' : 'needs_attention',
      permissionStatus: connection.permissionStatus,
      appCapabilities: {
        contents: platform.permissions.contents === 'write',
        pullRequests: platform.permissions.pull_requests === 'write',
        codespaces: platform.permissions.codespaces === 'write',
        codespacesLifecycle: platform.permissions.codespaces_lifecycle_admin === 'write',
        leastPrivilege: Object.entries(platform.permissions).every(([permission, level]) =>
          ['contents', 'metadata', 'pull_requests', 'codespaces', 'codespaces_lifecycle_admin'].includes(permission)
            ? ['read', 'write'].includes(level)
            : level === 'none'
        ),
      },
    },
    githubAvailable: platform.configured && platform.healthy,
    ai: { available: opencode.connected || directAi?.state === 'connected' },
    workspace: { terminalAvailable: workspace?.state === 'ready' && workspace.bridgeState === 'ready', cloudAvailable: infrastructure && connection.userAuthorizationState === 'established', previewAvailable: workspace?.state === 'ready' && workspace.bridgeState === 'ready', state: workspace?.state || 'not_created' },
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
  try {
    if (durableStorageConfigured()) {
      const repos = await githubListRepos(requestInstallationId(req));
      const selected = repos.find((item) => item.full.toLowerCase() === String(repository).toLowerCase());
      if (!selected || !(await githubBranches(selected.full, requestInstallationId(req))).includes(String(branch))) throw new Error('Repository or branch is not authorized for this Orlynx installation.');
      return res.json({ project: selected.full, branch, source: 'github' });
    }
    res.json({ project: await importGitHubRepository(String(repository), String(branch), requestInstallationId(req)), branch });
  }
  catch (error) {
    const message = (error as Error).message;
    if (/not available through an installed GitHub App|not connected|requir|approv/i.test(message)) return res.status(403).json({ error: 'Repository is not authorized for this Orlynx installation.' });
    if (/not configured|settings are incomplete/i.test(message)) return res.status(503).json({ error: 'GitHub is temporarily unavailable.' });
    res.status(400).json({ error: message });
  }
});
