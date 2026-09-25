// Real OpenCode adapter. There is intentionally no built-in/demo agent fallback.
import { v4 as uuid } from 'uuid';
import type { AgentMode, AgentRun, ChangedFile, PermissionProfile, TaskRecord } from '@orlynx/shared';
import { store } from './store.js';
import { emit } from './events.js';
import { createChangeSet } from './changes.js';
import { openCodeRuntime, type RuntimeMessage } from './agent-runtime.js';
import { canPerform, classifyError, getSessionPrefs, hydrateSessionPrefs, planInstruction, readOnlyInstruction, resolveAgentForMode } from './ai.js';
import { materializeAttachments } from './attachments.js';
import { controlPlaneRepository, durableStorageConfigured } from './storage.js';
import { bridgeRequest, queueBridgeCommand } from './bridge-rpc.js';
import { openCodeReadiness } from './opencode.js';
import { ProviderRequestError } from './opencode-local.js';
import { cancelDirectRun, executionPlaneFor, hasDirectRun, streamDirectRepositoryChat, type ExecutionPlane } from './direct-chat.js';

export type Engine = 'opencode';
const executingDirectTasks = new Set<string>();
const activeOpenCodeSessions = new Map<string, { project: string; sessionId: string; cancelled: boolean; task?: TaskRecord }>();
const timeoutMs = Math.max(60_000, Number(process.env.OPENCODE_RUN_TIMEOUT_MS || 30 * 60_000));

export interface TaskOptions {
  modelId?: string;
  mode?: AgentMode;
  tempPermission?: PermissionProfile;
  messageId?: string;
  plane?: ExecutionPlane;
  workspaceId?: string;
}

const staleTaskGraceMs = 15_000;
const queuedTaskTimeoutMs = Math.max(60_000, Number(process.env.ORLYNX_QUEUED_TASK_TIMEOUT_MS || 15 * 60_000));
const maxQueuedTasks = Math.max(1, Number(process.env.ORLYNX_MAX_QUEUED_TASKS || 8));

export function chooseNextQueuedTask(tasks: TaskRecord[]): TaskRecord | undefined {
  const queued = tasks.filter((item) => item.state === 'queued');
  return queued.find((item) => (item.plane || 'workspace') === 'direct') || queued[0];
}

export function workspaceCanAcceptTask(workspace: { state?: string; bridgeState?: string } | null | undefined): boolean {
  return Boolean(workspace && workspace.state === 'ready' && workspace.bridgeState === 'ready');
}

export function delayedWorkspaceTaskExpired(task: TaskRecord, now = Date.now()): boolean {
  if ((task.plane || 'workspace') !== 'workspace') return false;
  const created = Date.parse(task.createdAt);
  if (!Number.isFinite(created)) return false;
  if (task.state === 'queued') return created + queuedTaskTimeoutMs <= now;
  if (task.state !== 'running') return false;
  const updated = Date.parse(task.updatedAt);
  return Number.isFinite(updated) && updated - created >= queuedTaskTimeoutMs;
}

