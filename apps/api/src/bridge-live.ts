import type { WebSocket } from 'ws';

export interface LiveBridgeCommand {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

type LiveBridge = {
  socket: WebSocket;
  authenticated: boolean;
  delivered: Set<string>;
};

const liveBridges = new Map<string, LiveBridge>();

export function registerBridgeSocket(workspaceId: string, socket: WebSocket): WebSocket | undefined {
  const previous = liveBridges.get(workspaceId)?.socket;
  liveBridges.set(workspaceId, { socket, authenticated: false, delivered: new Set() });
  return previous;
}

export function authenticateBridgeSocket(workspaceId: string, socket: WebSocket): void {
  const current = liveBridges.get(workspaceId);
  if (current?.socket === socket) current.authenticated = true;
}

export function isCurrentBridgeSocket(workspaceId: string, socket: WebSocket): boolean {
  return liveBridges.get(workspaceId)?.socket === socket;
}

export function unregisterBridgeSocket(workspaceId: string, socket: WebSocket): void {
  if (liveBridges.get(workspaceId)?.socket === socket) liveBridges.delete(workspaceId);
}

export function hasLiveBridge(workspaceId: string): boolean {
  const current = liveBridges.get(workspaceId);
  return Boolean(current?.authenticated && current.socket.readyState === current.socket.OPEN);
}

export function sendBridgeCommandNow(workspaceId: string, command: LiveBridgeCommand): boolean {
  const current = liveBridges.get(workspaceId);
  if (!current?.authenticated || current.socket.readyState !== current.socket.OPEN) return false;
  if (current.delivered.has(command.id)) return true;
  current.delivered.add(command.id);
  current.socket.send(JSON.stringify({
    kind: 'COMMAND',
    commandId: command.id,
    type: command.kind,
    payload: command.payload,
  }));
  return true;
}

type BridgeResult = {
  ok: boolean;
  result: Record<string, unknown>;
  error?: string;
};

const resultWaiters = new Map<string, Set<(value: BridgeResult) => void>>();

export function waitForLiveBridgeResult(commandId: string): { promise: Promise<BridgeResult>; cancel: () => void } {
  let resolvePromise!: (value: BridgeResult) => void;
  const promise = new Promise<BridgeResult>((resolve) => { resolvePromise = resolve; });
  const listeners = resultWaiters.get(commandId) || new Set<(value: BridgeResult) => void>();
  listeners.add(resolvePromise);
  resultWaiters.set(commandId, listeners);
  return {
    promise,
    cancel: () => {
      const current = resultWaiters.get(commandId);
      current?.delete(resolvePromise);
      if (current && current.size === 0) resultWaiters.delete(commandId);
    },
  };
}

export function publishLiveBridgeResult(commandId: string, value: BridgeResult): void {
  const listeners = resultWaiters.get(commandId);
  if (!listeners) return;
  resultWaiters.delete(commandId);
  for (const listener of listeners) listener(value);
}
