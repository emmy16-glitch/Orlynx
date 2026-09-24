import { v4 as uuid } from 'uuid';
import { controlPlaneRepository } from './storage.js';

export async function bridgeRequest<T extends Record<string, unknown> = Record<string, unknown>>(workspaceId: string, kind: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  const repository = controlPlaneRepository();
  const id = await queueBridgeCommand(workspaceId, kind, payload, timeoutMs);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const command = await repository.getCommand(id);
    if (command?.status === 'completed') return (command.result || {}) as T;
    if (command?.status === 'failed') throw new Error(String(command.result?.error || 'Workspace command failed.'));
  }
  throw new Error('Workspace did not respond before the command timed out.');
}

export async function queueBridgeCommand(workspaceId: string, kind: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<string> {
  const repository = controlPlaneRepository();
  const id = `cmd_${uuid()}`;
  const now = new Date();
  await repository.queueCommand({ id, workspaceId, kind, payload, status: 'queued', expiresAt: new Date(now.getTime() + timeoutMs).toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString() });
  return id;
}