async function reconcileDurableTasks(sessionId: string): Promise<TaskRecord[]> {
  const repository = controlPlaneRepository();
  const tasks = await repository.listTasks(sessionId);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  let changed = false;

  for (const task of tasks) {
    if (delayedWorkspaceTaskExpired(task, now)) {
      const wasRunning = task.state === 'running';
      task.state = 'cancelled';
      task.updatedAt = nowIso;
      await repository.putTask(task);
      changed = true;

      const run = (store.db.runs[sessionId] || []).find((candidate) => candidate.id === task.runId);
      if (run && (run.state === 'running' || run.state === 'queued')) {
        run.state = 'cancelled';
        run.finishedAt = nowIso;
        run.errorKind = 'engine';
      }

      if (wasRunning && task.workspaceId && task.workspaceId !== 'direct') {
        void queueBridgeCommand(task.workspaceId, 'agent.cancel', { taskId: task.id }, 15_000).catch(() => {});
      }

      emit(sessionId, 'run.failed', {
        taskId: task.id,
        error: 'This delayed Build task expired before the development environment was ready. Send it again if you still want it to run.',
        errorKind: 'engine',
        recoverable: true,
        cancelled: true,
      }, task.runId);
      continue;
    }

    if (task.state !== 'running') continue;
    const touched = Date.parse(task.updatedAt || task.createdAt);
    if (!Number.isFinite(touched) || touched + timeoutMs + staleTaskGraceMs > now) continue;

    task.state = 'failed';
    task.updatedAt = nowIso;
    await repository.putTask(task);
    changed = true;

    const run = (store.db.runs[sessionId] || []).find((candidate) => candidate.id === task.runId);
    if (run && (run.state === 'running' || run.state === 'queued')) {
      run.state = 'failed';
      run.finishedAt = nowIso;
      run.errorKind = 'engine';
    }

    emit(sessionId, 'run.failed', {
      taskId: task.id,
      error: 'The previous AI task stopped responding and was released so you can continue.',
      errorKind: 'engine',
      recoverable: true,
    }, task.runId);
  }

  if (changed) store.save();
  return changed ? repository.listTasks(sessionId) : tasks;
}

export function taskPermission(current: PermissionProfile, requested?: PermissionProfile): { permission: PermissionProfile; tempPermission?: PermissionProfile } {
  const tempPermission = current === 'ask-first' && requested === 'full' ? 'full' : undefined;
  return { permission: tempPermission || current, ...(tempPermission ? { tempPermission } : {}) };
}

async function executeDirectTask(
  session: Awaited<ReturnType<ReturnType<typeof controlPlaneRepository>['getSession']>>,
  task: TaskRecord,
  run: AgentRun,
  modelId: string,
): Promise<void> {
  if (!session) return;
  executingDirectTasks.add(task.id);
  const repository = controlPlaneRepository();
  let visible = task.partialText || '';
  let pendingDelta = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flushDelta = () => {
    if (!pendingDelta) return;
    const delta = pendingDelta;
    pendingDelta = '';
    emit(session.id, 'message.delta', { delta }, run.id);
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flushDelta();
    }, 80);
    flushTimer.unref?.();
  };
  const heartbeat = setInterval(() => {
    if (task.state !== 'running' || run.state !== 'running') return;
    // Flush before snapshotting so reload recovery can use updatedAt as a
    // cutoff without replaying text already present in partialText.
    flushDelta();
    task.partialText = visible;
    task.updatedAt = new Date().toISOString();
    void repository.putTask(task).catch(() => {});
  }, 1000);
  heartbeat.unref?.();

  try {
    const responseText = await streamDirectRepositoryChat({
      runId: run.id,
      messageId: task.messageId,
      prompt: task.prompt,
      acceptedAt: task.createdAt,
      session,
      modelId,
      onStatus: (text) => emit(session.id, 'activity.progress', { taskId: task.id, text, sourceType: 'direct.chat' }, run.id),
      onDelta: (delta) => {
        if (run.state !== 'running') return;
        visible += delta;
        task.partialText = visible;
        pendingDelta += delta;
        if (pendingDelta.length >= 240) flushDelta();
        else scheduleFlush();
      },
    });
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    flushDelta();
    if (task.state === 'cancelled' || run.state === 'cancelled') return;

    const now = new Date().toISOString();
    task.state = 'completed';
    task.partialText = responseText;
    task.updatedAt = now;
    await repository.putTask(task);
    await repository.putMessage({ id: `msg_${run.id}`, sessionId: session.id, role: 'assistant', text: responseText, createdAt: now });

    run.state = 'completed';
    run.activity = 'Ready';
    run.finishedAt = now;
    store.save();
    emit(session.id, 'message.end', { taskId: task.id }, run.id);
    emit(session.id, 'run.completed', { taskId: task.id, summary: 'Response completed.' }, run.id);
    emit(session.id, 'activity.completed', { taskId: task.id, text: 'Response completed' }, run.id);
  } catch (error) {
    if (task.state === 'cancelled' || run.state === 'cancelled') return;
    const now = new Date().toISOString();
    const detail = error instanceof Error ? error.message : 'Direct chat failed.';
    const errorKind = error instanceof ProviderRequestError
      ? error.statusCode === 429 ? 'rate_limit' : error.statusCode === 401 && !error.publicAccess ? 'auth' : 'engine'
      : classifyError(detail);
    console.warn(`[direct-chat] failed session=${session.id} run=${run.id} model=${modelId} kind=${errorKind} detail=${detail.slice(0,900)}`);
    task.state = 'failed';
    task.updatedAt = now;
    await repository.putTask(task);
    run.state = 'failed';
    run.activity = 'Needs attention';
    run.finishedAt = now;
    run.errorKind = errorKind;
    store.save();
    emit(session.id, 'run.failed', {
      taskId: task.id,
      error: errorKind === 'rate_limit'
        ? 'The selected model is temporarily rate limited. Try again shortly.'
        : errorKind === 'quota'
          ? 'The OpenCode account has reached its available quota or credits.'
          : errorKind === 'auth'
            ? 'Reconnect your OpenCode account and try again.'
            : errorKind === 'model'
              ? 'That model is not available right now. Choose another model.'
              : detail,
      errorKind,
      retryable: errorKind === 'rate_limit' || errorKind === 'engine',
    }, run.id);
  } finally {
    if (flushTimer) clearTimeout(flushTimer);
    flushDelta();
    clearInterval(heartbeat);
    executingDirectTasks.delete(task.id);
    await promoteNextQueuedRun(session.id).catch(() => null);
  }
}

