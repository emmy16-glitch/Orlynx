import { v4 as uuid } from 'uuid';
import type { EventType, OrlynxEvent } from '@orlynx/shared';
import { store } from './store.js';
import { controlPlaneRepository, durableStorageConfigured } from './storage.js';

const durableQueues = new Map<string, Promise<void>>();
const MAX_EVENT_PAYLOAD_BYTES = Math.max(16_384, Number(process.env.ORLYNX_MAX_EVENT_PAYLOAD_BYTES || 65_536));

export function redactEventString(value: string): string {
  return String(value || '')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted-github-token]')
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[redacted-api-key]')
    .replace(/((?:admin\s+)?token|password|secret|api[_ -]?key|authorization|bearer)(\s*(?:[:=]|is)?\s*)([A-Za-z0-9._~+/=-]{16,})/ig, '$1$2[redacted]')
    .replace(/((?:admin\s+)?token[^\n]{0,80}?)([a-f0-9]{40,128})\b/ig, '$1[redacted]');
}
function redactEventValue(value: unknown): unknown {
  if (typeof value === 'string') return redactEventString(value);
  if (Array.isArray(value)) return value.map(redactEventValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /token|secret|password|private.?key|api.?key|credential|authorization/i.test(key) ? '[redacted]' : redactEventValue(item),
    ]));
  }
  return value;
}

function boundedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  payload = redactEventValue(payload) as Record<string, unknown>;
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) <= MAX_EVENT_PAYLOAD_BYTES) return payload;
  const clipped: Record<string, unknown> = { ...payload, truncated: true };
  for (const key of ['rawOutput', 'stdout', 'stderr', 'out', 'data']) {
    if (typeof clipped[key] === 'string') clipped[key] = String(clipped[key]).slice(0, Math.floor(MAX_EVENT_PAYLOAD_BYTES / 4));
  }
  const second = JSON.stringify(clipped);
  if (Buffer.byteLength(second) <= MAX_EVENT_PAYLOAD_BYTES) return clipped;
  return {
    truncated: true,
    summary: typeof payload.summary === 'string' ? payload.summary.slice(0, 2_000) : undefined,
    error: typeof payload.error === 'string' ? payload.error.slice(0, 2_000) : undefined,
    note: 'Large event payload omitted. Raw command output is not retained inline.',
  };
}

export async function emitPersisted(
  sessionId: string,
  type: EventType,
  payload: Record<string, unknown> = {},
  runId?: string,
  context: { taskId?: string; workspaceId?: string; eventId?: string; timestamp?: string } = {},
): Promise<OrlynxEvent> {
  payload = boundedPayload(payload);
  if (durableStorageConfigured()) {
    const pending: Omit<OrlynxEvent, 'sequence'> = {
      eventId: context.eventId || `evt_${uuid()}`,
      sessionId,
      ...(context.taskId ? { taskId: context.taskId } : {}),
      ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
      ...(runId ? { runId } : {}),
      type,
      timestamp: context.timestamp || new Date().toISOString(),
      payload,
    };
    let persisted: OrlynxEvent | undefined;
    const queued = (durableQueues.get(sessionId) || Promise.resolve()).then(async () => {
      persisted = await controlPlaneRepository().appendEvent(pending);
      subscribers.get(sessionId)?.forEach((res) => res.write(`id: ${persisted!.sequence}\ndata: ${JSON.stringify(persisted)}\n\n`));
      eventSubscribers.get(sessionId)?.forEach((listener) => listener(persisted!));
    });
    durableQueues.set(sessionId, queued.catch(() => {}));
    await queued;
    return persisted!;
  }

  const sequence = store.nextSeq(sessionId);
  const evt: OrlynxEvent = {
    eventId: context.eventId || `evt_${uuid().slice(0, 8)}`,
    sessionId,
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(runId ? { runId } : {}),
    sequence,
    type,
    timestamp: context.timestamp || new Date().toISOString(),
    payload,
  };
  (store.db.events[sessionId] ||= []).push(evt);
  if (store.db.events[sessionId].length > 2000) store.db.events[sessionId] = store.db.events[sessionId].slice(-2000);
  store.save();
  subscribers.get(sessionId)?.forEach((res) => res.write(`id: ${evt.sequence}\ndata: ${JSON.stringify(evt)}\n\n`));
  eventSubscribers.get(sessionId)?.forEach((listener) => listener(evt));
  return evt;
}

