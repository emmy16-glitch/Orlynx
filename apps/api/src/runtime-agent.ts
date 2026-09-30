import type { WorkspaceRecord } from '@orlynx/shared';
import { bridgeRequest } from './bridge-rpc.js';

export interface RuntimeHealth {
  bridge: 'ready' | 'unreachable';
  adapters: Record<string, { state?: string; reason?: string }>;
  capabilities: string[];
  activityAt?: string;
}

export interface RuntimeExecResult extends Record<string, unknown> {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RuntimePort {
  port: number;
  visibility?: string;
  url?: string;
}

export class RuntimeAgentClient {
  constructor(readonly workspaceId: string) {}

  async health(timeoutMs = 15_000): Promise<RuntimeHealth> {
    const result = await bridgeRequest<Record<string, unknown>>(this.workspaceId, 'health', {}, timeoutMs);
    return {
      bridge: String(result.bridge || '') === 'ready' ? 'ready' : 'unreachable',
      adapters: (result.adapters && typeof result.adapters === 'object' ? result.adapters : {}) as RuntimeHealth['adapters'],
      capabilities: Array.isArray(result.capabilities) ? result.capabilities.map(String) : [],
      activityAt: result.activityAt ? String(result.activityAt) : undefined,
    };
  }

  async capabilities(timeoutMs = 15_000): Promise<string[]> {
    const result = await bridgeRequest<{ capabilities?: unknown[] }>(this.workspaceId, 'runtime.capabilities', {}, timeoutMs);
    return Array.isArray(result.capabilities) ? result.capabilities.map(String) : [];
  }

  async exec(command: string, args: string[] = [], options: { cwd?: string; timeoutMs?: number } = {}): Promise<RuntimeExecResult> {
    return bridgeRequest<RuntimeExecResult>(this.workspaceId, 'command.exec', {
      command,
      args,
      cwd: options.cwd || '.',
      timeoutMs: options.timeoutMs || 120_000,
    }, Math.max(30_000, options.timeoutMs || 120_000) + 5_000);
  }

  async listFiles(path = '.'): Promise<string[]> {
    const result = await bridgeRequest<{ files?: unknown[] }>(this.workspaceId, 'fs.list', { path });
    return Array.isArray(result.files) ? result.files.map(String) : [];
  }

  async readFile(path: string): Promise<{ path: string; content: string }> {
    return bridgeRequest<{ path: string; content: string }>(this.workspaceId, 'fs.read', { path });
  }

  async gitStatus(): Promise<Record<string, unknown>> {
    return bridgeRequest(this.workspaceId, 'git.status');
  }

  async ports(): Promise<RuntimePort[]> {
    const result = await bridgeRequest<{ ports?: RuntimePort[] }>(this.workspaceId, 'ports.list');
    return Array.isArray(result.ports) ? result.ports : [];
  }
}

export function runtimeAgent(workspace: Pick<WorkspaceRecord, 'id'> | string): RuntimeAgentClient {
  return new RuntimeAgentClient(typeof workspace === 'string' ? workspace : workspace.id);
}
