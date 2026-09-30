import { Sandbox } from 'e2b';
import type { WorkspaceRecord } from '@orlynx/shared';
import type { CreateWorkspaceInput, WorkspaceConnectionValues, WorkspaceProvider, WorkspaceProviderHealth } from './workspace-provider.js';
import { githubRepositoryById, githubUserAccessToken } from './github.js';
import { buildWorkspaceBootstrapScript } from './runtime-worker.js';
import { controlPlaneRepository } from './storage.js';
import { decryptCredential } from './credentials.js';

const E2B_CAPABILITIES = ['isolated-vm', 'pause-resume', 'snapshot-capable', 'persistent-filesystem'] as const;

function apiKey(): string {
  return String(process.env.E2B_API_KEY || '').trim();
}

function template(): string {
  return String(process.env.ORLYNX_E2B_TEMPLATE || 'base').trim() || 'base';
}

function timeoutMs(): number {
  return Math.max(5 * 60_000, Number(process.env.ORLYNX_E2B_TIMEOUT_MS || 55 * 60_000));
}

function publicBridgeUrl(): string {
  const base = String(process.env.ORLYNX_PUBLIC_URL || '').replace(/\/$/, '');
  if (!base.startsWith('https://')) throw new Error('ORLYNX_PUBLIC_URL must be HTTPS before E2B workspaces can connect.');
  return `${base.replace(/^https:/, 'wss:')}/bridge`;
}

function requireConfigured(): string {
  const key = apiKey();
  if (!key) throw new Error('E2B is not configured: set E2B_API_KEY.');
  return key;
}

export function e2bConfigured(): boolean {
  return Boolean(apiKey());
}

async function connectSandbox(workspace: WorkspaceRecord): Promise<Sandbox> {
  if (!workspace.providerResourceId) throw new Error('E2B workspace has no sandbox id.');
  return Sandbox.connect(workspace.providerResourceId, {
    apiKey: requireConfigured(),
    timeoutMs: timeoutMs(),
    onResume: 'restore',
  });
}

export class E2BWorkspaceProvider implements WorkspaceProvider {
  readonly id = 'e2b' as const;
  readonly capabilities = E2B_CAPABILITIES;

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    const key = requireConfigured();
    const [repository, githubToken] = await Promise.all([
      githubRepositoryById(input.userId, input.repositoryId),
      githubUserAccessToken(input.userId),
    ]);
    const sandbox = await Sandbox.create(template(), {
      apiKey: key,
      timeoutMs: timeoutMs(),
      metadata: {
        orlynxWorkspaceId: input.workspaceId,
        orlynxSessionId: input.sessionId,
        orlynxProjectId: input.projectId,
        repositoryId: String(input.repositoryId),
        branch: input.branch,
      },
      lifecycle: { onTimeout: 'pause', autoResume: true },
    });

    const basic = Buffer.from(`x-access-token:${githubToken}`).toString('base64');
    const clone = await sandbox.commands.run(
      `mkdir -p /workspace && rm -rf /workspace/repo && git -c http.https://github.com/.extraheader="AUTHORIZATION: basic $ORLYNX_GIT_BASIC" clone --filter=blob:none --single-branch --branch "$ORLYNX_BRANCH" "https://github.com/${repository.fullName}.git" /workspace/repo`,
      {
        timeoutMs: Math.max(120_000, Number(process.env.ORLYNX_E2B_CLONE_TIMEOUT_MS || 180_000)),
        envs: { ORLYNX_GIT_BASIC: basic, ORLYNX_BRANCH: input.branch },
      },
    );
    if (clone.exitCode !== 0) {
      await sandbox.kill().catch(() => undefined);
      throw new Error(`E2B could not clone the repository: ${String(clone.stderr || clone.stdout || '').slice(-1200)}`);
    }