const promotions = new Map<string, Promise<AgentRun | null>>();
export function promoteNextQueuedRun(sessionId: string): Promise<AgentRun | null> {
  const existing = promotions.get(sessionId);
  if (existing) return existing;
  const pending = promoteNextQueuedRunInner(sessionId).finally(() => promotions.delete(sessionId));
  promotions.set(sessionId, pending);
  return pending;
}

async function promoteNextQueuedRunInner(sessionId: string): Promise<AgentRun | null> {
  if (!durableStorageConfigured()) return null;
  const repository = controlPlaneRepository();
  const session = await repository.getSession(sessionId);
  if (!session) return null;

  const tasks = await reconcileDurableTasks(sessionId);
  const queued = tasks.filter((item) => item.state === 'queued');
  if (!queued.length) return null;

  // Tasks admitted before the direct-chat plane existed were stored as
  // workspace work by default. Reclassify every safe conversational prompt so
  // one blocked workspace task cannot strand later chat behind it.
  for (const task of queued) {
    if ((task.plane || 'workspace') === 'workspace' && executionPlaneFor(task.prompt, task.mode || 'build') === 'direct') {
      task.plane = 'direct';
      task.workspaceId = 'direct';
      task.updatedAt = new Date().toISOString();
      await repository.putTask(task);
    }
  }

  // Conversational work does not depend on the development environment. Let it
  // bypass a queued Build task while GitHub Codespaces is still starting.
  const nextQueued = chooseNextQueuedTask(queued)!;

  if ((nextQueued.plane || 'workspace') === 'workspace') {
    const readyWorkspace = await repository.getWorkspace(nextQueued.workspaceId);
    if (!readyWorkspace) return null;
    if (readyWorkspace.state === 'failed') {
      const now = new Date().toISOString();
      nextQueued.state = 'failed';
      nextQueued.updatedAt = now;
      await repository.putTask(nextQueued);
      const failedRun = (store.db.runs[sessionId] || []).find((candidate) => candidate.id === nextQueued.runId);
      if (failedRun) {
        failedRun.state = 'failed';
        failedRun.activity = 'Development environment unavailable';
        failedRun.finishedAt = now;
        failedRun.errorKind = 'engine';
      }
      store.save();
      emit(sessionId, 'run.failed', {
        taskId: nextQueued.id,
        error: readyWorkspace.failureCode || 'The development environment could not start. Your message is saved and can be retried.',
        errorKind: 'engine',
        recoverable: true,
      }, nextQueued.runId);
      return promoteNextQueuedRunInner(sessionId);
    }
    if (readyWorkspace.state !== 'ready' || readyWorkspace.bridgeState !== 'ready') return null;
  }

  const task = await repository.claimQueuedTask(sessionId, nextQueued.id);
  if (!task) return null;

  let run = (store.db.runs[sessionId] || []).find((candidate) => candidate.id === task.runId);
  try {
    await hydrateSessionPrefs(sessionId, session.project);
    const gate = canPerform(sessionId, 'agent.task');
    if (!gate.allowed) {
      const error = new Error(gate.reason || 'This task is blocked by the project access level.');
      (error as { errorKind?: string }).errorKind = 'permission';
      throw error;
    }

    const prefs = getSessionPrefs(sessionId, session.project);
    const mode = task.mode || prefs.mode;
    const { permission, tempPermission } = taskPermission(task.permission || prefs.permission, task.tempPermission);
    const modelId = task.modelId || prefs.modelId;
    if (!modelId) {
      const error = new Error('Choose a model before sending a message.');
      (error as { errorKind?: string }).errorKind = 'model';
      throw error;
    }

    const [providerID, ...rest] = modelId.split('/');
    if (!providerID || !rest.length) throw new Error('Unknown model. Choose a model from the available list.');
    const provider = providerID;
    const model = { providerID, modelID: rest.join('/') };
    const startedAt = new Date().toISOString();

    if (!run) {
      const runId = task.runId || `run_${uuid().slice(0,8)}`;
      run = {
        id: runId,
        sessionId,
        engine: 'opencode',
        plane: task.plane || 'workspace',
        provider,
        model: modelId,
        mode,
        permission,
        tempPermission,
        state: 'running',
        activity: task.plane === 'direct' ? 'Starting response' : 'Starting work',
        startedAt,
      };
      task.runId = runId;
      (store.db.runs[sessionId] ||= []).push(run);
      await repository.putTask(task);
    } else {
      run.plane = task.plane || 'workspace';
      run.provider = provider;
      run.model = modelId;
      run.mode = mode;
      run.permission = permission;
      run.tempPermission = tempPermission;
      run.state = 'running';
      run.activity = task.plane === 'direct' ? 'Starting response' : 'Starting work';
      run.startedAt = startedAt;
      run.finishedAt = undefined;
      run.errorKind = undefined;
    }
    store.save();

    emit(sessionId, 'run.started', { taskId: task.id, plane: task.plane || 'workspace', engine: 'opencode', provider, model: modelId, mode, permission }, run.id);
    emit(sessionId, 'message.start', { taskId: task.id, plane: task.plane || 'workspace', model: modelId }, run.id);

    if (task.plane === 'direct') {
      emit(sessionId, 'activity.started', { taskId: task.id, text: 'Thinking…' }, run.id);
      void executeDirectTask(session, task, run, modelId);
      return run;
    }

    const workspace = await repository.getWorkspace(task.workspaceId);
    if (!workspace || workspace.state !== 'ready' || workspace.bridgeState !== 'ready') {
      task.state = 'queued';
      task.updatedAt = new Date().toISOString();
      await repository.putTask(task);
      run.state = 'queued';
      run.activity = 'Waiting for development environment';
      store.save();
      return run;
    }

    const connection = await openCodeReadiness(session.project, sessionId);
    if (!connection.connected) throw new Error(connection.message || 'OpenCode is unavailable for this workspace.');
    const resolvedAgent = await resolveAgentForMode(mode, openCodeRuntime.defaultAgent(), session.project, sessionId);
    emit(sessionId, 'activity.started', { taskId: task.id, text: 'Development environment ready' }, run.id);
    if (resolvedAgent.note) emit(sessionId, 'activity.progress', { taskId: task.id, text: resolvedAgent.note }, run.id);

    const guardedText = [
      permission !== 'full' ? readOnlyInstruction() : '',
      mode === 'plan' ? planInstruction() : '',
      mode === 'ask' ? readOnlyInstruction() : '',
      task.prompt,
    ].filter(Boolean).join('\n\n');
    const engineSessionId = await repository.getEngineSession(sessionId);
    await queueBridgeCommand(workspace.id, 'agent.run', { taskId: task.id, runId: run.id, sessionId, engineSessionId, text: guardedText, model, agent: resolvedAgent.agent }, timeoutMs);
    return run;
  } catch (error) {
    const now = new Date().toISOString();
    const detail = error instanceof Error ? error.message : 'Orlynx AI could not start this queued task.';
    const errorKind = (error as { errorKind?: AgentRun['errorKind'] }).errorKind || classifyError(detail);
    task.state = 'failed';
    task.updatedAt = now;
    await repository.putTask(task);
    if (!run && task.runId) {
      run = { id: task.runId, sessionId, engine: 'opencode', plane: task.plane || 'workspace', state: 'failed', activity: 'Needs attention', startedAt: task.createdAt, finishedAt: now, errorKind };
      (store.db.runs[sessionId] ||= []).push(run);
    } else if (run) {
      run.state = 'failed';
      run.activity = 'Needs attention';
      run.finishedAt = now;
      run.errorKind = errorKind;
    }
    store.save();
    emit(sessionId, 'run.failed', { taskId: task.id, error: detail, errorKind, recoverable: errorKind === 'engine' || errorKind === 'rate_limit' }, task.runId);
    return promoteNextQueuedRunInner(sessionId);
  }
}

