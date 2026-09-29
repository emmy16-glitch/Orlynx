import type { ActivityLifecycle } from '@orlynx/shared';
import { normalizeOrlynxEvents } from './adapter';
import {
  emptyAgentStreamState,
  type AgentStreamActivity,
  type AgentStreamMessage,
  type AgentStreamRun,
  type AgentStreamState,
  type AgentStreamTool,
  type StreamProjectionEvent,
} from './protocol';

const stamp = (value?: string) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const compact = (value: string, max = 120) => {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
};

const humanActivity = (value: string) => {
  const clean = value.replace(/[.!…]+$/, '').trim();
  if (!clean) return 'Working';
  if (/^(?:Orlynx → Model|Model → Orlynx|Orlynx learned)/i.test(clean)) return compact(clean, 180);
  if (/thinking|reasoning|reviewing|understanding/i.test(clean)) return 'Reviewing the request';
  if (/repository mapped|repository map/i.test(clean)) return 'Inspecting the repository';
  if (/reading files?/i.test(clean)) return 'Inspecting the repository';
  if (/^(?:updating|editing|writing|changing)\s+/i.test(clean)) {
    return /\bfiles?\b/i.test(clean) ? 'Updating files' : compact(clean, 96);
  }
  if (/running tests?/i.test(clean)) return 'Running tests';
  if (/building/i.test(clean)) return 'Building project';
  return clean;
};

const friendlyFailure = (value?: string) => {
  const message = String(value || '').replace(/\s+/g, ' ').trim();
  if (!message) return undefined;
  if (/timeout|timed out/i.test(message)) return 'The operation timed out. It may still be running.';
  if (/rate.?limit/i.test(message)) return 'The AI provider is temporarily rate limited. Try again shortly.';
  if (/quota|credits/i.test(message)) return 'The selected provider has reached its available quota or credits.';
  if (/(?:github|repository|\bgit\b).*(?:auth|unauthori|credential|access)|(?:auth|credential).*(?:github|repository|\bgit\b)/i.test(message)) return 'Repository access needs attention.';
  if (/auth|unauthori|credential/i.test(message)) return 'The AI connection needs attention.';
  return compact(message, 180);
};

function clone(state: AgentStreamState): AgentStreamState {
  return {
    ...state,
    seenEventIds: new Set(state.seenEventIds),
    runs: { ...state.runs },
    messages: { ...state.messages },
    tools: { ...state.tools },
    activities: { ...state.activities },
    order: [...state.order],
    state: { ...state.state },
  };
}

function rememberOrder(state: AgentStreamState, kind: 'tool' | 'activity', id: string, sequence: number) {
  if (state.order.some((entry) => entry.kind === kind && entry.id === id)) return;
  state.order.push({ kind, id, sequence });
}

function putActivity(state: AgentStreamState, item: AgentStreamActivity) {
  const prior = state.activities[item.id];
  state.activities[item.id] = prior ? { ...prior, ...item, startedSequence: prior.startedSequence } : item;
  rememberOrder(state, 'activity', item.id, item.startedSequence);
}

function updateRun(state: AgentStreamState, event: StreamProjectionEvent, patch: Partial<AgentStreamRun>) {
  if (!event.runId) return;
  const prior = state.runs[event.runId];
  const messageId = patch.messageId || prior?.messageId || `assistant:${event.runId}`;
  state.runs[event.runId] = {
    ...(prior || {}),
    ...patch,
    id: event.runId,
    state: patch.state || prior?.state || 'queued',
    messageId,
  };
}

function resolveRunActivities(state: AgentStreamState, runId: string, lifecycle: ActivityLifecycle) {
  for (const [id, activity] of Object.entries(state.activities)) {
    if (activity.runId !== runId || activity.state !== 'running') continue;
    state.activities[id] = { ...activity, state: lifecycle };
  }
  for (const [id, tool] of Object.entries(state.tools)) {
    if (tool.runId !== runId || (tool.state !== 'running' && tool.state !== 'waiting')) continue;
    state.tools[id] = { ...tool, state: lifecycle === 'success' ? 'success' : lifecycle === 'cancelled' ? 'cancelled' : 'failed' };
  }
}

