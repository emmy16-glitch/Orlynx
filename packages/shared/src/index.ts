// @orlynx/shared — canonical types per Architecture Spec v1.1 §§13-14
export type SessionMode = 'repository' | 'cloud';
export type WorkspaceState = 'not_created' | 'creating' | 'starting' | 'bootstrapping' | 'connecting' | 'ready' | 'stopping' | 'stopped' | 'failed';
export type AgentAdapterId = string;
export type AgentAdapterState = 'not_installed' | 'installing' | 'starting' | 'ready' | 'busy' | 'unavailable' | 'failed';
export type RunState = 'queued' | 'running' | 'waiting_input' | 'waiting_approval' | 'paused' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
export type ReviewState = 'pending' | 'approved' | 'committed' | 'stale' | 'discarded';

export interface ProjectSession {
  id: string;
  installationId?: number;
  project: string;
  owner?: string;
  repo?: string;
  branch: string;
  mode: SessionMode;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
  checkpoint?: SessionCheckpoint;
}

export interface SessionCheckpoint {
  goal?: string;
  decisions: string[];
  branch: string;
  filesTouched: string[];
  pendingIssues: string[];
  lastVerified?: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: string;
  /** Explicit run ownership for assistant messages. Legacy rows may omit this. */
  runId?: string;
}

export interface AttachmentMeta {
  id: string;
  sessionId: string;
  filename: string;
  safeName: string;
  mime: string;
  size: number;
  hash?: string;
  createdAt: string;
}

export interface ChangeSet {
  id: string;
  sessionId: string;
  runId?: string;
  baseSha: string;
  currentHead?: string;
  files: ChangedFile[];
  reviewState: ReviewState;
  commitSha?: string;
  pushedAt?: string;
  pushedBranch?: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  createdAt: string;
}

export interface ChangedFile {
  path: string;
  action: 'create' | 'modify' | 'delete';
  before?: string;
  after?: string;
  diff?: string;
}

export interface AgentRun {
  id: string;
  sessionId: string;
  engine: AgentAdapterId;
  plane?: 'direct' | 'workspace';
  provider?: string;
  model?: string;
  mode?: AgentMode;
  permission?: PermissionProfile;
  tempPermission?: PermissionProfile;
  state: RunState;
  activity?: string;
  startedAt: string;
  finishedAt?: string;
  errorKind?: 'rate_limit' | 'quota' | 'auth' | 'engine' | 'model' | 'permission' | 'unknown';
}

export type WorkspaceProviderId = 'github-codespaces' | 'orlynx-runner';

export interface WorkspaceRecord {
  id: string;
  sessionId: string;
  userId: string;
  projectId: string;
  provider: WorkspaceProviderId;
  codespaceName?: string;
  runnerId?: string;
  repositoryId: number;
  branch: string;
  state: WorkspaceState;
  bridgeState: 'disconnected' | 'connecting' | 'ready';
  connectionId?: string;
  repoRoot?: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  sessionId: string;
  workspaceId: string;
  plane?: 'direct' | 'workspace';
  runId?: string;
  messageId?: string;
  state: RunState;
  prompt: string;
  modelId?: string;
  adapterId?: AgentAdapterId;
  mode?: AgentMode;
  permission?: PermissionProfile;
  tempPermission?: PermissionProfile;
  partialText?: string;
  createdAt: string;
  updatedAt: string;
}

// Unified Orlynx AI layer (engine/provider/model stay underneath).
export type AgentMode = 'build' | 'plan' | 'ask';
export type PermissionProfile = 'full' | 'ask-first' | 'read-only';

export interface AIModel {
  id: string;
  providerId: string;
  providerName: string;
  displayName: string;
  family: string;
  free?: boolean;
  connected: boolean;
  status: 'available' | 'needs-connection' | 'unavailable';
}

export interface AISessionPrefs {
  sessionId: string;
  adapterId?: AgentAdapterId;
  providerId?: string;
  modelId?: string;
  mode: AgentMode;
  permission: PermissionProfile;
  updatedAt: string;
}

