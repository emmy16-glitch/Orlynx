import { v4 as uuid } from 'uuid';
import { controlPlaneRepository } from './storage.js';
import { sendBridgeCommandNow, waitForLiveBridgeResult } from './bridge-live.js';

export async function bridgeRequest<T extends Record<string, unknown> = Record<string, unknown>>(workspaceId: string, kind: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  const repository = controlPlaneRepository();
  const id = `cmd_${uuid()}`;
  const live = waitForLiveBridgeResult(id);
  try {
    await queueBridgeCommand(workspaceId, kind, payload, timeoutMs, id);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const remaining = Math.max(1, timeoutMs - (Date.now() - started));
      const liveResult = await Promise.race([
        live.promise.then((value) => ({ kind: 'live' as const, value })),
        new Promise<{ kind: 'tick' }>((resolve) => setTimeout(() => resolve({ kind: 'tick' }), Math.min(1_000, remaining))),
      ]);
      if (liveResult.kind === 'live') {
        if (liveResult.value.ok) return liveResult.value.result as T;
        throw new Error(String(liveResult.value.error || liveResult.value.result?.error || 'Workspace command failed.'));
      }

      // Recovery path for deploys, multi-instance routing, or a socket that
      // completed on another API process. The live WebSocket path above is the
      // normal low-latency transport.
      const command = await repository.getCommand(id);
      if (command?.status === 'completed') return (command.result || {}) as T;
      if (command?.status === 'failed') throw new Error(String(command.result?.error || 'Workspace command failed.'));
    }
    throw new Error('Workspace did not respond before the command timed out.');
  } finally {
    live.cancel();
  }
}

export async function queueBridgeCommand(
  workspaceId: string,
  kind: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 30_000,
  commandId = `cmd_${uuid()}`,
): Promise<string> {
  const repository = controlPlaneRepository();
  const now = new Date();
  await repository.queueCommand({
    id: commandId,
    workspaceId,
    kind,
    payload,
    status: 'queued',
    expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  // Best-effort fast path. If no authenticated socket is attached to this API
  // instance, the durable gateway recovery loop will claim and deliver it.
  sendBridgeCommandNow(workspaceId, { id: commandId, kind, payload });
  return commandId;
}
