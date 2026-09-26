import type { WorkspaceRecord, WorkspaceState } from '@orlynx/shared';
import type { CreateWorkspaceInput, WorkspaceProvider } from './workspace-provider.js';
import { githubUserAccessToken } from './github.js';
import { controlPlaneRepository } from './storage.js';
import { spawn } from 'node:child_process';

const API = 'https://api.github.com';
type Codespace = {
  name: string;
  display_name?: string;
  state: string;
  repository?: { id: number };
  git_status?: { ref?: string };
  last_used_at?: string;
  created_at?: string;
  updated_at?: string;
};

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

function branchMatches(codespace: Codespace, branch: string): boolean {
  const ref = String(codespace.git_status?.ref || '');
  return !ref || ref === branch || ref.endsWith(`/${branch}`);
}

function ageMs(value?: string): number {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : Number.POSITIVE_INFINITY;
}

export function orlynxSessionId(displayName?: string): string | null {
  const match = String(displayName || '').match(/^Orlynx\s+(ses_[A-Za-z0-9_-]+)$/);
  return match?.[1] || null;
}

export function codespaceMatchesProject(codespace: Codespace, repositoryId: number, branch: string): boolean {
  return codespace.repository?.id === repositoryId
    && branchMatches(codespace, branch)
    && !/failed|deleted/i.test(codespace.state);
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

  private async listUserCodespaces(userId: string): Promise<Codespace[]> {
    const result = await this.request<{ codespaces?: Codespace[] }>(userId, '/user/codespaces?per_page=100');
    return Array.isArray(result.codespaces) ? result.codespaces : [];
  }

  private async reusableForSession(input: CreateWorkspaceInput): Promise<Codespace | null> {
    const expected = `Orlynx ${input.sessionId}`;
    const rows = await this.listUserCodespaces(input.userId).catch(() => []);
    return rows.find((item) =>
      item.display_name === expected &&
      codespaceMatchesProject(item, input.repositoryId, input.branch)
    ) || null;
  }

  private async sessionHasActiveWork(sessionId: string): Promise<boolean> {
    try {
      const tasks = await controlPlaneRepository().listTasks(sessionId);
      return tasks.some((task) => task.state === 'running' || task.state === 'queued');
    } catch {
      return true;
    }
  }

  private async reusableForProject(input: CreateWorkspaceInput): Promise<Codespace | null> {
    const rows = await this.listUserCodespaces(input.userId).catch(() => []);
    const candidates = rows
      .filter((item) =>
        item.display_name !== `Orlynx ${input.sessionId}` &&
        Boolean(orlynxSessionId(item.display_name)) &&
        codespaceMatchesProject(item, input.repositoryId, input.branch) &&
        /available|starting|rebuilding|shutdown/i.test(item.state)
      )
      .sort((a, b) => {
        const aStopped = /shutdown/i.test(a.state) ? 1 : 0;
        const bStopped = /shutdown/i.test(b.state) ? 1 : 0;
        return bStopped - aStopped || ageMs(b.last_used_at || b.updated_at || b.created_at) - ageMs(a.last_used_at || a.updated_at || a.created_at);
      });

    const repository = controlPlaneRepository();
    for (const candidate of candidates) {
      const previousSessionId = orlynxSessionId(candidate.display_name);
      if (!previousSessionId || await this.sessionHasActiveWork(previousSessionId)) continue;
      const previousWorkspace = await repository.getWorkspaceBySession(previousSessionId).catch(() => null);
      if (previousWorkspace?.codespaceName && previousWorkspace.codespaceName !== candidate.name) continue;

      if (previousWorkspace?.codespaceName === candidate.name) {
        const now = new Date().toISOString();
        await repository.putWorkspace({
          ...previousWorkspace,
          codespaceName: undefined,
          state: 'failed',
          bridgeState: 'disconnected',
          connectionId: undefined,
          failureCode: 'This Orlynx Codespace was reused by a newer session for the same repository. Start Build again to reconnect.',
          updatedAt: now,
        });
      }
      return candidate;
    }
    return null;
  }

  private async waitUntilStopped(userId: string, name: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await this.listUserCodespaces(userId);
      const current = rows.find((item) => item.name === name);
      if (!current || /shutdown/i.test(current.state)) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error('GitHub did not finish stopping the old Orlynx Codespace before Orlynx retried.');
  }

  private async reclaimIdleOrlynxCodespace(userId: string, excludeName?: string): Promise<string | null> {
    const rows = await this.listUserCodespaces(userId).catch(() => []);
    const candidates = rows
      .filter((item) =>
        item.name !== excludeName &&
        Boolean(orlynxSessionId(item.display_name)) &&
        /available|starting|rebuilding|shutdown/i.test(item.state) &&
        ageMs(item.last_used_at || item.updated_at || item.created_at) > 2 * 60_000
      )
      .sort((a, b) => ageMs(b.last_used_at || b.updated_at || b.created_at) - ageMs(a.last_used_at || a.updated_at || a.created_at));

    for (const candidate of candidates) {
      const sessionId = orlynxSessionId(candidate.display_name);
      if (!sessionId || await this.sessionHasActiveWork(sessionId)) continue;
      if (!/shutdown/i.test(candidate.state)) {
        await this.request<Codespace>(userId, `/user/codespaces/${encodeURIComponent(candidate.name)}/stop`, { method: 'POST' });
        await this.waitUntilStopped(userId, candidate.name);
      }
      return candidate.name;
    }
    return null;
  }
  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    const now = new Date().toISOString();

    // Recover only the exact Codespace created for this session. Cross-session
    // reuse looked efficient, but an old Codespace can remain visible through
    // GitHub's REST API while its SSH/runtime transport is no longer usable.
    // When quota is tight we reclaim an idle Orlynx Codespace and create a
    // fresh environment instead of inheriting stale runtime state.
    const existing = await this.reusableForSession(input);
    if (existing) {
      const recovered: WorkspaceRecord = {
        id: input.workspaceId,
        sessionId: input.sessionId,
        userId: input.userId,
        projectId: input.projectId,
        provider: 'github-codespaces',
        codespaceName: existing.name,
        repositoryId: input.repositoryId,
        branch: input.branch,
        state: mappedState(existing.state),
        bridgeState: 'disconnected',
        createdAt: now,
        updatedAt: now,
      };
      return recovered.state === 'stopped' ? this.start(recovered) : recovered;
    }

    const create = () => this.request<Codespace>(input.userId, '/user/codespaces', {
      method: 'POST',
      body: JSON.stringify({
        repository_id: input.repositoryId,
        ref: input.branch,
        display_name: `Orlynx ${input.sessionId}`,
        idle_timeout_minutes: Number(process.env.ORLYNX_CODESPACE_IDLE_MINUTES || 30),
        retention_period_minutes: Number(process.env.ORLYNX_CODESPACE_RETENTION_MINUTES || 60),
      }),
    });

    let result: Codespace;
    try {
      result = await create();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!/too many codespaces running/i.test(message)) throw error;

      // Reclaim only an old Orlynx-owned Codespace. Never stop an unrelated
      // personal environment just to make room.
      const reclaimed = await this.reclaimIdleOrlynxCodespace(input.userId);
      if (!reclaimed) {
        throw new Error('GitHub has reached your running Codespace limit. Orlynx could not find an old idle Orlynx environment to stop safely.');
      }
      // GitHub's stop endpoint is asynchronous. Do not immediately retry
      // creation while the old environment still counts against the running
      // Codespace quota.
      await this.waitUntilStopped(input.userId, reclaimed);
      result = await create();
    }

    return {
      id: input.workspaceId,
      sessionId: input.sessionId,
      userId: input.userId,
      projectId: input.projectId,
      provider: 'github-codespaces',
      codespaceName: result.name,
      repositoryId: input.repositoryId,
      branch: input.branch,
      state: mappedState(result.state),
      bridgeState: 'disconnected',
      createdAt: now,
      updatedAt: now,
    };
  }
  async replace(input: CreateWorkspaceInput, workspace: WorkspaceRecord) {
    const oldName = workspace.codespaceName;
    if (oldName) {
      await this.destroy(workspace);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const rows = await this.listUserCodespaces(input.userId).catch(() => []);
        if (!rows.some((item) => item.name === oldName)) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const remaining = await this.listUserCodespaces(input.userId).catch(() => []);
      if (remaining.some((item) => item.name === oldName)) {
        throw new Error('GitHub did not finish deleting the broken Codespace before replacement.');
      }
    }
    return this.create(input);
  }

  async rebuild(workspace: WorkspaceRecord) {
    if (!workspace.codespaceName) throw new Error('Workspace has no Codespace name.');
    const token = await githubUserAccessToken(workspace.userId);
    const timeoutMs = Math.max(60_000, Number(process.env.ORLYNX_CODESPACE_REBUILD_TIMEOUT_MS || 8 * 60_000));
    await new Promise<void>((resolve, reject) => {
      const child = spawn('gh', ['codespace', 'rebuild', '-c', workspace.codespaceName || ''], {
        env: { ...process.env, GH_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        const detail = (stderr || stdout).trim().slice(-1200);
        finish(new Error(`Codespace rebuild did not finish within ${Math.round(timeoutMs / 1000)} seconds${detail ? `: ${detail}` : '.'}`));
      }, timeoutMs);
      timer.unref?.();
      child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-4000); });
      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
      child.once('error', (error) => finish(error));
      child.once('exit', (code, signal) => {
        if (settled) return;
        if (code === 0) finish();
        else finish(new Error(`Codespace rebuild failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${(stderr || stdout).trim().slice(-1600)}`));
      });
    });
    return {
      ...workspace,
      state: 'starting' as const,
      bridgeState: 'disconnected' as const,
      connectionId: undefined,
      failureCode: undefined,
      updatedAt: new Date().toISOString(),
    };
  }
  async start(workspace: WorkspaceRecord) {
    if (!workspace.codespaceName) throw new Error('Workspace has no Codespace name.');
    const result = await this.request<Codespace>(workspace.userId, `/user/codespaces/${encodeURIComponent(workspace.codespaceName)}/start`, { method: 'POST' });
    return { ...workspace, state: mappedState(result.state), updatedAt: new Date().toISOString() };
  }
  async stop(workspace: WorkspaceRecord) {
    if (!workspace.codespaceName) throw new Error('Workspace has no Codespace name.');
    await this.request<Codespace>(workspace.userId, `/user/codespaces/${encodeURIComponent(workspace.codespaceName)}/stop`, { method: 'POST' });
    return { ...workspace, state: 'stopped' as const, bridgeState: 'disconnected' as const , updatedAt: new Date().toISOString() };
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
    try {
      await this.request<void>(workspace.userId, `/user/codespaces/${encodeURIComponent(workspace.codespaceName)}`, { method: 'DELETE' });
    } catch (error) {
      // Replacement is idempotent: if GitHub already deleted the persisted
      // Codespace, there is nothing left to destroy.
      if ((error as Error & { status?: number })?.status === 404) return;
      throw error;
    }
  }
}
