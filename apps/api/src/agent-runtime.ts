import type { AgentAdapterId, AgentMode } from '@orlynx/shared';
import {
  abortOpenCodeSession,
  getOrCreateOpenCodeSession,
  openCodeDefaultAgent,
  openCodeDiff,
  openCodeMessages,
  openCodeReadiness,
  openCodeSessionStatus,
  openCodeStatus,
  promptOpenCode,
  type OpenCodeMessage,
  type OpenCodeSession,
} from './opencode.js';
import { openCodeCatalog, resolveModel } from './opencode-catalog.js';
import { controlPlaneRepository } from './storage.js';

export interface AgentPromptOptions {
  model?: { providerID: string; modelID: string };
  agent?: string;
}

export interface AgentAdapterCapabilities {
  workspace: boolean;
  streaming: boolean;
  planMode: boolean;
  approvals: boolean;
  resumeSession: boolean;
  diff: boolean;
}

export interface AgentWorkspacePayloadInput {
  modelId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  engineSessionId?: string | null;
  text: string;
  agent?: string;
}

export interface AgentRuntimeAdapter {
  readonly id: AgentAdapterId;
  readonly displayName: string;
  readonly capabilities: AgentAdapterCapabilities;
  readonly bridgeRunCommand: string;
  readonly bridgeCancelCommand: string;
  status(project?: string, sessionId?: string): ReturnType<typeof openCodeStatus>;
  readiness(project?: string, sessionId?: string): ReturnType<typeof openCodeReadiness>;
  getOrCreateSession(orlynxSessionId: string, project: string): Promise<OpenCodeSession>;
  messages(project: string, engineSessionId: string): Promise<OpenCodeMessage[]>;
  sessionStatus(project: string, engineSessionId: string): Promise<Record<string, any>>;
  diff(project: string, engineSessionId: string): Promise<Record<string, any>[]>;
  prompt(project: string, engineSessionId: string, text: string, options?: AgentPromptOptions): Promise<void>;
  abort(project: string, engineSessionId: string): Promise<void>;
  defaultAgent(mode?: AgentMode): string;
  parseModel(modelId: string): { providerID: string; modelID: string };
  publicAccessForModel(modelId: string): boolean | undefined;
  workspacePayload(input: AgentWorkspacePayloadInput): Record<string, unknown>;
}

function parseProviderModel(modelId: string): { providerID: string; modelID: string } {
  const [providerID, ...rest] = modelId.split('/');
  if (!providerID || !rest.length) throw new Error('Unknown model. Choose a model from the available list.');
  return { providerID, modelID: rest.join('/') };
}

export const openCodeRuntime: AgentRuntimeAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  capabilities: {
    workspace: true,
    streaming: true,
    planMode: true,
    approvals: true,
    resumeSession: true,
    diff: true,
  },
  bridgeRunCommand: 'agent.run',
  bridgeCancelCommand: 'agent.cancel',
  status: (project, sessionId) => openCodeStatus(project, sessionId),
  readiness: (project, sessionId) => openCodeReadiness(project, sessionId),
  getOrCreateSession: (sessionId, project) => getOrCreateOpenCodeSession(sessionId, project),
  messages: (project, engineSessionId) => openCodeMessages(project, engineSessionId),
  sessionStatus: (project, engineSessionId) => openCodeSessionStatus(project, engineSessionId),
  diff: (project, engineSessionId) => openCodeDiff(project, engineSessionId),
  prompt: (project, engineSessionId, text, options = {}) => promptOpenCode(project, engineSessionId, text, options),
  abort: (project, engineSessionId) => abortOpenCodeSession(project, engineSessionId),
  defaultAgent: () => openCodeDefaultAgent(),
  parseModel: parseProviderModel,
  publicAccessForModel: (modelId) => {
    if (!modelId.toLowerCase().startsWith('opencode/')) return undefined;
    try { return resolveModel(openCodeCatalog(), modelId).free; }
    catch { return undefined; }
  },
  workspacePayload: (input) => {
    const model = parseProviderModel(input.modelId);
    const publicAccess = openCodeRuntime.publicAccessForModel(input.modelId);
    return {
      adapterId: 'opencode',
      taskId: input.taskId,
      runId: input.runId,
      sessionId: input.sessionId,
      engineSessionId: input.engineSessionId || '',
      text: input.text,
      model,
      agent: input.agent,
      ...(publicAccess !== undefined ? { openCodePublicAccess: publicAccess } : {}),
    };
  },
};

const adapters = new Map<AgentAdapterId, AgentRuntimeAdapter>([
  [openCodeRuntime.id, openCodeRuntime],
]);

export function defaultAgentAdapterId(): AgentAdapterId {
  return process.env.ORLYNX_DEFAULT_AGENT_ADAPTER || 'opencode';
}

export function getAgentAdapter(id?: AgentAdapterId): AgentRuntimeAdapter {
  const resolved = id || defaultAgentAdapterId();
  const adapter = adapters.get(resolved);
  if (!adapter) throw new Error(`Agent adapter "${resolved}" is not installed in this Orlynx deployment.`);
  return adapter;
}

export function listAgentAdapters(): AgentRuntimeAdapter[] {
  return [...adapters.values()];
}

export async function getWorkspaceAdapterState(workspaceId: string, adapterId: AgentAdapterId) {
  return controlPlaneRepository().getWorkspaceAgentAdapter(workspaceId, adapterId);
}

export type RuntimeMessage = OpenCodeMessage;
