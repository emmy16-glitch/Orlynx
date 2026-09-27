import type { OrlynxEvent } from '@orlynx/shared';
import type { CanonicalAgentEvent } from './protocol';

type RawEvent = Omit<Partial<OrlynxEvent>, 'type'> & {
  type: string;
  payload?: Record<string, unknown>;
};

const str = (value: unknown) => typeof value === 'string' ? value : '';
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

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
  const rawId = str(payload.toolCallId || payload.callId) || `${tool}:${command || 'call'}`;
  // Tool-call IDs are scoped to a run. Some providers reuse short call IDs
  // across turns; the UI protocol must never merge two different runs.
  return `${event.runId || event.sessionId || 'session'}:${rawId}`;
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

export function normalizeOrlynxEvent(event: RawEvent): CanonicalAgentEvent[] {
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
        title: str(payload.title) || 'Terminal session',
        command: str(payload.command || payload.cmd) || undefined,
        path: str(payload.path) || undefined,
      }];
    case 'terminal.exited':
      return [{
        ...common,
        type: 'TOOL_END',
        toolCallId: toolCallId(event),
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
        ok: payload.ok !== false && num(payload.failed) === undefined ? Boolean(payload.ok ?? payload.success ?? true) : (num(payload.failed) ?? 1) === 0,
        error: str(payload.error || payload.message) || undefined,
        output: [str(payload.out), str(payload.stderr), str(payload.summary)].filter(Boolean).join('\n') || undefined,
        exitCode: num(payload.exitCode ?? payload.code),
        files: Array.isArray(payload.files) ? payload.files : undefined,
      }];
    case 'file.changed':
    case 'files.changed':
      return [{
        ...common,
        type: 'CHANGES_UPDATED',
        activityId: `changes:${event.runId || str(payload.changeId) || event.sessionId || event.sequence}`,
        changeId: str(payload.changeId) || undefined,
        files: Array.isArray(payload.files) ? payload.files : [],
        count: num(payload.count),
      }];
    case 'preview.ready':
    case 'preview.state':
      return [{ ...common, type: 'STATE_DELTA', scope: 'preview', state: str(payload.state) || 'ready', value: { ...payload, scope: 'preview' } }];
    case 'permission.request':
      return [{
        ...common,
        type: 'APPROVAL',
        activityId: `approval:${str(payload.approvalId || payload.id) || event.runId || event.sequence}`,
        resolved: false,
        action: str(payload.action) || undefined,
        detail: str(payload.detail || payload.message) || undefined,
      }];
    case 'permission.resolved':
      return [{
        ...common,
        type: 'APPROVAL',
        activityId: `approval:${str(payload.approvalId || payload.id) || event.runId || event.sequence}`,
        resolved: true,
        action: str(payload.action || payload.decision) || undefined,
        detail: str(payload.detail || payload.message) || undefined,
      }];
    case 'subagent.started':
      return [{ ...common, type: 'TOOL_START', toolCallId: `${event.runId || event.sessionId || 'session'}:subagent:${str(payload.subagentId || payload.id) || event.sequence}`, name: 'subagent', title: str(payload.title) || 'Delegated subtask' }];
    case 'subagent.finished':
      return [{ ...common, type: 'TOOL_END', toolCallId: `${event.runId || event.sessionId || 'session'}:subagent:${str(payload.subagentId || payload.id) || event.sequence}`, ok: payload.ok !== false, error: str(payload.error) || undefined }];
    case 'run.state':
      return [{ ...common, type: 'STATE_DELTA', scope: 'run', state: str(payload.state) || undefined, value: { ...payload, scope: 'run' } }];
    case 'workspace.state':
      return [{ ...common, type: 'WORKSPACE_STATE', activityId: workspaceId(event), state: 'preparing', message: str(payload.message) || undefined, provider: str(payload.provider) || undefined }];
    case 'extension.event':
      return [{ ...common, type: 'OTHER', rawType: str(payload.sourceType) || 'extension', payload }];
    case 'tool.completed':
    case 'tool.failed':
      return [{
        ...common,
        type: 'TOOL_END',
        toolCallId: toolCallId(event),
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
        files: Array.isArray(payload.files) ? payload.files : [],
        count: num(payload.count),
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
        resolved: event.type === 'approval.resolved',
        action: str(payload.action) || undefined,
        detail: str(payload.detail || payload.message) || undefined,
      }];
    default:
      return [{ ...common, type: 'OTHER', rawType: event.type, payload }];
  }
}

export function normalizeOrlynxEvents(events: RawEvent[]): CanonicalAgentEvent[] {
  const deduped = [...new Map(events.filter(Boolean).map((event) => [String(event.eventId || `${event.sequence}:${event.type}`), event])).values()]
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
  return deduped.flatMap(normalizeOrlynxEvent);
}