export async function recoverInterruptedDirectRuns(sessionId: string): Promise<void> {
  if (!durableStorageConfigured() || promotions.has(sessionId)) return;
  const repository = controlPlaneRepository();
  const tasks = await repository.listTasks(sessionId);
  let recovered = false;
  for (const task of tasks) {
    if (task.plane !== 'direct' || task.state !== 'running' || !task.runId || hasDirectRun(task.runId) || executingDirectTasks.has(task.id)) continue;
    // Another instance or an in-flight startup may own a fresh heartbeat.
    if (Date.now() - Date.parse(task.updatedAt) < 30_000) continue;
    // After process death an upstream request cannot be resumed safely. Keep
    // partial text and terminate once rather than silently billing/running twice.
    task.state = 'failed';
    task.updatedAt = new Date().toISOString();
    await repository.putTask(task);
    const run = (store.db.runs[sessionId] || []).find((item) => item.id === task.runId);
    if (run) { run.state = 'failed'; run.activity = 'Response interrupted'; run.finishedAt = task.updatedAt; }
    emit(sessionId, 'run.failed', { taskId: task.id, error: 'The server restarted before this response finished. Your partial response is preserved. Send a new message to continue.', errorKind: 'engine', recoverable: true }, task.runId);
    recovered = true;
  }
  if (recovered) {
    store.save();
    await promoteNextQueuedRun(sessionId).catch(() => null);
  }
}

