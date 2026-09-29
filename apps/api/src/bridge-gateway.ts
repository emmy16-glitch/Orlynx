import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import { createBridgeToken, verifyBridgeReconnectToken, verifyBridgeToken, type BridgeClaims } from './bridge-auth.js';
import { controlPlaneRepository } from './storage.js';
import { decryptCredential } from './credentials.js';
import { classifyError } from './ai.js';
import { promoteNextQueuedRun } from './agents.js';
import { store } from './store.js';
import { markWorkspaceConnectionLost, shouldRecoverTransientBridgeClose, workspaceNeedsRuntimeRefresh } from './workspaces.js';
import { authenticateBridgeSocket, hasLiveBridge, isCurrentBridgeSocket, publishLiveBridgeResult, registerBridgeSocket, sendBridgeCommandNow, unregisterBridgeSocket } from './bridge-live.js';
import { scheduleWorkspacePreparation } from './workspace-jobs.js';
import { bridgeEventKey, normalizeBridgeEvent, scopeToolCallId } from './agent-protocol.js';
import { bridgeRequest, queueBridgeCommand } from './bridge-rpc.js';
import { advanceHarnessPhase, consumeHarnessStep, createHarnessCheckpoint, harnessBudgetStatus, harnessSystemInstruction, needsFinalSynthesis, openCodeToolsFor, prepareReflection, reflectionInstruction, shouldReflect, userInputRequest, verifyHarness } from './harness.js';
import { agentMemoryInstruction, relevantAgentLessons, rememberVerifiedLesson } from './agent-memory.js';
import { emitPersisted, sanitizeEvent } from './events.js';
import { providerForWorkspace } from './workspace-providers.js';
import type { EventType } from '@orlynx/shared';

async function persistLiveEvent(event: {
  eventId: string;
  sessionId: string;
  workspaceId?: string;
  taskId?: string;
  runId?: string;
  type: EventType;
  timestamp: string;
  payload: Record<string, unknown>;
}) {
  return emitPersisted(event.sessionId, event.type, event.payload, event.runId, {
    eventId: event.eventId,
    taskId: event.taskId,
    workspaceId: event.workspaceId,
    timestamp: event.timestamp,
  });
}

async function controlledDefaultBranchPublish(workspaceId: string, sessionId: string) {
  const repository = controlPlaneRepository();
  const session = await repository.getSession(sessionId);
  if (!session) throw new Error('Session is unavailable for controlled publishing.');

  await bridgeRequest(workspaceId, 'git.fetch', { approved: true }, 120_000);
  const status = await bridgeRequest<{
    branch?: string;
    head?: string;
    remoteHead?: string;
    porcelain?: string;
    ahead?: number;
    behind?: number;
  }>(workspaceId, 'git.status', {}, 30_000);

  const branch = String(status.branch || '');
  const head = String(status.head || '');
  const porcelain = String(status.porcelain || '');
  if (!branch || !head) throw new Error('Orlynx could not determine the Git branch and commit.');
  if (branch !== session.branch) throw new Error(`Workspace is on ${branch}, but this conversation targets ${session.branch}.`);
  if (porcelain.trim()) throw new Error('Workspace still has uncommitted changes. Commit them before publishing.');
  if (Number(status.behind || 0) > 0) throw new Error(`origin/${branch} has newer commits. Pull or rebase before publishing.`);

  if (status.remoteHead && status.remoteHead === head && Number(status.ahead || 0) === 0) {
    return { branch, head, alreadyPublished: true };
  }

  const pushed = await bridgeRequest<{ branch?: string; head?: string }>(workspaceId, 'git.push', {
    approved: true,
    allowDefaultBranch: branch === 'main' || branch === 'master',
  }, 120_000);
  return { branch: String(pushed.branch || branch), head: String(pushed.head || head), alreadyPublished: false };
}

function continuationPayload(
  source: Record<string, unknown>,
  task: { id: string; runId?: string; sessionId: string; harness?: any },
  engineSessionId: string,
  text: string,
) {
  const system = [
    String(source.system || ''),
    task.harness ? harnessSystemInstruction(task.harness) : '',
  ].filter(Boolean).join('\n\n');
  return {
    ...source,
    taskId: task.id,
    runId: task.runId,
    sessionId: task.sessionId,
    engineSessionId,
    text,
    system,
    ...(task.harness?.reflectionAttempts ? { reflectionId: task.harness.reflectionAttempts } : {}),
    ...(task.harness ? { tools: openCodeToolsFor(task.harness) } : {}),
  };
}

type BridgeAdapterState = { state?: string; reason?: string };
type BridgeMessage = { kind?: string; commandId?: string; workspaceId?: string; sessionId?: string; userId?: string; connectionId?: string; repoRoot?: string; adapters?: Record<string, BridgeAdapterState>; adapterId?: string; adapter?: BridgeAdapterState; ok?: boolean; result?: Record<string, unknown>; error?: string; event?: { eventId?: string; sequence?: number; type?: string; payload?: Record<string, unknown>; taskId?: string; runId?: string } };

