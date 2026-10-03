import type { AgentAdapterCapabilities, AgentAdapterId, AgentMode, EventType, ProjectSession } from '@orlynx/shared';
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
} from './opencode.js';
import { openCodeCatalog, resolveModel } from './opencode-catalog.js';
import { controlPlaneRepository } from './storage.js';
import { cancelDirectRun, hasDirectRun, streamDirectRepositoryChat } from './direct-chat.js';

export interface RuntimeSession { id: string; directory?: string }
export interface RuntimeMessage { info: Record<string, any>; parts: Record<string, any>[] }
export interface AgentRuntimeStatus {
  configured: boolean;
  connected: boolean;
  message: string;
  agents?: Record<string, any>[];
  providers?: Record<string, any>[];
  connectedProviders?: string[];
  [key: string]: unknown;
}

export interface AgentPromptOptions {
  model?: { providerID: string; modelID: string };
  agent?: string;
  system?: string;
  tools?: Record<string, boolean>;
}

export interface AgentDirectChatInput {
  runId: string;
  messageId?: string;
  prompt: string;
  acceptedAt?: string;
  session: ProjectSession & { userId: string; projectId: string };
  modelId: string;
  mode: AgentMode;
  harnessSystem?: string;
  onDelta: (delta: string) => void;
  onStatus?: (message: string) => void;
  onActivity?: (type: EventType, payload: Record<string, unknown>) => void;
}

export interface AgentWorkspacePayloadInput {
  modelId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  engineSessionId?: string | null;
  executionGeneration?: number;
  workspaceBaseHead?: string;
  handoff?: import("@orlynx/shared").AgentHandoffCheckpoint;
  mode?: AgentMode;
  permission?: string;
  text: string;
  system?: string;
  tools?: Record<string, boolean>;
  agent?: string;
}

export interface AgentAdapter {
  readonly id: AgentAdapterId;
  readonly displayName: string;
  readonly version?: string;
  /** Explicit provider compatibility; never silently replace the selected model. */
  supportsModel?(modelId: string): boolean;
  supportsDirectModel?(modelId: string): boolean;
  readonly capabilities: AgentAdapterCapabilities;
  readonly bridgeRunCommand: string;
  readonly bridgeCancelCommand: string;
  status(project?: string, sessionId?: string): Promise<AgentRuntimeStatus>;
  readiness(project?: string, sessionId?: string): Promise<{ connected: boolean; message: string }>;
  getOrCreateSession?(orlynxSessionId: string, project: string): Promise<RuntimeSession>;
  messages?(project: string, engineSessionId: string): Promise<RuntimeMessage[]>;
  sessionStatus?(project: string, engineSessionId: string): Promise<Record<string, any>>;
  diff?(project: string, engineSessionId: string): Promise<Record<string, any>[]>;
  prompt?(project: string, engineSessionId: string, text: string, options?: AgentPromptOptions): Promise<void>;
  abort?(project: string, engineSessionId: string): Promise<void>;
  defaultAgent(mode?: AgentMode): string;
  parseModel(modelId: string): { providerID: string; modelID: string };
  publicAccessForModel(modelId: string): boolean | undefined;
  workspacePayload(input: AgentWorkspacePayloadInput): Record<string, unknown>;
  streamDirectChat?(input: AgentDirectChatInput): Promise<string>;
  hasDirectRun?(runId: string): boolean;
  cancelDirectRun?(runId: string): boolean;
}

function parseProviderModel(modelId: string): { providerID: string; modelID: string } {
  const [providerID, ...rest] = modelId.split('/');
  if (!providerID || !rest.length) throw new Error('Unknown model. Choose a model from the available list.');
  return { providerID, modelID: rest.join('/') };
}

export const openCodeRuntime: AgentAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  version: '1.18.32',
  supportsDirectModel: modelId => modelId.startsWith('opencode/'),
  capabilities: {
    repositoryRead: true, repositoryWrite: true, shell: true, tests: true, planning: true, review: true,
    workspace: true,
    directChat: true,
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
  streamDirectChat: (input) => streamDirectRepositoryChat(input),
  hasDirectRun: (runId) => hasDirectRun(runId),
  cancelDirectRun: (runId) => cancelDirectRun(runId),
  workspacePayload: (input) => {
    const model = parseProviderModel(input.modelId);
    const publicAccess = openCodeRuntime.publicAccessForModel(input.modelId);
    return {
      adapterId: 'opencode',
      executionGeneration: input.executionGeneration,
      workspaceBaseHead: input.workspaceBaseHead,
      handoff: input.handoff,
      taskId: input.taskId,
      runId: input.runId,
      sessionId: input.sessionId,
      engineSessionId: input.engineSessionId || '',
      text: input.text,
      ...(input.system ? { system: input.system } : {}),
      ...(input.tools ? { tools: input.tools } : {}),
      model,
      agent: input.agent,
      ...(publicAccess !== undefined ? { openCodePublicAccess: publicAccess } : {}),
    };
  },
};

