import type { AgentPartKind, OrlynxEvent } from '@orlynx/shared';
import type { StreamProjectionEvent } from './protocol';

type RawEvent = Omit<Partial<OrlynxEvent>, 'type'> & {
  type: string;
  payload?: Record<string, unknown>;
};

const str = (value: unknown) => typeof value === 'string' ? value : '';
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const PART_KINDS = new Set<AgentPartKind>(['terminal','file-change','file-read','test-result','build-result','git','preview','approval','error','status','generic']);
function semanticType(payload: Record<string, unknown>, fallback?: AgentPartKind): AgentPartKind | undefined {
  const value = str(payload.semanticType) as AgentPartKind;
  return PART_KINDS.has(value) ? value : fallback;
}
function workspaceState(payload: Record<string, unknown>): 'preparing' | 'reconnecting' | 'ready' | 'stopped' | 'failed' {
  const value = str(payload.state).toLowerCase();
  if (value === 'ready') return 'ready';
  if (value === 'failed') return 'failed';
  if (value === 'stopped' || value === 'stopping') return 'stopped';
  if (value === 'reconnecting' || value === 'connecting') return 'reconnecting';
  return 'preparing';
}
function singularFile(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.files)) return payload.files;
  const path = str(payload.path || payload.filePath || payload.file);
  if (!path) return [];
  return [{
    path,
    action: str(payload.action || payload.status) || 'modify',
    ...(typeof payload.diff === 'string' ? { diff: payload.diff } : {}),
    ...(typeof payload.before === 'string' ? { before: payload.before } : {}),
    ...(typeof payload.after === 'string' ? { after: payload.after } : {}),
  }];
}
function subagentId(event: RawEvent): string {
  const payload = event.payload || {};
  const raw = str(payload.subagentId || payload.id || payload.agentId || payload.parentToolCallId || payload.title) || 'default';
  return `${event.runId || event.sessionId || 'session'}:subagent:${raw}`;
}

function base(event: RawEvent) {
  return {
    eventId: String(event.eventId || `legacy:${event.runId || event.sessionId || 'session'}:${event.sequence || 0}:${event.type}`),
    sessionId: String(event.sessionId || ''),
    runId: event.runId ? String(event.runId) : undefined,
    taskId: event.taskId ? String(event.taskId) : undefined,
    workspaceId: event.workspaceId ? String(event.workspaceId) : undefined,
    sequence: Number(event.sequence || 0),
    timestamp: String(event.timestamp || new Date(0).toISOString()),
  };
}

function assistantMessageId(event: RawEvent): string {
  // run.started payload.messageId is the originating USER message. Never reuse
  // it as the assistant stream identity. The assistant stream is run-scoped
  // unless a provider explicitly supplies an assistantMessageId.
  return str(event.payload?.assistantMessageId)
    || (event.runId ? `assistant:${event.runId}` : `assistant:${event.sessionId || 'session'}:${event.sequence || 0}`);
}

function toolCallId(event: RawEvent): string {
  const payload = event.payload || {};
  const tool = str(payload.tool || payload.name) || 'tool';
  const command = str(payload.command || payload.cmd);
  const scope = event.runId || event.sessionId || 'session';
  const rawId = str(payload.toolCallId || payload.callId)
    || str(payload.ptyId || payload.terminalId || payload.resultId || payload.testId || payload.buildId)
    || `${tool}:${command || event.eventId || event.sequence || 'call'}`;
  // v1 server events already scope toolCallId to the run. Legacy events are
  // scoped here only as a compatibility fallback.
  return rawId.startsWith(`${scope}:`) ? rawId : `${scope}:${rawId}`;
}


function phaseId(event: RawEvent): string {
  const raw = str(event.payload?.sourceType).toLowerCase();
  // Providers are free to emit many low-level status names. Collapse them into
  // a few stable semantic phases so progress updates evolve one row instead of
  // creating a telemetry transcript.
  const source = raw === 'repository.map' ? 'repository'
    : raw === 'opencode.retry' ? 'provider-retry'
      : raw === 'pty.output' ? 'pty-output'
        : 'agent';
  return `activity:${event.runId || event.sessionId || 'session'}:${source}`;
}