export async function startRun(sessionId: string, project: string, userText: string, engine: Engine = 'opencode', options: TaskOptions = {}): Promise<AgentRun> {
  if (engine !== 'opencode') throw new Error('Only the configured OpenCode server adapter is supported.');
  if (!durableStorageConfigured() && (store.db.runs[sessionId] || []).some((candidate) => candidate.state === 'running')) throw new Error('An OpenCode task is already running in this project.');
  if (durableStorageConfigured()) await hydrateSessionPrefs(sessionId, project);
  const gate = canPerform(sessionId, 'agent.task');
  if (!gate.allowed) {
    const error = new Error(gate.reason || 'This task is blocked by the project access level.');
    (error as { errorKind?: string }).errorKind = 'permission';
    throw error;
  }
  const prefs = getSessionPrefs(sessionId, project);
  const mode = options.mode || prefs.mode;
  const { permission, tempPermission } = taskPermission(prefs.permission, options.tempPermission);
  const modelId = options.modelId || prefs.modelId;
  let model: { providerID: string; modelID: string } | undefined;
  let provider: string | undefined;
  if (modelId) {
    const [providerID, ...rest] = modelId.split('/');
    if (!providerID || !rest.length) throw new Error('Unknown model. Choose a model from the available list.');
    provider = providerID;
    model = { providerID, modelID: rest.join('/') };
  }
  if (durableStorageConfigured()) {
    const repository = controlPlaneRepository();
    const plane = options.plane || 'workspace';
    if (plane === 'workspace' && !options.workspaceId) throw new Error('The development environment could not be initialized.');
    const durableTasks = await reconcileDurableTasks(sessionId);
    const queuedAhead = durableTasks.filter((item) => item.state === 'queued').length;
    if (queuedAhead >= maxQueuedTasks) {
      const error = new Error(`Orlynx already has ${queuedAhead} queued tasks for this conversation. Wait for one to start or cancel a queued task.`);
      (error as { errorKind?: string }).errorKind = 'queue_full';
      throw error;
    }
    const admittedAt = new Date().toISOString();
    const run: AgentRun = {
      id: `run_${uuid().slice(0,8)}`,
      sessionId,
      engine,
      plane,
      provider,
      model: modelId,
      mode,
      permission,
      tempPermission,
      state: 'queued',
      activity: plane === 'direct' ? 'Queued for response' : 'Queued for development environment',
      startedAt: admittedAt,
    };
    const task: TaskRecord = {
      id: `task_${uuid()}`,
      sessionId,
      workspaceId: plane === 'direct' ? 'direct' : options.workspaceId!,
      plane,
      runId: run.id,
      messageId: options.messageId,
      state: 'queued',
      prompt: userText,
      modelId,
      mode,
      permission: prefs.permission,
      tempPermission: options.tempPermission,
      createdAt: admittedAt,
      updatedAt: admittedAt,
    };
    (store.db.runs[sessionId] ||= []).push(run);
    store.save();
    await repository.putTask(task);
    emit(sessionId, 'run.queued', { taskId: task.id, position: queuedAhead + 1, plane, engine, provider, model: modelId, mode, permission }, run.id);

    // Workspace tasks must remain queued while the development environment is
    // being created/repaired. The route starts preparation immediately after
    // admission and promotes the queue once the bridge is actually ready.
    if (plane === 'workspace') {
      const workspace = await repository.getWorkspace(options.workspaceId!);
      if (!workspaceCanAcceptTask(workspace)) return run;
    }

    const promoted = await promoteNextQueuedRun(sessionId).catch(() => null);
    return promoted?.id === run.id ? promoted : run;
  }
  const connection = await openCodeReadiness(project, sessionId);
  if (!connection.connected) throw new Error(connection.message || 'OpenCode is unavailable. Configure a healthy OpenCode server before sending work.');
  const resolvedAgent = await resolveAgentForMode(mode, openCodeRuntime.defaultAgent(), project, sessionId);
  const openCodeSession = await openCodeRuntime.getOrCreateSession(sessionId, project);
  const before = await openCodeRuntime.messages(project, openCodeSession.id);
  const previousAssistantId = [...before].reverse().find((message) => message.info?.role === 'assistant')?.info?.id;
  const run: AgentRun = {
    id: `run_${uuid().slice(0, 8)}`, sessionId, engine, provider, model: modelId,
    mode, permission, tempPermission,
    state: 'running', activity: 'Starting work', startedAt: new Date().toISOString(),
  };
  (store.db.runs[sessionId] ||= []).push(run);
  store.save();
  emit(sessionId, 'run.started', { engine, provider, model: modelId, mode, permission }, run.id);
  emit(sessionId, 'activity.started', { text: 'Starting work' }, run.id);
  if (resolvedAgent.note) emit(sessionId, 'activity.progress', { text: resolvedAgent.note }, run.id);
  emit(sessionId, 'message.start', { engine }, run.id);
  // Backend-enforced mode guardrails travel with the task itself.
  const availableAttachments = durableStorageConfigured() ? [] : materializeAttachments(sessionId, project);
  const attachmentInstruction = availableAttachments.length
    ? `[Orlynx attachments: ${availableAttachments.map((item) => `${item.name} at ${item.path}`).join('; ')}. Read these project-local files when they are relevant to the request. Do not move or commit the .orlynx directory.]`
    : '';
  const guardedText = [
    permission !== 'full' ? readOnlyInstruction() : '',
    mode === 'plan' ? planInstruction() : '',
    mode === 'ask' ? readOnlyInstruction() : '',
    attachmentInstruction,
    userText,
  ].filter(Boolean).join('\n\n');
  try {
    await openCodeRuntime.prompt(project, openCodeSession.id, guardedText, { model, agent: resolvedAgent.agent });
  } catch (error) {
    run.state = 'failed'; run.finishedAt = new Date().toISOString();
    run.errorKind = classifyError(error instanceof Error ? error.message : '');
    store.save();
    emit(sessionId, 'run.failed', { error: error instanceof Error ? error.message : 'OpenCode rejected the task.', errorKind: run.errorKind }, run.id);
    throw error;
  }
  activeOpenCodeSessions.set(run.id, { project, sessionId: openCodeSession.id, cancelled: false });
  void monitorRun(sessionId, project, openCodeSession.id, run, previousAssistantId);
  return run;
}

