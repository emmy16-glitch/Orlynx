import type { WorkspaceRecord, WorkspaceState } from '@orlynx/shared';
import type { CreateWorkspaceInput, WorkspaceProvider } from './workspace-provider.js';
import { githubUserAccessToken } from './github.js';

const API = 'https://api.github.com';
type Codespace = { name: string; state: string; repository?: { id: number }; git_status?: { ref?: string } };

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };
}

function mappedState(value: string): WorkspaceState {
  switch (value.toLowerCase()) {
    case 'available': return 'connecting';
    case 'shutdown': case 'shuttingdown': return 'stopped';
    case 'starting': case 'queued': case 'provisioning': case 'rebuilding': return 'starting';
    case 'failed': case 'unknown': return 'failed';
    default: return 'starting';
  }
}

export class GitHubCodespacesProvider implements WorkspaceProvider {
  private async request<T>(userId: string, path: string, init: RequestInit = {}): Promise<T> {
    const token = await githubUserAccessToken(userId);
    const response = await fetch(`${API}${path}`, { ...init, headers: { ...headers(token), ...(init.headers as Record<string, string> || {}) }, signal: init.signal || AbortSignal.timeout(20_000) });
    if (!response.ok) {
      const requestId = response.headers.get('x-github-request-id');
      const detail = await response.json().catch(() => ({})) as { message?: string };
      const codespacesPath = path.startsWith('/user/codespaces');
      const message = response.status === 403 && codespacesPath
        ? 'GitHub Codespaces permission is not approved for this Orlynx installation.'
        : response.status === 422 && codespacesPath
          ? 'GitHub Codespaces is not available for this repository or account yet.'
          : `GitHub Codespaces request failed (HTTP ${response.status}${requestId ? `, request ${requestId}` : ''})${detail.message ? `: ${detail.message.slice(0, 180)}` : ''}.`;
      const error = new Error(message) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    const now = new Date().toISOString();
    const result = await this.request<Codespace>(input.userId, '/user/codespaces', { method: 'POST', body: JSON.stringify({ repository_id: input.repositoryId, ref: input.branch, display_name: `Orlynx ${input.sessionId}` }) });
    return { id: input.workspaceId, sessionId: input.sessionId, userId: input.userId, projectId: input.projectId, provider: 'github-codespaces', codespaceName: result.name, repositoryId: input.repositoryId, branch: input.branch, state: mappedState(result.state), bridgeState: 'disconnected', openCodeState: 'not_installed', createdAt: now, updatedAt: now };
  }
  async start(workspace: WorkspaceRecord) {
    if (!workspace.codespaceName) throw new Error('Workspace has no Codespace name.');
    const result = await this.request<Codespace>(workspace.userId, `/user/codespaces/${encodeURIComponent(workspace.codespaceName)}/start`, { method: 'POST' });
    return { ...workspace, state: mappedState(result.state), updatedAt: new Date().toISOString() };
  }
  async stop(workspace: WorkspaceRecord) {
    if (!workspace.codespaceName) throw new Error('Workspace has no Codespace name.');
    await this.request<Codespace>(workspace.userId, `/user/codespaces/${encodeURIComponent(workspace.codespaceName)}/stop`, { method: 'POST' });
    return { ...workspace, state: 'stopped' as const, bridgeState: 'disconnected' as const, openCodeState: 'unavailable' as const, updatedAt: new Date().toISOString() };
  }
  async get(workspace: WorkspaceRecord) {
    if (!workspace.codespaceName) return workspace;
    const result = await this.request<Codespace>(workspace.userId, `/user/codespaces/${encodeURIComponent(workspace.codespaceName)}`);
    const state = mappedState(result.state);
    return { ...workspace, state: workspace.state === 'ready' && state === 'connecting' ? 'ready' : state, updatedAt: new Date().toISOString() };
  }
  async getStatus(workspace: WorkspaceRecord) { return (await this.get(workspace)).state; }
  async destroy(workspace: WorkspaceRecord) {
    if (!workspace.codespaceName) return;
    await this.request<void>(workspace.userId, `/user/codespaces/${encodeURIComponent(workspace.codespaceName)}`, { method: 'DELETE' });
  }
}
