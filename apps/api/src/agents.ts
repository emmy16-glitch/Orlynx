// Real OpenCode adapter. There is intentionally no built-in/demo agent fallback.
import { v4 as uuid } from 'uuid';
import type { AgentAdapterId, AgentMode, AgentRun, ChangedFile, PermissionProfile, TaskRecord, WorkspaceRecord } from '@orlynx/shared';
import { store } from './store.js';
import { emit } from './events.js';
import { createChangeSet } from './changes.js';
import { getAgentAdapter, openCodeRuntime, type AgentAdapter, type RuntimeMessage } from './agent-runtime.js';
import { buildAskFirstInstruction, canPerform, classifyError, getSessionPrefs, hydrateSessionPrefs, planInstruction, readOnlyInstruction, resolveAgentForMode } from './ai.js';
import { materializeAttachments } from './attachments.js';
import { controlPlaneRepository, durableStorageConfigured } from './storage.js';
import { bridgeRequest, queueBridgeCommand } from './bridge-rpc.js';
import { ProviderRequestError } from './opencode-local.js';
import type { ExecutionPlane } from './direct-chat.js';
import { markWorkspaceConnectionLost, migrateRunnerWorkspaceToCodespacesForCapability, workspaceNeedsCodespaceReplacement, workspaceShouldAdoptPreferredRunner } from './workspaces.js';
import { runnerHostSupportsBrowserE2e, taskRequiresBrowserE2e } from './runner-pool.js';
import { scopeToolCallId } from './agent-protocol.js';
import { scheduleWorkspacePreparation } from './workspace-jobs.js';
import { agentMemoryInstruction, relevantAgentLessons } from './agent-memory.js';
import { advanceHarnessPhase, createHarnessCheckpoint, harnessSystemInstruction, openCodeToolsFor, verifyHarness } from './harness.js';
import { GitHubActionsUnavailableError, githubActionsVerificationEligible, runGitHubActionsVerification, selectDispatchableVerificationWorkflow } from './github-actions.js';

export type Engine = AgentAdapterId;
const executingDirectTasks = new Set<string>();
const executingActionsVerifications = new Set<string>();
const activeAgentSessions = new Map<string, { adapterId: AgentAdapterId; project: string; sessionId: string; cancelled: boolean; task?: TaskRecord }>();
const timeoutMs = Math.max(60_000, Number(process.env.OPENCODE_RUN_TIMEOUT_MS || 30 * 60_000));

export interface TaskOptions {
  modelId?: string;
  mode?: AgentMode;
  tempPermission?: PermissionProfile;
  messageId?: string;
  plane?: ExecutionPlane;
  workspaceId?: string;
  queueAfterActive?: boolean;
}

const staleTaskGraceMs = 15_000;
// Workspace preparation can legitimately take longer than a single provider
// startup window (cold Render runners, Codespaces provisioning, deploys, etc.).
// Queued Build work is durable and must not be cancelled just because recovery
// crosses the old 15-minute wall clock. Keep a long retention guard for truly
// abandoned queued work; running work is governed by heartbeat/staleness below.
const queuedTaskRetentionMs = Math.max(
  60 * 60_000,
  Number(process.env.ORLYNX_QUEUED_TASK_RETENTION_MS || 24 * 60 * 60_000),
);
const maxQueuedTasks = Math.max(1, Number(process.env.ORLYNX_MAX_QUEUED_TASKS || 8));

export function chooseNextQueuedTask(tasks: TaskRecord[]): TaskRecord | undefined {
  const queued = tasks.filter((item) => item.state === 'queued');
  const hasActive = tasks.some((item) => ['running', 'waiting_input', 'waiting_approval'].includes(item.state));
  if (hasActive) return undefined;
  return queued.find((item) => (item.plane || 'workspace') === 'direct') || queued[0];
}

export function workspaceCanAcceptTask(workspace: { state?: string; bridgeState?: string } | null | undefined): boolean {
  return Boolean(workspace && workspace.state === 'ready' && workspace.bridgeState === 'ready');
}

export function delayedWorkspaceTaskExpired(task: TaskRecord, now = Date.now()): boolean {
  if ((task.plane || 'workspace') !== 'workspace' || task.state !== 'queued') return false;
  const created = Date.parse(task.createdAt);
  if (!Number.isFinite(created)) return false;
  return created + queuedTaskRetentionMs <= now;
}


async function executeGitHubActionsVerificationTask(
  sessionId: string,
  taskId: string,
  workspace: WorkspaceRecord,
  runId: string,
): Promise<void> {
  if (executingActionsVerifications.has(taskId)) return;
  executingActionsVerifications.add(taskId);
  const repository = controlPlaneRepository();
  try {
    const task = await repository.getTask(taskId);
    if (!task || task.state === 'cancelled' || task.state === 'completed' || task.state === 'failed') return;

    let run = (store.db.runs[sessionId] || []).find((candidate) => candidate.id === runId);
    if (!run) {
      run = {
        id: runId,
        sessionId,
        engine: 'github-actions',
        plane: 'workspace',
        provider: 'github-actions',
        model: task.modelId,
        mode: task.mode || 'build',
        permission: task.tempPermission || task.permission || 'full',
        state: 'running',
        activity: 'Running GitHub Actions verification',
        startedAt: new Date().toISOString(),
      };
      (store.db.runs[sessionId] ||= []).push(run);
      store.save();
    }

    const result = await runGitHubActionsVerification(task, workspace);
    const now = new Date().toISOString();
    const requirements = task.harness?.verification.required || [];
    task.harness ||= createHarnessCheckpoint({
      prompt: task.prompt,
      mode: task.mode || 'build',
      permission: task.tempPermission || task.permission || 'full',
      plane: 'workspace',
      now,
    });
    task.harness = advanceHarnessPhase(task.harness, 'verifying', {
      mode: task.mode || 'build',
      permission: task.tempPermission || task.permission || 'full',
      now,
    });

    for (const requirement of requirements) {
      if (requirement === 'tests') {
        emit(sessionId, 'test.result', {
          taskId: task.id,
          backend: 'github-actions',
          workflow: task.verificationWorkflow,
          runId: task.verificationRunId,
          runUrl: task.verificationUrl,
          exitCode: result.success ? 0 : 1,
          summary: result.summary,
          jobs: result.jobs,
          artifacts: result.artifacts,
        }, runId);
      } else if (requirement === 'build') {
        emit(sessionId, 'build.result', {
          taskId: task.id,
          backend: 'github-actions',
          workflow: task.verificationWorkflow,
          runId: task.verificationRunId,
          runUrl: task.verificationUrl,
          exitCode: result.success ? 0 : 1,
          summary: result.summary,
          jobs: result.jobs,
          artifacts: result.artifacts,
        }, runId);
      }
    }

    if (result.success) {
      task.harness = {
        ...task.harness,
        verification: {
          ...task.harness.verification,
          satisfied: [...task.harness.verification.required],
          missing: [],
          status: 'passed',
          checkedAt: now,
        },
      };
      task.harness = advanceHarnessPhase(task.harness, 'completed', {
        mode: task.mode || 'build',
        permission: task.tempPermission || task.permission || 'full',
        now,
      });
      task.state = 'completed';
      task.partialText = result.summary;
      task.updatedAt = now;
      await repository.putTask(task);

      const responseText = [
        result.summary,
        task.verificationUrl ? `GitHub Actions run: ${task.verificationUrl}` : '',
      ].filter(Boolean).join('\n');
      await repository.putMessage({
        id: `msg_${runId}`,
        sessionId,
        role: 'assistant',
        text: responseText,
        runId,
        createdAt: now,
      });

      run.state = 'completed';
      run.activity = 'Verified by GitHub Actions';
      run.finishedAt = now;
      run.errorKind = undefined;
      store.save();
      emit(sessionId, 'message.delta', { delta: responseText }, runId);
      emit(sessionId, 'message.end', { taskId: task.id }, runId);
      emit(sessionId, 'run.completed', {
        taskId: task.id,
        summary: result.summary,
        verificationBackend: 'github-actions',
        runUrl: task.verificationUrl,
      }, runId);
      emit(sessionId, 'activity.completed', {
        taskId: task.id,
        text: 'GitHub Actions verification completed',
        runUrl: task.verificationUrl,
      }, runId);
      return;
    }

    task.state = 'failed';
    task.harness = {
      ...advanceHarnessPhase(task.harness, 'failed', {
        mode: task.mode || 'build',
        permission: task.tempPermission || task.permission || 'full',
        now,
      }),
      verification: {
        ...task.harness.verification,
        status: 'failed',
        checkedAt: now,
      },
    };
    task.updatedAt = now;
    await repository.putTask(task);
    run.state = 'failed';
    run.activity = 'GitHub Actions verification failed';
    run.finishedAt = now;
    run.errorKind = 'verification';
    store.save();
    emit(sessionId, 'run.failed', {
      taskId: task.id,
      error: result.summary,
      errorKind: 'verification',
      recoverable: true,
      verificationBackend: 'github-actions',
      runUrl: task.verificationUrl,
      jobs: result.jobs,
      artifacts: result.artifacts,
    }, runId);
  } catch (error) {
    const task = await repository.getTask(taskId);
    if (!task || task.state === 'cancelled') return;
    const now = new Date().toISOString();
    const run = (store.db.runs[sessionId] || []).find((candidate) => candidate.id === runId);
    const unavailable = error instanceof GitHubActionsUnavailableError;
    task.state = 'queued';
    task.updatedAt = now;
    await repository.putTask(task);
    if (run) {
      run.state = 'queued';
      run.activity = unavailable ? 'GitHub Actions unavailable · waiting for workspace' : 'Resuming GitHub Actions verification';
      run.finishedAt = undefined;
      run.errorKind = undefined;
    }
    store.save();
    emit(sessionId, 'run.state', {
      taskId: task.id,
      state: 'queued',
      verificationBackend: 'github-actions',
      message: unavailable
        ? 'GitHub Actions cannot verify this repository automatically yet. Orlynx will keep the task queued and recover the interactive workspace instead.'
        : 'GitHub Actions verification was interrupted. Orlynx kept the run identity and will resume it automatically.',
    }, runId);

    void scheduleWorkspacePreparation({
      sessionId: workspace.sessionId,
      userId: workspace.userId,
      projectId: workspace.projectId,
      repositoryId: workspace.repositoryId,
      branch: workspace.branch,
    }, { allowFallback: true, reason: unavailable ? 'actions_unavailable' : 'actions_resume' }).catch(() => {});
  } finally {
    executingActionsVerifications.delete(taskId);
    void promoteNextQueuedRun(sessionId).catch(() => null);
  }
}

