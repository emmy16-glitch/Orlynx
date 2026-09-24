// Real OpenCode adapter. There is intentionally no built-in/demo agent fallback.
import { v4 as uuid } from 'uuid';
import type { AgentRun, ChangedFile } from '@orlynx/shared';
import { store } from './store.js';
import { emit } from './events.js';
import { createChangeSet } from './changes.js';
import { abortOpenCodeSession, getOrCreateOpenCodeSession, openCodeDiff, openCodeMessages, openCodeSessionStatus, openCodeStatus, promptOpenCode, type OpenCodeMessage } from './opencode.js';

export type Engine = 'opencode';
const activeOpenCodeSessions = new Map<string, { project: string; sessionId: string; cancelled: boolean }>();
const timeoutMs = Math.max(60_000, Number(process.env.OPENCODE_RUN_TIMEOUT_MS || 30 * 60_000));

export async function startRun(sessionId: string, project: string, userText: string, engine: Engine = 'opencode'): Promise<AgentRun> {
  if (engine !== 'opencode') throw new Error('Only the configured OpenCode server adapter is supported.');
  if ((store.db.runs[sessionId] || []).some((candidate) => candidate.state === 'running')) throw new Error('An OpenCode task is already running in this project.');
  const connection = await openCodeStatus(project);
  if (!connection.connected) throw new Error(connection.message || 'OpenCode is unavailable. Configure a healthy OpenCode server before sending work.');
  const openCodeSession = await getOrCreateOpenCodeSession(sessionId, project);
  const before = await openCodeMessages(project, openCodeSession.id);
  const previousAssistantId = [...before].reverse().find((message) => message.info?.role === 'assistant')?.info?.id;
  const run: AgentRun = {
    id: `run_${uuid().slice(0, 8)}`, sessionId, engine,
    state: 'running', activity: 'Sending work to OpenCode', startedAt: new Date().toISOString(),
  };
  (store.db.runs[sessionId] ||= []).push(run);
  store.save();
  emit(sessionId, 'run.started', { engine }, run.id);
  emit(sessionId, 'activity.started', { text: 'Sending task to OpenCode' }, run.id);
  emit(sessionId, 'message.start', { engine }, run.id);
  try {
    await promptOpenCode(project, openCodeSession.id, userText);
  } catch (error) {
    run.state = 'failed'; run.finishedAt = new Date().toISOString();
    store.save();
    emit(sessionId, 'run.failed', { error: error instanceof Error ? error.message : 'OpenCode rejected the task.' }, run.id);
    throw error;
  }
  activeOpenCodeSessions.set(run.id, { project, sessionId: openCodeSession.id, cancelled: false });
  void monitorRun(sessionId, project, openCodeSession.id, run, previousAssistantId);
  return run;
}