function applyOne(state: AgentStreamState, event: StreamProjectionEvent) {
  if (state.seenEventIds.has(event.eventId)) return;
  state.seenEventIds.add(event.eventId);
  state.lastSequence = Math.max(state.lastSequence, event.sequence || 0);

  switch (event.type) {
    case 'RUN_QUEUED': {
      if (event.runId) {
        updateRun(state, event, {
          state: 'queued',
          messageId: `assistant:${event.runId}`,
          plane: event.plane,
          mode: event.mode,
        });
        if (event.plane === 'workspace' || (event.position || 0) > 1) {
          const ahead = Math.max(0, (event.position || 1) - 1);
          putActivity(state, {
            id: `queue:${event.runId}`,
            runId: event.runId,
            taskId: event.taskId,
            sequence: event.sequence,
            startedSequence: event.sequence,
            timestamp: event.timestamp,
            state: 'queued',
            kind: 'agent',
            title: event.plane === 'workspace' ? 'Build queued' : 'Response queued',
            summary: ahead > 0
              ? `${ahead} ${ahead === 1 ? 'task' : 'tasks'} ahead · starts automatically`
              : 'Next · starts automatically',
          });
        }
      }
      return;
    }

    case 'RUN_STARTED': {
      if (!event.runId) return;
      updateRun(state, event, {
        state: 'running',
        messageId: event.messageId,
        userMessageId: event.userMessageId,
        plane: event.plane,
        model: event.model,
        mode: event.mode,
        permission: event.permission,
        startedAt: event.timestamp,
        error: undefined,
        errorKind: undefined,
      });
      const queued = state.activities[`queue:${event.runId}`];
      // Queue state is transient. Once real work begins, remove the placeholder
      // instead of leaving a useless "Build task started" row in the transcript.
      if (queued) delete state.activities[queued.id];
      const existing = state.messages[event.messageId];
      state.messages[event.messageId] = {
        id: event.messageId,
        runId: event.runId,
        role: 'assistant',
        text: existing?.text || '',
        state: 'streaming',
        startedAt: existing?.startedAt || event.timestamp,
        lastSequence: Math.max(existing?.lastSequence || 0, event.sequence),
        lastEventAt: Math.max(existing?.lastEventAt || 0, stamp(event.timestamp)),
        userMessageId: event.userMessageId || existing?.userMessageId,
        plane: event.plane || existing?.plane,
      };
      return;
    }

    case 'RUN_STATE': {
      if (!event.runId) return;
      const run = state.runs[event.runId];
      updateRun(state, event, {
        state: event.state,
        messageId: run?.messageId || `assistant:${event.runId}`,
        ...(event.state === 'completed' || event.state === 'failed' || event.state === 'cancelled'
          ? { finishedAt: event.timestamp }
          : { finishedAt: undefined, error: undefined, errorKind: undefined }),
      });
      if ((event.state === 'queued' || event.state === 'running') && state.activities[`run-error:${event.runId}`]) {
        delete state.activities[`run-error:${event.runId}`];
      }
      if (event.state === 'running' && run?.messageId && state.messages[run.messageId]) {
        state.messages[run.messageId] = {
          ...state.messages[run.messageId],
          state: 'streaming',
          endedAt: undefined,
          lastSequence: Math.max(state.messages[run.messageId].lastSequence, event.sequence),
        };
      }
      return;
    }

    case 'RUN_FINISHED': {
      if (!event.runId) return;
      const run = state.runs[event.runId];
      updateRun(state, event, { state: 'completed', messageId: run?.messageId || `assistant:${event.runId}`, finishedAt: event.timestamp });
      resolveRunActivities(state, event.runId, 'success');
      if (run?.messageId && state.messages[run.messageId]) {
        state.messages[run.messageId] = { ...state.messages[run.messageId], state: 'completed', endedAt: event.timestamp, lastSequence: Math.max(state.messages[run.messageId].lastSequence, event.sequence) };
      }
      return;
    }

    case 'RUN_ERROR': {
      if (!event.runId) return;
      const run = state.runs[event.runId];
      const runState = event.cancelled ? 'cancelled' : 'failed';
      updateRun(state, event, {
        state: runState,
        messageId: run?.messageId || `assistant:${event.runId}`,
        finishedAt: event.timestamp,
        error: event.error,
        errorKind: event.errorKind,
      });
      resolveRunActivities(state, event.runId, event.cancelled ? 'cancelled' : 'failed');
      if (run?.messageId && state.messages[run.messageId]) {
        state.messages[run.messageId] = { ...state.messages[run.messageId], state: runState, endedAt: event.timestamp, lastSequence: Math.max(state.messages[run.messageId].lastSequence, event.sequence) };
      }
      const failureTitle = event.cancelled ? 'Task stopped'
        : event.errorKind === 'auth' ? 'Reconnect AI'
          : event.errorKind === 'model' ? 'Model unavailable'
            : event.errorKind === 'rate_limit' ? 'Model is busy'
              : event.errorKind === 'quota' ? 'AI quota reached'
                : event.errorKind === 'repository' ? 'Repository access needs attention'
                  : event.errorKind === 'engine' ? 'AI runtime unavailable'
                    : event.errorKind === 'verification' ? 'Verification needs attention'
                    : 'Work needs attention';
      putActivity(state, {
        id: `run-error:${event.runId}`,
        runId: event.runId,
        taskId: event.taskId,
        sequence: event.sequence,
        startedSequence: event.sequence,
        timestamp: event.timestamp,
        state: event.cancelled ? 'cancelled' : 'failed',
        kind: 'error',
        title: failureTitle,
        summary: event.cancelled ? 'The task was stopped.' : friendlyFailure(event.error) || 'Orlynx could not complete the task.',
        evidence: { ...(event.errorKind ? { errorKind: event.errorKind } : {}), ...(event.retryable ? { retryable: true } : {}) },
      });
      return;
    }

    case 'TEXT_START': {
      if (!event.runId) return;
      const run = state.runs[event.runId];
      const prior = state.messages[event.messageId];
      state.messages[event.messageId] = {
        id: event.messageId,
        runId: event.runId,
        role: 'assistant',
        text: prior?.text || '',
        state: 'streaming',
        startedAt: prior?.startedAt || event.timestamp,
        lastSequence: Math.max(prior?.lastSequence || 0, event.sequence),
        lastEventAt: Math.max(prior?.lastEventAt || 0, stamp(event.timestamp)),
        userMessageId: prior?.userMessageId || run?.userMessageId,
        plane: prior?.plane || run?.plane,
      };
      return;
    }

    case 'TEXT_CONTENT': {
      if (!event.runId || !event.delta) return;
      const run = state.runs[event.runId];
      const prior: AgentStreamMessage = state.messages[event.messageId] || {
        id: event.messageId,
        runId: event.runId,
        role: 'assistant',
        text: '',
        state: 'streaming',
        startedAt: event.timestamp,
        lastSequence: 0,
        lastEventAt: 0,
        userMessageId: run?.userMessageId,
        plane: run?.plane,
      };
      // Sequence is the ordering authority. This accepts multiple chunks that
      // share the same timestamp and makes SSE replay idempotent.
      if (event.sequence && event.sequence <= prior.lastSequence) return;
      state.messages[event.messageId] = {
        ...prior,
        text: prior.text + event.delta,
        state: 'streaming',
        lastSequence: Math.max(prior.lastSequence, event.sequence),
        lastEventAt: Math.max(prior.lastEventAt, stamp(event.timestamp)),
      };
      return;
    }

    case 'TEXT_END': {
      const prior = state.messages[event.messageId];
      if (!prior) return;
      state.messages[event.messageId] = {
        ...prior,
        state: prior.state === 'failed' || prior.state === 'cancelled' ? prior.state : 'completed',
        endedAt: event.timestamp,
        lastSequence: Math.max(prior.lastSequence, event.sequence),
        lastEventAt: Math.max(prior.lastEventAt, stamp(event.timestamp)),
      };
      return;
    }

    case 'TOOL_START': {
      const prior = state.tools[event.toolCallId];
      const tool: AgentStreamTool = {
        id: event.toolCallId,
        runId: event.runId,
        taskId: event.taskId,
        sequence: event.sequence,
        startedSequence: prior?.startedSequence || event.sequence,
        timestamp: prior?.timestamp || event.timestamp,
        state: event.waiting ? 'waiting' : 'running',
        name: event.name || prior?.name || 'tool',
        semanticType: event.semanticType || prior?.semanticType,
        title: event.title || prior?.title,
        command: event.command || prior?.command,
        path: event.path || prior?.path,
        code: event.code || prior?.code,
        output: prior?.output,
        error: undefined,
        exitCode: prior?.exitCode,
        files: prior?.files,
      };
      state.tools[event.toolCallId] = tool;
      rememberOrder(state, 'tool', event.toolCallId, tool.startedSequence);
      return;
    }

    case 'TOOL_UPDATE': {
      const prior = state.tools[event.toolCallId];
      if (!prior) return;
      const nextOutput = event.replace
        ? String(event.delta || event.output || '')
        : event.delta
          ? `${prior.output || ''}${event.delta}`
          : event.output || prior.output;
      // The durable event ledger retains the complete raw stream. The live UI
      // keeps a generous bounded projection so runaway command output cannot
      // freeze a mobile browser.
      state.tools[event.toolCallId] = {
        ...prior,
        state: 'running',
        sequence: event.sequence,
        output: nextOutput ? nextOutput.slice(-200_000) : nextOutput,
      };
      return;
    }

    case 'TOOL_END': {
      const prior = state.tools[event.toolCallId] || {
        id: event.toolCallId,
        runId: event.runId,
        taskId: event.taskId,
        sequence: event.sequence,
        startedSequence: event.sequence,
        timestamp: event.timestamp,
        state: 'running' as const,
        name: 'tool',
      };
      const output = event.output || prior.output;
      state.tools[event.toolCallId] = {
        ...prior,
        sequence: event.sequence,
        state: event.ok ? 'success' : 'failed',
        semanticType: event.semanticType || prior.semanticType,
        output: output ? output.slice(-200_000) : output,
        error: event.ok ? undefined : friendlyFailure(event.error) || event.error || 'Action failed.',
        exitCode: event.exitCode ?? prior.exitCode,
        files: event.files || prior.files,
      };
      rememberOrder(state, 'tool', event.toolCallId, prior.startedSequence);
      return;
    }

    case 'ACTIVITY_START':
    case 'ACTIVITY_UPDATE': {
      // Terminal output is already represented by the tool/PTY surfaces. It
      // must not become another generic "Thought" row.
      if (event.sourceType === 'pty.output') return;
      const prior = state.activities[event.activityId];

      if (event.sourceType === 'agent.dialogue.orlynx' || event.sourceType === 'agent.dialogue.model') {
        const detail = event.type === 'ACTIVITY_UPDATE' && event.detail && typeof event.detail === 'object'
          ? event.detail as Record<string, unknown>
          : {};
        const reflectionId = Math.max(1, Number(detail.reflectionId || 1) || 1);
        const side = event.sourceType.endsWith('.model') ? 'model' : 'orlynx';
        const rawText = String(detail.text || event.text || '');
        const text = rawText
          .replace(/^Orlynx\s*[→>-]\s*Model:\s*/i, '')
          .replace(/^Model\s*[→>-]\s*Orlynx:\s*/i, '')
          .trim();
        const priorEvidence = prior?.evidence && typeof prior.evidence === 'object'
          ? prior.evidence as Record<string, unknown>
          : {};
        const priorDialogue = Array.isArray(priorEvidence.dialogue)
          ? priorEvidence.dialogue.filter((line): line is Record<string, unknown> => Boolean(line) && typeof line === 'object')
          : [];
        const dialogue = priorDialogue
          .filter((line) => !(Number(line.reflectionId || 0) === reflectionId && String(line.side || '') === side))
          .concat([{ reflectionId, side, text, sequence: event.sequence }])
          .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
        const latestOrlynx = [...dialogue].reverse().find((line) => line.side === 'orlynx');
        const latestModel = [...dialogue].reverse().find((line) => line.side === 'model');

        putActivity(state, {
          id: event.activityId,
          runId: event.runId,
          taskId: event.taskId,
          sequence: event.sequence,
          startedSequence: prior?.startedSequence || event.sequence,
          timestamp: prior?.timestamp || event.timestamp,
          state: 'running',
          kind: 'agent',
          title: 'Investigation',
          summary: `Orlynx ↔ Model · ${dialogue.length} ${dialogue.length === 1 ? 'update' : 'updates'}`,
          sourceType: 'agent.reflection',
          evidence: {
            sourceType: 'agent.reflection',
            reflectionId,
            dialogue,
            ...(latestOrlynx?.text ? { orlynxText: String(latestOrlynx.text) } : {}),
            ...(latestModel?.text ? { modelText: String(latestModel.text) } : {}),
          },
        });
        return;
      }

      const title = event.sourceType === 'repository.map' ? 'Inspecting the repository' : humanActivity(event.text);
      putActivity(state, {
        id: event.activityId,
        runId: event.runId,
        taskId: event.taskId,
        sequence: event.sequence,
        startedSequence: prior?.startedSequence || event.sequence,
        timestamp: prior?.timestamp || event.timestamp,
        state: 'running',
        kind: 'agent',
        title,
        summary: event.sourceType === 'repository.map' && /mapped/i.test(event.text) ? compact(event.text, 160) : undefined,
        sourceType: event.sourceType,
        evidence: event.type === 'ACTIVITY_UPDATE' && event.detail ? { ...event.detail } : prior?.evidence,
      });
      return;
    }

    case 'ACTIVITY_END': {
      const prior = state.activities[event.activityId];
      if (!prior) return;
      const finalTitle = event.text ? humanActivity(event.text) : prior.title;
      // Completion belongs in the assistant response/result, not as a second
      // lifecycle row underneath it.
      if (/^(?:response|work) completed$/i.test(finalTitle)) {
        delete state.activities[event.activityId];
        return;
      }
      state.activities[event.activityId] = { ...prior, state: 'success', sequence: event.sequence, title: finalTitle };
      return;
    }

    case 'WORKSPACE_STATE': {
      const prior = state.activities[event.activityId];
      // "Ready" is current infrastructure state, not useful task history.
      // Resolve any preparing/recovery row by removing it from chat.
      if (event.state === 'ready') {
        delete state.activities[event.activityId];
        return;
      }
      const recovering = event.state === 'reconnecting' || /recover|replace|fresh|ssh|lost|interrupt/i.test(event.message || '');
      const title = event.state === 'stopped' ? 'Workspace stopped'
        : event.state === 'failed' ? 'Workspace needs attention'
          : recovering ? 'Recovering workspace' : 'Preparing workspace';
      const activityState: AgentStreamActivity['state'] = event.state === 'stopped' ? 'cancelled'
        : event.state === 'failed' ? 'failed' : 'running';
      putActivity(state, {
        id: event.activityId,
        runId: event.runId,
        taskId: event.taskId,
        sequence: event.sequence,
        startedSequence: prior?.startedSequence || event.sequence,
        timestamp: prior?.timestamp || event.timestamp,
        state: activityState,
        kind: 'workspace',
        title,
        summary: event.message ? compact(event.message, 180) : undefined,
        evidence: event.provider ? { provider: event.provider } : prior?.evidence,
      });
      return;
    }

    case 'PREVIEW_STATE': {
      const prior = state.activities[event.activityId];
      const title = event.state === 'ready' ? 'Development server ready'
        : event.state === 'failed' ? 'Preview unavailable'
          : event.state === 'stopped' ? 'Development server stopped'
            : 'Starting development server';
      const activityState: AgentStreamActivity['state'] = event.state === 'ready' ? 'success'
        : event.state === 'failed' ? 'failed'
          : event.state === 'stopped' ? 'cancelled'
            : 'running';
      putActivity(state, {
        id: event.activityId,
        runId: event.runId,
        taskId: event.taskId,
        sequence: event.sequence,
        startedSequence: prior?.startedSequence || event.sequence,
        timestamp: prior?.timestamp || event.timestamp,
        state: activityState,
        kind: 'preview',
        title,
        summary: event.port ? `Port ${event.port}` : event.message ? compact(event.message, 180) : undefined,
        evidence: {
          semanticType: 'preview',
          ...(event.port ? { port: event.port } : {}),
          ...(event.url ? { url: event.url } : {}),
          ...(event.message ? { message: event.message } : {}),
        },
      });
      return;
    }

    case 'STATE_SNAPSHOT':
      state.state[event.scope] = { ...event.value };
      return;

    case 'STATE_DELTA': {
      state.state[event.scope] = { ...(state.state[event.scope] || {}), ...event.value };
      const reason = String(event.value.reason || event.value.error || event.value.message || '');
      const rawState = String(event.state || event.value.state || '').toLowerCase();
      if (event.scope === 'agent-adapter') {
        const adapterId = String(event.value.adapterId || 'orlynx-ai');
        const activityId = `adapter-error:${adapterId}`;
        const prior = state.activities[activityId];

        // Normal ready/busy heartbeats remain state-only. If a visible error
        // had existed, READY resolves that same semantic object in place.
        if (/ready/.test(rawState) && prior?.state === 'failed') {
          // Adapter health is current state, not durable transcript history.
          // Once recovered, remove the old error instead of adding a noisy
          // "Orlynx AI ready" success row to the user's task stream.
          delete state.activities[activityId];
          return;
        }

        if (/failed|unavailable|error|auth|quota|rate/i.test(`${rawState} ${reason}`)) {
          putActivity(state, {
            id: activityId,
            runId: event.runId,
            taskId: event.taskId,
            sequence: event.sequence,
            startedSequence: prior?.startedSequence || event.sequence,
            timestamp: prior?.timestamp || event.timestamp,
            state: 'failed',
            kind: 'error',
            title: /model/i.test(reason) ? 'Model unavailable' : /auth/i.test(reason) ? 'AI connection needs attention' : 'AI runtime unavailable',
            summary: friendlyFailure(reason) || 'The AI runtime needs attention.',
            evidence: { adapterId, state: rawState },
          });
        }
        return;
      }

      // Bridge/transport/runtime health is also state, not history. Surface only
      // actionable failures and resolve the same item when connectivity returns.
      const infraId = `infra-error:${event.scope}`;
      const priorInfra = state.activities[infraId];
      if (/ready|connected|online/.test(rawState) && priorInfra?.state === 'failed') {
        // Resolved transport errors should disappear from the transcript.
        // The live workspace/header state already communicates recovery.
        delete state.activities[infraId];
        return;
      }
      if (/fail|error|unavailable|disconnect|offline|interrupt|expired|denied/.test(`${rawState} ${reason}`.toLowerCase())) {
        putActivity(state, {
          id: infraId,
          runId: event.runId,
          taskId: event.taskId,
          sequence: event.sequence,
          startedSequence: priorInfra?.startedSequence || event.sequence,
          timestamp: priorInfra?.timestamp || event.timestamp,
          state: 'failed',
          kind: 'error',
          title: 'Connection issue',
          summary: friendlyFailure(reason) || 'The workspace connection needs attention.',
          evidence: { scope: event.scope, state: rawState },
        });
      }
      return;
    }

    case 'CHANGES_UPDATED': {
      const prior = state.activities[event.activityId];
      const count = event.count ?? event.files.length;
      const paths = event.files.map((file) => {
        const record = file && typeof file === 'object' ? file as Record<string, unknown> : {};
        return String(record.path || '');
      }).filter(Boolean);
      const title = count === 1 && paths[0] ? `Updated ${compact(paths[0], 88)}` : `Updated ${count} files`;
      const summary = count > 1 && paths.length
        ? paths.slice(0, 3).map((path) => compact(path, 48)).join(' · ') + (paths.length > 3 ? ` · +${paths.length - 3} more` : '')
        : undefined;
      putActivity(state, {
        id: event.activityId,
        runId: event.runId,
        taskId: event.taskId,
        sequence: event.sequence,
        startedSequence: prior?.startedSequence || event.sequence,
        timestamp: prior?.timestamp || event.timestamp,
        state: 'success',
        kind: 'changes',
        title,
        summary,
        evidence: { ...(event.changeId ? { changeId: event.changeId } : {}), files: event.files },
      });
      return;
    }

    case 'RECEIPT': {
      const command = event.command || '';
      const matching = Object.values(state.tools)
        .filter((tool) => tool.runId === event.runId && (!command || tool.command === command))
        .sort((a, b) => b.sequence - a.sequence)[0];
      if (matching) {
        state.tools[matching.id] = {
          ...matching,
          sequence: event.sequence,
          state: (event.exitCode ?? 0) === 0 ? 'success' : 'failed',
          output: event.output || matching.output,
          exitCode: event.exitCode ?? matching.exitCode,
          error: (event.exitCode ?? 0) === 0 ? undefined : matching.error,
        };
        return;
      }
      putActivity(state, {
        id: event.activityId,
        runId: event.runId,
        taskId: event.taskId,
        sequence: event.sequence,
        startedSequence: event.sequence,
        timestamp: event.timestamp,
        state: (event.exitCode ?? 0) === 0 ? 'success' : 'failed',
        kind: 'receipt',
        title: command ? 'Command completed' : 'Action completed',
        summary: command ? compact(command) : undefined,
        evidence: { ...(command ? { command } : {}), ...(typeof event.exitCode === 'number' ? { exitCode: event.exitCode } : {}) },
        rawOutput: event.output,
      });
      return;
    }

    case 'APPROVAL': {
      const prior = state.activities[event.activityId];
      putActivity(state, {
        id: event.activityId,
        runId: event.runId,
        taskId: event.taskId,
        sequence: event.sequence,
        startedSequence: prior?.startedSequence || event.sequence,
        timestamp: prior?.timestamp || event.timestamp,
        state: event.resolved ? 'success' : 'waiting',
        kind: 'approval',
        title: event.resolved
          ? event.decision === 'deny' || event.decision === 'denied' ? 'Permission denied' : 'Approval resolved'
          : 'Waiting for approval',
        summary: event.detail || event.action,
        evidence: {
          semanticType: 'approval',
          ...(event.approvalId ? { approvalId: event.approvalId } : {}),
          ...(event.action ? { action: event.action } : {}),
          ...(event.decision ? { decision: event.decision } : {}),
        },
      });
      return;
    }

    case 'OTHER':
      return;
  }
}

