import type { WorkspaceRecord, WorkspaceState } from '@orlynx/shared';
import { decryptCredential } from './credentials.js';
import { githubUserAccessToken } from './github.js';
import { controlPlaneRepository } from './storage.js';
import type { CreateWorkspaceInput, WorkspaceConnectionValues, WorkspaceProvider } from './workspace-provider.js';

type RunnerWorkspace = {
  runnerId: string;
  state?: string;
  repoRoot?: string;
  detail?: string;
};

function runnerBaseUrl(): string {
  return (process.env.ORLYNX_RUNNER_URL || '').replace(/\/$/, '');
}

function runnerToken(): string {
  return process.env.ORLYNX_RUNNER_TOKEN || '';
}

export function orlynxRunnerConfigured(): boolean {
  return runnerBaseUrl().startsWith('https://') && Boolean(runnerToken());
}

function mapState(value?: string): WorkspaceState {
  switch (String(value || '').toLowerCase()) {
    case 'ready':
    case 'running':
      return 'connecting';
    case 'starting':
    case 'provisioning':
    case 'cloning':
      return 'starting';
    case 'stopping':
      return 'stopping';
    case 'stopped':
    case 'idle':
      return 'stopped';
    case 'failed':
      return 'failed';
    default:
      return 'starting';
  }
}

export class OrlynxRunnerProvider implements WorkspaceProvider {
  readonly id = 'orlynx-runner' as const;

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const base = runnerBaseUrl();
    const token = runnerToken();
    if (!base.startsWith('https://') || !token) throw new Error('Orlynx runner infrastructure is not configured.');
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers as Record<string, string> || {}),
      },
      signal: init.signal || AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string; detail?: string };
      const detail = body.detail || body.error || `HTTP ${response.status}`;
      throw new Error(`Orlynx runner request failed: ${detail}`);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    const githubToken = await githubUserAccessToken(input.userId);
    const result = await this.request<RunnerWorkspace>('/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        userId: input.userId,
        repositoryId: input.repositoryId,
        branch: input.branch,
        githubToken,
      }),
      signal: AbortSignal.timeout(Math.max(30_000, Number(process.env.ORLYNX_RUNNER_CREATE_TIMEOUT_MS || 60_000))),
    });
    if (!result.runnerId) throw new Error('Orlynx runner did not return a runner identity.');
    const now = new Date().toISOString();
    return {
      id: input.workspaceId,
      sessionId: input.sessionId,
      userId: input.userId,
      projectId: input.projectId,
      provider: this.id,
      runnerId: result.runnerId,
      repositoryId: input.repositoryId,
      branch: input.branch,
      state: mapState(result.state),
      bridgeState: 'disconnected',
      repoRoot: result.repoRoot,
      createdAt: now,
      updatedAt: now,
    };
  }

  async connect(workspace: WorkspaceRecord, values: WorkspaceConnectionValues): Promise<void> {
    if (!workspace.runnerId) throw new Error('Workspace has no Orlynx runner identity.');
    const publicUrl = (process.env.ORLYNX_PUBLIC_URL || '').replace(/\/$/, '');
    if (!publicUrl.startsWith('https://')) throw new Error('ORLYNX_PUBLIC_URL must be HTTPS before a runner can connect.');

    const openCodeConnection = await controlPlaneRepository().getProviderConnection(workspace.userId, 'opencode');
    const openCodeApiKey = openCodeConnection?.state === 'connected' && openCodeConnection.credential
      ? decryptCredential(openCodeConnection.credential)
      : '';

    await this.request<void>(`/v1/workspaces/${encodeURIComponent(workspace.runnerId)}/connect`, {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: workspace.id,
        sessionId: workspace.sessionId,
        userId: workspace.userId,
        bridgeUrl: `${publicUrl.replace(/^https:/, 'wss:')}/bridge`,
        bridgeToken: values.bridgeToken,
        connectionId: values.connectionId,
        openCodePassword: values.openCodePassword,
        openCodeApiKey,
      }),
      signal: AbortSignal.timeout(Math.max(15_000, Number(process.env.ORLYNX_RUNNER_CONNECT_TIMEOUT_MS || 30_000))),
    });
  }

  async get(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    if (!workspace.runnerId) return workspace;
    const result = await this.request<RunnerWorkspace>(`/v1/workspaces/${encodeURIComponent(workspace.runnerId)}`);
    return {
      ...workspace,
      state: workspace.state === 'ready' && mapState(result.state) === 'connecting' ? 'ready' : mapState(result.state),
      repoRoot: result.repoRoot || workspace.repoRoot,
      failureCode: String(result.state || '').toLowerCase() === 'failed'
        ? (result.detail || workspace.failureCode || 'Runner failed to prepare the workspace.')
        : workspace.failureCode,
      updatedAt: new Date().toISOString(),
    };
  }

  async getStatus(workspace: WorkspaceRecord): Promise<WorkspaceState> {
    return (await this.get(workspace)).state;
  }

  async start(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    if (!workspace.runnerId) throw new Error('Workspace has no Orlynx runner identity.');
    const result = await this.request<RunnerWorkspace>(`/v1/workspaces/${encodeURIComponent(workspace.runnerId)}/start`, { method: 'POST', body: '{}' });
    return { ...workspace, state: mapState(result.state), updatedAt: new Date().toISOString() };
  }

  async stop(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    if (!workspace.runnerId) throw new Error('Workspace has no Orlynx runner identity.');
    await this.request<void>(`/v1/workspaces/${encodeURIComponent(workspace.runnerId)}/stop`, { method: 'POST', body: '{}' });
    return { ...workspace, state: 'stopped', bridgeState: 'disconnected', connectionId: undefined, updatedAt: new Date().toISOString() };
  }

  async destroy(workspace: WorkspaceRecord): Promise<void> {
    if (!workspace.runnerId) return;
    await this.request<void>(`/v1/workspaces/${encodeURIComponent(workspace.runnerId)}`, { method: 'DELETE' });
  }

  async replace(input: CreateWorkspaceInput, workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    await this.destroy(workspace).catch(() => {});
    return this.create(input);
  }
}
