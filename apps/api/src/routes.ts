import { adapterExecutionPlane } from './agent-runtime.js';
import { switchTaskAdapter, resolvePreferredAdapter } from './agent-handoff.js';
import { Router } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { store } from './store.js';
import { durableHistory, emit, emitPersisted, recentHistory, subscribe, subscribeEvents } from './events.js';
import { acceptGitHubWebhook, completeGitHubInstallation, completeGitHubOAuth, createGitHubPullRequest, disconnectGitHub, githubBranches, githubCallbackErrorUrl, githubConnectionStatus, githubHealth, githubInstallUrl, githubListRepos, githubManageUrl, githubOAuthUrl, githubPlatformHealth, githubRepositoryAuthorized, githubRepositoryFile, githubRepositoryFiles, headSha, importGitHubRepository, importedRepositoryBranch, importedRepositoryRoot, listFiles, readFile, refreshGitHubInstallation, restoreGitHubInstallation, status } from './github.js';
import { approve, commit, createChangeSet, currentChanges, push } from './changes.js';
import { saveAttachment } from './attachments.js';
import { ensureWorkspaceRecord, getWorkspace, markWorkspaceConnectionLost, stopWorkspace, workspaceNeedsRuntimeRefresh } from './workspaces.js';
import { cancelRun, currentRuns, promoteNextQueuedRun, recoverInterruptedDirectRuns, resumeWaitingInputTask, startRun } from './agents.js';
import { getOpenCodeSessionId, openCodeStatus, runOpenCodeShell } from './opencode.js';
import { warmOpenCodeRuntime } from './opencode-local.js';
import { aiStatus, canPerform, connectProviderKey, disconnectProvider, getSessionPrefs, hydrateSessionPrefs, listProviderConnections, setProjectDefaults, setSessionPrefs } from './ai.js';
import { MANIFEST_APP_FALLBACKS, MANIFEST_APP_NAME, buildManifest, exchangeManifestCode, persistCredentialsToVercel, setupAccess, setupAuthorized, signManifestState, verifyManifestState } from './manifest.js';
import { publicSiteUrl } from './site.js';
import { clearOAuthStateCookie, clearSessionCookie, installationIdFor, oauthStateFor, requestInstallationId, requireSession, setOAuthStateCookie, setSessionCookie } from './auth.js';
import type { Request } from 'express';
import crypto from 'node:crypto';
import { safeName, type ChatMessage } from '@orlynx/shared';
import { controlPlaneRepository, durableStorageConfigured } from './storage.js';
import { bridgeRequest, queueBridgeCommand } from './bridge-rpc.js';
import { encryptCredential } from './credentials.js';
import { deployIntentFor, executionPlaneFor, executionPlaneForSession, instantReplyFor, mergeIntentFor, publishIntentFor, publishTargetBranchFor, type PublishIntent } from './direct-chat.js';
import { getAgentAdapter, listAgentAdapters, workspaceModelCatalog } from './agent-runtime.js';
import { providerForWorkspace, shouldPrewarmWorkspace, workspaceInfrastructureConfigured } from './workspace-providers.js';
import { scheduleWorkspacePreparation } from './workspace-jobs.js';
import { advanceHarnessPhase, applySteering, createHarnessCheckpoint, queueIntentFor, steeringActionFor, verifyHarness } from './harness.js';
import { computeBrokerSnapshot, selectWorkspaceProvider } from './compute-broker.js';
import { expectedRunnerCommit, runnerPoolCachedHealth } from './runner-pool.js';
import { deploymentTargetForSession, mergePublishedPullRequest, publishVerifiedChangeSet } from './publisher.js';
import { rememberVerifiedProductionOutcome } from './agent-memory.js';

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
  const cached = (req as Request & { orlynxUserId?: string }).orlynxUserId;
  if (cached) return cached;
  const installationId = requestInstallationId(req);
  if (!installationId) return null;
  const connection = await controlPlaneRepository().getGitHubConnectionByInstallation(installationId);
  if (connection?.userId) (req as Request & { orlynxUserId?: string }).orlynxUserId = connection.userId;
  return connection?.userId || null;
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
    const repository = controlPlaneRepository();
    const [session, connection] = await Promise.all([
      repository.getSession(String(req.query.sessionId)),
      repository.getGitHubConnectionByInstallation(installationId),
    ]);
    if (session && connection?.userId === session.userId) {
      store.db.sessions[session.id] = session;
      (req as Request & { orlynxUserId?: string }).orlynxUserId = connection.userId;
    }
  }
  if (publicEndpoint(req)) return next();
  if ((process.env.VERCEL === '1' || process.env.ORLYNX_HOSTED_PRODUCTION === '1') && !durableStorageConfigured() && !storageOptionalEndpoint(req)) {
    return res.status(503).json({ error: 'This project is not ready to open yet. Please try again shortly.', code: 'STORAGE_REQUIRED' });
  }
  return requireSession(req, res, async () => {
    if (durableStorageConfigured()) {
      const repository = controlPlaneRepository();
      const connection = await repository.getGitHubConnectionByInstallation(requestInstallationId(req));
      if (connection?.userId) (req as Request & { orlynxUserId?: string }).orlynxUserId = connection.userId;

      const pathMatch = req.path.match(/^\/sessions\/([^/]+)/) || req.path.match(/^\/ai\/session\/([^/]+)/);
      const querySessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
      const sessionId = pathMatch?.[1] || querySessionId;
      if (sessionId && connection?.userId) {
        const session = await repository.getSession(sessionId);
        if (session?.userId === connection.userId) store.db.sessions[session.id] = session;
      }
    }
    next();
  });
});

function ownedSession(req: Request, id: string) {
  const session = store.db.sessions[id] as any;
  if (!session) return undefined;
  const userId = (req as Request & { orlynxUserId?: string }).orlynxUserId;
  if (durableStorageConfigured() && userId && session.userId) return session.userId === userId ? session : undefined;
  return session.installationId === requestInstallationId(req) ? session : undefined;
}


type WorkspacePublishResult = {
  branch: string;
  head: string;
  alreadyPublished?: boolean;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
};

async function publishCommittedWorkspaceHead(req: Request, session: any, strategy: PublishIntent, targetBranch?: string): Promise<WorkspacePublishResult> {
  const gate = canPerform(session.id, 'git.push');
  if (!gate.allowed) throw new Error(gate.reason || 'Publishing is blocked by the current project access level.');
  if (!durableStorageConfigured()) throw new Error('Controlled chat publishing requires the hosted Orlynx workspace.');

  const repository = controlPlaneRepository();
  const active = (await repository.listTasks(session.id)).some((task) => task.state === 'running' || task.state === 'queued');
  if (active) throw new Error('Finish or stop the current Build task before publishing.');

  const workspace = await getWorkspace(session.id);
  if (!workspace || workspace.state !== 'ready' || workspace.bridgeState !== 'ready') {
    throw new Error('The development environment must be ready before publishing.');
  }

  const published = await publishVerifiedChangeSet({
    sessionId: session.id,
    workspaceId: workspace.id,
    strategy,
    targetBranch: targetBranch || session.branch,
    commitMessage: 'Orlynx verified changes',
  });
  await recordAudit(
    req,
    session.id,
    published.pullRequestUrl ? 'git.pull_request' : 'git.push',
    'completed',
    {
      branch: published.branch,
      commitSha: published.head,
      pullRequestNumber: published.pullRequestNumber,
      protectedBranchFallback: published.protectedBranchFallback,
      source: 'chat-control-plane',
    },
  );
  return published;
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
  const userId = await requestUserId(req);
  for (const [sessionId, list] of Object.entries(store.db.changes)) {
    const session = store.db.sessions[sessionId] as any;
    const owned = durableStorageConfigured() && userId && session?.userId
      ? session.userId === userId
      : session?.installationId === installationId;
    if (owned && list.some((change) => change.id === changeId)) return sessionId;
  }
  if (durableStorageConfigured() && userId) {
    const change = await controlPlaneRepository().getChangeSet(changeId);
    if (change) {
      const session = await controlPlaneRepository().getSession(change.sessionId);
      if (session?.userId === userId) {
        store.db.sessions[session.id] = session;
        (store.db.changes[session.id] ||= []).push(change);
        return session.id;
      }
    }
  }
  return '';
}