export function emit(sessionId: string, type: EventType, payload: Record<string, unknown> = {}, runId?: string): OrlynxEvent {
  payload = boundedPayload(payload);
  if (durableStorageConfigured()) {
    const pending: Omit<OrlynxEvent, 'sequence'> = { eventId: `evt_${uuid()}`, sessionId, runId, type, timestamp: new Date().toISOString(), payload };
    const queued = (durableQueues.get(sessionId) || Promise.resolve()).then(async () => {
      const evt = await controlPlaneRepository().appendEvent(pending);
      subscribers.get(sessionId)?.forEach((res) => res.write(`id: ${evt.sequence}\ndata: ${JSON.stringify(evt)}\n\n`));
      eventSubscribers.get(sessionId)?.forEach((listener) => listener(evt));
    }).catch(() => { /* request paths surface storage health separately */ });
    durableQueues.set(sessionId, queued);
    return { ...pending, sequence: 0 };
  }
  const sequence = store.nextSeq(sessionId);
  const evt: OrlynxEvent = {
    eventId: `evt_${uuid().slice(0, 8)}`,
    sessionId,
    runId,
    sequence,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
  (store.db.events[sessionId] ||= []).push(evt);
  // bound log retention: keep last 2000 events per session (PDF §17)
  if (store.db.events[sessionId].length > 2000) {
    store.db.events[sessionId] = store.db.events[sessionId].slice(-2000);
  }
  store.save();
  // push to SSE subscribers
  subscribers.get(sessionId)?.forEach((res) => {
    res.write(`id: ${evt.sequence}\ndata: ${JSON.stringify(evt)}\n\n`);
  });
  eventSubscribers.get(sessionId)?.forEach((listener) => listener(evt));
  return evt;
}

export async function durableHistory(sessionId: string, after = 0, limit = 200): Promise<OrlynxEvent[]> {
  return durableStorageConfigured() ? controlPlaneRepository().listEvents(sessionId, after, limit) : history(sessionId, after, limit);
}

export async function recentHistory(sessionId: string, limit = 300): Promise<OrlynxEvent[]> {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 300, 500));
  return durableStorageConfigured()
    ? controlPlaneRepository().listRecentEvents(sessionId, safeLimit)
    : (store.db.events[sessionId] || []).slice(-safeLimit);
}

export function history(sessionId: string, after = 0, limit = 200): OrlynxEvent[] {
  return (store.db.events[sessionId] || []).filter((e) => e.sequence > after).slice(0, limit);
}

// SSE response registry (Response-like with write())
type Writer = { write: (s: string) => void };
const subscribers = new Map<string, Set<Writer>>();
export function subscribe(sessionId: string, w: Writer): () => void {
  let set = subscribers.get(sessionId);
  if (!set) { set = new Set(); subscribers.set(sessionId, set); }
  set.add(w);
  return () => { set!.delete(w); };
}

// Durable streams can receive freshly persisted events immediately without
// repeatedly querying Postgres. A slower database catch-up remains the safety
// net for restarts or events produced by another process.
type EventListener = (event: OrlynxEvent) => void;
const eventSubscribers = new Map<string, Set<EventListener>>();
export function subscribeEvents(sessionId: string, listener: EventListener): () => void {
  let set = eventSubscribers.get(sessionId);
  if (!set) { set = new Set(); eventSubscribers.set(sessionId, set); }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (!set!.size) eventSubscribers.delete(sessionId);
  };
}
