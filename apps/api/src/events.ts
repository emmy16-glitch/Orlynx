import { v4 as uuid } from 'uuid';
import type { EventType, OrlynxEvent } from '@orlynx/shared';
import { store } from './store.js';
import { controlPlaneRepository, durableStorageConfigured } from './storage.js';

const durableQueues = new Map<string, Promise<void>>();
const MAX_EVENT_PAYLOAD_BYTES = Math.max(16_384, Number(process.env.ORLYNX_MAX_EVENT_PAYLOAD_BYTES || 65_536));

function boundedPayload(payload: Record<string, unknown>): Record<string, unknown> {
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

export function emit(sessionId: string, type: EventType, payload: Record<string, unknown> = {}, runId?: string): OrlynxEvent {
  payload = boundedPayload(payload);
  if (durableStorageConfigured()) {
    const pending: Omit<OrlynxEvent, 'sequence'> = { eventId: `evt_${uuid()}`, sessionId, runId, type, timestamp: new Date().toISOString(), payload };
    const queued = (durableQueues.get(sessionId) || Promise.resolve()).then(async () => {
      const evt = await controlPlaneRepository().appendEvent(pending);
      subscribers.get(sessionId)?.forEach((res) => res.write(`id: ${evt.sequence}\ndata: ${JSON.stringify(evt)}\n\n`));
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
  return evt;
}

export async function durableHistory(sessionId: string, after = 0, limit = 200): Promise<OrlynxEvent[]> {
  return durableStorageConfigured() ? controlPlaneRepository().listEvents(sessionId, after, limit) : history(sessionId, after, limit);
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