export const AGENT_MODES: { id: AgentMode; name: string; hint: string }[] = [
  { id: 'build', name: 'Build', hint: 'Make changes and use tools.' },
  { id: 'plan', name: 'Plan', hint: 'Inspect and plan before changing anything.' },
  { id: 'ask', name: 'Ask', hint: 'Answer questions. No modifications.' },
];

export const PERMISSION_PROFILES: { id: PermissionProfile; name: string; hint: string }[] = [
  { id: 'full', name: 'Full access', hint: 'Work independently inside this project.' },
  { id: 'ask-first', name: 'Ask first', hint: 'Request approval before consequential actions.' },
  { id: 'read-only', name: 'Read only', hint: 'Inspect and explain without changing the project.' },
];

// §§14.2-14.3 event envelope + taxonomy
//
// Orlynx canonical agent protocol v1 (Orlynx-native, informed by AG-UI run/
// message/tool/state lifecycles, ACP session boundaries, OpenHands
// action/observation separation and assistant-ui message parts).
//
// Provider events are normalized into this vocabulary at the server adapter
// boundary (apps/api/src/agent-protocol.ts). The durable ledger stores the
// canonical types below; the browser compatibility adapter
// (apps/web/src/agent-stream/adapter.ts) only handles pre-v1 history.
export const CANONICAL_PROTOCOL_VERSION = 1;

export type EventType =
  | 'run.queued' | 'run.started' | 'run.completed' | 'run.failed' | 'run.state'
  | 'step.started' | 'step.finished'
  | 'message.start' | 'message.delta' | 'message.end'
  | 'tool.requested' | 'tool.started' | 'tool.progress' | 'tool.output' | 'tool.completed' | 'tool.failed'
  | 'terminal.started' | 'terminal.output' | 'terminal.exited'
  | 'file.changed' | 'files.changed'
  | 'test.result' | 'build.result'
  | 'preview.state' | 'preview.ready'
  | 'subagent.started' | 'subagent.finished'
  | 'permission.request' | 'permission.resolved'
  | 'workspace.preparing' | 'workspace.ready' | 'workspace.reconnecting' | 'workspace.stopped' | 'workspace.state'
  | 'state.snapshot' | 'state.delta' | 'changes.updated' | 'branch.changed'
  | 'activity.started' | 'activity.progress' | 'activity.completed'
  | 'approval.required' | 'approval.resolved'
  | 'receipt.created' | 'extension.event';

// Shared adapter capabilities. The operational adapter interface lives in
// apps/api/src/agent-runtime.ts because its methods depend on server-only
// request/session types. There is intentionally one production adapter
// contract, not a second documentation-only handle.
export interface AgentAdapterCapabilities {
  workspace: boolean;
  directChat: boolean;
  streaming: boolean;
  planMode: boolean;
  approvals: boolean;
  resumeSession: boolean;
  diff: boolean;
}

export interface OrlynxEvent {
  eventId: string;
  sessionId: string;
  taskId?: string;
  runId?: string;
  workspaceId?: string;
  sequence: number;
  type: EventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

// UI-facing projection of runtime events. Provider-specific payloads are normalized
// before they reach the primary work stream; rawRef points back to the source event.
export type ActivityCategory = 'agent' | 'search' | 'file' | 'command' | 'test' | 'build' | 'git' | 'cloud' | 'preview' | 'approval' | 'error';
export type ActivityLifecycle = 'queued' | 'running' | 'success' | 'failed' | 'waiting' | 'cancelled';
export interface ActivityEvent {
  id: string;
  runId?: string;
  taskId?: string;
  sequence: number;
  timestamp: string;
  category: ActivityCategory;
  state: ActivityLifecycle;
  title: string;
  summary?: string;
  evidence?: Record<string, unknown>;
  rawRef?: string;
  rawOutput?: string;
  collapsible?: boolean;
}

export const APPROVAL_ACTIONS = [
  'port.expose.public',
  'git.force-push',
  'fs.delete-many',
  'secrets.modify',
  'infra.billing',
  'exec.outside-root',
] as const;

export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
}