async function monitorRun(sessionId: string, project: string, openCodeSessionId: string, run: AgentRun, previousAssistantId?: string): Promise<void> {
  const active = activeOpenCodeSessions.get(run.id);
  if (!active) return;
  const deadline = Date.now() + timeoutMs;
  let assistant: OpenCodeMessage | undefined;
  let visibleText = '';
  const toolStates = new Map<string, string>();
  try {
    while (Date.now() < deadline && !active.cancelled) {
      const messages = await openCodeMessages(project, openCodeSessionId);
      assistant = [...messages].reverse().find((message) => message.info?.role === 'assistant' && message.info?.id !== previousAssistantId);
      if (assistant) {
        const text = assistant.parts.filter((part) => part.type === 'text').map((part) => String(part.text || '')).join('');
        if (text.startsWith(visibleText) && text.length > visibleText.length) {
          emit(sessionId, 'message.delta', { delta: text.slice(visibleText.length) }, run.id);
          visibleText = text;
        } else if (text && !visibleText) {
          emit(sessionId, 'message.delta', { delta: text }, run.id);
          visibleText = text;
        }
        collectToolEvents(sessionId, run.id, assistant, toolStates);
        const failed = Boolean(assistant.info?.error);
        const complete = Boolean(assistant.info?.time?.completed) || (assistant.info?.finish && assistant.info.finish !== 'tool-calls');
        if (failed) throw new Error('OpenCode reported that the task failed.');
        if (complete) break;
      }
      const status = await openCodeSessionStatus(project, openCodeSessionId);
      if (assistant && status.type === 'idle') break;
      await delay(800);
    }
    if (active.cancelled) return;
    if (Date.now() >= deadline) throw new Error(`OpenCode task timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    if (!assistant) throw new Error('OpenCode finished without returning an assistant response.');
    const responseText = assistant.parts.filter((part) => part.type === 'text').map((part) => String(part.text || '')).join('');
    (store.db.messages[sessionId] ||= []).push({ id: `msg_${run.id}`, sessionId, role: 'assistant', text: responseText, createdAt: new Date().toISOString() });
    emit(sessionId, 'message.end', {}, run.id);
    await captureDiff(sessionId, project, run.id, openCodeSessionId);
    run.state = 'completed';
    run.finishedAt = new Date().toISOString();
    run.activity = 'Ready for review';
    store.save();
    emit(sessionId, 'run.completed', { summary: 'OpenCode finished. Review the changes.' }, run.id);
    emit(sessionId, 'activity.completed', { text: 'OpenCode task completed' }, run.id);
  } catch (error) {
    if (active.cancelled) return;
    run.state = 'failed';
    run.finishedAt = new Date().toISOString();
    run.activity = 'OpenCode task failed';
    store.save();
    for (const [toolId, state] of toolStates) if (state === 'running') emit(sessionId, 'tool.failed', { toolCallId: toolId, error: 'OpenCode did not complete this action.' }, run.id);
    emit(sessionId, 'run.failed', { error: error instanceof Error ? error.message : 'OpenCode task failed.' }, run.id);
  } finally {
    activeOpenCodeSessions.delete(run.id);
  }
}

function collectToolEvents(sessionId: string, runId: string, message: OpenCodeMessage, toolStates: Map<string, string>) {
  for (const part of message.parts) {
    if (part.type !== 'tool') continue;
    const toolId = String(part.callID || part.id || `${message.info.id}:${part.tool}`);
    const state = String(part.state?.status || 'running');
    const prior = toolStates.get(toolId);
    if (!prior) emit(sessionId, 'tool.started', { tool: String(part.tool || 'OpenCode action'), toolCallId: toolId }, runId);
    if (state === 'completed' && prior !== 'completed') {
      emit(sessionId, 'tool.completed', { tool: String(part.tool || 'OpenCode action'), toolCallId: toolId, out: String(part.state?.output || '') }, runId);
    } else if (state === 'error' && prior !== 'error') {
      emit(sessionId, 'tool.failed', { tool: String(part.tool || 'OpenCode action'), toolCallId: toolId, error: String(part.state?.error || 'Action failed.'), out: String(part.state?.output || '') }, runId);
    } else if (state === 'running' && prior !== 'running') {
      emit(sessionId, 'tool.output', { tool: String(part.tool || 'OpenCode action'), toolCallId: toolId }, runId);
    }
    toolStates.set(toolId, state);
  }
}

async function captureDiff(sessionId: string, project: string, runId: string, openCodeSessionId: string) {
  const raw = await openCodeDiff(project, openCodeSessionId);
  const files: ChangedFile[] = raw.flatMap((item) => {
    const file = String(item.file || item.path || '');
    if (!file || file.startsWith('/') || file.split('/').includes('..')) return [];
    const action = item.status === 'added' ? 'create' : item.status === 'deleted' ? 'delete' : 'modify';
    return [{ path: file, action, before: typeof item.before === 'string' ? item.before : undefined, after: typeof item.after === 'string' ? item.after : undefined, diff: typeof item.diff === 'string' ? item.diff : undefined }];
  });
  if (files.length) createChangeSet(sessionId, project, files, runId);
}

export async function cancelRun(sessionId: string, runId: string) {
  const run = (store.db.runs[sessionId] || []).find((item) => item.id === runId);
  if (!run || run.state !== 'running') return run;
  const active = activeOpenCodeSessions.get(runId);
  if (active) {
    active.cancelled = true;
    try { await abortOpenCodeSession(active.project, active.sessionId); } catch { /* cancellation still terminates Orlynx state */ }
  }
  run.state = 'cancelled'; run.finishedAt = new Date().toISOString(); run.activity = 'Stopped';
  store.save();
  emit(sessionId, 'run.failed', { cancelled: true }, runId);
  return run;
}

export function currentRuns(sessionId: string): AgentRun[] { return store.db.runs[sessionId] || []; }

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
