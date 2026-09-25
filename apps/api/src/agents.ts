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

export type Engine = 'opencode';
const activeOpenCodeSessions = new Map<string, { project: string; sessionId: string; cancelled: boolean; task?: TaskRecord }>();
const timeoutMs = Math.max(60_000, Number(process.env.OPENCODE_RUN_TIMEOUT_MS || 30 * 60_000));

export interface TaskOptions {
  modelId?: string;
  mode?: AgentMode;
  tempPermission?: PermissionProfile;
  messageId?: string;
}

const staleTaskGraceMs = 15_000;
const maxQueuedTasks = Math.max(1, Number(process.env.ORLYNX_MAX_QUEUED_TASKS || 8));

async function reconcileDurableTasks(sessionId: string): Promise<TaskRecord[]> {
  const repository = controlPlaneRepository();
  const tasks = await repository.listTasks(sessionId);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  let changed = false;

  for (const task of tasks) {
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

export async function promoteNextQueuedRun(sessionId: string): Promise<AgentRun | null> {
  if (!durableStorageConfigured()) return null;
  const repository = controlPlaneRepository();
  const session = await repository.getSession(sessionId);
  if (!session) return null;

  await reconcileDurableTasks(sessionId);

  while (true) {
    const task = await repository.claimNextQueuedTask(sessionId);
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
      const { permission, tempPermission } = taskPermission(prefs.permission, task.tempPermission);
      const modelId = task.modelId || prefs.modelId;
      let model: { providerID: string; modelID: string } | undefined;
      let provider: string | undefined;
      if (modelId) {
        const [providerID, ...rest] = modelId.split('/');
        if (!providerID || !rest.length) throw new Error('Unknown model. Choose a model from the available list.');
        provider = providerID;
        model = { providerID, modelID: rest.join('/') };
      }

      const workspace = await repository.getWorkspace(task.workspaceId);
      if (!workspace || workspace.state !== 'ready') throw new Error('A ready cloud workspace is required.');
      const connection = await openCodeReadiness(session.project, sessionId);
      if (!connection.connected) throw new Error(connection.message || 'OpenCode is unavailable for this workspace.');
      const resolvedAgent = await resolveAgentForMode(mode, openCodeRuntime.defaultAgent(), session.project, sessionId);

      const startedAt = new Date().toISOString();
      if (!run) {
        const runId = task.runId || `run_${uuid().slice(0, 8)}`;
        run = { id: runId, sessionId, engine: 'opencode', provider, model: modelId, mode, permission, tempPermission, state: 'running', activity: 'Starting work', startedAt };
        task.runId = runId;
        (store.db.runs[sessionId] ||= []).push(run);
        await repository.putTask(task);
      } else {
        run.provider = provider;
        run.model = modelId;
        run.mode = mode;
        run.permission = permission;
        run.tempPermission = tempPermission;
        run.state = 'running';
        run.activity = 'Starting work';
        run.startedAt = startedAt;
        run.finishedAt = undefined;
        run.errorKind = undefined;
      }
      store.save();

      emit(sessionId, 'run.started', { taskId: task.id, engine: 'opencode', provider, model: modelId, mode, permission }, run.id);
      emit(sessionId, 'activity.started', { taskId: task.id, text: 'Starting work' }, run.id);
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
        run = { id: task.runId, sessionId, engine: 'opencode', state: 'failed', activity: 'Work needs attention', startedAt: task.createdAt, finishedAt: now, errorKind };
        (store.db.runs[sessionId] ||= []).push(run);
      } else if (run) {
        run.state = 'failed';
        run.activity = 'Work needs attention';
        run.finishedAt = now;
        run.errorKind = errorKind;
      }
      store.save();
      emit(sessionId, 'run.failed', { taskId: task.id, error: detail, errorKind, recoverable: errorKind === 'engine' || errorKind === 'rate_limit' }, task.runId);
    }
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
  const connection = await openCodeReadiness(project, sessionId);
  if (!connection.connected) throw new Error(connection.message || 'OpenCode is unavailable. Configure a healthy OpenCode server before sending work.');
  const resolvedAgent = await resolveAgentForMode(mode, openCodeRuntime.defaultAgent(), project, sessionId);
  if (durableStorageConfigured()) {
    const repository = controlPlaneRepository();
    const workspace = await repository.getWorkspaceBySession(sessionId);
    if (!workspace || workspace.state !== 'ready') throw new Error('A ready cloud workspace is required.');
    const durableTasks = await reconcileDurableTasks(sessionId);
    const queuedAhead = durableTasks.filter((item) => item.state === 'queued').length;
    if (queuedAhead >= maxQueuedTasks) {
      const error = new Error(`Orlynx already has ${queuedAhead} queued tasks for this conversation. Wait for one to start or cancel a queued task.`);
      (error as { errorKind?: string }).errorKind = 'queue_full';
      throw error;
    }
    const admittedAt = new Date().toISOString();
    const run: AgentRun = { id: `run_${uuid().slice(0, 8)}`, sessionId, engine, provider, model: modelId, mode, permission, tempPermission, state: 'queued', activity: 'Queued', startedAt: admittedAt };
    const task: TaskRecord = { id: `task_${uuid()}`, sessionId, workspaceId: workspace.id, runId: run.id, messageId: options.messageId, state: 'queued', prompt: userText, modelId, mode, tempPermission: options.tempPermission, createdAt: admittedAt, updatedAt: admittedAt };
    (store.db.runs[sessionId] ||= []).push(run);
    store.save();
    await repository.putTask(task);
    emit(sessionId, 'run.queued', { taskId: task.id, position: queuedAhead + 1, engine, provider, model: modelId, mode, permission }, run.id);
    const promoted = await promoteNextQueuedRun(sessionId).catch(() => null);
    return promoted?.id === run.id ? promoted : run;
  }
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
