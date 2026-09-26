import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import { createBridgeToken, verifyBridgeToken, type BridgeClaims } from './bridge-auth.js';
import { controlPlaneRepository } from './storage.js';
import { decryptCredential } from './credentials.js';
import { classifyError } from './ai.js';
import { promoteNextQueuedRun } from './agents.js';
import { store } from './store.js';
import { markWorkspaceConnectionLost, prepareWorkspace, shouldRecoverTransientBridgeClose } from './workspaces.js';

type BridgeAdapterState = { state?: string; reason?: string };
type BridgeMessage = { kind?: string; commandId?: string; workspaceId?: string; sessionId?: string; userId?: string; connectionId?: string; repoRoot?: string; openCode?: BridgeAdapterState; adapters?: Record<string, BridgeAdapterState>; adapterId?: string; adapter?: BridgeAdapterState; ok?: boolean; result?: Record<string, unknown>; error?: string; event?: { type?: string; payload?: Record<string, unknown>; taskId?: string; runId?: string } };
const activeSockets = new Map<string, WebSocket>();

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
  if (adapterId === 'opencode') {
    await repository.putWorkspace({ ...current, openCodeState: state, updatedAt: now });
  }
  await repository.appendEvent({
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
  const adapters = detail.adapters || (detail.openCode ? { opencode: detail.openCode } : {});
  const openCodeState = (adapters.opencode?.state || detail.openCode?.state) as typeof current.openCodeState | undefined;
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
    // Legacy compatibility only. Generic adapter health is stored separately.
    openCodeState: openCodeState || (state === 'disconnected' ? 'unavailable' : current.openCodeState),
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
    await repository.appendEvent({
      eventId: `evt_${uuid()}`,
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      type: 'state.delta',
      timestamp: now,
      payload: { scope: 'agent-adapter', adapterId, state: adapterState, ...(adapter.reason ? { reason: adapter.reason } : {}) },
    });
  }

  if (workspaceReady) {
    await repository.appendEvent({
      eventId: `evt_${uuid()}`,
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      type: 'workspace.ready',
      timestamp: now,
      payload: { provider: 'github-codespaces', adapters },
    });
  }
}

