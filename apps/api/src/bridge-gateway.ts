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
import { authenticateBridgeSocket, hasLiveBridge, isCurrentBridgeSocket, publishLiveBridgeResult, registerBridgeSocket, sendBridgeCommandNow, unregisterBridgeSocket , releaseBridgeCommandDelivery } from './bridge-live.js';
import { scheduleWorkspacePreparation } from './workspace-jobs.js';
import { bridgeEventKey, normalizeBridgeEvent, scopeToolCallId } from './agent-protocol.js';
import { bridgeRequest, queueBridgeCommand } from './bridge-rpc.js';
import { advanceHarnessPhase, blockInvestigation, consumeHarnessStep, createHarnessCheckpoint, evidenceSummary, harnessBudgetStatus, harnessSystemInstruction, markInvestigationLearned, markInvestigationVerifying, needsFinalSynthesis, needsSelectedModelReview, normalizeHarnessPlanItems, openCodeToolsFor, prepareReflection, reflectionInstruction, selectedModelReviewInstruction, shouldReflect, updateInvestigationFromOutcome, userInputRequest, verificationRequirementsFor, verifyHarness } from './harness.js';
import { agentMemoryInstruction, recordMemoryContradictions, relevantAgentLessons, rememberVerifiedLesson } from './agent-memory.js';
import { emitPersisted, sanitizeEvent } from './events.js';
import { providerForWorkspace } from './workspace-providers.js';
import { addChangeEvidence } from './changes.js';
import { publishVerifiedChangeSet, type PublicationStrategy } from './publisher.js';
import { publishIntentFor, publishTargetBranchFor } from './direct-chat.js';
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

async function controlledDefaultBranchPublish(
  workspaceId: string,
  sessionId: string,
  runId?: string,
  strategy: PublicationStrategy = 'direct',
  targetBranch?: string,
) {
  return publishVerifiedChangeSet({
    sessionId,
    workspaceId,
    runId,
    strategy,
    targetBranch,
    commitMessage: 'Orlynx verified changes',
  });
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
    ...(task.harness?.investigation?.id ? { investigationId: task.harness.investigation.id } : {}),
    ...(task.harness?.investigation?.stage ? { investigationStage: task.harness.investigation.stage } : {}),
    ...(task.harness ? { tools: openCodeToolsFor(task.harness) } : {}),
  };
}