function workspaceRuntime(id: string, displayName: string): AgentAdapter {
  return {
    id, displayName, version: '1',
    capabilities: { repositoryRead: true, repositoryWrite: true, shell: true, tests: true, planning: true, review: true,
      workspace: true, directChat: false, streaming: true, planMode: true, approvals: false, resumeSession: false, diff: true },
    bridgeRunCommand: 'agent.run', bridgeCancelCommand: 'agent.cancel',
    supportsModel: model => !model.startsWith('opencode/'),
    status: async () => ({ configured: true, connected: false, message: 'Workspace readiness is authoritative.' }),
    readiness: async () => ({ connected: false, message: 'Requires a configured workspace runtime and compatible provider.' }),
    defaultAgent: () => '', parseModel: parseProviderModel,
    publicAccessForModel: () => undefined,
    workspacePayload: input => ({ adapterId: id, taskId: input.taskId, runId: input.runId, sessionId: input.sessionId,
      text: input.text, system: input.system, modelId: input.modelId, tools: input.tools,
      mode: input.mode, permission: input.permission, workspaceBaseHead: input.workspaceBaseHead, executionGeneration: input.executionGeneration, handoff: input.handoff }),
  };
}
export const miniSweRuntime = workspaceRuntime('mini-swe', 'mini-SWE');
export const clineRuntime = workspaceRuntime('cline', 'Cline');

const adapters = new Map<AgentAdapterId, AgentAdapter>([
  [openCodeRuntime.id, openCodeRuntime],
  [miniSweRuntime.id, miniSweRuntime],
  [clineRuntime.id, clineRuntime],
]);

export function defaultAgentAdapterId(): AgentAdapterId {
  return process.env.ORLYNX_DEFAULT_AGENT_ADAPTER || 'opencode';
}

export function getAgentAdapter(id?: AgentAdapterId): AgentAdapter {
  const resolved = id || defaultAgentAdapterId();
  const adapter = adapters.get(resolved);
  if (!adapter) throw new Error(`Agent adapter "${resolved}" is not installed in this Orlynx deployment.`);
  return adapter;
}

export function listAgentAdapters(): AgentAdapter[] {
  return [...adapters.values()];
}

export async function getWorkspaceAdapterState(workspaceId: string, adapterId: AgentAdapterId) {
  return controlPlaneRepository().getWorkspaceAgentAdapter(workspaceId, adapterId);
}


export async function workspaceModelCatalog(sessionId: string): Promise<import('@orlynx/shared').AIModel[]> {
  const repository = controlPlaneRepository();
  const workspace = await repository.getWorkspaceBySession(sessionId);
  if (!workspace) return [];
  const states = await repository.listWorkspaceAgentAdapters(workspace.id);
  return states.flatMap(state => (state.supportedModels || []).map(id => ({ id, providerId: id.split('/')[0],
    providerName: 'Configured workspace endpoint', displayName: id.split('/').slice(1).join('/'), family: 'workspace',
    connected: state.state === 'ready' && Date.now() - Date.parse(state.updatedAt) < 90000,
    status: state.state === 'ready' && Date.now() - Date.parse(state.updatedAt) < 90000 ? 'available' as const : 'unavailable' as const })))
    .filter((model, index, all) => all.findIndex(other => other.id === model.id) === index);
}

/** Native session methods are optional, private adapter facilities. Portable
 * adapters implement the workspace execution contract without inventing them. */
export function requireSessionAdapter(adapter: AgentAdapter): asserts adapter is AgentAdapter & Required<Pick<AgentAdapter, 'getOrCreateSession' | 'messages' | 'sessionStatus' | 'diff' | 'prompt' | 'abort'>> {
  if (!adapter.getOrCreateSession || !adapter.messages || !adapter.sessionStatus || !adapter.diff || !adapter.prompt || !adapter.abort)
    throw new Error(`${adapter.displayName} requires durable workspace execution. Native session access is unsupported.`);
}

/** Direct chat availability is model-specific as well as adapter-specific. */
export function adapterExecutionPlane(adapter: AgentAdapter, modelId: string, requested: 'direct' | 'workspace'): 'direct' | 'workspace' {
  return requested==='direct' && adapter.capabilities.directChat && adapter.supportsDirectModel?.(modelId) ? 'direct' : 'workspace';
}