async function tryStartGitHubActionsVerification(
  sessionId: string,
  queuedTask: TaskRecord,
  workspace: WorkspaceRecord,
): Promise<AgentRun | null> {
  if (!githubActionsVerificationEligible(queuedTask)) return null;
  if (!queuedTask.verificationRunId) {
    try {
      await selectDispatchableVerificationWorkflow(workspace);
    } catch (error) {
      if (error instanceof GitHubActionsUnavailableError) return null;
      console.warn(`[actions] verification preflight failed session=${sessionId} task=${queuedTask.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
      return null;
    }
  }

  const repository = controlPlaneRepository();
  const task = await repository.claimQueuedTask(sessionId, queuedTask.id);
  if (!task) return null;
  const startedAt = new Date().toISOString();
  const runId = task.runId || `run_${uuid().slice(0, 8)}`;
  task.runId = runId;
  task.verificationBackend = 'github-actions';
  task.harness ||= createHarnessCheckpoint({
    prompt: task.prompt,
    mode: task.mode || 'build',
    permission: task.tempPermission || task.permission || 'full',
    plane: 'workspace',
    now: startedAt,
  });
  task.harness = advanceHarnessPhase(task.harness, 'verifying', {
    mode: task.mode || 'build',
    permission: task.tempPermission || task.permission || 'full',
    now: startedAt,
  });
  task.updatedAt = startedAt;
  await repository.putTask(task);

  let run = (store.db.runs[sessionId] || []).find((candidate) => candidate.id === runId);
  if (!run) {
    run = {
      id: runId,
      sessionId,
      engine: 'github-actions',
      plane: 'workspace',
      provider: 'github-actions',
      model: task.modelId,
      mode: task.mode || 'build',
      permission: task.tempPermission || task.permission || 'full',
      state: 'running',
      activity: 'Starting GitHub Actions verification',
      startedAt,
    };
    (store.db.runs[sessionId] ||= []).push(run);
  } else {
    run.engine = 'github-actions';
    run.plane = 'workspace';
    run.provider = 'github-actions';
    run.state = 'running';
    run.activity = 'Starting GitHub Actions verification';
    run.startedAt = startedAt;
    run.finishedAt = undefined;
    run.errorKind = undefined;
  }
  store.save();

  emit(sessionId, 'run.started', {
    taskId: task.id,
    messageId: task.messageId,
    plane: 'workspace',
    engine: 'github-actions',
    provider: 'github-actions',
    mode: task.mode || 'build',
    permission: task.tempPermission || task.permission || 'full',
    verificationOnly: true,
  }, runId);
  emit(sessionId, 'message.start', { taskId: task.id, plane: 'workspace' }, runId);
  emit(sessionId, 'activity.started', {
    taskId: task.id,
    sourceType: 'verification.github-actions',
    text: task.verificationRunId
      ? 'Resuming GitHub Actions verification…'
      : 'Starting independent GitHub Actions verification…',
  }, runId);

  void executeGitHubActionsVerificationTask(sessionId, task.id, workspace, runId);
  return run;
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
        try {
          const adapter = getAgentAdapter(task.adapterId || 'opencode');
          void queueBridgeCommand(task.workspaceId, adapter.bridgeCancelCommand, { adapterId: adapter.id, taskId: task.id }, 15_000).catch(() => {});
        } catch { /* adapter may have been removed; task expiry still proceeds */ }
      }

      emit(sessionId, 'run.failed', {
        taskId: task.id,
        error: 'This delayed Build task expired before the development environment was ready. Send it again if you still want it to run.',
        errorKind: 'repository',
        recoverable: true,
        cancelled: true,
      }, task.runId);
      continue;
    }

    if (task.state !== 'running') continue;
    if (task.verificationBackend === 'github-actions' && task.verificationRunId) {
      const workspace = await repository.getWorkspace(task.workspaceId);
      if (workspace) {
        task.updatedAt = nowIso;
        await repository.putTask(task);
        const runId = task.runId || `run_${uuid().slice(0, 8)}`;
        task.runId = runId;
        void executeGitHubActionsVerificationTask(sessionId, task.id, workspace, runId);
      }
      continue;
    }
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

export function instructionForModeAccess(mode: AgentMode, permission: PermissionProfile): string {
  if (mode === 'ask') return readOnlyInstruction();
  if (mode === 'plan') return planInstruction();
  if (permission === 'read-only') return readOnlyInstruction();
  if (mode === 'build' && permission === 'ask-first') return buildAskFirstInstruction();
  return '';
}

export function buildPresentationInstruction(mode: AgentMode): string {
  if (mode !== 'build') return '';
  return [
    'During Build execution, do not narrate routine progress in assistant prose.',
    'Use tools directly; Orlynx already renders repository reads, commands, tests, builds, edits, and workspace state as live activity rows.',
    'GitHub authentication is managed by the Orlynx GitHub App. The provider shell intentionally does not receive GitHub tokens.',
    'Never ask the user to run gh auth login, paste a PAT, or expose a GitHub token. Do not use gh auth status as evidence that Orlynx is disconnected from GitHub.',
    'Do not run raw git push from the provider shell. Prepare and commit changes locally, then report that they are ready for Orlynx controlled publish/review unless the Orlynx publish action itself confirms publication.',
    'When a repository already has a package-lock.json and the goal is only to install existing dependencies, prefer npm ci rather than npm install. Do not leave package-lock.json changed unless the task intentionally changes dependencies.',
    'Reserve normal assistant prose for the final result, a necessary user question, or an approval that genuinely requires user input.',
  ].join(' ');
}

async function executeDirectTask(
  session: Awaited<ReturnType<ReturnType<typeof controlPlaneRepository>['getSession']>>,
  task: TaskRecord,
  run: AgentRun,
  modelId: string,
  adapter: AgentAdapter,
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
    if (!adapter.streamDirectChat) throw new Error(`${adapter.displayName} does not support direct chat without a development environment.`);
    const effectivePermission = task.tempPermission || task.permission || run.permission || 'full';
    task.harness ||= createHarnessCheckpoint({
      prompt: task.prompt,
      mode: task.mode || run.mode || 'build',
      permission: effectivePermission,
      plane: 'direct',
    });
    task.harness = advanceHarnessPhase(task.harness, 'context_loading', {
      mode: task.mode || run.mode || 'build',
      permission: effectivePermission,
    });
    await repository.putTask(task);
    task.harness = advanceHarnessPhase(task.harness, 'executing', {
      mode: task.mode || run.mode || 'build',
      permission: effectivePermission,
    });
    await repository.putTask(task);

    const directProvider = adapter.parseModel(modelId).providerID;
    const directLessons = await relevantAgentLessons(session, task.prompt, directProvider).catch(() => []);
    task.harness = {
      ...task.harness,
      lessonsApplied: directLessons.map((lesson) => lesson.id),
    };
    await repository.putTask(task);
    const directHarnessSystem = [
      harnessSystemInstruction(task.harness),
      agentMemoryInstruction(directLessons),
    ].filter(Boolean).join('\n\n');
    if (directLessons.length) {
      emit(session.id, 'activity.progress', {
        taskId: task.id,
        sourceType: 'agent.memory',
        text: `Orlynx memory → Model: using ${directLessons.length} verified lesson${directLessons.length === 1 ? '' : 's'} from earlier successful work.`,
        lessonIds: directLessons.map((lesson) => lesson.id),
      }, run.id);
    }

    const streamDirectTurn = async (prompt: string, messageId?: string) => adapter.streamDirectChat!({
      runId: run.id,
      messageId,
      prompt,
      acceptedAt: task.createdAt,
      session,
      modelId,
      mode: task.mode || run.mode || 'build',
      harnessSystem: directHarnessSystem,
      onStatus: (text) => emit(session.id, 'activity.progress', { taskId: task.id, text, sourceType: 'direct.chat' }, run.id),
      onActivity: (type, payload) => emit(session.id, type, { taskId: task.id, ...payload }, run.id),
      onDelta: (delta) => {
        if (run.state !== 'running') return;
        visible += delta;
        task.partialText = visible;
        pendingDelta += delta;
        if (pendingDelta.length >= 240) flushDelta();
        else scheduleFlush();
      },
    });

    let responseText = await streamDirectTurn(task.prompt, task.messageId);

    // Direct Ask/Plan follows the same continuation contract as workspace
    // Build. Messages received while the provider is answering are stored in
    // the task inbox; before finalizing, feed them back to the connected model
    // in the same Orlynx run instead of creating a parallel chat/run.
    for (let continuationRound = 0; continuationRound < 4; continuationRound += 1) {
      const freshTask = await repository.getTask(task.id);
      if (!freshTask || freshTask.state === 'cancelled') return;
      const pendingSteering = freshTask.harness?.inbox.filter((item) => !item.appliedAt) || [];
      if (!pendingSteering.length) {
        Object.assign(task, freshTask);
        break;
      }

      const appliedAt = new Date().toISOString();
      if (freshTask.harness) {
        freshTask.harness = {
          ...freshTask.harness,
          inbox: freshTask.harness.inbox.map((item) => item.appliedAt ? item : { ...item, appliedAt }),
        };
      }
      freshTask.state = 'running';
      freshTask.updatedAt = appliedAt;
      await repository.putTask(freshTask);
      Object.assign(task, freshTask);

      const updateText = [
        'Continue the same Orlynx conversation. The user sent these updates while you were answering:',
        ...pendingSteering.map((item) => `[${item.action.toUpperCase()}] ${item.text}`),
        visible ? `Your response already streamed so far:\n${visible.slice(-8_000)}` : '',
        'Respond to the newest user intent and correct or extend the existing answer as needed. Do not restart the conversation or repeat completed explanation.',
      ].filter(Boolean).join('\n\n');

      emit(session.id, 'activity.progress', {
        taskId: task.id,
        sourceType: 'agent.dialogue.orlynx',
        reflectionId: task.harness?.steeringRevision || continuationRound + 1,
        text: `Orlynx → Model: the user added context while this response was running. Continue the same conversation and incorporate the update before finalizing.`,
      }, run.id);

      if (visible && !visible.endsWith('\n\n')) {
        visible += '\n\n';
        pendingDelta += '\n\n';
        flushDelta();
      }
      const history = await repository.listMessages(session.id);
      const latestContinuation = [...history].reverse().find((message) => message.role === 'user' && message.runId === run.id);
      await streamDirectTurn(updateText, latestContinuation?.id);
      responseText = visible;
    }
    if (visible) responseText = visible;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    flushDelta();
    if (task.state === 'cancelled' || run.state === 'cancelled') return;

    // Close the race where a follow-up lands just after the last continuation
    // round. Keep the same task/run identity and let the durable promoter resume
    // it again; never finalize while unapplied human input is still in the inbox.
    const latestBeforeFinalize = await repository.getTask(task.id);
    const unappliedBeforeFinalize = latestBeforeFinalize?.harness?.inbox.some((item) => !item.appliedAt) || false;
    if (latestBeforeFinalize && unappliedBeforeFinalize) {
      const queuedAt = new Date().toISOString();
      latestBeforeFinalize.state = 'queued';
      latestBeforeFinalize.updatedAt = queuedAt;
      await repository.putTask(latestBeforeFinalize);
      Object.assign(task, latestBeforeFinalize);
      run.state = 'queued';
      run.activity = 'Continuing with your latest message';
      run.finishedAt = undefined;
      run.errorKind = undefined;
      store.save();
      emit(session.id, 'run.state', {
        taskId: task.id,
        state: 'queued',
        continued: true,
        message: 'A newer follow-up arrived. Continuing the same conversation before finalizing.',
      }, run.id);
      return;
    }

    const now = new Date().toISOString();
    task.harness ||= createHarnessCheckpoint({
      prompt: task.prompt,
      mode: task.mode || run.mode || 'build',
      permission: effectivePermission,
      plane: 'direct',
      now,
    });
    task.harness = advanceHarnessPhase(task.harness, 'verifying', {
      mode: task.mode || run.mode || 'build',
      permission: effectivePermission,
      now,
    });
    task.harness = verifyHarness(task.harness, [], now);

    if (task.harness.verification.status !== 'passed') {
      task.state = 'failed';
      task.partialText = responseText;
      task.harness = {
        ...advanceHarnessPhase(task.harness, 'failed', {
          mode: task.mode || run.mode || 'build',
          permission: effectivePermission,
          now,
        }),
        verification: { ...task.harness.verification, status: 'failed', checkedAt: now },
      };
      task.updatedAt = now;
      await repository.putTask(task);
      run.state = 'failed';
      run.activity = 'Needs development environment';
      run.finishedAt = now;
      run.errorKind = 'verification';
      store.save();
      emit(session.id, 'run.failed', {
        taskId: task.id,
        error: `This request needs workspace evidence Orlynx could not verify in direct chat: ${task.harness.verification.missing.join(', ')}.`,
        errorKind: 'verification',
        recoverable: true,
      }, run.id);
      return;
    }

    task.harness = advanceHarnessPhase(task.harness, 'finalizing', {
      mode: task.mode || run.mode || 'build',
      permission: effectivePermission,
      now,
    });
    task.state = 'completed';
    task.partialText = responseText;
    task.harness = advanceHarnessPhase(task.harness, 'completed', {
      mode: task.mode || run.mode || 'build',
      permission: effectivePermission,
      now,
    });
    task.updatedAt = now;
    await repository.putTask(task);
    await repository.putMessage({ id: `msg_${run.id}`, sessionId: session.id, role: 'assistant', text: responseText, runId: run.id, createdAt: now });

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
    const classifiedDetail = classifyError(detail);
    const errorKind = error instanceof ProviderRequestError
      ? error.statusCode === 429
        ? 'rate_limit'
        : error.statusCode === 401 && !error.publicAccess
          ? 'auth'
          : classifiedDetail !== 'unknown'
            ? classifiedDetail
            : 'engine'
      : classifiedDetail;
    console.warn(`[direct-chat] failed session=${session.id} run=${run.id} model=${modelId} kind=${errorKind} detail=${detail.slice(0,900)}`);
    task.state = 'failed';
    task.updatedAt = now;
    if (task.harness) task.harness = advanceHarnessPhase(task.harness, 'failed', { mode: task.mode || 'build', permission: task.permission || 'full', now });
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
          ? 'The selected OpenCode access path has reached its current usage allowance.'
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
const promotionWakeups = new Set<string>();

export function promoteNextQueuedRun(sessionId: string): Promise<AgentRun | null> {
  const existing = promotions.get(sessionId);
  if (existing) {
    // Do not drop readiness/queue wake-ups that arrive while another promotion
    // pass is still reading durable state. Re-run once the current pass settles.
    promotionWakeups.add(sessionId);
    return existing;
  }

  const pending = (async () => {
    let latest: AgentRun | null = null;
    do {
      promotionWakeups.delete(sessionId);
      const promoted = await promoteNextQueuedRunInner(sessionId);
      if (promoted) latest = promoted;
    } while (promotionWakeups.delete(sessionId));
    return latest;
  })().finally(() => {
    promotions.delete(sessionId);
    // Cover the narrow race where a wake-up lands after the loop condition but
    // before the single-flight entry is removed.
    if (promotionWakeups.delete(sessionId)) void promoteNextQueuedRun(sessionId);
  });

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

  // Conversational work does not depend on the development environment. Let it
  // bypass a queued Build task while GitHub Codespaces is still starting.
  const nextQueued = chooseNextQueuedTask(queued)!;

  if ((nextQueued.plane || 'workspace') === 'workspace') {
    const readyWorkspace = await repository.getWorkspace(nextQueued.workspaceId);
    if (!readyWorkspace) return null;
    if (readyWorkspace.state === 'failed') {
      const permanentWorkspaceFailure = /permission|forbidden|authorization expired|not configured|invalid .*configuration/i.test(readyWorkspace.failureCode || '');
      const recoverableWorkspaceFailure = !permanentWorkspaceFailure && (
        readyWorkspace.provider === 'github-codespaces'
        || readyWorkspace.provider === 'orlynx-runner'
        || workspaceShouldAdoptPreferredRunner(readyWorkspace)
        || workspaceNeedsCodespaceReplacement(readyWorkspace.failureCode)
      );
      if (recoverableWorkspaceFailure) {
        console.warn(`[queue] scheduling failed workspace repair before Build task session=${sessionId} workspace=${readyWorkspace.id} failure=${readyWorkspace.failureCode || 'unknown'}`);
        await scheduleWorkspacePreparation({
          sessionId,
          userId: readyWorkspace.userId,
          projectId: readyWorkspace.projectId,
          repositoryId: readyWorkspace.repositoryId,
          branch: readyWorkspace.branch,
        }, { allowFallback: true, reason: 'queue_repair' });
        return null;
      }

      const now = new Date().toISOString();
      nextQueued.state = 'failed';
      nextQueued.updatedAt = now;
      await repository.putTask(nextQueued);
      const failedRun = (store.db.runs[sessionId] || []).find((candidate) => candidate.id === nextQueued.runId);
      if (failedRun) {
        failedRun.state = 'failed';
        failedRun.activity = 'Development environment unavailable';
        failedRun.finishedAt = now;
        failedRun.errorKind = 'repository';
      }
      store.save();
      emit(sessionId, 'run.failed', {
        taskId: nextQueued.id,
        error: readyWorkspace.failureCode || 'The development environment could not start. Your message is saved and can be retried.',
        errorKind: 'repository',
        recoverable: true,
      }, nextQueued.runId);
      return promoteNextQueuedRunInner(sessionId);
    }
    if (readyWorkspace.state !== 'ready' || readyWorkspace.bridgeState !== 'ready') return null;

    if (readyWorkspace.provider === 'orlynx-runner' && taskRequiresBrowserE2e(nextQueued.prompt)) {
      const browserReady = await runnerHostSupportsBrowserE2e(readyWorkspace.runnerHostId).catch(() => undefined);
      if (browserReady === false) {
        emit(sessionId, 'activity.progress', {
          taskId: nextQueued.id,
          sourceType: 'workspace.capability',
          capability: 'browserE2e',
          text: 'Browser E2E runtime is not available on this runner · switching automatically…',
        }, nextQueued.runId);
        const migrated = await migrateRunnerWorkspaceToCodespacesForCapability(readyWorkspace, 'browserE2e');
        await scheduleWorkspacePreparation({
          sessionId,
          userId: migrated.userId,
          projectId: migrated.projectId,
          repositoryId: migrated.repositoryId,
          branch: migrated.branch,
        }, { allowFallback: true, reason: 'browser_capability' });
        return null;
      }
    }

    const adapterId = nextQueued.adapterId || 'opencode';
    const adapterState = await repository.getWorkspaceAgentAdapter(readyWorkspace.id, adapterId);
    if (!adapterState || ['not_installed', 'installing', 'starting', 'busy', 'unavailable'].includes(adapterState.state)) {
      const state = adapterState?.state || 'missing';
      console.info(`[queue] waiting session=${sessionId} task=${nextQueued.id} adapter=${adapterId} state=${state}`);
      const text = state === 'busy' ? 'OpenCode is finishing the previous operation…'
        : state === 'installing' ? 'Preparing OpenCode in the workspace…'
          : state === 'starting' ? 'Starting OpenCode in the existing workspace…'
            : state === 'unavailable' ? 'OpenCode disconnected · recovering the existing workspace runtime…'
              : 'Checking the workspace AI runtime…';
      emit(sessionId, 'activity.progress', {
        taskId: nextQueued.id,
        sourceType: 'agent.runtime.wait',
        adapterId,
        state,
        text,
      }, nextQueued.runId);
      return null;
    }
    if (adapterState.state === 'failed') {
      const now = new Date().toISOString();

      // A persisted adapter failure is recoverable infrastructure state, not a
      // terminal verdict on a newly submitted Build. This is especially
      // important when an old workspace row survives while another bridge or
      // runner is healthy: immediately failing the new run produces the false
      // "AI runtime unavailable" loop the user sees.
      console.warn(`[queue] stale failed adapter requires workspace repair session=${sessionId} task=${nextQueued.id} workspace=${readyWorkspace.id} adapter=${adapterId} reason=${adapterState.reason || 'unknown'}`);

      nextQueued.state = 'queued';
      nextQueued.updatedAt = now;
      if (nextQueued.harness) {
        nextQueued.harness = advanceHarnessPhase(nextQueued.harness, 'routing', {
          mode: nextQueued.mode || 'build',
          permission: nextQueued.tempPermission || nextQueued.permission || 'full',
          now,
        });
      }
      await repository.putTask(nextQueued);
      await repository.putWorkspaceAgentAdapter({
        workspaceId: readyWorkspace.id,
        adapterId,
        state: 'starting',
        reason: 'Recovering a previously failed workspace adapter before Build.',
        updatedAt: now,
      });

      const recoveringRun = (store.db.runs[sessionId] || []).find((candidate) => candidate.id === nextQueued.runId);
      if (recoveringRun) {
        recoveringRun.state = 'queued';
        recoveringRun.activity = 'Repairing workspace AI runtime';
        recoveringRun.finishedAt = undefined;
        recoveringRun.errorKind = undefined;
      }
      store.save();

      emit(sessionId, 'run.state', {
        taskId: nextQueued.id,
        state: 'queued',
        message: 'The previous workspace AI process failed. Your Build is saved while Orlynx repairs or reassigns this workspace automatically.',
      }, nextQueued.runId);
      emit(sessionId, 'activity.progress', {
        taskId: nextQueued.id,
        sourceType: 'agent.runtime.wait',
        adapterId,
        state: 'recovering',
        text: 'Repairing this workspace AI runtime · Build will continue automatically…',
      }, nextQueued.runId);

      const lost = await markWorkspaceConnectionLost(readyWorkspace.id).catch(() => null);
      const repair = lost || readyWorkspace;
      void scheduleWorkspacePreparation({
        sessionId: repair.sessionId,
        userId: repair.userId,
        projectId: repair.projectId,
        repositoryId: repair.repositoryId,
        branch: repair.branch,
      }, { allowFallback: true, reason: 'adapter_failed_recovery' }).catch((repairError) => {
        console.warn(`[queue] adapter-failed workspace repair failed session=${sessionId}: ${repairError instanceof Error ? repairError.message : 'unknown error'}`);
      });
      return null;
    }

    // Build must never silently execute against a stale checkout. This is
    // deliberately after runtime/adapter readiness but before task claim, so a
    // user sees the repository check as preparation and no model/tool work can
    // begin until branch/freshness truth is known.
    emit(sessionId, 'activity.progress', {
      taskId: nextQueued.id,
      sourceType: 'repository.sync',
      text: `Checking ${session.branch} against GitHub…`,
    }, nextQueued.runId);

    let gitSync: {
      state?: 'current' | 'synced' | 'branch_mismatch' | 'blocked_dirty' | 'blocked_diverged';
      branch?: string;
      targetBranch?: string;
      head?: string;
      previousHead?: string;
      remoteHead?: string;
      ahead?: number;
      behind?: number;
      porcelain?: string;
      updatedBy?: number;
    };
    try {
      gitSync = await bridgeRequest(readyWorkspace.id, 'git.sync', {
        approved: true,
        branch: session.branch,
      }, 120_000);
    } catch (error) {
      const now = new Date().toISOString();
      const detail = error instanceof Error ? error.message : 'Repository freshness check failed.';
      const transportInterrupted = /workspace (?:connection )?interrupted|workspace did not respond|bridge|socket|connection (?:closed|lost|interrupted)|transport|timed out|timeout/i.test(detail);
      const repositoryCredentialMissing = /GitHub credentials are unavailable in this workspace/i.test(detail);

      if (transportInterrupted || repositoryCredentialMissing) {
        const lost = await markWorkspaceConnectionLost(readyWorkspace.id).catch(() => null);
        nextQueued.state = 'queued';
        nextQueued.updatedAt = now;
        if (nextQueued.harness) {
          nextQueued.harness = advanceHarnessPhase(nextQueued.harness, 'routing', {
            mode: nextQueued.mode || 'build',
            permission: nextQueued.tempPermission || nextQueued.permission || 'full',
            now,
          });
        }
        await repository.putTask(nextQueued);

        const recoveringRun = (store.db.runs[sessionId] || []).find((candidate) => candidate.id === nextQueued.runId);
        if (recoveringRun) {
          recoveringRun.state = 'queued';
          recoveringRun.activity = 'Reconnecting workspace';
          recoveringRun.finishedAt = undefined;
          recoveringRun.errorKind = undefined;
        }
        store.save();

        emit(sessionId, 'run.state', {
          taskId: nextQueued.id,
          state: 'queued',
          message: repositoryCredentialMissing
            ? 'Repository check needs refreshed GitHub access. Refreshing the workspace connection and retrying automatically.'
            : 'Repository check paused because the workspace connection dropped. Reconnecting and retrying automatically.',
        }, nextQueued.runId);
        emit(sessionId, 'activity.progress', {
          taskId: nextQueued.id,
          sourceType: 'repository.sync',
          state: 'recovering',
          text: repositoryCredentialMissing
            ? 'Refreshing GitHub access for this workspace…'
            : 'GitHub check paused · reconnecting workspace…',
        }, nextQueued.runId);

        const repair = lost || readyWorkspace;
        void scheduleWorkspacePreparation({
          sessionId: repair.sessionId,
          userId: repair.userId,
          projectId: repair.projectId,
          repositoryId: repair.repositoryId,
          branch: repair.branch,
        }, { allowFallback: true, reason: repositoryCredentialMissing ? 'repository_credentials' : 'repository_preflight_recovery' }).catch((repairError) => {
          console.warn(`[repository] preflight workspace recovery failed session=${sessionId}: ${repairError instanceof Error ? repairError.message : 'unknown error'}`);
        });
        return null;
      }

      nextQueued.state = 'failed';
      nextQueued.updatedAt = now;
      await repository.putTask(nextQueued);
      const failedRun = (store.db.runs[sessionId] || []).find((candidate) => candidate.id === nextQueued.runId);
      if (failedRun) {
        failedRun.state = 'failed';
        failedRun.activity = 'Repository sync unavailable';
        failedRun.finishedAt = now;
        failedRun.errorKind = 'repository';
      }
      store.save();
      console.warn(`[repository] preflight failed session=${sessionId} workspace=${readyWorkspace.id} detail=${detail.replace(/\s+/g, ' ').slice(0, 500)}`);
      emit(sessionId, 'run.failed', {
        taskId: nextQueued.id,
        error: `Orlynx could not verify the workspace against GitHub before Build: ${detail}`,
        errorKind: 'repository',
        recoverable: true,
      }, nextQueued.runId);
      return promoteNextQueuedRunInner(sessionId);
    }

    if (gitSync.state === 'synced') {
      console.info(`[repository] synced session=${sessionId} workspace=${readyWorkspace.id} branch=${session.branch} commits=${gitSync.updatedBy || 0} head=${String(gitSync.head || '').slice(0, 12)}`);
      emit(sessionId, 'activity.progress', {
        taskId: nextQueued.id,
        sourceType: 'repository.sync',
        text: `Workspace updated to latest ${session.branch} · ${gitSync.updatedBy || 0} commit${Number(gitSync.updatedBy || 0) === 1 ? '' : 's'} fast-forwarded.`,
        branch: session.branch,
        head: gitSync.head,
        previousHead: gitSync.previousHead,
      }, nextQueued.runId);
    }

    if (gitSync.state === 'branch_mismatch' || gitSync.state === 'blocked_dirty' || gitSync.state === 'blocked_diverged') {
      const now = new Date().toISOString();
      const dirtyFiles = String(gitSync.porcelain || '').trim().split(/\r?\n/).filter(Boolean).slice(0, 8);
      const detail = gitSync.state === 'branch_mismatch'
        ? `Workspace is on ${gitSync.branch || 'another branch'}, but this conversation targets ${gitSync.targetBranch || session.branch}.`
        : gitSync.state === 'blocked_dirty'
          ? `Workspace is ${gitSync.behind || 0} commit${Number(gitSync.behind || 0) === 1 ? '' : 's'} behind origin/${session.branch} and has uncommitted changes${dirtyFiles.length ? `: ${dirtyFiles.join(', ')}` : ''}.`
          : `Workspace branch has diverged from origin/${session.branch} (ahead ${gitSync.ahead || 0}, behind ${gitSync.behind || 0}).`;

      nextQueued.state = 'failed';
      nextQueued.updatedAt = now;
      await repository.putTask(nextQueued);
      const failedRun = (store.db.runs[sessionId] || []).find((candidate) => candidate.id === nextQueued.runId);
      if (failedRun) {
        failedRun.state = 'failed';
        failedRun.activity = 'Repository needs safe reconciliation';
        failedRun.finishedAt = now;
        failedRun.errorKind = 'input';
      }
      store.save();
      emit(sessionId, 'run.failed', {
        taskId: nextQueued.id,
        error: `${detail} Orlynx stopped before executing stale or conflicting code; local work was not discarded.`,
        errorKind: 'input',
        recoverable: true,
        repositorySync: gitSync,
      }, nextQueued.runId);
      return promoteNextQueuedRunInner(sessionId);
    }
  }

  const task = await repository.claimQueuedTask(sessionId, nextQueued.id);
  if (!task) return null;
  console.info(`[queue] promoted session=${sessionId} task=${task.id} adapter=${task.adapterId || 'opencode'} plane=${task.plane || 'workspace'}`);

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

    const adapterId = task.adapterId || prefs.adapterId || 'opencode';
    const adapter = getAgentAdapter(adapterId);
    const parsedModel = adapter.parseModel(modelId);
    const provider = parsedModel.providerID;
    const startedAt = new Date().toISOString();

    if (!run) {
      const runId = task.runId || `run_${uuid().slice(0,8)}`;
      run = {
        id: runId,
        sessionId,
        engine: adapter.id,
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

    task.harness ||= createHarnessCheckpoint({
      prompt: task.prompt,
      mode,
      permission,
      plane: task.plane || 'workspace',
      now: startedAt,
    });
    task.harness = advanceHarnessPhase(task.harness, 'routing', { mode, permission, now: startedAt });
    await repository.putTask(task);

    emit(sessionId, 'run.started', { taskId: task.id, messageId: task.messageId, plane: task.plane || 'workspace', engine: adapter.id, provider, model: modelId, mode, permission }, run.id);
    emit(sessionId, 'message.start', { taskId: task.id, plane: task.plane || 'workspace', model: modelId }, run.id);

    if (task.plane === 'direct') {
      emit(sessionId, 'activity.started', { taskId: task.id, text: 'Thinking…' }, run.id);
      void executeDirectTask(session, task, run, modelId, adapter);
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

    // Workspace Build readiness is owned by the workspace adapter lifecycle.
    // Do not gate a healthy workspace on the separate direct/control-plane
    // OpenCode runtime: that caused Build to fail while the workspace adapter
    // was already reporting ready.
    const workspaceAdapter = await repository.getWorkspaceAgentAdapter(workspace.id, adapter.id);
    if (!workspaceAdapter || workspaceAdapter.state !== 'ready') {
      task.state = 'queued';
      task.updatedAt = new Date().toISOString();
      await repository.putTask(task);
      run.state = 'queued';
      run.activity = 'Waiting for workspace AI runtime';
      run.finishedAt = undefined;
      run.errorKind = undefined;
      store.save();
      const state = workspaceAdapter?.state || 'missing';
      emit(sessionId, 'run.state', {
        taskId: task.id,
        state: 'queued',
        message: `Workspace AI runtime is ${state}; continuing automatically when it is ready.`,
      }, run.id);
      emit(sessionId, 'activity.progress', {
        taskId: task.id,
        sourceType: 'agent.runtime.wait',
        adapterId: adapter.id,
        state,
        text: state === 'busy'
          ? 'OpenCode is finishing the previous operation…'
          : state === 'starting' || state === 'installing'
            ? 'Starting OpenCode in this workspace…'
            : 'Reconnecting OpenCode in this workspace…',
      }, run.id);
      return run;
    }
    const resolvedAgent = await resolveAgentForMode(mode, adapter.defaultAgent(mode), session.project, sessionId, adapter.status);
    // Workspace readiness already has a single canonical workspace lifecycle row.
    // Do not emit a second "Development environment ready" activity for the same turn.
    if (resolvedAgent.note) emit(sessionId, 'activity.progress', { taskId: task.id, text: resolvedAgent.note, adapterId: adapter.id }, run.id);

    task.harness = advanceHarnessPhase(task.harness, 'context_loading', { mode, permission });
    await repository.putTask(task);
    task.harness = advanceHarnessPhase(task.harness, 'executing', { mode, permission });
    await repository.putTask(task);

    const lessons = await relevantAgentLessons(session, task.prompt, provider).catch(() => []);
    task.harness = {
      ...task.harness,
      lessonsApplied: lessons.map((lesson) => lesson.id),
    };
    await repository.putTask(task);
    if (lessons.length) {
      emit(sessionId, 'activity.progress', {
        taskId: task.id,
        sourceType: 'agent.memory',
        text: `Orlynx memory → Model: using ${lessons.length} verified lesson${lessons.length === 1 ? '' : 's'} from earlier successful work.`,
        lessonIds: lessons.map((lesson) => lesson.id),
      }, run.id);
    }
    const privateSystem = [
      instructionForModeAccess(mode, permission),
      buildPresentationInstruction(mode),
      harnessSystemInstruction(task.harness),
      agentMemoryInstruction(lessons),
    ].filter(Boolean).join('\n\n');
    const engineSessionId = await repository.getAgentSession(sessionId, adapter.id);
    const payload = adapter.workspacePayload({
      modelId,
      taskId: task.id,
      runId: run.id,
      sessionId,
      engineSessionId,
      text: task.prompt,
      system: privateSystem,
      tools: openCodeToolsFor(task.harness),
      agent: resolvedAgent.agent,
    });
    await queueBridgeCommand(workspace.id, adapter.bridgeRunCommand, payload, timeoutMs);
    return run;
  } catch (error) {
    const now = new Date().toISOString();
    const detail = error instanceof Error ? error.message : 'Orlynx AI could not start this queued task.';
    const errorKind = (error as { errorKind?: AgentRun['errorKind'] }).errorKind || classifyError(detail);
    console.warn(`[queue] promotion failed session=${sessionId} task=${task.id} workspace=${task.workspaceId} adapter=${task.adapterId || 'opencode'} model=${task.modelId || 'none'} kind=${errorKind} detail=${detail.replace(/\s+/g, ' ').slice(0, 700)}`);
    task.state = 'failed';
    task.updatedAt = now;
    await repository.putTask(task);
    if (!run && task.runId) {
      run = { id: task.runId, sessionId, engine: task.adapterId || 'opencode', plane: task.plane || 'workspace', state: 'failed', activity: 'Needs attention', startedAt: task.createdAt, finishedAt: now, errorKind };
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

export async function resumeWaitingInputTask(sessionId: string, taskId: string, userText: string): Promise<AgentRun> {
  const repository = controlPlaneRepository();
  const session = await repository.getSession(sessionId);
  const task = await repository.getTask(taskId);
  if (!session || !task || task.sessionId !== sessionId || task.state !== 'waiting_input') {
    throw new Error('The task waiting for input is no longer available.');
  }
  if ((task.plane || 'workspace') !== 'workspace') throw new Error('Only workspace tasks can resume from human input.');

  const workspace = await repository.getWorkspace(task.workspaceId);
  if (!workspace || workspace.state !== 'ready' || workspace.bridgeState !== 'ready') {
    throw new Error('The development environment must reconnect before this task can resume.');
  }

  await hydrateSessionPrefs(sessionId, session.project);
  const prefs = getSessionPrefs(sessionId, session.project);
  const mode = task.mode || prefs.mode;
  const permission = task.tempPermission || task.permission || prefs.permission;
  const modelId = task.modelId || prefs.modelId;
  if (!modelId) throw new Error('Choose a model before continuing this task.');

  const adapter = getAgentAdapter(task.adapterId || prefs.adapterId || 'opencode');
  const workspaceAdapter = await repository.getWorkspaceAgentAdapter(workspace.id, adapter.id);
  if (!workspaceAdapter || workspaceAdapter.state !== 'ready') {
    throw new Error(`The workspace AI runtime is ${workspaceAdapter?.state || 'not ready'}; reconnect the development environment before continuing this task.`);
  }
  const engineSessionId = await repository.getAgentSession(sessionId, adapter.id);
  if (!engineSessionId) throw new Error('The connected model session is no longer available to resume.');

  const resolvedAgent = await resolveAgentForMode(mode, adapter.defaultAgent(mode), session.project, sessionId, adapter.status);
  const provider = adapter.parseModel(modelId).providerID;
  const lessons = await relevantAgentLessons(session, `${task.prompt} ${userText}`, provider).catch(() => []);
  const now = new Date().toISOString();
  task.state = 'running';
  task.partialText = undefined;
  task.harness ||= createHarnessCheckpoint({ prompt: task.prompt, mode, permission, plane: 'workspace', now });
  task.harness = {
    ...advanceHarnessPhase(task.harness, 'executing', { mode, permission, now }),
    lessonsApplied: lessons.map((lesson) => lesson.id),
  };
  task.updatedAt = now;
  await repository.putTask(task);

  let run = (store.db.runs[sessionId] || []).find((candidate) => candidate.id === task.runId);
  if (!run) {
    run = {
      id: task.runId || `run_${uuid().slice(0,8)}`,
      sessionId,
      engine: adapter.id,
      plane: 'workspace',
      provider,
      model: modelId,
      mode,
      permission,
      state: 'running',
      activity: 'Resuming with your input',
      startedAt: task.createdAt,
    };
    (store.db.runs[sessionId] ||= []).push(run);
  } else {
    run.state = 'running';
    run.activity = 'Resuming with your input';
    run.finishedAt = undefined;
    run.errorKind = undefined;
  }
  store.save();

  const system = [
    instructionForModeAccess(mode, permission),
    buildPresentationInstruction(mode),
    harnessSystemInstruction(task.harness),
    agentMemoryInstruction(lessons),
  ].filter(Boolean).join('\n\n');

  const payload = adapter.workspacePayload({
    modelId,
    taskId: task.id,
    runId: run.id,
    sessionId,
    engineSessionId,
    text: [
      'The user supplied the human-only information you requested:',
      userText,
      'Continue the same task from the current workspace state. Re-check the evidence; do not restart completed work unnecessarily.',
    ].join('\n\n'),
    system,
    tools: openCodeToolsFor(task.harness),
    agent: resolvedAgent.agent,
  });

  emit(sessionId, 'run.state', { taskId: task.id, state: 'running', resumedFrom: 'waiting_input' }, run.id);
  emit(sessionId, 'activity.progress', {
    taskId: task.id,
    sourceType: 'agent.dialogue.orlynx',
    reflectionId: (task.harness.reflectionAttempts || 0) + 1,
    text: 'Orlynx → Model: Joseph supplied the requested input. Continue the same task and verify the outcome.',
  }, run.id);
  await queueBridgeCommand(workspace.id, adapter.bridgeRunCommand, payload, timeoutMs);
  return run;
}

export async function recoverInterruptedDirectRuns(sessionId: string): Promise<void> {
  if (!durableStorageConfigured() || promotions.has(sessionId)) return;
  const repository = controlPlaneRepository();
  const tasks = await repository.listTasks(sessionId);
  let recovered = false;
  for (const task of tasks) {
    if (task.plane !== 'direct' || task.state !== 'running' || !task.runId || executingDirectTasks.has(task.id)) continue;
    let directStillRunning = false;
    try { directStillRunning = Boolean(getAgentAdapter(task.adapterId || 'opencode').hasDirectRun?.(task.runId)); } catch {}
    if (directStillRunning) continue;
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

export async function startRun(sessionId: string, project: string, userText: string, engine?: Engine, options: TaskOptions = {}): Promise<AgentRun> {
  if (!durableStorageConfigured() && (store.db.runs[sessionId] || []).some((candidate) => candidate.state === 'running')) throw new Error('An agent task is already running in this project.');
  if (durableStorageConfigured()) await hydrateSessionPrefs(sessionId, project);
  const gate = canPerform(sessionId, 'agent.task');
  if (!gate.allowed) {
    const error = new Error(gate.reason || 'This task is blocked by the project access level.');
    (error as { errorKind?: string }).errorKind = 'permission';
    throw error;
  }
  const prefs = getSessionPrefs(sessionId, project);
  const adapter = getAgentAdapter(engine || prefs.adapterId || 'opencode');
  const mode = options.mode || prefs.mode;
  const { permission, tempPermission } = taskPermission(prefs.permission, options.tempPermission);
  const modelId = options.modelId || prefs.modelId;
  let model: { providerID: string; modelID: string } | undefined;
  let provider: string | undefined;
  if (modelId) {
    model = adapter.parseModel(modelId);
    provider = model.providerID;
  }
  if (durableStorageConfigured()) {
    const repository = controlPlaneRepository();
    const plane = options.plane || 'workspace';
    if (plane === 'workspace' && !options.workspaceId) throw new Error('The development environment could not be initialized.');
    const durableTasks = await reconcileDurableTasks(sessionId);
    const queuedTotal = durableTasks.filter((item) => item.state === 'queued').length;
    const queuedAhead = options.queueAfterActive
      ? durableTasks.filter((item) => item.state === 'queued').length
      : durableTasks.filter((item) =>
          item.state === 'queued' && (item.plane || 'workspace') === plane
        ).length;
    if (queuedTotal >= maxQueuedTasks) {
      const error = new Error(`Orlynx already has ${queuedTotal} queued tasks for this conversation. Wait for one to start or cancel a queued task.`);
      (error as { errorKind?: string }).errorKind = 'queue_full';
      throw error;
    }
    const admittedAt = new Date().toISOString();
    const run: AgentRun = {
      id: `run_${uuid().slice(0,8)}`,
      sessionId,
      engine: adapter.id,
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
      adapterId: adapter.id,
      mode,
      permission: prefs.permission,
      tempPermission: options.tempPermission,
      harness: {
        ...createHarnessCheckpoint({
          prompt: userText,
          mode,
          permission,
          plane,
          now: admittedAt,
        }),
        ...(options.queueAfterActive ? { queueAfterActive: true } : {}),
      },
      createdAt: admittedAt,
      updatedAt: admittedAt,
    };
    (store.db.runs[sessionId] ||= []).push(run);
    store.save();
    await repository.putTask(task);
    emit(sessionId, 'run.queued', { taskId: task.id, position: queuedAhead + 1, plane, engine: adapter.id, adapterId: adapter.id, provider, model: modelId, mode, permission }, run.id);

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
  const connection = await adapter.readiness(project, sessionId);
  if (!connection.connected) throw new Error(connection.message || `${adapter.displayName} adapter is unavailable.`);
  const resolvedAgent = await resolveAgentForMode(mode, adapter.defaultAgent(mode), project, sessionId, adapter.status);
  const engineSession = await adapter.getOrCreateSession(sessionId, project);
  const before = await adapter.messages(project, engineSession.id);
  const previousAssistantId = [...before].reverse().find((message) => message.info?.role === 'assistant')?.info?.id;
  const run: AgentRun = {
    id: `run_${uuid().slice(0, 8)}`, sessionId, engine: adapter.id, provider, model: modelId,
    mode, permission, tempPermission,
    state: 'running', activity: 'Starting work', startedAt: new Date().toISOString(),
  };
  (store.db.runs[sessionId] ||= []).push(run);
  store.save();
  emit(sessionId, 'run.started', { engine: adapter.id, adapterId: adapter.id, provider, model: modelId, mode, permission }, run.id);
  emit(sessionId, 'activity.started', { text: 'Starting work' }, run.id);
  if (resolvedAgent.note) emit(sessionId, 'activity.progress', { text: resolvedAgent.note }, run.id);
  emit(sessionId, 'message.start', { engine: adapter.id, adapterId: adapter.id }, run.id);
  // Backend-enforced mode guardrails travel with the task itself.
  const availableAttachments = durableStorageConfigured() ? [] : materializeAttachments(sessionId, project);
  const attachmentInstruction = availableAttachments.length
    ? `[Orlynx attachments: ${availableAttachments.map((item) => `${item.name} at ${item.path}`).join('; ')}. Read these project-local files when they are relevant to the request. Do not move or commit the .orlynx directory.]`
    : '';
  let localHarness = createHarnessCheckpoint({
    prompt: userText,
    mode,
    permission,
    plane: 'workspace',
  });
  localHarness = advanceHarnessPhase(localHarness, 'executing', { mode, permission });
  const privateSystem = [
    instructionForModeAccess(mode, permission),
    buildPresentationInstruction(mode),
    harnessSystemInstruction(localHarness),
    attachmentInstruction,
  ].filter(Boolean).join('\n\n');
  try {
    await adapter.prompt(project, engineSession.id, userText, {
      model,
      agent: resolvedAgent.agent,
      system: privateSystem,
      tools: openCodeToolsFor(localHarness),
    });
  } catch (error) {
    run.state = 'failed'; run.finishedAt = new Date().toISOString();
    run.errorKind = classifyError(error instanceof Error ? error.message : '');
    store.save();
    emit(sessionId, 'run.failed', { error: error instanceof Error ? error.message : `${adapter.displayName} rejected the task.`, errorKind: run.errorKind }, run.id);
    throw error;
  }
  activeAgentSessions.set(run.id, { adapterId: adapter.id, project, sessionId: engineSession.id, cancelled: false });
  void monitorRun(sessionId, project, engineSession.id, run, adapter, previousAssistantId);
  return run;
}

async function monitorRun(sessionId: string, project: string, engineSessionId: string, run: AgentRun, adapter: AgentAdapter, previousAssistantId?: string): Promise<void> {
  const active = activeAgentSessions.get(run.id);
  if (!active) return;
  const deadline = Date.now() + timeoutMs;
  let assistant: RuntimeMessage | undefined;
  let visibleText = '';
  const toolStates = new Map<string, string>();
  try {
    while (Date.now() < deadline && !active.cancelled) {
      const messages = await adapter.messages(project, engineSessionId);
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
        if (failed) throw new Error(`${adapter.displayName} reported that the task failed.`);
        if (complete) break;
      }
      const status = await adapter.sessionStatus(project, engineSessionId);
      if (assistant && status.type === 'idle') break;
      await delay(800);
    }
    if (active.cancelled) return;
    if (Date.now() >= deadline) throw new Error(`${adapter.displayName} task timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    if (!assistant) throw new Error(`${adapter.displayName} finished without returning an assistant response.`);
    const responseText = assistant.parts.filter((part) => part.type === 'text').map((part) => String(part.text || '')).join('');
    (store.db.messages[sessionId] ||= []).push({ id: `msg_${run.id}`, sessionId, role: 'assistant', text: responseText, runId: run.id, createdAt: new Date().toISOString() });
    if (durableStorageConfigured()) await controlPlaneRepository().putMessage(store.db.messages[sessionId][store.db.messages[sessionId].length - 1]);
    emit(sessionId, 'message.end', {}, run.id);
    await captureDiff(sessionId, project, run.id, engineSessionId, adapter);
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
    for (const [toolId, state] of toolStates) if (state === 'running') emit(sessionId, 'tool.failed', { toolCallId: toolId, error: `${adapter.displayName} did not complete this action.` }, run.id);
    emit(sessionId, 'run.failed', { error: error instanceof Error ? error.message : `${adapter.displayName} task failed.`, errorKind: run.errorKind }, run.id);
  } finally {
    activeAgentSessions.delete(run.id);
  }
}

function toolSemanticType(toolName: string, command: string, filePath: string): string {
  const text = `${toolName} ${command}`.toLowerCase();
  if (/vitest|jest|pytest|mocha|playwright|(^|\s)test(\s|$)|npm test|pnpm test|yarn test/.test(text)) return 'test-result';
  if (/build|compile|tsc|webpack|vite build|next build/.test(text)) return 'build-result';
  if (/git\b|commit|checkout|branch|merge|rebase|push|pull/.test(text)) return 'git';
  if (filePath && /read|cat|view|inspect|open|grep|search/.test(text)) return 'file-read';
  if (filePath && /write|edit|patch|apply|create|delete|remove|replace/.test(text)) return 'file-change';
  if (/vite|next dev|next start|npm run dev|pnpm dev|yarn dev|astro dev|remix dev|serve|preview/.test(text)) return 'preview';
  if (/bash|shell|exec|terminal|command/.test(text) || command) return 'terminal';
  return 'generic';
}

function collectToolEvents(sessionId: string, runId: string, message: RuntimeMessage, toolStates: Map<string, string>) {
  for (const part of message.parts) {
    if (part.type !== 'tool') continue;
    const rawToolId = String(part.callID || part.id || `${message.info.id}:${part.tool}`);
    const toolId = scopeToolCallId(runId, rawToolId);
    const state = String(part.state?.status || 'running');
    const input = part.state?.input && typeof part.state.input === 'object'
      ? part.state.input as Record<string, unknown>
      : part.input && typeof part.input === 'object'
        ? part.input as Record<string, unknown>
        : {};
    const tool = String(part.tool || 'OpenCode action');
    const command = typeof (input.command ?? input.cmd ?? input.script ?? input.shell) === 'string'
      ? String(input.command ?? input.cmd ?? input.script ?? input.shell)
      : '';
    const filePath = typeof (input.filePath ?? input.path ?? input.file ?? input.filename) === 'string'
      ? String(input.filePath ?? input.path ?? input.file ?? input.filename)
      : '';
    const semanticType = toolSemanticType(tool, command, filePath);
    const metadata = {
      tool,
      toolCallId: toolId,
      semanticType,
      ...(command ? { command } : {}),
      ...(filePath ? { path: filePath } : {}),
    };
    const prior = toolStates.get(toolId);
    if (!prior) emit(sessionId, 'tool.started', metadata, runId);
    if (state === 'completed' && prior !== 'completed') {
      emit(sessionId, 'tool.completed', { ...metadata, out: String(part.state?.output || '') }, runId);
    } else if (state === 'error' && prior !== 'error') {
      emit(sessionId, 'tool.failed', { ...metadata, error: String(part.state?.error || 'Action failed.'), out: String(part.state?.output || '') }, runId);
    } else if (state === 'running' && prior !== 'running') {
      emit(sessionId, 'tool.output', metadata, runId);
    }
    toolStates.set(toolId, state);
  }
}

async function captureDiff(sessionId: string, project: string, runId: string, engineSessionId: string, adapter: AgentAdapter = openCodeRuntime) {
  const raw = await adapter.diff(project, engineSessionId);
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
  if (run.plane === 'direct') {
    try { getAgentAdapter(run.engine).cancelDirectRun?.(runId); } catch {}
  }
  const active = activeAgentSessions.get(runId);
  if (active) {
    active.cancelled = true;
    try { await getAgentAdapter(active.adapterId).abort(active.project, active.sessionId); } catch { /* cancellation still terminates Orlynx state */ }
  }
  run.state = 'cancelled'; run.finishedAt = new Date().toISOString(); run.activity = 'Stopped';
  if (active?.task) {
    active.task.state = 'cancelled';
    active.task.updatedAt = run.finishedAt;
    if (active.task.harness) {
      active.task.harness = advanceHarnessPhase(active.task.harness, 'cancelled', {
        mode: active.task.mode || run.mode || 'build',
        permission: active.task.tempPermission || active.task.permission || run.permission || 'full',
        now: run.finishedAt,
      });
    }
    await controlPlaneRepository().putTask(active.task);
  }
  store.save();
  emit(sessionId, 'run.failed', { cancelled: true }, runId);
  return run;
}

export function currentRuns(sessionId: string): AgentRun[] { return store.db.runs[sessionId] || []; }

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
