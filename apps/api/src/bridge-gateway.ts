import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import { createBridgeToken, verifyBridgeToken, type BridgeClaims } from './bridge-auth.js';
import { controlPlaneRepository } from './storage.js';
import { decryptCredential } from './credentials.js';

type BridgeMessage = { kind?: string; commandId?: string; workspaceId?: string; sessionId?: string; userId?: string; connectionId?: string; repoRoot?: string; openCode?: { state?: string }; ok?: boolean; result?: Record<string, unknown>; error?: string; event?: { type?: string; payload?: Record<string, unknown>; taskId?: string; runId?: string } };
const activeSockets = new Map<string, WebSocket>();

function bearer(request: http.IncomingMessage): string {
  const header = String(request.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

async function persistBridgeState(claims: BridgeClaims, state: 'connecting' | 'ready' | 'disconnected', detail: BridgeMessage = {}) {
  const repository = controlPlaneRepository();
  const current = await repository.getWorkspace(claims.workspaceId);
  if (!current || current.sessionId !== claims.sessionId || current.userId !== claims.userId) throw new Error('Workspace credential scope does not match durable state.');
  // A prior socket may close after its replacement has authenticated. Never
  // let that stale close (or a delayed READY) downgrade the new connection.
  if (current.connectionId !== claims.connectionId) return;
  const openCodeState = detail.openCode?.state as typeof current.openCodeState | undefined;
  const ready = state === 'ready' && openCodeState === 'ready';
  const startupFailed = state === 'ready' && openCodeState === 'failed';
  await repository.putWorkspace({ ...current, connectionId: claims.connectionId, bridgeState: state === 'disconnected' ? 'disconnected' : state, openCodeState: openCodeState || (state === 'disconnected' ? 'unavailable' : current.openCodeState), state: startupFailed || current.state === 'failed' ? 'failed' : ready ? 'ready' : state === 'disconnected' ? 'connecting' : current.state === 'bootstrapping' ? 'connecting' : current.state, failureCode: startupFailed ? 'OpenCode did not start in the Codespace.' : current.failureCode, repoRoot: detail.repoRoot || current.repoRoot, updatedAt: new Date().toISOString() });
  if (ready) await repository.appendEvent({ eventId: `evt_${uuid()}`, sessionId: claims.sessionId, workspaceId: claims.workspaceId, type: 'workspace.ready', timestamp: new Date().toISOString(), payload: { provider: 'github-codespaces' } });
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
  const commands = setInterval(async () => {
    if (!active || !authenticatedHello || ws.readyState !== ws.OPEN) return;
    try {
      for (const command of await repository.claimCommands(claims.workspaceId)) ws.send(JSON.stringify({ kind: 'COMMAND', commandId: command.id, type: command.kind, payload: command.payload }));
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
      if (message.kind === 'READY') {
        console.info(`[bridge] agent reported OpenCode ${message.openCode?.state === 'ready' ? 'ready' : 'unavailable'}`);
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
        return;
      }
      if (message.kind === 'RESULT' && message.commandId) {
        const command = await repository.getCommand(message.commandId);
        await repository.completeCommand(message.commandId, message.ok ? 'completed' : 'failed', message.result || { error: message.error || 'Workspace command failed.' });
        if (command?.kind === 'agent.run') {
          const taskId = String(command.payload.taskId || ''); const runId = String(command.payload.runId || ''); const task = taskId ? await repository.getTask(taskId) : null; const now = new Date().toISOString();
          if (task && task.state !== 'cancelled') { task.state = message.ok ? 'completed' : 'failed'; task.updatedAt = now; await repository.putTask(task); }
          if (message.ok) {
            const responseText = String(message.result?.responseText || '');
            if (responseText) await repository.putMessage({ id: `msg_${runId || uuid()}`, sessionId: claims.sessionId, role: 'assistant', text: responseText, createdAt: now });
            if (message.result?.engineSessionId) await repository.putEngineSession(claims.sessionId, String(message.result.engineSessionId));
            const rawDiff = Array.isArray(message.result?.diff) ? message.result.diff as Array<Record<string, unknown>> : [];
            const files = rawDiff.flatMap((item) => { const file = String(item.file || item.path || ''); if (!file || file.startsWith('/') || file.split('/').includes('..')) return []; return [{ path: file, action: item.status === 'added' ? 'create' as const : item.status === 'deleted' ? 'delete' as const : 'modify' as const, before: typeof item.before === 'string' ? item.before : undefined, after: typeof item.after === 'string' ? item.after : undefined, diff: typeof item.diff === 'string' ? item.diff : undefined }]; });
            if (files.length) await repository.putChangeSet({ id: `chg_${uuid()}`, sessionId: claims.sessionId, runId, baseSha: String(message.result?.head || ''), files, reviewState: 'pending', createdAt: now });
            await repository.appendEvent({ eventId: `evt_${uuid()}`, sessionId: claims.sessionId, taskId, runId, workspaceId: claims.workspaceId, type: 'message.end', timestamp: now, payload: {} });
            await repository.appendEvent({ eventId: `evt_${uuid()}`, sessionId: claims.sessionId, taskId, runId, workspaceId: claims.workspaceId, type: 'run.completed', timestamp: now, payload: { summary: 'Work completed. Review the result.' } });
          } else {
            await repository.appendEvent({ eventId: `evt_${uuid()}`, sessionId: claims.sessionId, taskId, runId, workspaceId: claims.workspaceId, type: 'run.failed', timestamp: now, payload: { error: 'Orlynx AI could not complete this task.' } });
          }
        }
        return;
      }
      if (message.kind === 'EVENT' && message.event?.type) {
        if (message.event.type === 'heartbeat') return;
        const allowed = new Set(['message.delta', 'tool.started', 'tool.output', 'tool.completed', 'tool.failed', 'activity.progress']);
        const eventType = allowed.has(message.event.type) ? message.event.type as 'message.delta' : 'activity.progress';
        await repository.appendEvent({ eventId: `evt_${uuid()}`, sessionId: claims.sessionId, workspaceId: claims.workspaceId, taskId: message.event.taskId, runId: message.event.runId, type: eventType, timestamp: new Date().toISOString(), payload: eventType === 'activity.progress' ? { sourceType: message.event.type, ...(message.event.payload || {}) } : message.event.payload || {} });
      }
    } catch { console.warn('[bridge] message persistence failed'); ws.close(1011, 'persistence failed'); }
  });
  ws.once('close', async (code) => { console.info(`[bridge] socket closed: ${code}, hello: ${authenticatedHello}`); active = false; clearTimeout(helloTimeout); clearInterval(commands); clearInterval(credentials); if (activeSockets.get(claims.workspaceId) !== ws) return; activeSockets.delete(claims.workspaceId); try { await persistBridgeState(claims, 'disconnected'); } catch {} });
  ws.send(JSON.stringify({ kind: 'HELLO_REQUEST' }));
}

export const bridgeGatewayServer = http.createServer((_req, res) => { res.writeHead(426, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'WebSocket upgrade required.' })); });
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
bridgeGatewayServer.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (pathname !== '/bridge' && pathname !== '/v1/bridge') { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request); });
});
wss.on('connection', (ws, request) => { void handleConnection(ws, request); });
