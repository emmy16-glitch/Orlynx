import type { AgentMode, PermissionProfile } from '@orlynx/shared';

/**
 * Orlynx canonical agent/UI protocol.
 *
 * Raw provider/bridge/workspace events are adapted into this small lifecycle
 * before React sees them. The shape intentionally follows the strongest common
 * pattern used by AG-UI/Cline/OpenHands: run boundaries, start/update/end text,
 * stable tool-call identity, state snapshots/deltas, and explicit activities.
 */
export type CanonicalAgentEvent =
  | (Base & { type: 'RUN_QUEUED'; position?: number; plane?: string; mode?: AgentMode })
  | (Base & { type: 'RUN_STARTED'; messageId: string; userMessageId?: string; plane?: string; model?: string; mode?: AgentMode; permission?: PermissionProfile })
  | (Base & { type: 'RUN_FINISHED'; summary?: string })
  | (Base & { type: 'RUN_ERROR'; error?: string; errorKind?: string; cancelled?: boolean; retryable?: boolean })
  | (Base & { type: 'TEXT_START'; messageId: string; role: 'assistant' })
  | (Base & { type: 'TEXT_CONTENT'; messageId: string; delta: string })
  | (Base & { type: 'TEXT_END'; messageId: string })
  | (Base & { type: 'TOOL_START'; toolCallId: string; name: string; title?: string; command?: string; path?: string; code?: string })
  | (Base & { type: 'TOOL_UPDATE'; toolCallId: string; output?: string; delta?: string; replace?: boolean })
  | (Base & { type: 'TOOL_END'; toolCallId: string; ok: boolean; error?: string; output?: string; exitCode?: number; files?: unknown[] })
  | (Base & { type: 'ACTIVITY_START'; activityId: string; text: string; sourceType?: string })
  | (Base & { type: 'ACTIVITY_UPDATE'; activityId: string; text: string; sourceType?: string; detail?: Record<string, unknown> })
  | (Base & { type: 'ACTIVITY_END'; activityId: string; text?: string })
  | (Base & { type: 'WORKSPACE_STATE'; activityId: string; state: 'preparing' | 'reconnecting' | 'ready' | 'stopped' | 'failed'; message?: string; provider?: string })
  | (Base & { type: 'STATE_SNAPSHOT'; scope: string; value: Record<string, unknown> })
  | (Base & { type: 'STATE_DELTA'; scope: string; state?: string; value: Record<string, unknown> })
  | (Base & { type: 'CHANGES_UPDATED'; activityId: string; changeId?: string; files: unknown[]; count?: number })
  | (Base & { type: 'RECEIPT'; activityId: string; command?: string; output?: string; exitCode?: number })
  | (Base & { type: 'APPROVAL'; activityId: string; resolved: boolean; action?: string; detail?: string })
  | (Base & { type: 'OTHER'; rawType: string; payload: Record<string, unknown> });

export interface Base {
  eventId: string;
  sessionId: string;
  runId?: string;
  taskId?: string;
  workspaceId?: string;
  sequence: number;
  timestamp: string;
}

export interface AgentStreamRun {
  id: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  messageId: string;
  userMessageId?: string;
  plane?: string;
  model?: string;
  mode?: AgentMode;
  permission?: PermissionProfile;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  errorKind?: string;
}

export interface AgentStreamMessage {
  id: string;
  runId: string;
  role: 'assistant';
  text: string;
  state: 'streaming' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  endedAt?: string;
  lastSequence: number;
  lastEventAt: number;
  userMessageId?: string;
  plane?: string;
}

export interface AgentStreamTool {
  id: string;
  runId?: string;
  taskId?: string;
  sequence: number;
  startedSequence: number;
  timestamp: string;
  state: 'waiting' | 'running' | 'success' | 'failed' | 'cancelled';
  name: string;
  title?: string;
  command?: string;
  path?: string;
  code?: string;
  output?: string;
  error?: string;
  exitCode?: number;
  files?: unknown[];
}

export interface AgentStreamActivity {
  id: string;
  runId?: string;
  taskId?: string;
  sequence: number;
  startedSequence: number;
  timestamp: string;
  state: 'queued' | 'running' | 'success' | 'failed' | 'waiting' | 'cancelled';
  kind: 'agent' | 'workspace' | 'changes' | 'receipt' | 'approval' | 'error';
  title: string;
  summary?: string;
  sourceType?: string;
  evidence?: Record<string, unknown>;
  rawOutput?: string;
}

export interface AgentStreamState {
  version: 1;
  lastSequence: number;
  seenEventIds: Set<string>;
  runs: Record<string, AgentStreamRun>;
  messages: Record<string, AgentStreamMessage>;
  tools: Record<string, AgentStreamTool>;
  activities: Record<string, AgentStreamActivity>;
  order: Array<{ kind: 'tool' | 'activity'; id: string; sequence: number }>;
  state: Record<string, Record<string, unknown>>;
}

export function emptyAgentStreamState(): AgentStreamState {
  return {
    version: 1,
    lastSequence: 0,
    seenEventIds: new Set(),
    runs: {},
    messages: {},
    tools: {},
    activities: {},
    order: [],
    state: {},
  };
}