function workspaceId(event: RawEvent): string {
  return `workspace:${event.workspaceId || event.sessionId || 'session'}`;
}

export function normalizeOrlynxEvent(event: RawEvent): StreamProjectionEvent[] {
  const payload = event.payload || {};
  const common = base(event);

  switch (event.type) {
    case 'run.queued':
      return [{ ...common, type: 'RUN_QUEUED', position: num(payload.position), plane: str(payload.plane) || undefined, mode: str(payload.mode) as any || undefined }];
    case 'run.started':
      return [{
        ...common,
        type: 'RUN_STARTED',
        messageId: assistantMessageId(event),
        userMessageId: str(payload.messageId) || undefined,
        plane: str(payload.plane) || undefined,
        model: str(payload.model) || undefined,
        mode: str(payload.mode) as any || undefined,
        permission: str(payload.permission) as any || undefined,
      }];
    case 'run.completed':
      return [{ ...common, type: 'RUN_FINISHED', summary: str(payload.summary) || undefined }];
    case 'run.failed':
      return [{
        ...common,
        type: 'RUN_ERROR',
        error: str(payload.error || payload.message) || undefined,
        errorKind: str(payload.errorKind) || undefined,
        cancelled: Boolean(payload.cancelled),
        retryable: Boolean(payload.retryable),
      }];

    case 'message.start':
      return [{ ...common, type: 'TEXT_START', messageId: assistantMessageId(event), role: 'assistant' }];
    case 'message.delta': {
      const delta = str(payload.delta);
      return delta ? [{ ...common, type: 'TEXT_CONTENT', messageId: assistantMessageId(event), delta }] : [];
    }
    case 'message.end':
      return [{ ...common, type: 'TEXT_END', messageId: assistantMessageId(event) }];

    case 'tool.requested':
    case 'tool.started':
      return [{
        ...common,
        type: 'TOOL_START',
        toolCallId: toolCallId(event),
        name: str(payload.tool || payload.name) || 'tool',
        semanticType: semanticType(payload),
        waiting: event.type === 'tool.requested',
        title: str(payload.title) || undefined,
        command: str(payload.command || payload.cmd) || undefined,
        path: str(payload.path) || undefined,
        code: str(payload.code) || undefined,
      }];
    case 'tool.output':
    case 'tool.progress':
    case 'terminal.output':
      return [{
        ...common,
        type: 'TOOL_UPDATE',
        toolCallId: toolCallId(event),
        delta: str(payload.outDelta || payload.delta || payload.data) || undefined,
        output: [str(payload.out), str(payload.stderr), str(payload.data)].filter(Boolean).join('\n') || undefined,
        replace: Boolean(payload.replace),
      }];
    case 'terminal.started':
      return [{
        ...common,
        type: 'TOOL_START',
        toolCallId: toolCallId(event),
        name: 'terminal',
        semanticType: semanticType(payload, 'terminal'),
        title: str(payload.title) || 'Terminal session',
        command: str(payload.command || payload.cmd) || undefined,
        path: str(payload.path) || undefined,
      }];
    case 'terminal.exited':
      return [{
        ...common,
        type: 'TOOL_END',
        toolCallId: toolCallId(event),
        semanticType: semanticType(payload, 'terminal'),
        ok: (num(payload.exitCode ?? payload.code) ?? 0) === 0,
        output: [str(payload.out), str(payload.stderr)].filter(Boolean).join('\n') || undefined,
        exitCode: num(payload.exitCode ?? payload.code),
      }];
    case 'test.result':
    case 'build.result':
      return [{
        ...common,
        type: 'TOOL_END',
        toolCallId: toolCallId(event),
        semanticType: semanticType(payload, event.type === 'test.result' ? 'test-result' : 'build-result'),
        ok: payload.ok !== false && num(payload.failed) === undefined ? Boolean(payload.ok ?? payload.success ?? true) : (num(payload.failed) ?? 1) === 0,
        error: str(payload.error || payload.message) || undefined,
        output: [str(payload.out), str(payload.stderr), str(payload.summary)].filter(Boolean).join('\n') || undefined,
        exitCode: num(payload.exitCode ?? payload.code),
        files: Array.isArray(payload.files) ? payload.files : undefined,
      }];
    case 'file.changed':
    case 'files.changed': {
      const files = Array.isArray(payload.files)
        ? payload.files
        : str(payload.path || payload.filePath || payload.file)
          ? [{
              path: str(payload.path || payload.filePath || payload.file),
              action: str(payload.action || payload.status) || 'modify',
              ...(str(payload.diff) ? { diff: str(payload.diff) } : {}),
              ...(str(payload.before) ? { before: str(payload.before) } : {}),
              ...(str(payload.after) ? { after: str(payload.after) } : {}),
            }]
          : [];
      return [{
        ...common,
        type: 'CHANGES_UPDATED',
        activityId: `changes:${event.runId || str(payload.changeId) || event.sessionId || event.sequence}`,
        changeId: str(payload.changeId) || undefined,
        files,
        count: num(payload.count) ?? files.length,
      }];
    }
    case 'preview.ready':
    case 'preview.state': {
      const projected = event.type === 'preview.ready' ? 'ready' : workspaceState(payload);
      const state = projected === 'reconnecting' ? 'preparing' : projected;
      return [{
        ...common,
        type: 'PREVIEW_STATE',
        activityId: `preview:${event.runId || event.workspaceId || event.sessionId || 'session'}:${num(payload.port) || 'app'}`,
        state,
        port: num(payload.port),
        url: str(payload.url) || undefined,
        message: str(payload.message) || undefined,
      }];
    }
    case 'permission.request':
      return [{
        ...common,
        type: 'APPROVAL',
        activityId: `approval:${str(payload.approvalId || payload.id) || event.runId || event.sequence}`,
        approvalId: str(payload.approvalId || payload.id) || undefined,
        resolved: false,
        action: str(payload.action) || undefined,
        detail: str(payload.detail || payload.message) || undefined,
      }];
    case 'permission.resolved':
      return [{
        ...common,
        type: 'APPROVAL',
        activityId: `approval:${str(payload.approvalId || payload.id) || event.runId || event.sequence}`,
        approvalId: str(payload.approvalId || payload.id) || undefined,
        resolved: true,
        decision: str(payload.decision) || undefined,
        action: str(payload.action) || undefined,
        detail: str(payload.detail || payload.message) || undefined,
      }];
    case 'subagent.started':
    case 'subagent.finished': {
      const stableSubagentId = str(payload.subagentId || payload.id || payload.taskId || payload.name || payload.title) || 'delegated';
      const id = `${event.runId || event.sessionId || 'session'}:subagent:${stableSubagentId}`;
      return event.type === 'subagent.started'
        ? [{ ...common, type: 'TOOL_START', toolCallId: id, name: 'subagent', semanticType: 'generic', title: str(payload.title) || 'Delegated subtask' }]
        : [{ ...common, type: 'TOOL_END', toolCallId: id, semanticType: 'generic', ok: payload.ok !== false, error: str(payload.error) || undefined }];
    }
    case 'run.state':
      return [{ ...common, type: 'STATE_DELTA', scope: 'run', state: str(payload.state) || undefined, value: { ...payload, scope: 'run' } }];
    case 'workspace.state':
      return [{ ...common, type: 'WORKSPACE_STATE', activityId: workspaceId(event), state: workspaceState(payload), message: str(payload.message) || undefined, provider: str(payload.provider) || undefined }];
    case 'extension.event':
      return [{ ...common, type: 'OTHER', rawType: str(payload.sourceType) || 'extension', payload }];
    case 'tool.completed':
    case 'tool.failed':
      return [{
        ...common,
        type: 'TOOL_END',
        toolCallId: toolCallId(event),
        semanticType: semanticType(payload),
        ok: event.type === 'tool.completed',
        error: str(payload.error || payload.message) || undefined,
        output: [str(payload.out), str(payload.stderr)].filter(Boolean).join('\n') || undefined,
        exitCode: num(payload.exitCode ?? payload.code),
        files: Array.isArray(payload.files) ? payload.files : undefined,
      }];

    case 'activity.started':
      return [{ ...common, type: 'ACTIVITY_START', activityId: phaseId(event), text: str(payload.text) || 'Working', sourceType: str(payload.sourceType) || undefined }];
    case 'activity.progress':
      return [{ ...common, type: 'ACTIVITY_UPDATE', activityId: phaseId(event), text: str(payload.text) || 'Working', sourceType: str(payload.sourceType) || undefined, detail: payload }];
    case 'activity.completed':
      return [{ ...common, type: 'ACTIVITY_END', activityId: phaseId(event), text: str(payload.text) || undefined }];

    case 'workspace.preparing':
      return [{ ...common, type: 'WORKSPACE_STATE', activityId: workspaceId(event), state: 'preparing', message: str(payload.message) || undefined, provider: str(payload.provider) || undefined }];
    case 'workspace.reconnecting':
      return [{ ...common, type: 'WORKSPACE_STATE', activityId: workspaceId(event), state: 'reconnecting', message: str(payload.message) || undefined, provider: str(payload.provider) || undefined }];
    case 'workspace.ready':
      return [{ ...common, type: 'WORKSPACE_STATE', activityId: workspaceId(event), state: 'ready', message: str(payload.message) || undefined, provider: str(payload.provider) || undefined }];
    case 'workspace.stopped':
      return [{ ...common, type: 'WORKSPACE_STATE', activityId: workspaceId(event), state: 'stopped', message: str(payload.message) || undefined, provider: str(payload.provider) || undefined }];

    case 'state.snapshot':
      return [{ ...common, type: 'STATE_SNAPSHOT', scope: str(payload.scope) || 'session', value: payload }];
    case 'state.delta':
      return [{ ...common, type: 'STATE_DELTA', scope: str(payload.scope) || 'session', state: str(payload.state) || undefined, value: payload }];

    case 'changes.updated':
      return [{
        ...common,
        type: 'CHANGES_UPDATED',
        activityId: `changes:${event.runId || str(payload.changeId) || event.sessionId || event.sequence}`,
        changeId: str(payload.changeId) || undefined,
        files: singularFile(payload),
        count: num(payload.count) ?? singularFile(payload).length,
      }];
    case 'receipt.created':
      return [{
        ...common,
        type: 'RECEIPT',
        activityId: `receipt:${event.runId || event.sessionId || 'session'}:${event.sequence || 0}`,
        command: str(payload.command || payload.cmd) || undefined,
        output: [str(payload.out), str(payload.stderr)].filter(Boolean).join('\n') || undefined,
        exitCode: num(payload.exitCode ?? payload.code),
      }];
    case 'approval.required':
    case 'approval.resolved':
      return [{
        ...common,
        type: 'APPROVAL',
        activityId: `approval:${str(payload.approvalId || payload.id) || event.runId || event.sequence}`,
        approvalId: str(payload.approvalId || payload.id) || undefined,
        resolved: event.type === 'approval.resolved',
        decision: str(payload.decision) || undefined,
        action: str(payload.action) || undefined,
        detail: str(payload.detail || payload.message) || undefined,
      }];
    default:
      return [{ ...common, type: 'OTHER', rawType: event.type, payload }];
  }
}

export function normalizeOrlynxEvents(events: RawEvent[]): StreamProjectionEvent[] {
  const deduped = [...new Map(events.filter(Boolean).map((event) => [String(event.eventId || `${event.sequence}:${event.type}`), event])).values()]
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
  return deduped.flatMap(normalizeOrlynxEvent);
}