async function handleConnection(ws: WebSocket, request: http.IncomingMessage) {
  let claims: BridgeClaims;
  try { claims = verifyBridgeToken(bearer(request)); }
  catch { console.warn('[bridge] handshake rejected: credential'); ws.close(1008, 'unauthorized'); return; }
  try { await persistBridgeState(claims, 'connecting'); }
  catch { console.warn('[bridge] handshake rejected: workspace scope or storage'); ws.close(1008, 'workspace scope rejected'); return; }
  console.info('[bridge] credential accepted');

  let active = true;
  let authenticatedHello = false;
  const helloTimeout = setTimeout(() => { if (!authenticatedHello) ws.close(1008, 'hello timeout'); }, 15_000);
  activeSockets.set(claims.workspaceId, ws);
  const repository = controlPlaneRepository();
  // A durable "sent" command is eligible for delivery retry after its lease
  // expires. Never re-execute that retry on the same transport: it is only
  // useful after a socket replacement. This also protects older bridge
  // processes that do not yet de-duplicate commands while they are running.
  const deliveredOnSocket = new Set<string>();
  const commands = setInterval(async () => {
    if (!active || !authenticatedHello || ws.readyState !== ws.OPEN) return;
    try {
      for (const command of await repository.claimCommands(claims.workspaceId)) {
        if (deliveredOnSocket.has(command.id)) continue;
        deliveredOnSocket.add(command.id);
        ws.send(JSON.stringify({ kind: 'COMMAND', commandId: command.id, type: command.kind, payload: command.payload }));
      }
    } catch { /* the next poll retries queued commands */ }
  }, 300);
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
        clearTimeout(helloTimeout);
        console.info('[bridge] hello authenticated');
        ws.send(JSON.stringify({ kind: 'AUTHENTICATED', token: createBridgeToken({ workspaceId: claims.workspaceId, sessionId: claims.sessionId, userId: claims.userId, connectionId: claims.connectionId }) }));
        return;
      }
      if (message.kind === 'ADAPTER_STATUS' && message.adapterId && message.adapter) {
        await persistAdapterState(claims, String(message.adapterId), message.adapter);
        console.info(`[bridge] adapter status ${message.adapterId}=${message.adapter.state || 'unknown'}`);
        if (message.adapter.state === 'ready') {
          void promoteNextQueuedRun(claims.sessionId).catch((error) => console.warn(`[bridge] queued promotion after adapter ready failed: ${error instanceof Error ? error.message : 'unknown error'}`));
        }
        return;
      }
      if (message.kind === 'READY') {
        const reported = message.adapters || (message.openCode ? { opencode: message.openCode } : {});
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
        void promoteNextQueuedRun(claims.sessionId).catch((error) => console.warn(`[bridge] queued promotion after READY failed: ${error instanceof Error ? error.message : 'unknown error'}`));
        return;
      }
      if (message.kind === 'RESULT' && message.commandId) {
        const command = await repository.getCommand(message.commandId);
        await repository.completeCommand(message.commandId, message.ok ? 'completed' : 'failed', message.result || { error: message.error || 'Workspace command failed.' });
        if (command?.kind === 'agent.run') {
          const taskId = String(command.payload.taskId || ''); const runId = String(command.payload.runId || ''); const task = taskId ? await repository.getTask(taskId) : null; const now = new Date().toISOString();
          if (task?.state === 'cancelled') {
            console.info(`[bridge] ignored late result for cancelled run=${runId}`);
            void promoteNextQueuedRun(claims.sessionId).catch(() => {});
            return;
          }
          if (task) { task.state = message.ok ? 'completed' : 'failed'; task.updatedAt = now; await repository.putTask(task); }
          const memoryRun = (store.db.runs[claims.sessionId] || []).find((candidate) => candidate.id === runId);
          if (memoryRun) {
            memoryRun.state = message.ok ? 'completed' : 'failed';
            memoryRun.activity = message.ok ? 'Ready for review' : 'Work needs attention';
            memoryRun.finishedAt = now;
            if (!message.ok) memoryRun.errorKind = classifyError(String(message.error || message.result?.error || ''));
            store.save();
          }
          if (message.ok) {
            const responseText = String(message.result?.responseText || '');
            if (responseText) await repository.putMessage({ id: `msg_${runId || uuid()}`, sessionId: claims.sessionId, role: 'assistant', text: responseText, createdAt: now });
            if (message.result?.engineSessionId) {
              const adapterId = String(command.payload.adapterId || 'opencode');
              await repository.putAgentSession(claims.sessionId, adapterId, String(message.result.engineSessionId));
            }
            const rawDiff = Array.isArray(message.result?.diff) ? message.result.diff as Array<Record<string, unknown>> : [];
            const files = rawDiff.flatMap((item) => { const file = String(item.file || item.path || ''); if (!file || file.startsWith('/') || file.split('/').includes('..')) return []; return [{ path: file, action: item.status === 'added' ? 'create' as const : item.status === 'deleted' ? 'delete' as const : 'modify' as const, before: typeof item.before === 'string' ? item.before : undefined, after: typeof item.after === 'string' ? item.after : undefined, diff: typeof item.diff === 'string' ? item.diff : undefined }]; });
            if (files.length) {
              const changeId = `chg_${uuid()}`;
              await repository.putChangeSet({ id: changeId, sessionId: claims.sessionId, runId, baseSha: String(message.result?.head || ''), files, reviewState: 'pending', createdAt: now });
              // Keep activity payloads bounded while still showing developers the
              // actual patch that OpenCode produced. Full diffs remain in Changes.
              let remainingDiffChars = 24_000;
              const activityFiles = files.slice(0, 20).map((file) => {
                const source = file.diff || file.after || file.before || '';
                const diff = source && remainingDiffChars > 0 ? source.slice(0, Math.min(remainingDiffChars, 8_000)) : '';
                remainingDiffChars -= diff.length;
                return { path: file.path, action: file.action, ...(diff ? { diff } : {}) };
              });
              await repository.appendEvent({
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
            await repository.appendEvent({ eventId: `evt_${uuid()}`, sessionId: claims.sessionId, taskId, runId, workspaceId: claims.workspaceId, type: 'message.end', timestamp: now, payload: {} });
            await repository.appendEvent({ eventId: `evt_${uuid()}`, sessionId: claims.sessionId, taskId, runId, workspaceId: claims.workspaceId, type: 'run.completed', timestamp: now, payload: { summary: 'Work completed. Review the result.' } });
          } else {
            const adapterId = String(command.payload.adapterId || 'opencode');
            const detail = String(message.error || message.result?.error || `${adapterId} adapter could not complete the task.`);
            const errorKind = classifyError(detail);
            const error = errorKind === 'rate_limit'
              ? 'The AI provider is temporarily rate limiting requests. Wait a moment and try again.'
              : errorKind === 'quota'
                ? 'The selected AI provider has reached its quota or available credits. Check that provider account or choose another model.'
                : errorKind === 'auth'
                  ? 'The AI provider connection needs to be refreshed before this model can be used.'
                  : errorKind === 'model'
                    ? 'The selected model is not currently available. Choose another model and try again.'
                    : errorKind === 'permission'
                      ? 'This task needs permission that the current access level does not allow.'
                      : errorKind === 'engine'
                        ? 'The AI workspace connection was interrupted. Reconnect the workspace and try again.'
                        : 'Orlynx AI could not complete this task.';
            await repository.appendEvent({
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
          }
          await promoteNextQueuedRun(claims.sessionId).catch((error) => console.warn(`[bridge] queued promotion after result failed: ${error instanceof Error ? error.message : 'unknown error'}`));
        }
        return;
      }
      if (message.kind === 'EVENT' && message.event?.type) {
        if (message.event.type === 'heartbeat') return;
        const allowed = new Set(['message.delta', 'tool.requested', 'tool.started', 'tool.output', 'tool.completed', 'tool.failed', 'activity.progress']);
        const eventType = allowed.has(message.event.type)
          ? message.event.type as 'message.delta' | 'tool.requested' | 'tool.started' | 'tool.output' | 'tool.completed' | 'tool.failed' | 'activity.progress'
          : 'activity.progress';
        await repository.appendEvent({ eventId: `evt_${uuid()}`, sessionId: claims.sessionId, workspaceId: claims.workspaceId, taskId: message.event.taskId, runId: message.event.runId, type: eventType, timestamp: new Date().toISOString(), payload: eventType === 'activity.progress' ? { sourceType: message.event.type, ...(message.event.payload || {}) } : message.event.payload || {} });
      }
    } catch { console.warn('[bridge] message persistence failed'); ws.close(1011, 'persistence failed'); }
  });
  ws.once('close', async (code) => {
    console.info(`[bridge] socket closed: ${code}, hello: ${authenticatedHello}`);
    active = false; clearTimeout(helloTimeout); clearInterval(commands); clearInterval(credentials);
    if (activeSockets.get(claims.workspaceId) !== ws) return;
    activeSockets.delete(claims.workspaceId);
    // A transient socket close may reconnect by itself. Give the bridge a short
    // grace window; if no replacement socket arrives, mark the transport lost
    // and re-bootstrap the existing Codespace automatically. Keeping a dead
    // socket marked "ready" strands queued Build work indefinitely.
    if (shouldRecoverTransientBridgeClose(authenticatedHello, code)) {
      console.info('[bridge] transient transport close; waiting briefly for reconnect');
      const recovery = setTimeout(async () => {
        if (activeSockets.has(claims.workspaceId)) return;
        try {
          const current = await repository.getWorkspace(claims.workspaceId);
          if (!current || current.connectionId !== claims.connectionId) return;
          const lost = await markWorkspaceConnectionLost(claims.workspaceId);
          if (!lost) return;
          console.warn(`[bridge] transient close did not recover; re-bootstrapping workspace=${claims.workspaceId}`);
          await prepareWorkspace({
            sessionId: lost.sessionId,
            userId: lost.userId,
            projectId: lost.projectId,
            repositoryId: lost.repositoryId,
            branch: lost.branch,
          });
          await promoteNextQueuedRun(lost.sessionId);
        } catch (error) {
          console.warn(`[bridge] automatic transport recovery failed workspace=${claims.workspaceId}: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }, 5_000);
      recovery.unref?.();
      return;
    }
    try { await persistBridgeState(claims, 'disconnected'); } catch {}
  });
  ws.on('error', (error) => { console.warn(`[bridge] socket error: ${error.message}`); ws.close(); });
  ws.send(JSON.stringify({ kind: 'HELLO_REQUEST' }));
}

// Existing workspaces can still send OpenCode's full provider catalog until
// they reconnect with the compact bridge. Accept that bounded legacy reply.
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

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