    const now = new Date().toISOString();
    return {
      id: input.workspaceId,
      sessionId: input.sessionId,
      userId: input.userId,
      projectId: input.projectId,
      provider: 'e2b',
      providerResourceId: sandbox.sandboxId,
      repositoryId: input.repositoryId,
      branch: input.branch,
      state: 'connecting',
      bridgeState: 'disconnected',
      runtimeState: 'connecting',
      capabilities: [...E2B_CAPABILITIES],
      providerHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  async start(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    await connectSandbox(workspace);
    const now = new Date().toISOString();
    return {
      ...workspace,
      state: 'connecting',
      bridgeState: 'disconnected',
      runtimeState: 'connecting',
      providerHeartbeatAt: now,
      updatedAt: now,
    };
  }

  async stop(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    if (!workspace.providerResourceId) return { ...workspace, state: 'stopped', bridgeState: 'disconnected' };
    await Sandbox.pause(workspace.providerResourceId, { apiKey: requireConfigured(), keepMemory: true });
    const now = new Date().toISOString();
    return { ...workspace, state: 'stopped', bridgeState: 'disconnected', runtimeState: 'disconnected', providerHeartbeatAt: now, updatedAt: now };
  }

  async get(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    const sandbox = await connectSandbox(workspace);
    const running = await sandbox.isRunning();
    const now = new Date().toISOString();
    return {
      ...workspace,
      state: running ? (workspace.state === 'ready' && workspace.bridgeState === 'ready' ? 'ready' : 'connecting') : 'stopped',
      runtimeState: running ? (workspace.runtimeState === 'ready' ? 'ready' : 'connecting') : 'disconnected',
      providerHeartbeatAt: now,
      updatedAt: now,
    };
  }

  async getStatus(workspace: WorkspaceRecord) {
    return (await this.get(workspace)).state;
  }

  async health(workspace: WorkspaceRecord): Promise<WorkspaceProviderHealth> {
    try {
      const current = await this.get(workspace);
      return { reachable: current.state !== 'failed', state: current.state, capabilities: [...E2B_CAPABILITIES] };
    } catch (error) {
      return {
        reachable: false,
        state: 'failed',
        capabilities: [...E2B_CAPABILITIES],
        detail: error instanceof Error ? error.message : 'E2B health check failed.',
      };
    }
  }

  async destroy(workspace: WorkspaceRecord): Promise<void> {
    if (!workspace.providerResourceId) return;
    try {
      const sandbox = await connectSandbox(workspace);
      await sandbox.kill();
    } catch (error) {
      if (/not found|404/i.test(error instanceof Error ? error.message : '')) return;
      throw error;
    }
  }

  async replace(input: CreateWorkspaceInput, workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    await this.destroy(workspace).catch(() => undefined);
    return this.create(input);
  }

  async connect(workspace: WorkspaceRecord, values: WorkspaceConnectionValues): Promise<void> {
    const sandbox = await connectSandbox(workspace);
    const githubToken = await githubUserAccessToken(workspace.userId);
    const connection = await controlPlaneRepository().getProviderConnection(workspace.userId, 'opencode');
    const openCodeApiKey = connection?.state === 'connected' && connection.credential
      ? decryptCredential(connection.credential)
      : '';
    const script = buildWorkspaceBootstrapScript(workspace, values, publicBridgeUrl(), openCodeApiKey, githubToken);
    const encoded = Buffer.from(script).toString('base64');
    const result = await sandbox.commands.run(
      `printf '%s' "$ORLYNX_BOOTSTRAP_B64" | base64 -d > /tmp/orlynx-bootstrap.sh && chmod 700 /tmp/orlynx-bootstrap.sh && /tmp/orlynx-bootstrap.sh`,
      {
        timeoutMs: Math.max(180_000, Number(process.env.ORLYNX_E2B_BOOTSTRAP_TIMEOUT_MS || 5 * 60_000)),
        envs: {
          ORLYNX_BOOTSTRAP_B64: encoded,
          ORLYNX_REPO_ROOT_HINT: '/workspace/repo',
        },
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(`E2B runtime bootstrap failed: ${String(result.stderr || result.stdout || '').slice(-1600)}`);
    }
  }

  previewUrl(): string | undefined {
    // Preview is intentionally not advertised until Orlynx stores the E2B
    // sandbox domain/traffic token alongside the durable provider handle.
    return undefined;
  }
}