async function monitorRun(sessionId: string, project: string, openCodeSessionId: string, run: AgentRun, previousAssistantId?: string): Promise<void> {
  const active = activeOpenCodeSessions.get(run.id);
  if (!active) return;
  const deadline = Date.now() + timeoutMs;
  let assistant: RuntimeMessage | undefined;
  let visibleText = '';
  const toolStates = new Map<string, string>();
  try {
    while (Date.now() < deadline && !active.cancelled) {
      const messages = await openCodeRuntime.messages(project, openCodeSessionId);
      assistant = [...messages].reverse().find((message) => message.info?.role === 'assistant' && message.info?.id !== previousAssistantId);
      if (assistant) {
        const text = assistant.parts.filter((part) => part.type === 'text').map((part) => String(part.text || '')).join('');
        if (text.startsWith(visibleText) && text.length > visibleText.length) {
          emit(sessionId, 'message.delta', { delta: text.slice(visibleText.length) }, run.id);
          visibleText = text;
        } else if (text && !visibleText) {
          emit(sessionId, 'message.delta', { delta: text }, run.id);
          visibleText = text;
        }
        collectToolEvents(sessionId, run.id, assistant, toolStates);
        const failed = Boolean(assistant.info?.error);
        const complete = Boolean(assistant.info?.time?.completed) || (assistant.info?.finish && assistant.info.finish !== 'tool-calls');
        if (failed) throw new Error('OpenCode reported that the task failed.');
        if (complete) break;
      }
      const status = await openCodeRuntime.sessionStatus(project, openCodeSessionId);
      if (assistant && status.type === 'idle') break;
      await delay(800);
    }
    if (active.cancelled) return;
    if (Date.now() >= deadline) throw new Error(`OpenCode task timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    if (!assistant) throw new Error('OpenCode finished without returning an assistant response.');
    const responseText = assistant.parts.filter((part) => part.type === 'text').map((part) => String(part.text || '')).join('');
    (store.db.messages[sessionId] ||= []).push({ id: `msg_${run.id}`, sessionId, role: 'assistant', text: responseText, createdAt: new Date().toISOString() });
    if (durableStorageConfigured()) await controlPlaneRepository().putMessage(store.db.messages[sessionId][store.db.messages[sessionId].length - 1]);
    emit(sessionId, 'message.end', {}, run.id);
    await captureDiff(sessionId, project, run.id, openCodeSessionId);
    run.state = 'completed';
    run.finishedAt = new Date().toISOString();
    run.activity = 'Ready for review';
    if (active.task) { active.task.state = 'completed'; active.task.updatedAt = run.finishedAt; await controlPlaneRepository().putTask(active.task); }
    store.save();
    emit(sessionId, 'run.completed', { summary: 'Work completed. Review the result.' }, run.id);
    emit(sessionId, 'activity.completed', { text: 'Work completed' }, run.id);
  } catch (error) {
    if (active.cancelled) return;
    run.state = 'failed';
    run.finishedAt = new Date().toISOString();
    run.activity = 'Work needs attention';
    run.errorKind = classifyError(error instanceof Error ? error.message : '');
    if (active.task) { active.task.state = 'failed'; active.task.updatedAt = run.finishedAt; await controlPlaneRepository().putTask(active.task); }
    store.save();
    for (const [toolId, state] of toolStates) if (state === 'running') emit(sessionId, 'tool.failed', { toolCallId: toolId, error: 'OpenCode did not complete this action.' }, run.id);
    emit(sessionId, 'run.failed', { error: error instanceof Error ? error.message : 'OpenCode task failed.', errorKind: run.errorKind }, run.id);
  } finally {
    activeOpenCodeSessions.delete(run.id);
  }
}

function collectToolEvents(sessionId: string, runId: string, message: RuntimeMessage, toolStates: Map<string, string>) {
  for (const part of message.parts) {
    if (part.type !== 'tool') continue;
    const toolId = String(part.callID || part.id || `${message.info.id}:${part.tool}`);
    const state = String(part.state?.status || 'running');
    const prior = toolStates.get(toolId);
    if (!prior) emit(sessionId, 'tool.started', { tool: String(part.tool || 'OpenCode action'), toolCallId: toolId }, runId);
    if (state === 'completed' && prior !== 'completed') {
      emit(sessionId, 'tool.completed', { tool: String(part.tool || 'OpenCode action'), toolCallId: toolId, out: String(part.state?.output || '') }, runId);
    } else if (state === 'error' && prior !== 'error') {
      emit(sessionId, 'tool.failed', { tool: String(part.tool || 'OpenCode action'), toolCallId: toolId, error: String(part.state?.error || 'Action failed.'), out: String(part.state?.output || '') }, runId);
    } else if (state === 'running' && prior !== 'running') {
      emit(sessionId, 'tool.output', { tool: String(part.tool || 'OpenCode action'), toolCallId: toolId }, runId);
    }
    toolStates.set(toolId, state);
  }
}

async function captureDiff(sessionId: string, project: string, runId: string, openCodeSessionId: string) {
  const raw = await openCodeRuntime.diff(project, openCodeSessionId);
  const files: ChangedFile[] = raw.flatMap((item) => {
    const file = String(item.file || item.path || '');
    if (!file || file.startsWith('/') || file.split('/').includes('..')) return [];
    const action = item.status === 'added' ? 'create' : item.status === 'deleted' ? 'delete' : 'modify';
    return [{ path: file, action, before: typeof item.before === 'string' ? item.before : undefined, after: typeof item.after === 'string' ? item.after : undefined, diff: typeof item.diff === 'string' ? item.diff : undefined }];
  });
  if (files.length) {
    let baseSha: string | undefined;
    if (durableStorageConfigured()) { const workspace = await controlPlaneRepository().getWorkspaceBySession(sessionId); if (workspace) baseSha = (await bridgeRequest<{ head?: string }>(workspace.id, 'git.status')).head; }
    createChangeSet(sessionId, project, files, runId, baseSha);
  }
}

export async function cancelRun(sessionId: string, runId: string) {
  const run = (store.db.runs[sessionId] || []).find((item) => item.id === runId);
  if (!run || run.state !== 'running') return run;
  if (run.plane === 'direct') cancelDirectRun(runId);
  const active = activeOpenCodeSessions.get(runId);
  if (active) {
    active.cancelled = true;
    try { await openCodeRuntime.abort(active.project, active.sessionId); } catch { /* cancellation still terminates Orlynx state */ }
  }
  run.state = 'cancelled'; run.finishedAt = new Date().toISOString(); run.activity = 'Stopped';
  if (active?.task) { active.task.state = 'cancelled'; active.task.updatedAt = run.finishedAt; await controlPlaneRepository().putTask(active.task); }
  store.save();
  emit(sessionId, 'run.failed', { cancelled: true }, runId);
  return run;
}

export function currentRuns(sessionId: string): AgentRun[] { return store.db.runs[sessionId] || []; }

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