async function runIndependentDelegate(input: {
  workspaceId: string;
  sessionId: string;
  taskId: string;
  runId?: string;
  modelId: string;
  role: 'architect' | 'reviewer';
  instruction: string;
}): Promise<string | undefined> {
  const delegationId = `${input.role}_${uuid()}`;
  const label = input.role === 'architect' ? 'architect' : 'reviewer';
  const startedAt = new Date().toISOString();
  await persistLiveEvent({
    eventId: `evt_${uuid()}`,
    sessionId: input.sessionId,
    taskId: input.taskId,
    runId: input.runId,
    workspaceId: input.workspaceId,
    type: 'subagent.started',
    timestamp: startedAt,
    payload: {
      delegationId,
      role: input.role,
      modelId: input.modelId,
      text: `Independent ${label} started · read-only evidence analysis.`,
    },
  });

  try {
    const created = await bridgeRequest<{ status: number; body?: { id?: string } }>(
      input.workspaceId,
      'opencode.request',
      {
        path: '/session',
        method: 'POST',
        body: { title: `Orlynx independent ${label} ${input.runId || input.taskId}` },
        timeoutMs: 15_000,
      },
      20_000,
    );
    const engineSessionId = String(created.body?.id || '');
    if (!engineSessionId) throw new Error(`Independent ${label} session was not created.`);

    const [providerID, ...modelParts] = input.modelId.split('/');
    if (!providerID || !modelParts.length) throw new Error(`Independent ${label} model id is invalid.`);
    const modelID = modelParts.join('/');

    await bridgeRequest(
      input.workspaceId,
      'opencode.request',
      {
        path: `/session/${engineSessionId}/prompt_async`,
        method: 'POST',
        body: {
          parts: [{ type: 'text', text: input.instruction }],
          model: { providerID, modelID },
          tools: {
            read: true,
            grep: true,
            glob: true,
            list: true,
            write: false,
            edit: false,
            patch: false,
            bash: false,
            shell: false,
            webfetch: false,
            websearch: false,
          },
        },
        timeoutMs: 15_000,
      },
      20_000,
    );

    const deadline = Date.now() + 90_000;
    let idle = false;
    while (Date.now() < deadline) {
      const status = await bridgeRequest<{ status: number; body?: Record<string, Record<string, unknown>> }>(
        input.workspaceId,
        'opencode.request',
        { path: '/session/status', method: 'GET', timeoutMs: 10_000 },
        15_000,
      );
      const state = status.body?.[engineSessionId] || {};
      if (String(state.type || '') === 'idle') {
        idle = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (!idle) throw new Error(`Independent ${label} timed out before returning to idle.`);

    const messages = await bridgeRequest<{ status: number; body?: Array<{ info?: Record<string, unknown>; parts?: Array<Record<string, unknown>> }> }>(
      input.workspaceId,
      'opencode.request',
      { path: `/session/${engineSessionId}/message`, method: 'GET', timeoutMs: 10_000 },
      15_000,
    );
    const assistant = [...(messages.body || [])].reverse().find((message) => String(message.info?.role || '') === 'assistant');
    const text = (assistant?.parts || [])
      .filter((part) => part.type === 'text' && !part.synthetic && !part.ignored)
      .map((part) => String(part.text || ''))
      .join('')
      .trim()
      .slice(0, 8_000);
    if (!text) throw new Error(`Independent ${label} completed without a readable response.`);

    await persistLiveEvent({
      eventId: `evt_${uuid()}`,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      type: 'subagent.finished',
      timestamp: new Date().toISOString(),
      payload: {
        delegationId,
        role: input.role,
        modelId: input.modelId,
        state: 'completed',
        summary: text.slice(0, 1_200),
        text: `Independent ${label} finished · findings returned to the primary agent.`,
      },
    });
    return text;
  } catch (error) {
    await persistLiveEvent({
      eventId: `evt_${uuid()}`,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      type: 'subagent.finished',
      timestamp: new Date().toISOString(),
      payload: {
        delegationId,
        role: input.role,
        modelId: input.modelId,
        state: 'failed',
        error: error instanceof Error ? error.message.slice(0, 1_000) : `Independent ${label} failed.`,
        text: `Independent ${label} was unavailable · primary execution continues without fabricating a delegation result.`,
      },
    });
    return undefined;
  }
}

async function runIndependentReviewer(input: Omit<Parameters<typeof runIndependentDelegate>[0], 'role'>): Promise<string | undefined> {
  return runIndependentDelegate({ ...input, role: 'reviewer' });
}

async function runIndependentArchitect(input: Omit<Parameters<typeof runIndependentDelegate>[0], 'role'>): Promise<string | undefined> {
  return runIndependentDelegate({ ...input, role: 'architect' });
}

type BridgeAdapterState = { state?: string; reason?: string };
type BridgeMessage = { kind?: string; commandId?: string; workspaceId?: string; sessionId?: string; userId?: string; connectionId?: string; repoRoot?: string; capabilities?: string[]; adapters?: Record<string, BridgeAdapterState>; adapterId?: string; adapter?: BridgeAdapterState; ok?: boolean; result?: Record<string, unknown>; error?: string; event?: { eventId?: string; sequence?: number; type?: string; payload?: Record<string, unknown>; taskId?: string; runId?: string } };

type VerificationArtifact = {
  path?: string;
  kind?: string;
  size?: number;
  excerpt?: string;
};
interface VerificationArtifactsResult extends Record<string, unknown> {
  artifacts?: VerificationArtifact[];
}

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
    runtimeState: workspaceReady ? 'ready' : state === 'disconnected' ? 'recovering' : 'connecting',
    capabilities: detail.capabilities || current.capabilities,
    agentHeartbeatAt: state === 'disconnected' ? current.agentHeartbeatAt : now,
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
      payload: { provider: current.provider, adapters, capabilities: detail.capabilities || current.capabilities || [] },
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
        if (command.kind === 'agent.run' && !String(payload.engineSessionId || '') && !String(payload.delegationRole || '')) {
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
      const scopedWorkspace = await repository.getWorkspace(claims.workspaceId);
      if (!scopedWorkspace || scopedWorkspace.connectionId !== claims.connectionId) {
        ws.close(1008, 'superseded workspace connection');
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

        // Durable commands are at-most-once at the state-machine layer. The
        // workspace deliberately replays a remembered RESULT after reconnect,
        // and two API instances can race on the same result. Never let a late
        // duplicate overwrite an expired/failed/completed command or re-run the
        // associated task finalization.
        if (command && (command.status === 'completed' || command.status === 'failed')) {
          const priorResult = command.result || {};
          publishLiveBridgeResult(message.commandId, {
            ok: command.status === 'completed',
            result: priorResult,
            error: command.status === 'failed' ? String(priorResult.error || 'Workspace command failed.') : undefined,
          });
          releaseBridgeCommandDelivery(claims.workspaceId, message.commandId);
          console.info(`[bridge] ignored duplicate terminal result command=${message.commandId} status=${command.status}`);
          return;
        }

        const accepted = await repository.completeCommand(message.commandId, message.ok ? 'completed' : 'failed', resultPayload);
        if (command && !accepted) {
          const latest = await repository.getCommand(message.commandId);
          const priorResult = latest?.result || {};
          publishLiveBridgeResult(message.commandId, {
            ok: latest?.status === 'completed',
            result: priorResult,
            error: latest?.status === 'failed' ? String(priorResult.error || 'Workspace command failed.') : undefined,
          });
          releaseBridgeCommandDelivery(claims.workspaceId, message.commandId);
          console.info(`[bridge] ignored raced late result command=${message.commandId} status=${latest?.status || 'unknown'}`);
          return;
        }

        releaseBridgeCommandDelivery(claims.workspaceId, message.commandId);
        publishLiveBridgeResult(message.commandId, { ok: Boolean(message.ok), result: resultPayload, error: message.error });
        if (command?.kind === 'agent.run') {
          const taskId = String(command.payload.taskId || '');
          const runId = String(command.payload.runId || '');
          const delegationRole = String(command.payload.delegationRole || '');
          const task = taskId ? await repository.getTask(taskId) : null;
          const now = new Date().toISOString();

          if (delegationRole) {
            await persistLiveEvent({
              eventId: `evt_${uuid()}`,
              sessionId: claims.sessionId,
              taskId,
              runId,
              workspaceId: claims.workspaceId,
              type: 'subagent.finished',
              timestamp: now,
              payload: {
                subagentId: `${runId || taskId}:${delegationRole}`,
                role: delegationRole,
                state: message.ok ? 'completed' : 'failed',
                modelId: command.payload.model,
              },
            });
          }
          const memoryRun = (store.db.runs[claims.sessionId] || []).find((candidate) => candidate.id === runId);

          if (task && ['cancelled', 'failed', 'completed'].includes(task.state)) {
            console.info(`[bridge] ignored late result for terminal run=${runId} taskState=${task.state}`);
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
                        ? 'The AI workspace connection was interrupted after automatic recovery could not complete safely. Your workspace state is preserved.'
                        : 'Orlynx AI could not complete this task.';
            console.warn(`[bridge] agent run failed session=${claims.sessionId} run=${runId} kind=${errorKind} freePublic=${freePublicModel}`);

            const bridgeRetrySafe = message.result?.retrySafe === true;
            const automaticRecoveryEligible = Boolean(
              task
              && bridgeRetrySafe
              && (errorKind === 'engine' || (errorKind === 'unknown' && /timed out|timeout|connection|transport|stopped making observable progress/i.test(detail)))
              && Number(task.harness?.runtimeRecoveryAttempts || 0) < 2
            );

            if (task && automaticRecoveryEligible) {
              const effectivePermission = task.tempPermission || task.permission || 'full';
              task.harness ||= createHarnessCheckpoint({
                prompt: task.prompt,
                mode: task.mode || 'build',
                permission: effectivePermission,
                plane: task.plane || 'workspace',
                now,
              });
              task.harness = {
                ...advanceHarnessPhase(task.harness, 'routing', {
                  mode: task.mode || 'build',
                  permission: effectivePermission,
                  now,
                }),
                runtimeRecoveryAttempts: Number(task.harness.runtimeRecoveryAttempts || 0) + 1,
              };
              task.state = 'queued';
              task.updatedAt = now;
              await repository.putTask(task);

              if (memoryRun) {
                memoryRun.state = 'queued';
                memoryRun.activity = 'Recovering interrupted task';
                memoryRun.finishedAt = undefined;
                memoryRun.errorKind = undefined;
                store.save();
              }

              await persistLiveEvent({
                eventId: `evt_${uuid()}`,
                sessionId: claims.sessionId,
                taskId,
                runId,
                workspaceId: claims.workspaceId,
                type: 'run.state',
                timestamp: now,
                payload: {
                  state: 'queued',
                  recovered: true,
                  message: 'The agent connection ended before any visible output or side effects · Orlynx is retrying this same task automatically.',
                },
              });
              void promoteNextQueuedRun(claims.sessionId).catch((promoteError) => console.warn(`[bridge] automatic safe retry promotion failed: ${promoteError instanceof Error ? promoteError.message : 'unknown error'}`));
              return;
            }

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
          // RESULT carries the engine's authoritative complete assistant text.
          // Store it with a narrow partial-text update before verification or
          // reflection begins, so a reconnect cannot leave the durable snapshot
          // behind the final visible response.
          if (task && responseText) {
            await repository.setTaskPartialText(task.id, responseText, now);
            task.partialText = responseText;
          }
          const engineSessionId = String(message.result?.engineSessionId || command.payload.engineSessionId || '');
          if (engineSessionId && !delegationRole) {
            const adapterId = String(command.payload.adapterId || 'opencode');
            await repository.putAgentSession(claims.sessionId, adapterId, engineSessionId);
          }

          const rawDiff = Array.isArray(message.result?.diff) ? message.result.diff as Array<Record<string, unknown>> : [];
          const files = rawDiff.flatMap((item) => {
            const file = String(item.file || item.path || '');
            if (!file || file.startsWith('/') || file.split('/').includes('..')) return [];
            return [addChangeEvidence({
              path: file,
              action: item.status === 'added' ? 'create' as const : item.status === 'deleted' ? 'delete' as const : 'modify' as const,
              before: typeof item.before === 'string' ? item.before : undefined,
              after: typeof item.after === 'string' ? item.after : undefined,
              diff: typeof item.diff === 'string' ? item.diff : undefined,
            })];
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
              return {
                path: file.path,
                action: file.action,
                ...(typeof file.additions === 'number' ? { additions: file.additions } : {}),
                ...(typeof file.deletions === 'number' ? { deletions: file.deletions } : {}),
                ...(file.afterHash ? { afterHash: file.afterHash } : {}),
                ...(diff ? { diff } : {}),
              };
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
            const url = preview.url || (previewWorkspace ? await previewProvider?.previewUrl?.(previewWorkspace, preview.port) : undefined);
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
          task.harness = markInvestigationVerifying(task.harness, now);
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

          let recent = (await repository.listRunEvents(claims.sessionId, runId, 1000))
            .map(sanitizeEvent);
          const verificationNow = new Date().toISOString();
          task.harness = verifyHarness(task.harness, recent, verificationNow);
          task.harness = updateInvestigationFromOutcome(task.harness, responseText, recent, verificationNow);

          const correctionSession = await repository.getSession(claims.sessionId);
          const correctedLessons = correctionSession
            ? await recordMemoryContradictions({
                session: correctionSession,
                harness: task.harness,
                responseText,
              }).catch(() => [])
            : [];
          if (correctedLessons.length) {
            await persistLiveEvent({
              eventId: `evt_${uuid()}`,
              sessionId: claims.sessionId,
              taskId,
              runId,
              workspaceId: claims.workspaceId,
              type: 'activity.progress',
              timestamp: verificationNow,
              payload: {
                sourceType: 'agent.memory.corrected',
                text: `Fresh evidence contradicted ${correctedLessons.length} retrieved lesson${correctedLessons.length === 1 ? '' : 's'} · confidence reduced.`,
                lessonIds: correctedLessons,
              },
            });
          }

          if (task.harness.investigation?.stage === 'resolved') {
            await persistLiveEvent({
              eventId: `evt_${uuid()}`,
              sessionId: claims.sessionId,
              taskId,
              runId,
              workspaceId: claims.workspaceId,
              type: 'activity.progress',
              timestamp: verificationNow,
              payload: {
                sourceType: 'agent.dialogue.orlynx',
                reflectionId: task.harness.investigation.attempt,
                investigationId: task.harness.investigation.id,
                investigationStage: 'resolved',
                investigationQuestion: task.harness.investigation.question,
                investigationFailureClass: task.harness.verificationFailureClass,
                investigationEvidence: task.harness.investigation.evidence.slice(-8),
                investigationOutcome: task.harness.investigation.outcome,
                text: `Orlynx → Model: resolved — ${task.harness.investigation.outcome || 'the requested outcome is now verified by current evidence'}.`,
              },
            });
          }
          // Once every requirement except publication is satisfied, bind that
          // evidence to the exact workspace HEAD. Publication will refuse stale
          // evidence if a later commit changes HEAD.
          if (task.harness.verification.missing.every((item) => item === 'publish')) {
            const verifiedStatus = await bridgeRequest<{ head?: string }>(claims.workspaceId, 'git.status', {}, 30_000).catch(() => null);
            if (verifiedStatus?.head) task.harness.verifiedWorkspaceHead = String(verifiedStatus.head);
          }
          await repository.putTask(task);

          let publishError = '';
          const publishSession = await repository.getSession(claims.sessionId);
          const publishMessages = [
            task.prompt,
            ...(task.harness?.inbox || []).map((item) => item.text),
          ].filter((value) => verificationRequirementsFor(String(value)).includes('publish'));
          const publishExplicitlyRequested = publishMessages.length > 0;
          const publishText = String(publishMessages.at(-1) || task.prompt);
          const publishStrategy = publishIntentFor(publishText, publishSession?.branch || '') || 'direct';
          const publishTarget = publishTargetBranchFor(publishText, publishSession?.branch || '') || publishSession?.branch;
          // Existing committed local work can legitimately leave this run with
          // both "changes" and "publish" missing: there was no fresh edit event
          // because the desired commit already existed before the request.
          // Let the controlled publisher recover that committed diff instead of
          // sending the model back to manufacture another edit.
          const publicationRecoverable = task.harness.verification.missing.includes('publish')
            && task.harness.verification.missing.every((item) => item === 'changes' || item === 'publish');

          // Ask-first protects unrequested privileged actions. When the user
          // explicitly wrote "push/publish" in this task (or live steering),
          // that instruction is already the approval for this exact publish.
          if (publicationRecoverable && effectivePermission === 'ask-first' && !publishExplicitlyRequested) {
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
                branch: publishTarget || publishSession?.branch || '',
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
                detail: `Publish the verified commit to ${publishTarget || publishSession?.branch || 'the conversation branch'}.`,
              },
            });
            return;
          }

          if (publicationRecoverable && (effectivePermission === 'full' || publishExplicitlyRequested)) {
            try {
              const published = await controlledDefaultBranchPublish(
                claims.workspaceId,
                claims.sessionId,
                runId,
                publishStrategy,
                publishTarget,
              );
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
              recent = await repository.listRunEvents(claims.sessionId, runId, 1000);
              task.harness = verifyHarness(task.harness, recent, publishedAt);
              task.harness = updateInvestigationFromOutcome(task.harness, responseText, recent, publishedAt);
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

            if (
              engineSessionId
              && task.harness.verification.missing.some((item) => item === 'tests' || item === 'build')
            ) {
              try {
                const artifactResult = await bridgeRequest<VerificationArtifactsResult>(
                  claims.workspaceId,
                  'verification.artifacts',
                  {},
                  15_000,
                );
                const artifacts = Array.isArray(artifactResult.artifacts)
                  ? artifactResult.artifacts
                    .filter((artifact) => artifact && typeof artifact === 'object' && String(artifact.path || '').trim())
                    .slice(0, 16)
                    .map((artifact) => ({
                      path: String(artifact.path || '').slice(0, 1_200),
                      kind: String(artifact.kind || 'artifact').slice(0, 80),
                      size: Number.isFinite(Number(artifact.size)) ? Number(artifact.size) : 0,
                      ...(artifact.excerpt ? { excerpt: String(artifact.excerpt).slice(0, 1_600) } : {}),
                    }))
                  : [];

                if (artifacts.length) {
                  const signature = artifacts.map((artifact) => `${artifact.kind}:${artifact.path}:${artifact.size}`).join('|').slice(0, 8_000);
                  const alreadyRecorded = recent.some((event) =>
                    event.type === 'state.delta'
                    && String(event.payload?.scope || '') === 'verification-artifacts'
                    && String(event.payload?.signature || '') === signature
                  );
                  if (!alreadyRecorded) {
                    const contextCount = artifacts.filter((artifact) => artifact.kind === 'context').length;
                    const screenshotCount = artifacts.filter((artifact) => artifact.kind === 'screenshot').length;
                    const traceCount = artifacts.filter((artifact) => artifact.kind === 'trace').length;
                    const reportCount = artifacts.filter((artifact) => artifact.kind === 'report').length;
                    const paths = artifacts.slice(0, 8).map((artifact) => `${artifact.kind}: ${artifact.path}`);
                    const summary = [
                      `Verification artifacts found: ${artifacts.length}.`,
                      contextCount ? `${contextCount} error context` : '',
                      screenshotCount ? `${screenshotCount} screenshot${screenshotCount === 1 ? '' : 's'}` : '',
                      traceCount ? `${traceCount} trace${traceCount === 1 ? '' : 's'}` : '',
                      reportCount ? `${reportCount} report${reportCount === 1 ? '' : 's'}` : '',
                      paths.length ? `Paths: ${paths.join(' | ')}` : '',
                    ].filter(Boolean).join(' ');

                    await persistLiveEvent({
                      eventId: `evt_${uuid()}`,
                      sessionId: claims.sessionId,
                      taskId,
                      runId,
                      workspaceId: claims.workspaceId,
                      type: 'state.delta',
                      timestamp: new Date().toISOString(),
                      payload: {
                        scope: 'verification-artifacts',
                        sourceType: 'verification.artifacts',
                        signature,
                        summary,
                        artifacts,
                      },
                    });
                    recent = (await repository.listRunEvents(claims.sessionId, runId, 1000))
                      .map(sanitizeEvent);
                  }
                }
              } catch (artifactError) {
                console.info(`[harness] verification artifact discovery unavailable run=${runId}: ${artifactError instanceof Error ? artifactError.message : 'unknown error'}`);
              }
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
                  investigationId: task.harness.investigation?.id,
                  investigationStage: task.harness.investigation?.stage,
                  investigationQuestion: task.harness.investigation?.question,
                  investigationFailureClass: task.harness.verificationFailureClass,
                  investigationEvidence: task.harness.investigation?.evidence?.slice(-8),
                  text: `Orlynx → Model: ${task.harness.investigation?.question || `I cannot verify ${missing}.${contradiction ? ` ${contradiction}` : ''} What does the current evidence imply, and what is the next check that would resolve the uncertainty?`}`,
                },
              });

              const architectReview = task.modelId && (
                Number(task.harness.reflectionAttempts || 0) >= 2
                || Number(task.harness.stagnantReflections || 0) > 0
                || task.harness.verificationFailureClass === 'unknown'
              )
                ? await runIndependentArchitect({
                    workspaceId: claims.workspaceId,
                    sessionId: claims.sessionId,
                    taskId,
                    runId,
                    modelId: task.modelId,
                    instruction: [
                      'You are Orlynx\'s independent read-only architect in a separate agent session.',
                      `Task: ${task.prompt}`,
                      `Missing verification: ${task.harness.verification.missing.join(', ') || 'unknown'}`,
                      `Failure class: ${task.harness.verificationFailureClass || 'unknown'}`,
                      task.harness.investigation?.question ? `Investigation question: ${task.harness.investigation.question}` : '',
                      task.harness.investigation?.hypothesis ? `Current hypothesis: ${task.harness.investigation.hypothesis}` : '',
                      task.harness.investigation?.nextCheck ? `Current next check: ${task.harness.investigation.nextCheck}` : '',
                      task.harness.reflectionEvidence?.length ? `Evidence: ${task.harness.reflectionEvidence.join(' | ')}` : '',
                      'Do not edit files. Challenge the current diagnosis and return: ARCHITECT HYPOTHESIS, EVIDENCE, and ONE DISCRIMINATING NEXT CHECK. Prefer a different diagnostic path if the primary run is stagnant.',
                    ].filter(Boolean).join('\n\n'),
                  })
                : undefined;

              const continuation = [
                reflectionInstruction(task.harness, lessons.map((lesson) => `${lesson.title}: ${lesson.lesson}`)),
                architectReview
                  ? `Independent architect findings from a separate read-only agent session:\n${architectReview}\nTreat this as a challenge, not authority. Test the proposed next check before changing code.`
                  : '',
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
            task.harness = blockInvestigation(
              task.harness,
              `Investigation budget exhausted before Orlynx could verify: ${missing.join(', ') || 'requested outcome'}.`,
              failedAt,
            );
            if (task.harness.investigation) {
              await persistLiveEvent({
                eventId: `evt_${uuid()}`,
                sessionId: claims.sessionId,
                taskId,
                runId,
                workspaceId: claims.workspaceId,
                type: 'activity.progress',
                timestamp: failedAt,
                payload: {
                  sourceType: 'agent.dialogue.orlynx',
                  reflectionId: task.harness.investigation.attempt,
                  investigationId: task.harness.investigation.id,
                  investigationStage: 'blocked',
                  investigationQuestion: task.harness.investigation.question,
                  investigationFailureClass: task.harness.verificationFailureClass,
                  investigationEvidence: task.harness.investigation.evidence.slice(-8),
                  investigationOutcome: task.harness.investigation.outcome,
                  text: `Orlynx → Model: blocked — ${task.harness.investigation.outcome || 'the remaining issue could not be verified inside the investigation budget'}`,
                },
              });
            }
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
                investigation: task.harness.investigation,
              },
            });
            await promoteNextQueuedRun(claims.sessionId).catch(() => {});
            return;
          }

          // A follow-up can land after the initial steering check while
          // verification/final synthesis is still running. Re-read durable task
          // state before learning/finalizing so no human update is silently
          // stranded behind a completed run.
          const latestBeforeFinalize = await repository.getTask(task.id);
          const lateSteering = latestBeforeFinalize?.harness?.inbox.filter((item) => !item.appliedAt) || [];
          if (latestBeforeFinalize && lateSteering.length && engineSessionId) {
            const continuedAt = new Date().toISOString();
            latestBeforeFinalize.harness = {
              ...latestBeforeFinalize.harness!,
              inbox: latestBeforeFinalize.harness!.inbox.map((item) => item.appliedAt ? item : { ...item, appliedAt: continuedAt }),
            };
            latestBeforeFinalize.harness = advanceHarnessPhase(latestBeforeFinalize.harness, 'executing', {
              mode: latestBeforeFinalize.mode || 'build',
              permission: effectivePermission,
              now: continuedAt,
            });
            latestBeforeFinalize.state = 'running';
            latestBeforeFinalize.updatedAt = continuedAt;
            await repository.putTask(latestBeforeFinalize);

            await persistLiveEvent({
              eventId: `evt_${uuid()}`,
              sessionId: claims.sessionId,
              taskId,
              runId,
              workspaceId: claims.workspaceId,
              type: 'activity.progress',
              timestamp: continuedAt,
              payload: {
                sourceType: 'agent.dialogue.orlynx',
                reflectionId: latestBeforeFinalize.harness.steeringRevision || 1,
                text: 'Orlynx → Model: a newer user follow-up arrived before finalization. Continue this same run and incorporate it before completing.',
              },
            });

            await queueBridgeCommand(
              claims.workspaceId,
              'agent.run',
              continuationPayload(
                command.payload,
                latestBeforeFinalize,
                engineSessionId,
                [
                  'Continue the same Orlynx task. A user update arrived just before finalization:',
                  ...lateSteering.map((item) => `[${item.action.toUpperCase()}] ${item.text}`),
                  'Incorporate the update, preserve completed work, then re-verify before finalizing.',
                ].join('\n'),
              ),
              30 * 60_000,
            );
            return;
          }

          if (needsSelectedModelReview(task.harness, task.mode || 'build', task.modelId) && engineSessionId && task.modelId) {
            const reviewAt = new Date().toISOString();
            const durableSessionForReview = await repository.getSession(claims.sessionId);
            const lessons = durableSessionForReview
              ? await relevantAgentLessons(durableSessionForReview, task.prompt, memoryRun?.provider).catch(() => [])
              : [];

            task.harness = {
              ...markInvestigationVerifying(advanceHarnessPhase(task.harness, 'executing', {
                mode: task.mode || 'build',
                permission: effectivePermission,
                now: reviewAt,
              }), reviewAt),
              modelReviewAttempts: (task.harness.modelReviewAttempts || 0) + 1,
              modelReviewModelId: task.modelId,
              lessonsApplied: [...new Set([...(task.harness.lessonsApplied || []), ...lessons.map((lesson) => lesson.id)])],
            };
            task.state = 'running';
            task.updatedAt = reviewAt;
            await repository.putTask(task);

            await persistLiveEvent({
              eventId: `evt_${uuid()}`,
              sessionId: claims.sessionId,
              taskId,
              runId,
              workspaceId: claims.workspaceId,
              type: 'activity.progress',
              timestamp: reviewAt,
              payload: {
                sourceType: 'agent.dialogue.orlynx',
                reflectionId: `review:${task.harness.modelReviewAttempts}`,
                modelId: task.modelId,
                investigationId: task.harness.investigation?.id || `review-${runId}`,
                investigationStage: 'verifying',
                investigationQuestion: 'Does the completed work and evidence actually satisfy the user request without hidden gaps or regressions?',
                investigationEvidence: evidenceSummary(recent).slice(-8),
                text: `Orlynx → Model: verification passed. Before I finalize, independently review the evidence and completed work. Challenge unsupported claims or missed requirements, fix anything questionable, and only approve what the evidence supports.`,
              },
            });

            const independentReview = await runIndependentReviewer({
              workspaceId: claims.workspaceId,
              sessionId: claims.sessionId,
              taskId,
              runId,
              modelId: task.modelId,
              instruction: [
                'You are an independent read-only Orlynx reviewer in a separate agent session.',
                selectedModelReviewInstruction(
                  task.harness,
                  task.modelId,
                  evidenceSummary(recent),
                  lessons.map((lesson) => `${lesson.title}: ${lesson.lesson}`),
                ),
                agentMemoryInstruction(lessons),
                'Do not edit files. Return a concise evidence-grounded review for the primary agent: VERIFIED if the work is sound, or CONCERN followed by the exact unsupported claim, missed requirement, regression risk, or check that still needs to be performed.',
              ].filter(Boolean).join('\n\n'),
            });

            await persistLiveEvent({
              eventId: `evt_${uuid()}`,
              sessionId: claims.sessionId,
              taskId,
              runId,
              workspaceId: claims.workspaceId,
              type: 'subagent.started',
              timestamp: reviewAt,
              payload: {
                subagentId: `${runId || task.id}:reviewer`,
                role: 'reviewer',
                modelId: task.modelId,
                isolatedSession: true,
                text: 'Independent reviewer started in a separate agent session.',
              },
            });

            await queueBridgeCommand(
              claims.workspaceId,
              'agent.run',
              {
                ...continuationPayload(
                  command.payload,
                  task,
                  '',
                  [
                  selectedModelReviewInstruction(
                    task.harness,
                    task.modelId,
                    evidenceSummary(recent),
                    lessons.map((lesson) => `${lesson.title}: ${lesson.lesson}`),
                  ),
                  independentReview
                    ? `Independent reviewer findings from a separate read-only agent session:\n${independentReview}\nUse these findings as evidence to challenge the result. If a concern is valid, inspect/fix it and re-run verification before finalizing; do not merely echo the reviewer.`
                    : 'Independent reviewer was unavailable. Perform the mandatory review yourself using fresh tool evidence; do not claim an independent review occurred.',
                  agentMemoryInstruction(lessons),
                ].filter(Boolean).join('\n\n'),
                ),
                engineSessionId: '',
                delegationRole: 'reviewer',
              },
              30 * 60_000,
            );
            console.info(`[harness] mandatory selected-model review run=${runId} model=${task.modelId}`);
            return;
          }

          const durableSessionForMemory = await repository.getSession(claims.sessionId);
          let learnedLessonIds: string[] = [];
          if (durableSessionForMemory && ((task.harness.reflectionAttempts || 0) > 0 || (task.harness.modelReviewAttempts || 0) > 0)) {
            learnedLessonIds = await rememberVerifiedLesson({
              session: durableSessionForMemory,
              task,
              harness: task.harness,
              responseText,
              provider: memoryRun?.provider,
            }).catch(() => []);
            if (learnedLessonIds.length) {
              const learnedAt = new Date().toISOString();
              task.harness = markInvestigationLearned(task.harness, learnedLessonIds, learnedAt);
              await repository.putTask(task);
              await persistLiveEvent({
                eventId: `evt_${uuid()}`,
                sessionId: claims.sessionId,
                taskId,
                runId,
                workspaceId: claims.workspaceId,
                type: 'activity.progress',
                timestamp: learnedAt,
                payload: {
                  sourceType: 'agent.memory',
                  investigationId: task.harness.investigation?.id,
                  investigationStage: task.harness.investigation?.stage,
                  text: `Orlynx learned from this verified recovery · saved ${learnedLessonIds.length} reusable lesson${learnedLessonIds.length === 1 ? '' : 's'}.`,
                  lessonIds: learnedLessonIds,
                },
              });
            }
          }

          const finalizingAt = new Date().toISOString();
          task.harness = {
            ...task.harness,
            ...(task.harness.modelReviewAttempts ? { modelReviewCompletedAt: finalizingAt } : {}),
          };
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
        if (normalized.heartbeat) {
          const now = new Date().toISOString();
          const heartbeatPayload = message.event.payload || {};
          const capabilities = Array.isArray(heartbeatPayload.capabilities) ? heartbeatPayload.capabilities.map(String) : undefined;
          await repository.touchWorkspaceRuntime(claims.workspaceId, {
            runtimeState: 'ready',
            capabilities,
            agentHeartbeatAt: now,
          });

          const activeTaskIds = new Set(
            Array.isArray(heartbeatPayload.activeTaskIds)
              ? heartbeatPayload.activeTaskIds.map(String).filter(Boolean)
              : [],
          );
          if (activeTaskIds.size) {
            const tasks = await repository.listTasks(claims.sessionId);
            let touchedTask = false;
            for (const task of tasks) {
              if (
                (task.plane || 'workspace') !== 'workspace'
                || task.state !== 'running'
                || !activeTaskIds.has(task.id)
              ) continue;
              task.updatedAt = now;
              await repository.putTask(task);
              touchedTask = true;
            }
            if (touchedTask) await repository.touchWorkspaceRuntime(claims.workspaceId, { taskHeartbeatAt: now });
          }
          return;
        }

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

        if (eventTaskId && type === 'activity.progress' && String(payload.sourceType || '') === 'agent.plan') {
          const task = await repository.getTask(eventTaskId);
          if (task) {
            const now = new Date().toISOString();
            const effectivePermission = task.tempPermission || task.permission || 'full';
            task.harness ||= createHarnessCheckpoint({
              prompt: task.prompt,
              mode: task.mode || 'build',
              permission: effectivePermission,
              plane: task.plane || 'workspace',
              now,
            });
            const planItems = normalizeHarnessPlanItems(payload.items);
            task.harness = {
              ...task.harness,
              planItems,
              planUpdatedAt: now,
              lastProgressAt: now,
              lastCheckpointAt: now,
              updatedAt: now,
            };
            task.updatedAt = now;
            await repository.putTask(task);
            payload.items = planItems;
            payload.completed = planItems.filter((item) => item.status === 'completed' || item.status === 'cancelled').length;
            payload.total = planItems.length;
            payload.active = planItems.find((item) => item.status === 'in_progress')?.content || '';
          }
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
        const persisted = await persistLiveEvent({
          eventId,
          sessionId: claims.sessionId,
          workspaceId: claims.workspaceId,
          taskId: message.event.taskId,
          runId,
          type,
          timestamp: new Date().toISOString(),
          payload,
        });

        // Workspace text is not merely transport telemetry. Fold persisted
        // deltas from the authoritative event ledger while locking the task row.
        // Async WebSocket callbacks can overlap; read/modify/write here used to
        // lose chunks under bursty streaming. The repository cursor makes replay
        // and concurrent delivery idempotent and sequence-correct.
        if (eventTaskId && type === 'message.delta' && typeof payload.delta === 'string' && payload.delta) {
          await repository.checkpointTaskPartialFromEvents(eventTaskId, persisted.sequence);
        }
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
    try {
      await persistBridgeState(claims, 'disconnected');
      await repository.touchWorkspaceRuntime(claims.workspaceId, { runtimeState: 'recovering' });
    } catch {}
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
