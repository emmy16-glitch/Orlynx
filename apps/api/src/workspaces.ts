// Codespaces is fail-closed until a remote execution bridge is configured.
export interface WorkspaceInfo {
  id: string; sessionId: string; project: string; branch: string;
  provider: 'codespaces'; state: 'preparing' | 'ready' | 'reconnecting' | 'stopped' | 'failed';
  updatedAt: string; externalId?: string;
}

// No local timer or fabricated workspace state is returned as cloud readiness.
export function getWorkspace(_sessionId: string): WorkspaceInfo | undefined { return undefined; }