// GET /v1/sessions — identity-based restore across phones/laptops.
router.get('/sessions', async (req, res) => {
  if (!durableStorageConfigured()) return res.json([]);
  const userId = await requestUserId(req);
  if (!userId) return res.status(401).json({ error: 'Reconnect GitHub to continue.' });
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 200));
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

  // One durable conversation per user + repository + branch. Reopening a
  // project resumes the existing Orlynx thread instead of silently creating
  // another session that looks like a fresh chat.
  if (durableStorageConfigured()) {
    const repository = controlPlaneRepository();
    const connection = await repository.getGitHubConnectionByInstallation(installationId);
    const githubRepo = (await githubListRepos(installationId)).find((item) => item.full.toLowerCase() === String(project).toLowerCase());
    if (!connection || !githubRepo) return res.status(409).json({ error: 'Reconnect GitHub before creating a durable project session.' });
    const existing = (await repository.listSessionsByUser(connection.userId, 200))
      .find((item) =>
        item.project.toLowerCase() === String(project).toLowerCase()
        && item.branch === String(branch)
      );
    if (existing) {
      const resumed = { ...existing, installationId, updatedAt: new Date().toISOString() };
      await repository.putSession(resumed);
      store.db.sessions[resumed.id] = resumed;
      store.save();
      if (shouldPrewarmWorkspace()) {
        await scheduleWorkspacePreparation({
          sessionId: resumed.id,
          userId: resumed.userId,
          projectId: resumed.projectId,
          repositoryId: githubRepo.id,
          branch: resumed.branch,
        }, { allowFallback: false, reason: 'reopen' }).catch((error) => {
          console.warn(`[workspace] reopen prewarm scheduling failed session=${existing.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
        });
      }
      return res.json(resumed);
    }
  }

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

    // Warm runners are prepared as soon as the repository opens, while chat
    // remains immediately usable. Codespaces are intentionally not prewarmed
    // here because their cold-start/cost profile is the fallback path.
    if (shouldPrewarmWorkspace()) {
      await scheduleWorkspacePreparation({
        sessionId: id,
        userId: connection.userId,
        projectId,
        repositoryId: githubRepo.id,
        branch: String(branch),
      }, { allowFallback: false, reason: 'prewarm' }).catch((error) => {
        console.warn(`[workspace] prewarm scheduling failed session=${id}: ${error instanceof Error ? error.message : 'unknown error'}`);
      });
    }
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

          messageId: task.messageId,
          mode: task.mode,
          permission: task.permission,
          partialText: task.partialText,
          partialUpdatedAt: task.partialText ? (task.harness?.partialUpdatedAt || task.updatedAt) : undefined,
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
  const selectedModel = modelId ? String(modelId) : prefs.modelId;
  const preference = adapterId ? String(adapterId) : prefs.adapterId || 'opencode';
  const selectedAdapterId = preference === 'auto' && durableStorageConfigured() ? await resolvePreferredAdapter(preference, s.id, selectedModel || '', effectiveMode, prefs.permission) : preference === 'auto' ? 'opencode' : preference;
  const selectedAdapter = getAgentAdapter(selectedAdapterId);
  let plane = executionPlaneFor(String(text), effectiveMode);
  plane = adapterExecutionPlane(selectedAdapter, selectedModel || '', plane);
  const publishIntent = effectiveMode === 'build' ? publishIntentFor(String(text), s.branch) : null;
  const publishTargetBranch = publishIntent ? publishTargetBranchFor(String(text), s.branch) : null;
  const instantReply = instantReplyFor({ text: String(text), mode: effectiveMode, project: s.project, branch: s.branch });
  if (!selectedModel && !instantReply && !publishIntent) return res.status(409).json({ error: 'Choose a model before sending a message.', code: 'MODEL_REQUIRED' });

  const msg: ChatMessage = { id: (clientId as string) || uuid(), sessionId: s.id, role: 'user', text: String(text), createdAt: new Date().toISOString() };
  s.checkpoint = { ...(s.checkpoint || { decisions: [], branch: s.branch, filesTouched: [], pendingIssues: [] }), goal: text.slice(0,200), branch: s.branch, updatedAt: new Date().toISOString() };
  (store.db.messages[s.id] ||= []).push(msg);
  store.save();

  let workspaceId: string | undefined;
  let automaticWorkspaceInput: { sessionId: string; userId: string; projectId: string; repositoryId: number; branch: string } | undefined;
  let durableSession: any = null;
  let queueAfterActive = false;

  if (durableStorageConfigured()) {
    const repository = controlPlaneRepository();
    await repository.putMessage(msg);
    durableSession = await repository.getSession(s.id);
    if (!durableSession) return res.status(404).json({ error: 'session not found' });
    await repository.putSession({ ...s, userId: durableSession.userId, projectId: durableSession.projectId });

    const existingTasks = await repository.listTasks(s.id);
    const requestedSteeringAction = steeringActionFor(String(text));
    const explicitQueue = queueIntentFor(String(text));
    const waitingInputTask = existingTasks.find(
      (item) => item.state === 'waiting_input' && (item.plane || 'workspace') === 'workspace',
    );
    if (waitingInputTask && requestedSteeringAction !== 'stop' && !explicitQueue) {
      // This user message belongs to the run that asked for input. Persist the
      // linkage so the conversation projection keeps one continuous turn.
      msg.runId = waitingInputTask.runId;
      await repository.putMessage(msg);
      try {
        const resumedRun = await resumeWaitingInputTask(s.id, waitingInputTask.id, String(text));
        return res.json({ message: msg, run: resumedRun, plane: 'workspace', resumed: true, continued: true, targetRunId: waitingInputTask.runId });
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'The waiting task could not resume yet.';
        console.warn(`[harness] waiting-input resume failed session=${s.id} task=${waitingInputTask.id}: ${detail}`);
        const now = new Date().toISOString();
        const steered = applySteering(waitingInputTask, String(text), 'append', now);
        const waitingWorkspace = await repository.getWorkspace(waitingInputTask.workspaceId).catch(() => null);

        const transportInterrupted = /workspace connection interrupted|workspace did not respond|bridge|socket|connection (?:closed|lost|interrupted)|transport/i.test(detail);
        if (waitingWorkspace && (
          waitingWorkspace.state !== 'ready'
          || waitingWorkspace.bridgeState !== 'ready'
          || transportInterrupted
        )) {
          const repairWorkspace = transportInterrupted
            ? (await markWorkspaceConnectionLost(waitingWorkspace.id).catch(() => null)) || waitingWorkspace
            : waitingWorkspace;

          steered.state = 'queued';
          if (steered.harness) {
            steered.harness = advanceHarnessPhase(steered.harness, 'routing', {
              mode: steered.mode || 'build',
              permission: steered.tempPermission || steered.permission || 'full',
              now,
            });
          }
          steered.updatedAt = now;
          await repository.putTask(steered);
          emit(s.id, 'run.state', {
            taskId: steered.id,
            state: 'queued',
            message: transportInterrupted
              ? 'Your message was saved. The workspace connection dropped, so Orlynx is reconnecting before continuing.'
              : 'Your reply was saved. Reconnecting the development environment before continuing the same task.',
          }, steered.runId);
          void scheduleWorkspacePreparation({
            sessionId: repairWorkspace.sessionId,
            userId: repairWorkspace.userId,
            projectId: repairWorkspace.projectId,
            repositoryId: repairWorkspace.repositoryId,
            branch: repairWorkspace.branch,
          }, { allowFallback: true, reason: 'waiting_input_resume' }).catch((repairError) => {
            console.warn(`[harness] waiting-input workspace repair failed session=${s.id}: ${repairError instanceof Error ? repairError.message : 'unknown error'}`);
          });
          return res.status(202).json({
            message: msg,
            run: { id: steered.runId, sessionId: s.id, plane: 'workspace', state: 'queued' },
            plane: 'workspace',
            resumed: false,
            continued: true,
            queued: true,
            recoveringWorkspace: true,
            targetRunId: steered.runId,
          });
        }

        // The user's reply is already durable. Never make them resend it
        // merely because the model/runtime was briefly unavailable. Requeue the
        // same task and let the normal workspace/provider recovery path decide
        // whether it can resume or must surface a real terminal provider error.
        steered.state = 'queued';
        if (steered.harness) {
          steered.harness = advanceHarnessPhase(steered.harness, 'routing', {
            mode: steered.mode || 'build',
            permission: steered.tempPermission || steered.permission || 'full',
            now,
          });
        }
        steered.updatedAt = now;
        await repository.putTask(steered);
        if (waitingWorkspace) {
          void scheduleWorkspacePreparation({
            sessionId: waitingWorkspace.sessionId,
            userId: waitingWorkspace.userId,
            projectId: waitingWorkspace.projectId,
            repositoryId: waitingWorkspace.repositoryId,
            branch: waitingWorkspace.branch,
          }, { allowFallback: true, reason: 'waiting_input_provider_recovery' }).catch((repairError) => {
            console.warn(`[harness] waiting-input provider recovery failed session=${s.id}: ${repairError instanceof Error ? repairError.message : 'unknown error'}`);
          });
        }
        emit(s.id, 'run.state', {
          taskId: steered.id,
          state: 'queued',
          message: 'Your reply was saved. Orlynx is recovering the AI runtime and will continue this same task automatically.',
        }, steered.runId);
        return res.status(202).json({
          message: msg,
          run: { id: steered.runId, sessionId: s.id, plane: 'workspace', state: 'queued' },
          plane: 'workspace',
          resumed: false,
          continued: true,
          queued: true,
          recoveringRuntime: true,
          targetRunId: steered.runId,
        });
      }
    }

    // One project session is one conversation. While a run is genuinely
    // executing, ordinary follow-ups steer that same run by default. Once the
    // run has crossed into verification/finalization (or is waiting for an
    // approval), new text becomes the next queued turn so it cannot be attached
    // after the model has stopped consulting the live inbox.
    const unresolvedTask = existingTasks
      .filter((item) => ['running', 'waiting_approval', 'waiting_input'].includes(item.state))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    const closingPhase = unresolvedTask?.harness?.phase === 'verifying' || unresolvedTask?.harness?.phase === 'finalizing';
    const explicitContinuation = requestedSteeringAction !== 'ignore';
    const activeTask = unresolvedTask && (
      unresolvedTask.state === 'waiting_input'
      || (unresolvedTask.state === 'running' && !closingPhase && explicitContinuation)
      || (unresolvedTask.state === 'waiting_approval' && requestedSteeringAction === 'stop')
    ) ? unresolvedTask : undefined;
    // Unrelated new input is a new turn. If earlier work is still unresolved,
    // queue that new turn behind it rather than attaching it to the old run.
    queueAfterActive = Boolean(unresolvedTask && (explicitQueue || !activeTask));

    if (activeTask && !explicitQueue) {
      const steeringAction = requestedSteeringAction;
      const now = new Date().toISOString();
      msg.runId = activeTask.runId;
      await repository.putMessage(msg);
      const steeredTask = applySteering(activeTask, String(text), steeringAction, now);

      if (steeringAction === 'stop') {
        if (activeTask.state === 'running' || activeTask.state === 'waiting_input') {
          if ((activeTask.plane || 'workspace') === 'direct') {
            try { getAgentAdapter(activeTask.adapterId || 'opencode').cancelDirectRun?.(activeTask.runId || ''); } catch {}
          } else {
            try {
              const adapter = getAgentAdapter(activeTask.adapterId || 'opencode');
              await bridgeRequest(activeTask.workspaceId, adapter.bridgeCancelCommand, {
                adapterId: adapter.id,
                taskId: activeTask.id,
                runId: activeTask.runId,
              }, 15_000);
            } catch (error) {
              console.warn(`[harness] stop command failed session=${s.id} task=${activeTask.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
            }
          }
        }

        await repository.putTask(steeredTask);
        const memoryRun = (store.db.runs[s.id] || []).find((item) => item.id === activeTask.runId);
        if (memoryRun) {
          memoryRun.state = 'cancelled';
          memoryRun.finishedAt = now;
          memoryRun.activity = 'Stopped';
          store.save();
        }
        emit(s.id, 'run.failed', { taskId: activeTask.id, cancelled: true, steering: true }, activeTask.runId);
        await promoteNextQueuedRun(s.id).catch(() => null);
      } else {
        await repository.putTask(steeredTask);
        emit(s.id, 'state.delta', {
          taskId: activeTask.id,
          scope: 'harness',
          steeringAction,
          steeringRevision: steeredTask.harness?.steeringRevision,
          message: steeringAction === 'replace'
            ? 'Updated the current request with your new direction.'
            : 'Added your follow-up to the current request.',
        }, activeTask.runId);
      }

      const continuedRun = {
        id: activeTask.runId || activeTask.id,
        sessionId: s.id,
        engine: activeTask.adapterId || selectedAdapterId,
        plane: activeTask.plane || 'workspace',
        model: activeTask.modelId || selectedModel || undefined,
        mode: activeTask.mode || effectiveMode,
        permission: activeTask.permission || prefs.permission,
        state: steeringAction === 'stop' ? 'cancelled' : activeTask.state,
        activity: steeringAction === 'stop' ? 'Stopped' : 'Continuing',
        startedAt: activeTask.createdAt,
        ...(steeringAction === 'stop' ? { finishedAt: now } : {}),
      };
      return res.json({
        message: msg,
        run: continuedRun,
        plane: activeTask.plane || 'workspace',
        continued: true,
        steering: steeringAction,
        targetRunId: activeTask.runId,
      });
    }
  }

  if (publishIntent && !queueAfterActive) {
    const now = new Date().toISOString();
    const runId = `run_${uuid().slice(0, 8)}`;
    const taskId = `task_${uuid()}`;
    const workspace = durableStorageConfigured() ? await getWorkspace(s.id) : null;
    const baseRun = {
      id: runId,
      sessionId: s.id,
      engine: selectedAdapterId,
      plane: 'workspace' as const,
      model: selectedModel || undefined,
      mode: effectiveMode,
      permission: prefs.permission,
      activity: 'Publishing to GitHub',
      startedAt: now,
    };

    const wantsMerge = mergeIntentFor(String(text));
    emit(s.id, 'run.started', { taskId, messageId: msg.id, plane: 'workspace', engine: selectedAdapterId, mode: effectiveMode, permission: prefs.permission }, runId);
    emit(s.id, 'activity.started', { taskId, text: wantsMerge ? 'Merging pull request…' : publishIntent === 'direct' ? `Publishing to ${publishTargetBranch || s.branch}…` : 'Creating pull request…', sourceType: 'git.publish' }, runId);

    try {
      if (wantsMerge) {
        const gate = canPerform(s.id, 'git.push');
        if (!gate.allowed) throw new Error(gate.reason || 'Merging is blocked by the current project access level.');
        const merged = await mergePublishedPullRequest({ sessionId: s.id });
        const reply = merged.merged
          ? `Merged pull request #${merged.pullRequestNumber}${merged.mergeCommitSha ? ` (\`${merged.mergeCommitSha.slice(0, 7)}\`)` : ''}${merged.alreadyMerged ? ' — it was already merged.' : '.'}`
          : `Not merged yet: ${merged.message}`;
        const finishedAt = new Date().toISOString();
        const assistant = { id: `msg_${runId}`, sessionId: s.id, role: 'assistant' as const, text: reply, runId, createdAt: finishedAt };
        const run = { ...baseRun, state: (merged.merged ? 'completed' : 'failed') as 'completed' | 'failed', activity: merged.merged ? 'Merged' : 'Merge needs attention', finishedAt, ...(merged.merged ? {} : { errorKind: 'permission' as const }) };
        (store.db.messages[s.id] ||= []).push(assistant);
        (store.db.runs[s.id] ||= []).push(run as never);
        store.save();
        if (durableStorageConfigured()) {
          const repository = controlPlaneRepository();
          await repository.putMessage(assistant);
          await repository.putTask({
            id: taskId, sessionId: s.id, workspaceId: workspace?.id || 'workspace', plane: 'workspace',
            runId, messageId: msg.id, state: merged.merged ? 'completed' : 'failed',
            prompt: String(text), modelId: selectedModel || undefined, adapterId: selectedAdapterId,
            mode: effectiveMode, permission: prefs.permission, createdAt: now, updatedAt: finishedAt,
          });
        }
        await recordAudit(req, s.id, 'git.merge', merged.merged ? 'completed' : 'blocked', {
          pullRequestNumber: merged.pullRequestNumber, mergeCommitSha: merged.mergeCommitSha,
          checksPending: merged.checksPending, alreadyMerged: merged.alreadyMerged,
        });
        emit(s.id, 'activity.completed', { taskId, text: merged.merged ? 'Merged' : 'Merge blocked', sourceType: 'git.publish', pullRequestNumber: merged.pullRequestNumber, mergeCommitSha: merged.mergeCommitSha }, runId);
        emit(s.id, 'receipt.created', { taskId, pullRequestNumber: merged.pullRequestNumber, pullRequestUrl: merged.pullRequestUrl, mergeCommitSha: merged.mergeCommitSha, merged: merged.merged, checksPending: merged.checksPending }, runId);
        emit(s.id, 'message.end', { taskId, instant: true }, runId);
        if (merged.merged) emit(s.id, 'run.completed', { taskId, summary: reply, instant: true }, runId);
        else emit(s.id, 'run.failed', { taskId, error: reply, errorKind: 'permission', recoverable: true }, runId);
        return merged.merged
          ? res.json({ message: msg, run, plane: 'workspace', instant: true, merged })
          : res.status(409).json({ message: msg, run, plane: 'workspace', instant: true, error: reply, merged });
      }
      // If the newest change is already on GitHub, a bare deploy follow-up is
      // deployment verification only. In particular, after a PR merge the
      // workspace still points at the PR head; re-publishing that old commit
      // would be wrong and may fail because main has moved to the merge commit.
      if (deployIntentFor(String(text)) && durableStorageConfigured()) {
        const target = await deploymentTargetForSession(s.id);
        if (target) {
          const { renderDeployStatus } = await import('./render.js');
          const deployment = await renderDeployStatus(target.commitSha);
          const shortSha = target.commitSha.slice(0, 7);
          const reply = `Deployment verification for ${target.source === 'merged' ? 'merged' : 'published'} commit \`${shortSha}\`: ${deployment.message}`;
          const finishedAt = new Date().toISOString();
          const degraded = Boolean(
            deployment.configured
            && (deployment.failed || (deployment.live && deployment.commitMatches === false))
          );
          const assistant = { id: `msg_${runId}`, sessionId: s.id, role: 'assistant' as const, text: reply, runId, createdAt: finishedAt };
          const run = degraded
            ? { ...baseRun, state: 'failed' as const, activity: 'Deployment needs attention', finishedAt, errorKind: 'engine' as const }
            : { ...baseRun, state: 'completed' as const, activity: deployment.live ? 'Deployment verified' : 'Deployment checked', finishedAt };

          (store.db.messages[s.id] ||= []).push(assistant);
          (store.db.runs[s.id] ||= []).push(run as never);
          store.save();

          const repository = controlPlaneRepository();
          await repository.putMessage(assistant);
          await repository.putTask({
            id: taskId, sessionId: s.id, workspaceId: workspace?.id || 'workspace', plane: 'workspace',
            runId, messageId: msg.id, state: degraded ? 'failed' : 'completed',
            prompt: String(text), modelId: selectedModel || undefined, adapterId: selectedAdapterId,
            mode: effectiveMode, permission: prefs.permission, createdAt: now, updatedAt: finishedAt,
          });
          await recordAudit(req, s.id, 'deploy.verify', degraded ? 'attention' : deployment.live ? 'live' : 'checked', {
            changeId: target.changeId,
            commitSha: target.commitSha,
            source: target.source,
            deployId: deployment.deployId,
            deployStatus: deployment.status,
            commitMatches: deployment.commitMatches,
            fleetSize: deployment.services?.length || 1,
          });
          if (deployment.live && deployment.commitMatches === true) {
            const durableSession = await repository.getSession(s.id);
            if (durableSession) {
              await rememberVerifiedProductionOutcome({
                session: durableSession,
                commitSha: target.commitSha,
                deployment,
                provider: 'render',
              }).catch(() => undefined);
            }
          }
          emit(s.id, 'activity.completed', {
            taskId,
            text: deployment.live && deployment.commitMatches ? 'Deployment verified' : deployment.message,
            sourceType: 'deployment.verify',
            deployId: deployment.deployId,
            commitSha: target.commitSha,
          }, runId);
          emit(s.id, 'receipt.created', {
            taskId,
            changeId: target.changeId,
            commitSha: target.commitSha,
            deployment,
          }, runId);
          emit(s.id, 'message.end', { taskId, instant: true }, runId);
          if (degraded) emit(s.id, 'run.failed', { taskId, error: reply, errorKind: 'engine', recoverable: true }, runId);
          else emit(s.id, 'run.completed', { taskId, summary: reply, instant: true }, runId);
          return res.json({ message: msg, run, plane: 'workspace', instant: true, deployment, deploymentOnly: true });
        }
      }

      const published = await publishCommittedWorkspaceHead(req, s, publishIntent, publishTargetBranch || undefined);
      const shortSha = published.head.slice(0, 7);
      let reply = published.pullRequestUrl
        ? `Published \`${shortSha}\` as pull request #${published.pullRequestNumber}: ${published.pullRequestUrl}`
        : published.alreadyPublished
          ? `Already published: \`${shortSha}\` is already on \`${published.branch}\`.`
          : `Published \`${shortSha}\` to \`${published.branch}\`.`;
      // Deployment verification: only for direct branch publication when the
      // user asked for a deploy. Never collapses push/CI/deploy into one
      // fake success state; each stage is reported from live evidence.
      let deployment: import('./render.js').RenderDeployState | undefined;
      if (deployIntentFor(String(text)) && !published.pullRequestUrl) {
        const { renderDeployStatus } = await import('./render.js');
        deployment = await renderDeployStatus(published.head);
        reply += deployment?.configured
          ? `\nDeployment: ${deployment.message}`
          : `\nDeployment: ${deployment?.message || 'verification is not configured.'}`;
        emit(s.id, 'activity.progress', { taskId, text: `Deployment: ${deployment?.status || 'unknown'}`, sourceType: 'git.publish', deployId: deployment?.deployId, commitSha: published.head }, runId);
      }
      const finishedAt = new Date().toISOString();
      const assistant = { id: `msg_${runId}`, sessionId: s.id, role: 'assistant' as const, text: reply, runId, createdAt: finishedAt };
      // The push succeeded but the deployment did not: degrade the task
      // instead of reporting full success.
      const deployFailed = Boolean(deployment?.configured && deployment.failed);
      const deployDrift = Boolean(deployment?.configured && deployment.live && deployment.commitMatches === false);
      const degraded = deployFailed || deployDrift;
      const run = degraded
        ? { ...baseRun, state: 'failed' as const, activity: 'Deployment needs attention', finishedAt, errorKind: 'engine' as const }
        : { ...baseRun, state: 'completed' as const, activity: 'Published', finishedAt };

      (store.db.messages[s.id] ||= []).push(assistant);
      (store.db.runs[s.id] ||= []).push(run as never);
      store.save();

      if (durableStorageConfigured()) {
        const repository = controlPlaneRepository();
        await repository.putMessage(assistant);
        await repository.putTask({
          id: taskId,
          sessionId: s.id,
          workspaceId: workspace?.id || 'workspace',
          plane: 'workspace',
          runId,
          messageId: msg.id,
          state: degraded ? 'failed' : 'completed',
          prompt: String(text),
          modelId: selectedModel || undefined,
          adapterId: selectedAdapterId,
          mode: effectiveMode,
          permission: prefs.permission,
          createdAt: now,
          updatedAt: finishedAt,
        });
        if (!degraded && deployment?.live && deployment.commitMatches === true) {
          const durableSession = await repository.getSession(s.id);
          if (durableSession) {
            await rememberVerifiedProductionOutcome({
              session: durableSession,
              commitSha: published.head,
              deployment,
              provider: 'render',
            }).catch(() => undefined);
          }
        }
      }

      emit(s.id, 'activity.completed', { taskId, text: published.alreadyPublished ? 'Already published' : 'Published to GitHub', sourceType: 'git.publish', branch: published.branch, head: published.head, pullRequestUrl: published.pullRequestUrl }, runId);
      emit(s.id, 'receipt.created', { taskId, branch: published.branch, commitSha: published.head, pullRequestUrl: published.pullRequestUrl, pullRequestNumber: published.pullRequestNumber, ...(deployment ? { deployment } : {}) }, runId);
      emit(s.id, 'message.end', { taskId, instant: true }, runId);
      if (degraded) {
        emit(s.id, 'run.failed', { taskId, error: reply, errorKind: 'engine', recoverable: true, degraded: true }, runId);
        return res.status(502).json({ message: msg, run, plane: 'workspace', instant: true, published, deployment });
      }
      emit(s.id, 'run.completed', { taskId, summary: reply, instant: true }, runId);
      return res.json({ message: msg, run, plane: 'workspace', instant: true, published, ...(deployment ? { deployment } : {}) });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const detail = error instanceof Error ? error.message : 'Orlynx could not publish this commit.';
      const assistant = { id: `msg_${runId}`, sessionId: s.id, role: 'assistant' as const, text: `Publish needs attention: ${detail}`, runId, createdAt: finishedAt };
      const run = { ...baseRun, state: 'failed' as const, activity: 'Publish needs attention', finishedAt, errorKind: 'permission' as const };

      (store.db.messages[s.id] ||= []).push(assistant);
      (store.db.runs[s.id] ||= []).push(run as any);
      store.save();

      if (durableStorageConfigured()) {
        const repository = controlPlaneRepository();
        await repository.putMessage(assistant);
        await repository.putTask({
          id: taskId,
          sessionId: s.id,
          workspaceId: workspace?.id || 'workspace',
          plane: 'workspace',
          runId,
          messageId: msg.id,
          state: 'failed',
          prompt: String(text),
          modelId: selectedModel || undefined,
          adapterId: selectedAdapterId,
          mode: effectiveMode,
          permission: prefs.permission,
          createdAt: now,
          updatedAt: finishedAt,
        });
      }

      emit(s.id, 'activity.progress', { taskId, text: 'Publish failed', error: detail, sourceType: 'git.publish', state: 'failed' }, runId);
      emit(s.id, 'message.end', { taskId, instant: true }, runId);
      emit(s.id, 'run.failed', { taskId, error: detail, errorKind: 'permission', recoverable: true }, runId);
      return res.status(409).json({ message: msg, run, plane: 'workspace', instant: true, error: detail });
    }
  }

  if (instantReply) {
    const now = new Date().toISOString();
    const runId = `run_${uuid().slice(0, 8)}`;
    const taskId = `task_${uuid()}`;
    const assistant = { id: `msg_${runId}`, sessionId: s.id, role: 'assistant' as const, text: instantReply, runId, createdAt: now };
    const run = {
      id: runId, sessionId: s.id, engine: selectedAdapterId, plane: 'direct' as const,
      model: selectedModel || undefined, mode: effectiveMode, permission: prefs.permission,
      state: 'completed' as const, activity: 'Ready', startedAt: now, finishedAt: now,
    };
    (store.db.messages[s.id] ||= []).push(assistant);
    (store.db.runs[s.id] ||= []).push(run as any);
    store.save();

    if (durableStorageConfigured()) {
      const repository = controlPlaneRepository();
      await repository.putMessage(assistant);
      await repository.putTask({
        id: taskId,
        sessionId: s.id,
        workspaceId: 'direct',
        plane: 'direct',
        runId,
        messageId: msg.id,
        state: 'completed',
        prompt: String(text),
        modelId: selectedModel || undefined,
        adapterId: selectedAdapterId,
        mode: effectiveMode,
        permission: prefs.permission,
        createdAt: now,
        updatedAt: now,
      });
    }

    emit(s.id, 'message.end', { taskId, instant: true }, runId);
    emit(s.id, 'run.completed', { taskId, summary: 'Answered locally.', instant: true }, runId);
    console.info(`[orlynx] sid=${s.id} instant reply mode=${effectiveMode} len=${String(text).length}`);
    return res.json({ message: msg, run, plane: 'direct', instant: true });
  }

  if (durableStorageConfigured()) {
    const repository = controlPlaneRepository();

    // Active Build follow-ups were already attached to their running task
    // above. For a new turn, a merely warm workspace must not make ordinary
    // conversation pay cloud/runtime recovery latency.
    let workspace = await repository.getWorkspaceBySession(s.id);
    plane = adapterExecutionPlane(selectedAdapter, selectedModel || '', executionPlaneForSession(String(text), effectiveMode, workspace));

    if (plane === 'workspace') {
      // The compute broker is authoritative for new/recovering Build work, but
      // an already healthy workspace stays sticky. This prevents provider
      // thrashing between Render runners, E2B, and Codespaces on successive
      // turns while still allowing degraded workspaces to migrate.
      let repositoryId = workspace?.repositoryId;
      if (!repositoryId) {
        const githubRepo = (await githubListRepos(requestInstallationId(req))).find((item) => item.full.toLowerCase() === s.project.toLowerCase());
        if (!githubRepo) return res.status(403).json({ error: 'Repository authorization could not be verified.' });
        repositoryId = githubRepo.id;
      }
      const brokerPreferred = await selectWorkspaceProvider({
        taskText: String(text),
        ...(workspace?.provider ? { preferredProvider: workspace.provider } : {}),
      }).catch(() => workspace?.provider || null);
      workspace = await ensureWorkspaceRecord({
        sessionId: s.id,
        userId: durableSession.userId,
        projectId: durableSession.projectId,
        repositoryId,
        branch: s.branch,
      }, {
        ...(brokerPreferred ? { preferredProvider: brokerPreferred } : {}),
        taskText: String(text),
        preserveHealthyExisting: true,
      });

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
      ...(queueAfterActive ? { queueAfterActive: true } : {}),
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
      await scheduleWorkspacePreparation(automaticWorkspaceInput, {
        allowFallback: true,
        reason: 'build_task',
      }).catch((error) => {
        console.warn(`[workspace] automatic preparation scheduling failed session=${s.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
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
      message: current.codespaceName || current.runnerId ? 'Waking the existing development environment…' : 'Starting a development environment only for this task…',
    });
    await scheduleWorkspacePreparation({
      sessionId: s.id,
      userId: durable.userId,
      projectId: durable.projectId,
      repositoryId: githubRepo.id,
      branch: s.branch,
    }, { allowFallback: true, reason: 'manual_start' });

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
    const reconnecting = { ...current, state: 'connecting' as const, bridgeState: 'disconnected' as const, connectionId: undefined, failureCode: undefined, updatedAt: new Date().toISOString() };
    await repository.putWorkspace(reconnecting);
    emit(s.id, 'workspace.reconnecting', { workspaceId: current.id, message: 'Reconnecting to the development environment…' });

    // Reconnect is asynchronous just like first startup. Holding this HTTP
    // request open while GitHub boots/SSHs causes browser timeouts and duplicate
    // retries. The durable workspace row + SSE/session polling report progress.
    await scheduleWorkspacePreparation(
      { sessionId: s.id, userId: durable.userId, projectId: durable.projectId, repositoryId: githubRepo.id, branch: s.branch },
      { allowFallback: true, reason: 'reconnect' },
    );

    return res.status(202).json(reconnecting);
  } catch (error) {
    return res.status(502).json({ error: 'Workspace connection interrupted.', retryable: true, diagnostic: error instanceof Error ? error.message : 'Reconnect failed.' });
  }
});

router.post('/sessions/:id/exec', async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { cmd = 'echo ok', approved = false } = req.body || {};
  if (durableStorageConfigured()) await hydrateSessionPrefs(s.id, s.project);
  const gate = canPerform(s.id, 'terminal.exec', { cmd: String(cmd) });
  if (!gate.allowed) return res.status(403).json({ error: gate.reason });
  if (gate.needsApproval && !approved) {
    const approvalId = `approval_${uuid()}`;
    const command = String(cmd).slice(0, 200);
    const now = new Date().toISOString();
    if (durableStorageConfigured()) {
      await controlPlaneRepository().putApproval({ id: approvalId, sessionId: s.id, action: 'terminal.exec', state: 'pending', context: { cmd: command }, createdAt: now });
    }
    emit(s.id, 'approval.required', { approvalId, action: 'terminal.exec', cmd: command, detail: `Run ${command}` });
    return res.status(409).json({ error: 'Approval required before running this command.', approvalRequired: true, approvalId, cmd: command });
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
router.post('/sessions/:id/approvals/:approvalId/resolve', async (req, res) => {
  const session = ownedSession(req, req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!durableStorageConfigured()) return res.status(503).json({ error: 'Durable approval storage is not configured.' });

  const decision = String(req.body?.decision || '');
  if (!['allow_once', 'deny'].includes(decision)) return res.status(400).json({ error: 'decision must be allow_once or deny' });

  const repository = controlPlaneRepository();
  const approval = await repository.getApproval(req.params.approvalId);
  if (!approval || approval.sessionId !== session.id) return res.status(404).json({ error: 'approval not found' });
  if (approval.state !== 'pending') return res.json({ approval, deduplicated: true });

  const now = new Date().toISOString();
  if (decision === 'deny') {
    const denied = { ...approval, state: 'denied', resolvedAt: now };
    await repository.putApproval(denied);

    if (approval.action === 'git.push.default' && approval.taskId) {
      const task = await repository.getTask(approval.taskId);
      if (task && task.state === 'waiting_approval') {
        const permission = task.tempPermission || task.permission || 'ask-first';
        task.harness ||= createHarnessCheckpoint({
          prompt: task.prompt,
          mode: task.mode || 'build',
          permission,
          plane: task.plane || 'workspace',
          now,
        });
        task.state = 'failed';
        task.harness = {
          ...advanceHarnessPhase(task.harness, 'failed', { mode: task.mode || 'build', permission, now }),
          verification: { ...task.harness.verification, status: 'failed', checkedAt: now },
        };
        task.updatedAt = now;
        await repository.putTask(task);

        const memoryRun = (store.db.runs[session.id] || []).find((item) => item.id === task.runId);
        if (memoryRun) {
          memoryRun.state = 'failed';
          memoryRun.activity = 'Publish approval denied';
          memoryRun.finishedAt = now;
          memoryRun.errorKind = 'permission';
          store.save();
        }
        emit(session.id, 'run.failed', {
          taskId: task.id,
          error: 'Publishing was not approved. The workspace changes remain available.',
          errorKind: 'permission',
          recoverable: true,
        }, task.runId);
        await promoteNextQueuedRun(session.id).catch(() => null);
      }
    }

    emit(session.id, 'approval.resolved', { approvalId: approval.id, action: approval.action, decision: 'deny', detail: 'Permission denied.' });
    await recordAudit(req, session.id, 'approval.resolve', 'denied', { approvalId: approval.id, action: approval.action });
    return res.json({ approval: denied });
  }

  if (approval.action === 'git.push.default') {
    const taskId = String(approval.taskId || approval.context.taskId || '');
    const task = taskId ? await repository.getTask(taskId) : null;
    if (!task) return res.status(409).json({ error: 'The Build task waiting for this approval is no longer available.' });
    if (task.state === 'cancelled' || task.harness?.phase === 'cancelled') {
      const cancelledApproval = { ...approval, state: 'denied', resolvedAt: now };
      await repository.putApproval(cancelledApproval);
      return res.status(409).json({ error: 'This Build task was cancelled, so the pending approval can no longer run.', approval: cancelledApproval });
    }

    const workspaceId = String(approval.context.workspaceId || task.workspaceId || '');
    const workspace = workspaceId ? await repository.getWorkspace(workspaceId) : await getWorkspace(session.id);
    if (!workspace || workspace.state !== 'ready' || workspace.bridgeState !== 'ready') {
      if (workspace) {
        await scheduleWorkspacePreparation({
          sessionId: workspace.sessionId,
          userId: workspace.userId,
          projectId: workspace.projectId,
          repositoryId: workspace.repositoryId,
          branch: workspace.branch,
        }, { allowFallback: true, reason: 'approval_resume' }).catch((error) => {
          console.warn(`[approval] workspace wake scheduling failed session=${session.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
        });
        return res.status(202).json({
          approval,
          recoveringWorkspace: true,
          retryAfterMs: 1500,
          message: 'Waking the development environment before completing this approval.',
        });
      }
      return res.status(503).json({ error: 'The project workspace is not available for this approval.' });
    }

    try {
      const published = await publishVerifiedChangeSet({
        sessionId: session.id,
        workspaceId: workspace.id,
        strategy: 'direct',
        targetBranch: session.branch,
        runId: task.runId,
        commitMessage: 'Orlynx verified changes',
      });

      const approvedRecord = { ...approval, state: 'approved', resolvedAt: now };
      await repository.putApproval(approvedRecord);
      await emitPersisted(session.id, 'approval.resolved', {
        approvalId: approval.id,
        action: approval.action,
        decision: 'allow_once',
        detail: 'Approved once.',
      }, task.runId, { taskId: task.id, workspaceId: workspace.id, timestamp: now });
      await emitPersisted(session.id, 'receipt.created', {
        command: published.pullRequestUrl ? 'github pull request' : 'github publish',
        publish: true,
        pushedBranch: published.branch,
        commitSha: published.head,
        alreadyPublished: published.alreadyPublished,
        pullRequestUrl: published.pullRequestUrl,
        pullRequestNumber: published.pullRequestNumber,
        protectedBranchFallback: published.protectedBranchFallback,
      }, task.runId, { taskId: task.id, workspaceId: workspace.id, timestamp: now });

      const permission = task.tempPermission || task.permission || 'ask-first';
      task.harness ||= createHarnessCheckpoint({
        prompt: task.prompt,
        mode: task.mode || 'build',
        permission,
        plane: task.plane || 'workspace',
        now,
      });
      const events = await repository.listRunEvents(session.id, task.runId || '', 1000);
      task.harness = verifyHarness(task.harness, events, now);

      if (task.harness.verification.status !== 'passed') {
        task.state = 'failed';
        task.harness = {
          ...advanceHarnessPhase(task.harness, 'failed', { mode: task.mode || 'build', permission, now }),
          verification: { ...task.harness.verification, status: 'failed', checkedAt: now },
        };
        task.updatedAt = now;
        await repository.putTask(task);
        emit(session.id, 'run.failed', {
          taskId: task.id,
          error: `Publish completed, but Orlynx still could not verify: ${task.harness.verification.missing.join(', ')}.`,
          errorKind: 'verification',
          recoverable: true,
        }, task.runId);
        await promoteNextQueuedRun(session.id).catch(() => null);
        return res.status(409).json({ approval: approvedRecord, verification: task.harness.verification });
      }

      task.harness = advanceHarnessPhase(task.harness, 'finalizing', { mode: task.mode || 'build', permission, now });
      const publishSummary = published.pullRequestUrl
        ? `Published verified commit \`${published.head.slice(0, 7)}\` on \`${published.branch}\` and opened PR #${published.pullRequestNumber}.`
        : `Published verified commit \`${published.head.slice(0, 7)}\` to \`${published.branch}\`.`;
      const finalText = [task.partialText || '', publishSummary].filter(Boolean).join('\n\n');
      if (finalText) await repository.putMessage({
        id: `msg_${task.runId || uuid()}`,
        sessionId: session.id,
        role: 'assistant',
        text: finalText,
        runId: task.runId,
        createdAt: now,
      });

      task.state = 'completed';
      task.partialText = undefined;
      task.harness = advanceHarnessPhase(task.harness, 'completed', { mode: task.mode || 'build', permission, now });
      task.updatedAt = now;
      await repository.putTask(task);

      const memoryRun = (store.db.runs[session.id] || []).find((item) => item.id === task.runId);
      if (memoryRun) {
        memoryRun.state = 'completed';
        memoryRun.activity = 'Ready for review';
        memoryRun.finishedAt = now;
        store.save();
      }

      emit(session.id, 'message.end', { taskId: task.id }, task.runId);
      emit(session.id, 'run.completed', { taskId: task.id, summary: 'Verified work published.' }, task.runId);
      await recordAudit(req, session.id, 'approval.resolve', 'approved_once', {
        approvalId: approval.id,
        action: approval.action,
        branch: published.branch,
        commitSha: published.head,
        pullRequestNumber: published.pullRequestNumber,
        protectedBranchFallback: published.protectedBranchFallback,
      });
      await promoteNextQueuedRun(session.id).catch(() => null);
      return res.json({ approval: approvedRecord, published, verification: task.harness.verification });
    } catch (error) {
      return res.status(502).json({ error: error instanceof Error ? error.message : 'The approved publish could not be completed.' });
    }
  }

  if (approval.action !== 'terminal.exec') {
    return res.status(409).json({ error: 'This approval type cannot be executed from chat yet.' });
  }

  const workspace = await getWorkspace(session.id);
  if (!workspace || workspace.state !== 'ready' || workspace.bridgeState !== 'ready') {
    if (workspace) {
      await scheduleWorkspacePreparation({
        sessionId: workspace.sessionId,
        userId: workspace.userId,
        projectId: workspace.projectId,
        repositoryId: workspace.repositoryId,
        branch: workspace.branch,
      }, { allowFallback: true, reason: 'approval_resume' }).catch((error) => {
        console.warn(`[approval] terminal workspace wake scheduling failed session=${session.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
      });
      return res.status(202).json({
        approval,
        recoveringWorkspace: true,
        retryAfterMs: 1500,
        message: 'Waking the development environment before running the approved command.',
      });
    }
    return res.status(503).json({ error: 'The project workspace is not available for this approval.' });
  }

  const command = String(approval.context.cmd || '');
  if (!command.trim()) return res.status(409).json({ error: 'The pending command is missing.' });
  const parts = command.trim().split(/\s+/);
  try {
    const result = await bridgeRequest(workspace.id, 'command.exec', { command: parts.shift(), args: parts });
    const approvedRecord = { ...approval, state: 'approved', resolvedAt: now };
    await repository.putApproval(approvedRecord);
    emit(session.id, 'approval.resolved', { approvalId: approval.id, action: approval.action, decision: 'allow_once', detail: 'Approved once.' });
    emit(session.id, 'receipt.created', { approvalId: approval.id, cmd: command, ...result });
    await recordAudit(req, session.id, 'approval.resolve', 'approved_once', { approvalId: approval.id, action: approval.action });
    return res.json({ approval: approvedRecord, result });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : 'The approved command could not be completed.' });
  }
});

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
    if (task.state === 'running' || task.state === 'queued' || task.state === 'waiting_approval' || task.state === 'waiting_input') {
      task.state = 'cancelled';
      task.updatedAt = new Date().toISOString();
      if (task.harness) {
        task.harness = advanceHarnessPhase(task.harness, 'cancelled', {
          mode: task.mode || 'build',
          permission: task.tempPermission || task.permission || 'full',
          now: task.updatedAt,
        });
      }
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

// Durable task queue — the UI edits/cancels the same records the scheduler
// consumes, so queue controls cannot drift from execution truth.
router.get('/sessions/:id/tasks', async (req, res) => {
  const session = ownedSession(req, req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!durableStorageConfigured()) return res.json([]);
  const tasks = await controlPlaneRepository().listTasks(session.id);
  const queued = tasks
    .filter((task) => task.state === 'queued')
    .sort((a, b) => {
      const planeOrder = (a.plane === 'direct' ? 0 : 1) - (b.plane === 'direct' ? 0 : 1);
      if (planeOrder) return planeOrder;
      const created = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      return created || a.id.localeCompare(b.id);
    });
  const positions = new Map(queued.map((task, index) => [task.id, index + 1]));
  res.json(tasks
    .filter((task) => ['queued', 'running', 'waiting_input', 'waiting_approval'].includes(task.state))
    .map((task) => ({
      id: task.id,
      runId: task.runId,
      messageId: task.messageId,
      state: task.state,
      prompt: task.prompt,
      plane: task.plane || 'workspace',
      mode: task.mode || 'build',
      modelId: task.modelId,
      position: task.state === 'queued' ? positions.get(task.id) : undefined,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    })));
});

router.patch('/sessions/:id/tasks/:taskId', async (req, res) => {
  const session = ownedSession(req, req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!durableStorageConfigured()) return res.status(503).json({ error: 'Durable task storage is not configured.' });

  const repository = controlPlaneRepository();
  const task = await repository.getTask(req.params.taskId);
  if (!task || task.sessionId !== session.id) return res.status(404).json({ error: 'task not found' });
  if (task.state !== 'queued') return res.status(409).json({ error: 'Only queued tasks can be edited.' });

  const prompt = String(req.body?.text || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Task text cannot be empty.' });
  if (prompt.length > 24_000) return res.status(413).json({ error: 'Task text is too long.' });

  const now = new Date().toISOString();
  const permission = task.tempPermission || task.permission || 'full';
  let harness = createHarnessCheckpoint({
    prompt,
    mode: task.mode || 'build',
    permission,
    plane: task.plane || 'workspace',
    now,
  });
  if (task.harness?.phase === 'routing') {
    harness = advanceHarnessPhase(harness, 'routing', { mode: task.mode || 'build', permission, now });
  }
  task.prompt = prompt;
  task.harness = harness;
  task.updatedAt = now;
  await repository.putTask(task);

  if (task.messageId) {
    const original = (await repository.listMessages(session.id)).find((message) => message.id === task.messageId);
    if (original?.role === 'user') {
      const updatedMessage = { ...original, text: prompt, runId: task.runId || original.runId };
      await repository.putMessage(updatedMessage);
      const memoryMessage = (store.db.messages[session.id] || []).find((message) => message.id === original.id);
      if (memoryMessage) Object.assign(memoryMessage, updatedMessage);
      store.save();
    }
  }

  emit(session.id, 'state.delta', {
    scope: 'task-queue',
    taskId: task.id,
    state: 'queued',
    action: 'edited',
    prompt,
  }, task.runId);
  return res.json({ id: task.id, runId: task.runId, state: task.state, prompt: task.prompt, plane: task.plane || 'workspace', mode: task.mode || 'build', updatedAt: task.updatedAt });
});

router.delete('/sessions/:id/tasks/:taskId', async (req, res) => {
  const session = ownedSession(req, req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!durableStorageConfigured()) return res.status(503).json({ error: 'Durable task storage is not configured.' });

  const repository = controlPlaneRepository();
  const task = await repository.getTask(req.params.taskId);
  if (!task || task.sessionId !== session.id) return res.status(404).json({ error: 'task not found' });
  if (task.state !== 'queued') return res.status(409).json({ error: 'Only queued tasks can be cancelled here. Use Stop for active work.' });

  const now = new Date().toISOString();
  task.state = 'cancelled';
  task.updatedAt = now;
  if (task.harness) {
    task.harness = advanceHarnessPhase(task.harness, 'cancelled', {
      mode: task.mode || 'build',
      permission: task.tempPermission || task.permission || 'full',
      now,
    });
  }
  await repository.putTask(task);

  const memoryRun = (store.db.runs[session.id] || []).find((item) => item.id === task.runId);
  if (memoryRun) {
    memoryRun.state = 'cancelled';
    memoryRun.finishedAt = now;
    memoryRun.activity = 'Cancelled in queue';
    store.save();
  }

  emit(session.id, 'run.failed', { taskId: task.id, cancelled: true, queued: true }, task.runId);
  emit(session.id, 'state.delta', { scope: 'task-queue', taskId: task.id, state: 'cancelled', action: 'cancelled' }, task.runId);
  await promoteNextQueuedRun(session.id).catch(() => null);
  return res.json({ id: task.id, runId: task.runId, state: task.state, updatedAt: task.updatedAt });
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

      messageId: task.messageId,
      mode: task.mode,
      permission: task.permission,
      harness: task.harness ? {
        phase: task.harness.phase,
        step: task.harness.step,
        stepBudget: task.harness.stepBudget,
        steeringRevision: task.harness.steeringRevision,
        verification: {
          status: task.harness.verification.status,
          missing: task.harness.verification.missing,
        },
      } : undefined,
      partialText: task.partialText,
      partialUpdatedAt: task.partialText ? (task.harness?.partialUpdatedAt || task.updatedAt) : undefined,
      updatedAt: task.updatedAt,
      activity: task.state === 'running'
        ? (task.plane === 'direct' ? 'Streaming response' : 'Working')
        : task.state === 'queued'
          ? (task.plane === 'direct' ? 'Waiting to respond' : 'Waiting for development environment')
          : task.state === 'waiting_input' ? 'Waiting for you' : task.state === 'waiting_approval' ? 'Waiting for approval' : task.state === 'completed' ? 'Ready' : task.state,
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
  try {
    const result = await bridgeRequest<{ ports?: Array<{ port: number; visibility?: string; url?: string }> }>(workspace.id, 'ports.list');
    const provider = providerForWorkspace(workspace);
    const blockedPreviewPorts = new Set([22, 23, 25, 2222, 3306, 5432, 5601, 6379, 6380, 9229, 9333, 27017, 27018]);
    const resolved = await Promise.all((result.ports || []).map(async (item) => ({
      ...item,
      url: item.url || await provider.previewUrl?.(workspace, Number(item.port)),
    })));
    const ports = resolved.filter((item) => {
      const port = Number(item.port);
      return item.url && Number.isInteger(port) && port > 1024 && port < 65536 && !blockedPreviewPorts.has(port);
    });
    res.json({ ports });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Preview ports are unavailable.' }); }
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
      const result = await bridgeRequest<{ sha: string }>(workspace.id, 'git.commit', {
        message: String(req.body?.message || 'Orlynx update'),
        files: c.files.map((file) => file.path),
      });
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
        const result = await bridgeRequest<{ branch?: string }>(workspace.id, 'git.push', {
          approved: true,
          allowDefaultBranch: originalBranch === 'main' || originalBranch === 'master',
        });
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
router.post('/ai/runtime/prewarm', async (_req, res) => {
  // Authenticated hint only. Do not block navigation or chat on a cold
  // downstream free-model runtime; wake it in the background so the next turn
  // is more likely to stream immediately.
  void warmOpenCodeRuntime().catch(() => false);
  return res.status(202).json({ warming: true });
});

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
    if (sessionId && durableStorageConfigured()) {
      const workspaceModels = await workspaceModelCatalog(sessionId);
      snapshot.models = [...snapshot.models.filter(model => !workspaceModels.some(item => item.id === model.id)), ...workspaceModels];
    }
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
        supportedModels: persisted?.supportedModels,
        runtimeVersion: persisted?.runtimeVersion,
        consecutiveFailures: persisted?.consecutiveFailures || 0,
        circuitOpenUntil: persisted?.circuitOpenUntil,
        capabilities: adapter.capabilities,
      };
    });
    adapters.push({ id: 'auto', displayName: 'Auto', state: 'available', reason: 'Orlynx selects a healthy compatible adapter', capabilities: getAgentAdapter('opencode').capabilities, supportedModels: undefined, runtimeVersion: undefined, consecutiveFailures: 0, circuitOpenUntil: undefined });
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
    const { engine, models: baseModels } = await listProviderConnections(session?.project, await requestUserId(req) || undefined, sessionId || undefined);
    const workspaceModels = session && durableStorageConfigured() ? await workspaceModelCatalog(session.id) : [];
    const models = [...baseModels.filter(model => !workspaceModels.some(item => item.id === model.id)), ...workspaceModels];
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
    ? (await controlPlaneRepository().listTasks(s.id)).some((r) => ['running', 'waiting_input', 'waiting_approval'].includes(r.state))
    : (store.db.runs[s.id] || []).some((r) => r.state === 'running');
  res.json({ prefs, activeRun, appliesTo: activeRun ? 'next-turn' : 'next-task' });
});
router.put('/ai/session/:id', async (req, res) => {
  const s = ownedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  try {
    if (durableStorageConfigured()) await hydrateSessionPrefs(s.id, s.project);
    let switchedTask: import('@orlynx/shared').TaskRecord | undefined;
    if (req.body?.adapterId !== undefined) {
      const preference = String(req.body.adapterId);
      const currentPrefs = getSessionPrefs(s.id, s.project);
      const selected = getAgentAdapter(preference === 'auto' && durableStorageConfigured() ? await resolvePreferredAdapter(preference, s.id, currentPrefs.modelId || '', currentPrefs.mode, currentPrefs.permission) : preference === 'auto' ? 'opencode' : preference);
      if (durableStorageConfigured()) {
        const active = (await controlPlaneRepository().listTasks(s.id)).find(task => ['running','queued','waiting_input'].includes(task.state));
        if (active && (active.adapterId || 'opencode') !== selected.id) {
          switchedTask = await switchTaskAdapter(active.id, selected.id, 'manual-switch', req.body?.modelId ? String(req.body.modelId) : currentPrefs.modelId);
          void promoteNextQueuedRun(s.id).catch(() => {});
        }
      }
    }
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
    // Agent changes reconcile and continue the same task; other preferences apply to the next turn.
    res.json({ prefs, appliesTo: switchedTask ? 'same-task' : activeRun ? 'next-turn' : 'next-task', taskId: switchedTask?.id });
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
      actions: platform.permissions.actions === 'write',
      leastPrivilege: Object.entries(platform.permissions).every(([permission, level]) =>
        ['contents', 'metadata', 'pull_requests', 'codespaces', 'codespaces_lifecycle_admin', 'actions'].includes(permission)
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
  const infrastructure = durableStorageConfigured() && workspaceInfrastructureConfigured() && Boolean(process.env.ORLYNX_BRIDGE_SIGNING_SECRET);
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
    build: {
      commit: String(process.env.RENDER_GIT_COMMIT || '') || null,
      serviceId: String(process.env.RENDER_SERVICE_ID || '') || null,
    },
    compute: diagnosticsCompute(),
  });
});

function diagnosticsCompute(): {
  broker: Array<{ id: string; successes: number; failures: number; consecutiveFailures: number; quarantined: boolean; lastFailure?: string }>;
  runners: Array<{ hostId: string; ok: boolean | null; available: number; latencyMs: number; buildCommit: string | null; stale: boolean; detail?: string }>;
  expectedRunnerCommit: string | null;
} {
  return {
    broker: computeBrokerSnapshot().map((row) => ({
      id: row.id, successes: row.successes, failures: row.failures,
      consecutiveFailures: row.consecutiveFailures, quarantined: row.quarantined,
      ...(row.lastFailure ? { lastFailure: row.lastFailure } : {}),
    })),
    runners: runnerPoolCachedHealth().map((row) => ({
      hostId: row.hostId,
      ok: row.health ? row.health.ok : null,
      available: row.health?.available ?? 0,
      latencyMs: row.health?.latencyMs ?? 0,
      buildCommit: row.health?.buildCommit ?? null,
      stale: Boolean(row.health?.stale),
      ...(row.health?.detail ? { detail: row.health.detail } : {}),
    })),
    expectedRunnerCommit: expectedRunnerCommit(),
  };
}
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