function bearer(request: http.IncomingMessage): string {
  const header = String(request.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

async function persistAdapterState(claims: BridgeClaims, adapterId: string, adapter: BridgeAdapterState) {
  const repository = controlPlaneRepository();
  const current = await repository.getWorkspace(claims.workspaceId);
  if (!current || current.sessionId !== claims.sessionId || current.userId !== claims.userId || current.connectionId !== claims.connectionId) return;
  const state = ['not_installed','installing','starting','ready','busy','unavailable','failed'].includes(String(adapter.state))
    ? String(adapter.state) as 'not_installed' | 'installing' | 'starting' | 'ready' | 'busy' | 'unavailable' | 'failed'
    : 'unavailable';
  const now = new Date().toISOString();
  await repository.putWorkspaceAgentAdapter({ workspaceId: claims.workspaceId, adapterId, state, reason: adapter.reason, updatedAt: now });
  await persistLiveEvent({
    eventId: `evt_${uuid()}`,
    sessionId: claims.sessionId,
    workspaceId: claims.workspaceId,
    type: 'state.delta',
    timestamp: now,
    payload: { scope: 'agent-adapter', adapterId, state, ...(adapter.reason ? { reason: adapter.reason } : {}) },
  });
}

async function persistBridgeState(claims: BridgeClaims, state: 'connecting' | 'ready' | 'disconnected', detail: BridgeMessage = {}) {
  const repository = controlPlaneRepository();
  const current = await repository.getWorkspace(claims.workspaceId);
  if (!current || current.sessionId !== claims.sessionId || current.userId !== claims.userId) throw new Error('Workspace credential scope does not match durable state.');
  // A prior socket may close after its replacement has authenticated. Never
  // let that stale close (or a delayed READY) downgrade the new connection.
  if (current.connectionId !== claims.connectionId) return;
  const now = new Date().toISOString();
  const adapters = detail.adapters || {};
  const workspaceReady = state === 'ready';
  const nextWorkspaceState = workspaceReady
    ? 'ready'
    : state === 'disconnected'
      ? 'connecting'
      : current.state === 'bootstrapping'
        ? 'connecting'
        : current.state;

  await repository.putWorkspace({
    ...current,
    connectionId: claims.connectionId,
    bridgeState: state === 'disconnected' ? 'disconnected' : state,
    state: nextWorkspaceState,
    failureCode: workspaceReady ? undefined : current.failureCode,
    repoRoot: detail.repoRoot || current.repoRoot,
    updatedAt: now,
  });

  for (const [adapterId, adapter] of Object.entries(adapters)) {
    const adapterState = ['not_installed','installing','starting','ready','busy','unavailable','failed'].includes(String(adapter.state))
      ? String(adapter.state) as 'not_installed' | 'installing' | 'starting' | 'ready' | 'busy' | 'unavailable' | 'failed'
      : 'unavailable';
    await repository.putWorkspaceAgentAdapter({ workspaceId: claims.workspaceId, adapterId, state: adapterState, reason: adapter.reason, updatedAt: now });
    await persistLiveEvent({
      eventId: `evt_${uuid()}`,
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      type: 'state.delta',
      timestamp: now,
      payload: { scope: 'agent-adapter', adapterId, state: adapterState, ...(adapter.reason ? { reason: adapter.reason } : {}) },
    });
  }

  if (workspaceReady) {
    await persistLiveEvent({
      eventId: `evt_${uuid()}`,
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      type: 'workspace.ready',
      timestamp: now,
      payload: { provider: current.provider, adapters },
    });
  }
}

async function handleConnection(ws: WebSocket, request: http.IncomingMessage) {
  let claims: BridgeClaims;
  let reconnectGraceUsed = false;
  const token = bearer(request);
  try {
    claims = verifyBridgeToken(token);
  } catch {
    try {
      claims = verifyBridgeReconnectToken(token);
      reconnectGraceUsed = true;
    } catch {
      console.warn('[bridge] handshake rejected: credential');
      ws.close(1008, 'unauthorized');
      return;
    }
  }
  try { await persistBridgeState(claims, 'connecting'); }
  catch { console.warn('[bridge] handshake rejected: workspace scope or storage'); ws.close(1008, 'workspace scope rejected'); return; }
  console.info(reconnectGraceUsed ? '[bridge] expired reconnect credential accepted and will be rotated' : '[bridge] credential accepted');

  let active = true;
  let authenticatedHello = false;
  const helloTimeout = setTimeout(() => { if (!authenticatedHello) ws.close(1008, 'hello timeout'); }, 15_000);
  const previousSocket = registerBridgeSocket(claims.workspaceId, ws);
  if (previousSocket && previousSocket !== ws && previousSocket.readyState === previousSocket.OPEN) {
    console.info(`[bridge] retiring previous socket workspace=${claims.workspaceId}`);
    previousSocket.close(1000, 'replaced by newer workspace connection');
  }
  const repository = controlPlaneRepository();
  // A durable "sent" command is eligible for delivery retry after its lease
  // expires. Never re-execute that retry on the same transport: it is only
  // useful after a socket replacement. This also protects older bridge
  // processes that do not yet de-duplicate commands while they are running.
  const commands = setInterval(async () => {
    if (!active || !authenticatedHello || ws.readyState !== ws.OPEN) return;
    try {
      for (const command of await repository.claimCommands(claims.workspaceId)) {
        let payload = command.payload;
        if (command.kind === 'agent.run' && !String(payload.engineSessionId || '')) {
          const adapterId = String(payload.adapterId || 'opencode');
          const savedEngineSessionId = await repository.getAgentSession(claims.sessionId, adapterId);
          if (savedEngineSessionId) payload = { ...payload, engineSessionId: savedEngineSessionId };
        }
        sendBridgeCommandNow(claims.workspaceId, { id: command.id, kind: command.kind, payload });
      }
    } catch { /* the next poll retries queued commands */ }
  }, 1_000);
  const credentials = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind: 'CREDENTIAL', token: createBridgeToken({ workspaceId: claims.workspaceId, sessionId: claims.sessionId, userId: claims.userId, connectionId: claims.connectionId }) }));
  }, 4 * 60_000);

  ws.on('message', async (raw) => {
    let message: BridgeMessage;
    try { message = JSON.parse(String(raw)); } catch { ws.close(1003, 'invalid json'); return; }
    try {
      if (!authenticatedHello) {
        if (message.kind !== 'HELLO' || message.workspaceId !== claims.workspaceId || message.sessionId !== claims.sessionId || message.userId !== claims.userId || message.connectionId !== claims.connectionId) { console.warn('[bridge] hello rejected: claim mismatch'); ws.close(1008, 'claim mismatch'); return; }
        authenticatedHello = true;
        authenticateBridgeSocket(claims.workspaceId, ws);
        clearTimeout(helloTimeout);
        console.info('[bridge] hello authenticated');
        ws.send(JSON.stringify({ kind: 'AUTHENTICATED', token: createBridgeToken({ workspaceId: claims.workspaceId, sessionId: claims.sessionId, userId: claims.userId, connectionId: claims.connectionId }) }));
        return;
      }
      if (message.kind === 'ADAPTER_STATUS' && message.adapterId && message.adapter) {
        await persistAdapterState(claims, String(message.adapterId), message.adapter);
        console.info(`[bridge] adapter status ${message.adapterId}=${message.adapter.state || 'unknown'}`);
        if (message.adapter.state === 'ready' || message.adapter.state === 'failed') {
          void promoteNextQueuedRun(claims.sessionId).catch((error) => console.warn(`[bridge] queued promotion after adapter state change failed: ${error instanceof Error ? error.message : 'unknown error'}`));
        }
        return;
      }
      if (message.kind === 'READY') {
        const reported = message.adapters || {};
        console.info(`[bridge] adapter states: ${Object.entries(reported).map(([id, value]) => `${id}=${value.state || 'unknown'}${value.reason ? `:${value.reason}` : ''}`).join(', ') || 'none'}`);
        await persistBridgeState(claims, 'ready', message);

        // Attachments can be uploaded before a cloud workspace exists. Once
        // the authenticated bridge is ready, replay those durable attachments
        // directly into the private workspace. Reconnects are safe because the
        // bridge writes deterministic attachment names and overwrites them.
        const attachments = await repository.listAttachmentPayloads(claims.sessionId);
        for (const attachment of attachments) {
          if (ws.readyState !== ws.OPEN) break;
          ws.send(JSON.stringify({
            kind: 'COMMAND',
            commandId: `attachment_${attachment.id}_${uuid()}`,
            type: 'fs.write-attachment',
            payload: {
              name: `${attachment.id}__${attachment.safeName}`,
              contentBase64: attachment.contentBase64.startsWith('v1.')
                ? decryptCredential(attachment.contentBase64)
                : attachment.contentBase64,
            },
          }));
        }
        const currentWorkspace = await repository.getWorkspace(claims.workspaceId);
        if (currentWorkspace && workspaceNeedsRuntimeRefresh(currentWorkspace)) {
          console.info(`[bridge] stale runtime revision detected on reconnect; refreshing workspace=${claims.workspaceId}`);
          void scheduleWorkspacePreparation({
            sessionId: currentWorkspace.sessionId,
            userId: currentWorkspace.userId,
            projectId: currentWorkspace.projectId,
            repositoryId: currentWorkspace.repositoryId,
            branch: currentWorkspace.branch,
          }, { allowFallback: true, reason: 'runtime_refresh' })
            .catch((error) => console.warn(`[bridge] runtime refresh scheduling failed: ${error instanceof Error ? error.message : 'unknown error'}`));
          return;
        }
        void promoteNextQueuedRun(claims.sessionId).catch((error) => console.warn(`[bridge] queued promotion after READY failed: ${error instanceof Error ? error.message : 'unknown error'}`));
        return;
      }
      if (message.kind === 'RESULT' && message.commandId) {
        const command = await repository.getCommand(message.commandId);
        const resultPayload = message.result || { error: message.error || 'Workspace command failed.' };
        await repository.completeCommand(message.commandId, message.ok ? 'completed' : 'failed', resultPayload);
        publishLiveBridgeResult(message.commandId, { ok: Boolean(message.ok), result: resultPayload, error: message.error });
        if (command?.kind === 'agent.run') {
          const taskId = String(command.payload.taskId || '');
          const runId = String(command.payload.runId || '');
          const task = taskId ? await repository.getTask(taskId) : null;
          const now = new Date().toISOString();
          const memoryRun = (store.db.runs[claims.sessionId] || []).find((candidate) => candidate.id === runId);

          if (task?.state === 'cancelled') {
            console.info(`[bridge] ignored late result for cancelled run=${runId}`);
            void promoteNextQueuedRun(claims.sessionId).catch(() => {});
            return;
          }

          if (!message.ok) {
            const adapterId = String(command.payload.adapterId || 'opencode');
            const detail = String(message.error || message.result?.error || `${adapterId} adapter could not complete the task.`);
            const freePublicModel = command.payload.openCodePublicAccess === true;
            const classifiedErrorKind = classifyError(detail);
            // A 401/403 from OpenCode's public/free route is not evidence that
            // the user's optional saved account credential needs reconnecting.
            // Keep that recovery local to the model instead of sending users
            // into an unrelated credential flow.
            const errorKind = freePublicModel && classifiedErrorKind === 'auth'
              ? 'model'
              : classifiedErrorKind;
            const error = errorKind === 'rate_limit'
              ? 'The AI provider is temporarily rate limiting requests. Wait a moment and try again.'
              : errorKind === 'quota'
                ? freePublicModel
                  ? 'OpenCode free-model usage is currently limited for this route. Retry later or choose another free model.'
                  : 'The selected OpenCode account has reached its current usage allowance.'
                : errorKind === 'auth'
                  ? 'The AI provider connection needs to be refreshed before this model can be used.'
                  : errorKind === 'model'
                    ? freePublicModel
                      ? 'OpenCode rejected this free-model route for the current run. This does not mean your account needs reconnecting; retry later or choose another free model.'
                      : 'The selected model is not currently available. Choose another model and try again.'
                    : errorKind === 'permission'
                      ? 'This task needs permission that the current access level does not allow.'
                      : errorKind === 'engine'
                        ? 'The AI workspace connection was interrupted. Reconnect the workspace and try again.'
                        : 'Orlynx AI could not complete this task.';
            console.warn(`[bridge] agent run failed session=${claims.sessionId} run=${runId} kind=${errorKind} freePublic=${freePublicModel}`);

            if (task) {
              task.state = 'failed';
              task.updatedAt = now;
              const effectivePermission = task.tempPermission || task.permission || 'full';
              task.harness ||= createHarnessCheckpoint({
                prompt: task.prompt,
                mode: task.mode || 'build',
                permission: effectivePermission,
                plane: task.plane || 'workspace',
                now,
              });
              task.harness = advanceHarnessPhase(task.harness, 'failed', {
                mode: task.mode || 'build',
                permission: effectivePermission,
                now,
              });
              await repository.putTask(task);
            }

            if (memoryRun) {
              memoryRun.state = 'failed';
              memoryRun.activity = 'Work needs attention';
              memoryRun.finishedAt = now;
              memoryRun.errorKind = errorKind;
              store.save();
            }

            await persistLiveEvent({
              eventId: `evt_${uuid()}`,
              sessionId: claims.sessionId,
              taskId,
              runId,
              workspaceId: claims.workspaceId,
              type: 'run.failed',
              timestamp: now,
              payload: {
                error,
                errorKind,
                retryable: errorKind === 'rate_limit' || errorKind === 'engine',
              },
            });
            await promoteNextQueuedRun(claims.sessionId).catch((error) => console.warn(`[bridge] queued promotion after failed result failed: ${error instanceof Error ? error.message : 'unknown error'}`));
            return;
          }

          const responseText = String(message.result?.responseText || '');
          const engineSessionId = String(message.result?.engineSessionId || command.payload.engineSessionId || '');
          if (engineSessionId) {
            const adapterId = String(command.payload.adapterId || 'opencode');
            await repository.putAgentSession(claims.sessionId, adapterId, engineSessionId);
          }

          const rawDiff = Array.isArray(message.result?.diff) ? message.result.diff as Array<Record<string, unknown>> : [];
          const files = rawDiff.flatMap((item) => {
            const file = String(item.file || item.path || '');
            if (!file || file.startsWith('/') || file.split('/').includes('..')) return [];
            return [{
              path: file,
              action: item.status === 'added' ? 'create' as const : item.status === 'deleted' ? 'delete' as const : 'modify' as const,
              before: typeof item.before === 'string' ? item.before : undefined,
              after: typeof item.after === 'string' ? item.after : undefined,
              diff: typeof item.diff === 'string' ? item.diff : undefined,
            }];
          });

          if (files.length) {
            const changeId = `chg_${uuid()}`;
            await repository.putChangeSet({
              id: changeId,
              sessionId: claims.sessionId,
              runId,
              baseSha: String(message.result?.head || ''),
              files,
              reviewState: 'pending',
              createdAt: now,
            });

            let remainingDiffChars = 24_000;
            const activityFiles = files.slice(0, 20).map((file) => {
              const source = file.diff || file.after || file.before || '';
              const diff = source && remainingDiffChars > 0 ? source.slice(0, Math.min(remainingDiffChars, 8_000)) : '';
              remainingDiffChars -= diff.length;
              return { path: file.path, action: file.action, ...(diff ? { diff } : {}) };
            });

            await persistLiveEvent({
              eventId: `evt_${uuid()}`,
              sessionId: claims.sessionId,
              taskId,
              runId,
              workspaceId: claims.workspaceId,
              type: 'changes.updated',
              timestamp: now,
              payload: { changeId, count: files.length, files: activityFiles },
            });
          }

          const localPreviewPorts = Array.isArray(message.result?.previewPorts)
            ? (message.result.previewPorts as Array<Record<string, unknown>>)
              .map((item) => ({ port: Number(item.port), url: typeof item.url === 'string' ? item.url : undefined }))
              .filter((item) => Number.isInteger(item.port) && item.port > 1024 && item.port < 65536)
            : [];
          const previewWorkspace = await repository.getWorkspace(claims.workspaceId).catch(() => null);
          const previewProvider = previewWorkspace ? providerForWorkspace(previewWorkspace) : null;
          for (const preview of localPreviewPorts) {
            const url = preview.url || (previewWorkspace ? previewProvider?.previewUrl?.(previewWorkspace, preview.port) : undefined);
            if (!url) {
              await persistLiveEvent({
                eventId: `evt_${uuid()}`,
                sessionId: claims.sessionId,
                taskId,
                runId,
                workspaceId: claims.workspaceId,
                type: 'preview.state',
                timestamp: now,
                payload: {
                  port: preview.port,
                  state: 'preparing',
                  localReady: true,
                  verified: false,
                  message: 'Local server is healthy; waiting for the workspace provider to expose a browser preview.',
                },
              });
              continue;
            }
            await persistLiveEvent({
              eventId: `evt_${uuid()}`,
              sessionId: claims.sessionId,
              taskId,
              runId,
              workspaceId: claims.workspaceId,
              type: 'preview.ready',
              timestamp: now,
              payload: { port: preview.port, url, verified: true },
            });
          }

          if (!task) {
            if (responseText) await repository.putMessage({
              id: `msg_${runId || uuid()}`,
              sessionId: claims.sessionId,
              role: 'assistant',
              text: responseText,
              runId: runId || undefined,
              createdAt: now,
            });
            if (memoryRun) {
              memoryRun.state = 'completed';
              memoryRun.activity = 'Ready for review';
              memoryRun.finishedAt = now;
              store.save();
            }
            await persistLiveEvent({ eventId: `evt_${uuid()}`, sessionId: claims.sessionId, taskId, runId, workspaceId: claims.workspaceId, type: 'message.end', timestamp: now, payload: {} });
            await persistLiveEvent({ eventId: `evt_${uuid()}`, sessionId: claims.sessionId, taskId, runId, workspaceId: claims.workspaceId, type: 'run.completed', timestamp: now, payload: { summary: 'Work completed.' } });
            await promoteNextQueuedRun(claims.sessionId).catch(() => {});
            return;
          }

          const effectivePermission = task.tempPermission || task.permission || 'full';
          task.harness ||= createHarnessCheckpoint({
            prompt: task.prompt,
            mode: task.mode || 'build',
            permission: effectivePermission,
            plane: task.plane || 'workspace',
            now,
          });
          task.harness = advanceHarnessPhase(task.harness, 'verifying', {
            mode: task.mode || 'build',
            permission: effectivePermission,
            now,
          });
          task.updatedAt = now;
          await repository.putTask(task);

          const pendingSteering = task.harness.inbox.filter((item) => !item.appliedAt);
          if (pendingSteering.length && engineSessionId) {
            const appliedAt = new Date().toISOString();
            task.harness = {
              ...task.harness,
              inbox: task.harness.inbox.map((item) => item.appliedAt ? item : { ...item, appliedAt }),
            };
            task.harness = advanceHarnessPhase(task.harness, 'executing', {
              mode: task.mode || 'build',
              permission: effectivePermission,
              now: appliedAt,
            });
            task.updatedAt = appliedAt;
            await repository.putTask(task);

            const updateText = [
              'Continue the same Orlynx task. Apply these live user updates before finalizing:',
              ...pendingSteering.map((item) => `[${item.action.toUpperCase()}] ${item.text}`),
              'Do not repeat work that is already complete. Re-check the acceptance criteria after applying the update.',
            ].join('\n');
            await queueBridgeCommand(
              claims.workspaceId,
              'agent.run',
              continuationPayload(command.payload, task, engineSessionId, updateText),
              30 * 60_000,
            );
            console.info(`[harness] continued run=${runId} after steering updates=${pendingSteering.length}`);
            return;
          }

          let recent = (await repository.listRecentEvents(claims.sessionId, 1000))
            .filter((event) => event.runId === runId)
            .map(sanitizeEvent);
          task.harness = verifyHarness(task.harness, recent, new Date().toISOString());
          await repository.putTask(task);

          let publishError = '';
          const onlyPublishMissing = task.harness.verification.missing.length === 1
            && task.harness.verification.missing[0] === 'publish';

          if (onlyPublishMissing && effectivePermission === 'ask-first') {
            const approvalId = `approval_${uuid()}`;
            const approvalNow = new Date().toISOString();
            task.state = 'waiting_approval';
            task.partialText = responseText;
            task.harness = advanceHarnessPhase(task.harness, 'waiting_approval', {
              mode: task.mode || 'build',
              permission: effectivePermission,
              now: approvalNow,
            });
            task.updatedAt = approvalNow;
            await repository.putTask(task);
            await repository.putApproval({
              id: approvalId,
              sessionId: claims.sessionId,
              taskId: task.id,
              action: 'git.push.default',
              state: 'pending',
              context: {
                taskId: task.id,
                runId,
                workspaceId: claims.workspaceId,
                branch: (await repository.getSession(claims.sessionId))?.branch || '',
              },
              createdAt: approvalNow,
            });
            if (memoryRun) {
              memoryRun.state = 'waiting_approval';
              memoryRun.activity = 'Waiting for approval';
              memoryRun.finishedAt = undefined;
              store.save();
            }
            await persistLiveEvent({
              eventId: `evt_${uuid()}`,
              sessionId: claims.sessionId,
              taskId,
              runId,
              workspaceId: claims.workspaceId,
              type: 'approval.required',
              timestamp: approvalNow,
              payload: {
                approvalId,
                action: 'git.push.default',
                detail: 'Publish the verified commit to the conversation branch.',
              },
            });
            return;
          }

          if (onlyPublishMissing && effectivePermission === 'full') {
            try {
              const published = await controlledDefaultBranchPublish(claims.workspaceId, claims.sessionId);
              const publishedAt = new Date().toISOString();
              await persistLiveEvent({
                eventId: `evt_${uuid()}`,
                sessionId: claims.sessionId,
                taskId,
                runId,
                workspaceId: claims.workspaceId,
                type: 'receipt.created',
                timestamp: publishedAt,
                payload: {
                  command: 'git push',
                  publish: true,
                  pushedBranch: published.branch,
                  commitSha: published.head,
                  alreadyPublished: published.alreadyPublished,
                },
              });
              recent = (await repository.listRecentEvents(claims.sessionId, 1000)).filter((event) => event.runId === runId);
              task.harness = verifyHarness(task.harness, recent, publishedAt);
              await repository.putTask(task);
            } catch (error) {
              publishError = error instanceof Error ? error.message : 'Controlled Git publish failed.';
            }
          }

          if (
            task.harness.verification.status === 'passed'
            && needsFinalSynthesis(task.harness, responseText)
            && (task.harness.finalSynthesisAttempts || 0) < 1
            && engineSessionId
          ) {
            const synthesisNow = new Date().toISOString();
            task.harness = {
              ...task.harness,
              finalSynthesisAttempts: (task.harness.finalSynthesisAttempts || 0) + 1,
            };
            task.harness = advanceHarnessPhase(task.harness, 'finalizing', {
              mode: task.mode || 'build',
              permission: effectivePermission,
              now: synthesisNow,
            });
            task.updatedAt = synthesisNow;
            await repository.putTask(task);

            await queueBridgeCommand(
              claims.workspaceId,
              'agent.run',
              continuationPayload(
                command.payload,
                task,
                engineSessionId,
                'Finalization pass. All required evidence is already satisfied. Do not call tools. Give the user a concise final result based only on the verified evidence and completed work.',
              ),
              10 * 60_000,
            );
            console.info(`[harness] forced final synthesis run=${runId}`);
            return;
          }

          if (task.harness.verification.status !== 'passed') {
            const requiredUserInput = userInputRequest(responseText);
            if (requiredUserInput && engineSessionId) {
              const waitingAt = new Date().toISOString();
              task.state = 'waiting_input';
              task.partialText = requiredUserInput;
              task.harness = advanceHarnessPhase(task.harness, 'waiting_input', {
                mode: task.mode || 'build',
                permission: effectivePermission,
                now: waitingAt,
              });
              task.updatedAt = waitingAt;
              await repository.putTask(task);
              if (memoryRun) {
                memoryRun.state = 'waiting_input';
                memoryRun.activity = 'Waiting for you';
                memoryRun.finishedAt = undefined;
                store.save();
              }
              await repository.putMessage({
                id: `msg_${runId || uuid()}:input`,
                sessionId: claims.sessionId,
                role: 'assistant',
                text: requiredUserInput,
                runId: runId || undefined,
                createdAt: waitingAt,
              });
              await persistLiveEvent({
                eventId: `evt_${uuid()}`,
                sessionId: claims.sessionId,
                taskId,
                runId,
                workspaceId: claims.workspaceId,
                type: 'run.state',
                timestamp: waitingAt,
                payload: { state: 'waiting_input', message: requiredUserInput },
              });
              await persistLiveEvent({
                eventId: `evt_${uuid()}`,
                sessionId: claims.sessionId,
                taskId,
                runId,
                workspaceId: claims.workspaceId,
                type: 'message.end',
                timestamp: waitingAt,
                payload: { waitingInput: true },
              });
              return;
            }

            if (shouldReflect(task.harness, responseText) && engineSessionId) {
              const reflectionNow = new Date().toISOString();
              task.harness = prepareReflection(task.harness, recent, reflectionNow);
              task.harness = advanceHarnessPhase(task.harness, 'executing', {
                mode: task.mode || 'build',
                permission: effectivePermission,
                now: reflectionNow,
              });

              const durableSession = await repository.getSession(claims.sessionId);
              const lessons = durableSession
                ? await relevantAgentLessons(durableSession, task.prompt, memoryRun?.provider).catch(() => [])
                : [];
              task.harness = {
                ...task.harness,
                lessonsApplied: lessons.map((lesson) => lesson.id),
              };
              task.updatedAt = reflectionNow;
              await repository.putTask(task);

              const missing = task.harness.verification.missing.join(', ');
              const contradiction = task.harness.contradictions?.[0] || '';
              await persistLiveEvent({
                eventId: `evt_${uuid()}`,
                sessionId: claims.sessionId,
                taskId,
                runId,
                workspaceId: claims.workspaceId,
                type: 'activity.progress',
                timestamp: reflectionNow,
                payload: {
                  sourceType: 'agent.dialogue.orlynx',
                  reflectionId: task.harness.reflectionAttempts,
                  text: `Orlynx → Model: still unverified: ${missing}.${contradiction ? ` ${contradiction}` : ' Re-check the evidence and choose the next diagnostic step.'}`,
                },
              });

              const continuation = [
                reflectionInstruction(task.harness, lessons.map((lesson) => `${lesson.title}: ${lesson.lesson}`)),
                agentMemoryInstruction(lessons),
                publishError ? `Controlled publish note: ${publishError}` : '',
                task.harness.verification.missing.includes('publish')
                  ? 'If publishing is still required, prepare and commit the workspace locally; Orlynx will perform the authenticated push.'
                  : '',
                'Follow the reflection instruction above: stream the one-line Model → Orlynx diagnostic first, then use tools to test it.',
              ].filter(Boolean).join('\n\n');

              await queueBridgeCommand(
                claims.workspaceId,
                'agent.run',
                continuationPayload(command.payload, task, engineSessionId, continuation),
                30 * 60_000,
              );
              console.info(`[harness] reflection run=${runId} attempt=${task.harness.reflectionAttempts} missing=${missing}`);
              return;
            }

            const failedAt = new Date().toISOString();
            const missing = task.harness.verification.missing;
            task.state = 'failed';
            task.partialText = responseText;
            task.harness = {
              ...advanceHarnessPhase(task.harness, 'failed', {
                mode: task.mode || 'build',
                permission: effectivePermission,
                now: failedAt,
              }),
              verification: {
                ...task.harness.verification,
                status: 'failed',
                checkedAt: failedAt,
              },
            };
            task.updatedAt = failedAt;
            await repository.putTask(task);

            const verificationText = `Orlynx could not verify: ${missing.join(', ')}.`;
            const finalText = [responseText, verificationText].filter(Boolean).join('\n\n');
            if (finalText) await repository.putMessage({
              id: `msg_${runId || uuid()}`,
              sessionId: claims.sessionId,
              role: 'assistant',
              text: finalText,
              runId: runId || undefined,
              createdAt: failedAt,
            });

            if (memoryRun) {
              memoryRun.state = 'failed';
              memoryRun.activity = 'Verification needs attention';
              memoryRun.finishedAt = failedAt;
              memoryRun.errorKind = 'verification';
              store.save();
            }

            await persistLiveEvent({ eventId: `evt_${uuid()}`, sessionId: claims.sessionId, taskId, runId, workspaceId: claims.workspaceId, type: 'message.end', timestamp: failedAt, payload: {} });
            await persistLiveEvent({
              eventId: `evt_${uuid()}`,
              sessionId: claims.sessionId,
              taskId,
              runId,
              workspaceId: claims.workspaceId,
              type: 'run.failed',
              timestamp: failedAt,
              payload: {
                error: verificationText,
                errorKind: 'verification',
                recoverable: true,
                missing,
              },
            });
            await promoteNextQueuedRun(claims.sessionId).catch(() => {});
            return;
          }

          const durableSessionForMemory = await repository.getSession(claims.sessionId);
          if (durableSessionForMemory && (task.harness.reflectionAttempts || 0) > 0) {
            const learned = await rememberVerifiedLesson({
              session: durableSessionForMemory,
              task,
              harness: task.harness,
              responseText,
              provider: memoryRun?.provider,
            }).catch(() => []);
            if (learned.length) {
              await persistLiveEvent({
                eventId: `evt_${uuid()}`,
                sessionId: claims.sessionId,
                taskId,
                runId,
                workspaceId: claims.workspaceId,
                type: 'activity.progress',
                timestamp: new Date().toISOString(),
                payload: {
                  sourceType: 'agent.memory',
                  text: `Orlynx learned from this verified recovery · saved ${learned.length} reusable lesson${learned.length === 1 ? '' : 's'}.`,
                  lessonIds: learned,
                },
              });
            }
          }

          const finalizingAt = new Date().toISOString();
          task.harness = advanceHarnessPhase(task.harness, 'finalizing', {
            mode: task.mode || 'build',
            permission: effectivePermission,
            now: finalizingAt,
          });
          await repository.putTask(task);

          if (responseText) await repository.putMessage({
            id: `msg_${runId || uuid()}`,
            sessionId: claims.sessionId,
            role: 'assistant',
            text: responseText,
            runId: runId || undefined,
            createdAt: finalizingAt,
          });

          const completedAt = new Date().toISOString();
          task.state = 'completed';
          task.partialText = undefined;
          task.harness = advanceHarnessPhase(task.harness, 'completed', {
            mode: task.mode || 'build',
            permission: effectivePermission,
            now: completedAt,
          });
          task.updatedAt = completedAt;
          await repository.putTask(task);

          if (memoryRun) {
            memoryRun.state = 'completed';
            memoryRun.activity = 'Ready for review';
            memoryRun.finishedAt = completedAt;
            store.save();
          }

          await persistLiveEvent({ eventId: `evt_${uuid()}`, sessionId: claims.sessionId, taskId, runId, workspaceId: claims.workspaceId, type: 'message.end', timestamp: completedAt, payload: {} });
          await persistLiveEvent({
            eventId: `evt_${uuid()}`,
            sessionId: claims.sessionId,
            taskId,
            runId,
            workspaceId: claims.workspaceId,
            type: 'run.completed',
            timestamp: completedAt,
            payload: {
              summary: 'Verified work completed.',
              verification: task.harness.verification,
            },
          });

          await promoteNextQueuedRun(claims.sessionId).catch((error) => console.warn(`[bridge] queued promotion after verified result failed: ${error instanceof Error ? error.message : 'unknown error'}`));
        }
        return;
      }
      if (message.kind === 'EVENT' && message.event?.type) {
        // Provider semantics are normalized ONCE at the server boundary. React
        // receives the shared canonical protocol; it never sees raw OpenCode
        // event names.
        const runId = message.event.runId;
        const normalized = normalizeBridgeEvent(String(message.event.type), message.event.payload || {});
        if (normalized.heartbeat) return;

        const payload: Record<string, unknown> = { ...normalized.payload };
        const type = normalized.type;

        // Stable tool identity is a protocol invariant, not a UI heuristic.
        if (/^(tool\.|terminal\.|test\.result|build\.result)/.test(type)) {
          const rawToolId = String(
            payload.toolCallId
            || payload.callId
            || payload.ptyId
            || payload.terminalId
            || payload.resultId
            || payload.testId
            || payload.buildId
            || message.event.eventId
            || `${type}:${message.event.sequence || 0}`,
          );
          payload.toolCallId = scopeToolCallId(runId, rawToolId);
          delete payload.callId;
        }

        // Preserve singular file-change semantics for the typed renderer.
        if (type === 'file.changed' && !Array.isArray(payload.files)) {
          const path = String(payload.path || payload.filePath || payload.file || '');
          if (path) {
            payload.files = [{
              path,
              action: String(payload.action || payload.status || 'modify'),
              ...(typeof payload.diff === 'string' ? { diff: payload.diff } : {}),
              ...(typeof payload.before === 'string' ? { before: payload.before } : {}),
              ...(typeof payload.after === 'string' ? { after: payload.after } : {}),
            }];
            payload.count = 1;
          }
        }

        // workspace.state must retain its actual state. The browser must never
        // turn ready/failed/stopped into a generic "preparing" row.
        if (type === 'workspace.state') {
          payload.state = String(payload.state || 'connecting');
        }

        const eventTaskId = String(message.event.taskId || '');
        if (type === 'state.delta' && String(payload.scope || '') === 'harness' && String(payload.engineSessionId || '')) {
          const adapterId = String(payload.adapterId || 'opencode');
          await repository.putAgentSession(claims.sessionId, adapterId, String(payload.engineSessionId));
        }

        if (eventTaskId && (type === 'step.started' || type === 'approval.required' || type === 'approval.resolved')) {
          const task = await repository.getTask(eventTaskId);
          if (task) {
            const effectivePermission = task.tempPermission || task.permission || 'full';
            task.harness ||= createHarnessCheckpoint({
              prompt: task.prompt,
              mode: task.mode || 'build',
              permission: effectivePermission,
              plane: task.plane || 'workspace',
            });

            if (type === 'step.started') {
              task.harness = consumeHarnessStep(task.harness, {
                mode: task.mode || 'build',
                permission: effectivePermission,
              });
              const budget = harnessBudgetStatus(task.harness);
              payload.harnessStep = budget.step;
              payload.harnessBudget = budget.budget;
              payload.harnessRemaining = budget.remaining;
              payload.harnessBudgetStage = budget.stage;
            } else if (type === 'approval.required') {
              task.harness = advanceHarnessPhase(task.harness, 'waiting_approval', {
                mode: task.mode || 'build',
                permission: effectivePermission,
              });
            } else if (type === 'approval.resolved' && task.state === 'running') {
              task.harness = advanceHarnessPhase(task.harness, 'executing', {
                mode: task.mode || 'build',
                permission: effectivePermission,
              });
            }
            task.updatedAt = new Date().toISOString();
            await repository.putTask(task);
          }
        }

        const eventId = bridgeEventKey(
          claims.sessionId,
          runId,
          type,
          payload,
          message.event.eventId,
        );
        await persistLiveEvent({
          eventId,
          sessionId: claims.sessionId,
          workspaceId: claims.workspaceId,
          taskId: message.event.taskId,
          runId,
          type,
          timestamp: new Date().toISOString(),
          payload,
        });
      }
    } catch { console.warn('[bridge] message persistence failed'); ws.close(1011, 'persistence failed'); }
  });
  ws.once('close', async (code) => {
    console.info(`[bridge] socket closed: ${code}, hello: ${authenticatedHello}`);
    active = false; clearTimeout(helloTimeout); clearInterval(commands); clearInterval(credentials);
    if (!isCurrentBridgeSocket(claims.workspaceId, ws)) return;
    unregisterBridgeSocket(claims.workspaceId, ws);
    // A transient socket close may reconnect by itself. Do not immediately
    // SSH back into an idle Codespace: that creates background churn and turns
    // harmless network/deploy blips into expensive bootstrap failures. Only
    // auto-repair when queued/running workspace work actually needs the bridge.
    if (shouldRecoverTransientBridgeClose(authenticatedHello, code)) {
      const graceMs = Math.max(10_000, Number(process.env.ORLYNX_BRIDGE_RECONNECT_GRACE_MS || 20_000));
      console.info(`[bridge] transient transport close; waiting ${Math.round(graceMs / 1000)}s for reconnect`);
      const recovery = setTimeout(async () => {
        if (hasLiveBridge(claims.workspaceId)) return;
        try {
          const current = await repository.getWorkspace(claims.workspaceId);
          if (!current || current.connectionId !== claims.connectionId) return;

          const tasks = await repository.listTasks(claims.sessionId);
          const activeWorkspaceWork = tasks.some((task) =>
            (task.plane || 'workspace') === 'workspace' &&
            (task.state === 'queued' || task.state === 'running')
          );

          const lost = await markWorkspaceConnectionLost(claims.workspaceId);
          if (!lost) return;

          if (!activeWorkspaceWork) {
            console.info(`[bridge] idle workspace transport lost; deferring SSH repair until next Build task workspace=${claims.workspaceId}`);
            return;
          }

          console.warn(`[bridge] active Build work needs transport recovery; scheduling workspace=${claims.workspaceId}`);
          await scheduleWorkspacePreparation({
            sessionId: lost.sessionId,
            userId: lost.userId,
            projectId: lost.projectId,
            repositoryId: lost.repositoryId,
            branch: lost.branch,
          }, { allowFallback: true, reason: 'bridge_recovery' });
        } catch (error) {
          console.warn(`[bridge] automatic transport recovery failed workspace=${claims.workspaceId}: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }, graceMs);
      recovery.unref?.();
      return;
    }
    try { await persistBridgeState(claims, 'disconnected'); } catch {}
  });
  ws.on('error', (error) => { console.warn(`[bridge] socket error: ${error.message}`); ws.close(); });
  ws.send(JSON.stringify({ kind: 'HELLO_REQUEST' }));
}

// Bridge messages are bounded. Provider/model catalogs are normalized before
// crossing this socket, so oversized legacy payload compatibility is gone.
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

export function attachBridgeGateway(server: http.Server): void {
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname !== '/bridge' && pathname !== '/v1/bridge') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request); });
  });
}

export const bridgeGatewayServer = http.createServer((_req, res) => {
  res.writeHead(426, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'WebSocket upgrade required.' }));
});
attachBridgeGateway(bridgeGatewayServer);
wss.on('connection', (ws, request) => { void handleConnection(ws, request); });
