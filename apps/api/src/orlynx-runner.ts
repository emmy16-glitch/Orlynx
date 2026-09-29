import crypto from 'node:crypto';
import type { WorkspaceRecord, WorkspaceState } from '@orlynx/shared';
import { decryptCredential } from './credentials.js';
import { githubUserAccessToken } from './github.js';
import {
  noteRunnerHostFailure,
  noteRunnerHostSuccess,
  rankedRunnerHosts,
  runnerHostById,
  runnerPoolConfigured,
  type RunnerHostConfig,
} from './runner-pool.js';
import { controlPlaneRepository } from './storage.js';
import type { CreateWorkspaceInput, WorkspaceConnectionValues, WorkspaceProvider } from './workspace-provider.js';

type RunnerWorkspace = {
  runnerId: string;
  state?: string;
  repoRoot?: string;
  detail?: string;
};

class RunnerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hostId: string,
  ) {
    super(message);
  }
}

function runnerToken(): string {
  return process.env.ORLYNX_RUNNER_TOKEN || '';
}

export function orlynxRunnerConfigured(): boolean {
  return runnerPoolConfigured();
}

function signedPreviewUrl(workspace: WorkspaceRecord, port: number): string | undefined {
  if (!workspace.runnerId || !Number.isInteger(port) || port <= 1024 || port > 65535) return undefined;
  const host = runnerHostById(workspace.runnerHostId);
  const base = host?.publicUrl || '';
  const secret = runnerToken();
  if (!base.startsWith('https://') || !secret) return undefined;
  const expires = Math.floor(Date.now() / 1000) + Math.max(60, Number(process.env.ORLYNX_PREVIEW_TOKEN_TTL_SECONDS || 600));
  const material = `${workspace.runnerId}:${port}:${expires}`;
  const signature = crypto.createHmac('sha256', secret).update(material).digest('base64url');
  return `${base}/preview/${encodeURIComponent(workspace.runnerId)}/${port}/?t=${expires}.${signature}`;
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

  private async request<T>(host: RunnerHostConfig, path: string, init: RequestInit = {}): Promise<T> {
    const token = runnerToken();
    if (!host.url.startsWith('https://') || !token) throw new Error('Orlynx runner infrastructure is not configured.');
    try {
      const response = await fetch(`${host.url}${path}`, {
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
        noteRunnerHostFailure(host.id);
        throw new RunnerRequestError(`Orlynx runner request failed on ${host.id}: ${detail}`, response.status, host.id);
      }
      noteRunnerHostSuccess(host.id);
      return response.status === 204 ? undefined as T : await response.json() as T;
    } catch (error) {
      if (!(error instanceof RunnerRequestError)) noteRunnerHostFailure(host.id);
      throw error;
    }
  }

  private hostFor(workspace: WorkspaceRecord): RunnerHostConfig {
    const host = runnerHostById(workspace.runnerHostId);
    if (!host) throw new Error('No Orlynx runner host is configured.');
    return host;
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    const githubToken = await githubUserAccessToken(input.userId);
    const excluded = new Set<string>();
    let lastError: unknown;

    for (;;) {
      const candidates = await rankedRunnerHosts(excluded);
      if (!candidates.length) break;

      for (const host of candidates) {
        excluded.add(host.id);
        try {
          const result = await this.request<RunnerWorkspace>(host, '/v1/workspaces', {
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
            runnerHostId: host.id,
            repositoryId: input.repositoryId,
            branch: input.branch,
            state: mapState(result.state),
            bridgeState: 'disconnected',
            repoRoot: result.repoRoot,
            createdAt: now,
            updatedAt: now,
          };
        } catch (error) {
          lastError = error;
          // Capacity, temporary host failure, or a host-local runner problem can
          // be satisfied by another healthy host. Authentication/repository
          // failures will repeat elsewhere, but trying another host is still
          // bounded by the configured pool size.
          continue;
        }
      }
      break;
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('No healthy Orlynx runner host has available capacity.');
  }

  async connect(workspace: WorkspaceRecord, values: WorkspaceConnectionValues): Promise<void> {
    if (!workspace.runnerId) throw new Error('Workspace has no Orlynx runner identity.');
    const publicUrl = (process.env.ORLYNX_PUBLIC_URL || '').replace(/\/$/, '');
    if (!publicUrl.startsWith('https://')) throw new Error('ORLYNX_PUBLIC_URL must be HTTPS before a runner can connect.');

    const openCodeConnection = await controlPlaneRepository().getProviderConnection(workspace.userId, 'opencode');
    const openCodeApiKey = openCodeConnection?.state === 'connected' && openCodeConnection.credential
      ? decryptCredential(openCodeConnection.credential)
      : '';
    const githubToken = await githubUserAccessToken(workspace.userId);
    const host = this.hostFor(workspace);

    await this.request<void>(host, `/v1/workspaces/${encodeURIComponent(workspace.runnerId)}/connect`, {
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
        githubToken,
      }),
      signal: AbortSignal.timeout(Math.max(15_000, Number(process.env.ORLYNX_RUNNER_CONNECT_TIMEOUT_MS || 30_000))),
    });
  }

  async get(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    if (!workspace.runnerId) return workspace;
    const host = this.hostFor(workspace);
    const result = await this.request<RunnerWorkspace>(host, `/v1/workspaces/${encodeURIComponent(workspace.runnerId)}`);
    return {
      ...workspace,
      runnerHostId: host.id,
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
    const host = this.hostFor(workspace);
    const result = await this.request<RunnerWorkspace>(host, `/v1/workspaces/${encodeURIComponent(workspace.runnerId)}/start`, { method: 'POST', body: '{}' });
    return { ...workspace, runnerHostId: host.id, state: mapState(result.state), updatedAt: new Date().toISOString() };
  }

  async stop(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    if (!workspace.runnerId) throw new Error('Workspace has no Orlynx runner identity.');
    const host = this.hostFor(workspace);
    await this.request<void>(host, `/v1/workspaces/${encodeURIComponent(workspace.runnerId)}/stop`, { method: 'POST', body: '{}' });
    return { ...workspace, runnerHostId: host.id, state: 'stopped', bridgeState: 'disconnected', connectionId: undefined, updatedAt: new Date().toISOString() };
  }

  async destroy(workspace: WorkspaceRecord): Promise<void> {
    if (!workspace.runnerId) return;
    const host = this.hostFor(workspace);
    await this.request<void>(host, `/v1/workspaces/${encodeURIComponent(workspace.runnerId)}`, { method: 'DELETE' });
  }

  async replace(input: CreateWorkspaceInput, workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    const failedHost = workspace.runnerHostId;
    await this.destroy(workspace).catch(() => {});
    if (failedHost) noteRunnerHostFailure(failedHost);
    return this.create(input);
  }

  previewUrl(workspace: WorkspaceRecord, port: number): string | undefined {
    return signedPreviewUrl(workspace, port);
  }
}