export function applyStreamProjectionEvents(current: AgentStreamState, events: StreamProjectionEvent[]): AgentStreamState {
  if (!events.length) return current;
  const state = clone(current);
  for (const event of events.sort((a, b) => a.sequence - b.sequence)) applyOne(state, event);
  state.order.sort((a, b) => a.sequence - b.sequence);
  return state;
}

export function applyRawAgentEvents(current: AgentStreamState, events: any[]): AgentStreamState {
  const unseen = events.filter((event) => event?.eventId && !current.seenEventIds.has(String(event.eventId)));
  if (!unseen.length) return current;
  return applyStreamProjectionEvents(current, normalizeOrlynxEvents(unseen));
}

export function reconcileAgentStream(
  current: AgentStreamState,
  runs: any[],
  persistedMessages: any[],
): AgentStreamState {
  const state = clone(current);
  const durableRunIds = new Set(
    persistedMessages
      .filter((message) => message?.role === 'assistant')
      .flatMap((message) => {
        const explicit = String(message?.runId || '');
        if (explicit) return [explicit];
        const id = String(message?.id || '');
        return id.startsWith('msg_') ? [id.slice(4)] : [];
      }),
  );

  for (const run of runs || []) {
    const runId = String(run?.id || '');
    if (!runId) continue;
    const existingRun = state.runs[runId];
    const messageId = existingRun?.messageId || `assistant:${runId}`;
    const terminal = ['completed', 'failed', 'cancelled'].includes(String(run.state || ''));

    state.runs[runId] = {
      id: runId,
      state: String(run.state || existingRun?.state || 'queued') as AgentStreamRun['state'],
      messageId,
      userMessageId: String(run.messageId || existingRun?.userMessageId || '') || undefined,
      plane: String(run.plane || existingRun?.plane || '') || undefined,
      model: String(run.model || existingRun?.model || '') || undefined,
      mode: run.mode || existingRun?.mode,
      permission: run.permission || existingRun?.permission,
      startedAt: String(run.startedAt || existingRun?.startedAt || '') || undefined,
      finishedAt: String(run.finishedAt || existingRun?.finishedAt || '') || undefined,
      error: existingRun?.error,
      errorKind: String(run.errorKind || existingRun?.errorKind || '') || undefined,
    };

    if (terminal && durableRunIds.has(runId)) {
      delete state.messages[messageId];
      continue;
    }

    const snapshot = String(run.partialText || '');
    if (!snapshot) {
      const currentMessage = state.messages[messageId];
      if (currentMessage && terminal) {
        state.messages[messageId] = {
          ...currentMessage,
          state: run.state === 'failed' ? 'failed' : run.state === 'cancelled' ? 'cancelled' : 'completed',
          endedAt: String(run.finishedAt || currentMessage.endedAt || '') || currentMessage.endedAt,
        };
      }
      continue;
    }

    const prior = state.messages[messageId];
    const snapshotAt = stamp(run.partialUpdatedAt || run.updatedAt);
    let text = snapshot;
    if (prior?.text) {
      if (prior.text.startsWith(snapshot)) text = prior.text;
      else if (snapshot.startsWith(prior.text)) text = snapshot;
      else if (snapshotAt < prior.lastEventAt) text = prior.text;
    }
    state.messages[messageId] = {
      id: messageId,
      runId,
      role: 'assistant',
      text,
      state: terminal ? (run.state === 'failed' ? 'failed' : run.state === 'cancelled' ? 'cancelled' : 'completed') : 'streaming',
      startedAt: String(run.startedAt || prior?.startedAt || new Date().toISOString()),
      endedAt: terminal ? String(run.finishedAt || prior?.endedAt || '') || undefined : prior?.endedAt,
      lastSequence: prior?.lastSequence || 0,
      lastEventAt: Math.max(prior?.lastEventAt || 0, snapshotAt),
      userMessageId: String(run.messageId || prior?.userMessageId || '') || undefined,
      plane: String(run.plane || prior?.plane || '') || undefined,
    };
  }

  return state;
}

export function rebuildAgentStream(events: any[], runs: any[] = [], messages: any[] = []): AgentStreamState {
  return reconcileAgentStream(applyRawAgentEvents(emptyAgentStreamState(), events), runs, messages);
}
