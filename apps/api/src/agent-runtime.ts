import type { AgentMode } from '@orlynx/shared';
import {
  abortOpenCodeSession,
  getOrCreateOpenCodeSession,
  openCodeDefaultAgent,
  openCodeDiff,
  openCodeMessages,
  openCodeSessionStatus,
  openCodeStatus,
  promptOpenCode,
  type OpenCodeMessage,
  type OpenCodeSession,
} from './opencode.js';

export interface AgentPromptOptions {
  model?: { providerID: string; modelID: string };
  agent?: string;
}

export interface AgentRuntimeAdapter {
  readonly id: string;
  status(project?: string): ReturnType<typeof openCodeStatus>;
  getOrCreateSession(orlynxSessionId: string, project: string): Promise<OpenCodeSession>;
  messages(project: string, engineSessionId: string): Promise<OpenCodeMessage[]>;
  sessionStatus(project: string, engineSessionId: string): Promise<Record<string, any>>;
  diff(project: string, engineSessionId: string): Promise<Record<string, any>[]>;
  prompt(project: string, engineSessionId: string, text: string, options?: AgentPromptOptions): Promise<void>;
  abort(project: string, engineSessionId: string): Promise<void>;
  defaultAgent(mode?: AgentMode): string;
}

// OpenCode is the first production runtime, not the Orlynx product model.
// Agent orchestration depends on this interface so additional real runtimes can
// be added later without changing sessions/events/UI contracts.
export const openCodeRuntime: AgentRuntimeAdapter = {
  id: 'opencode',
  status: (project) => openCodeStatus(project),
  getOrCreateSession: (sessionId, project) => getOrCreateOpenCodeSession(sessionId, project),
  messages: (project, engineSessionId) => openCodeMessages(project, engineSessionId),
  sessionStatus: (project, engineSessionId) => openCodeSessionStatus(project, engineSessionId),
  diff: (project, engineSessionId) => openCodeDiff(project, engineSessionId),
  prompt: (project, engineSessionId, text, options = {}) => promptOpenCode(project, engineSessionId, text, options),
  abort: (project, engineSessionId) => abortOpenCodeSession(project, engineSessionId),
  defaultAgent: () => openCodeDefaultAgent(),
};

export type RuntimeMessage = OpenCodeMessage;
