// Run-scoped live assistant replies. Multiple direct/workspace runs may overlap;
 // never combine their message.delta streams into one bubble.
export type LiveReply = {
  runId: string;
  text: string;
  startedAt: string;
  messageId?: string;
  plane?: string;
  state: string;
  lastEventAt: number;
  lastSequence: number;
};

const stamp = (value?: string) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

export function applyLiveReplyEvents(
  current: Record<string, LiveReply>,
  batch: any[],
): Record<string, LiveReply> {
  const next = { ...current };

  for (const event of batch) {
    const runId = String(event?.runId || '');
    if (!runId) continue;
    const sequence = Number(event?.sequence || 0);
    const eventAt = stamp(event?.timestamp);

    if (event.type === 'run.started') {
      const previous = next[runId];
      // A fresh run.start owns only this run. Never clear another reply.
      next[runId] = {
        runId,
        text: previous?.text || '',
        startedAt: String(event.timestamp || previous?.startedAt || new Date().toISOString()),
        messageId: String(event.payload?.messageId || previous?.messageId || '') || undefined,
        plane: String(event.payload?.plane || previous?.plane || '') || undefined,
        state: 'running',
        lastEventAt: Math.max(previous?.lastEventAt || 0, eventAt),
        lastSequence: Math.max(previous?.lastSequence || 0, sequence),
      };
      continue;
    }

    if (event.type === 'message.delta') {
      const delta = String(event.payload?.delta || '');
      if (!delta) continue;
      const previous = next[runId] || {
        runId,
        text: '',
        startedAt: String(event.timestamp || new Date().toISOString()),
        messageId: String(event.payload?.messageId || '') || undefined,
        plane: String(event.payload?.plane || '') || undefined,
        state: 'running',
        lastEventAt: 0,
        lastSequence: 0,
      };
      // Session sequence is authoritative for SSE ordering. This also fixes
      // same-timestamp chunks being dropped by timestamp-only cutoffs.
      if (sequence && sequence <= previous.lastSequence) continue;
      next[runId] = {
        ...previous,
        text: previous.text + delta,
        state: 'running',
        lastEventAt: Math.max(previous.lastEventAt, eventAt),
        lastSequence: Math.max(previous.lastSequence, sequence),
      };
      continue;
    }

    if (event.type === 'run.completed' || event.type === 'run.failed') {
      const previous = next[runId];
      if (previous) {
        next[runId] = {
          ...previous,
          state: event.type === 'run.completed' ? 'completed' : event.payload?.cancelled ? 'cancelled' : 'failed',
          lastEventAt: Math.max(previous.lastEventAt, eventAt),
          lastSequence: Math.max(previous.lastSequence, sequence),
        };
      }
    }
  }

  return next;
}

export function reconcileLiveRepliesFromRuns(
  current: Record<string, LiveReply>,
  runs: any[],
  messages: any[],
): Record<string, LiveReply> {
  const next = { ...current };
  const persistedAssistantIds = new Set(
    messages.filter((message) => message?.role === 'assistant').map((message) => String(message.id || '')),
  );
  const knownRunIds = new Set<string>();

  for (const run of runs) {
    const runId = String(run?.id || '');
    if (!runId) continue;
    knownRunIds.add(runId);
    const terminal = ['completed', 'failed', 'cancelled'].includes(String(run.state || ''));
    const persisted = persistedAssistantIds.has(`msg_${runId}`);

    // Once the durable assistant message exists, it replaces the transient
    // stream bubble. Keep partial text after a failure/cancel only when there
    // is no persisted assistant message to replace it.
    if (terminal && persisted) {
      delete next[runId];
      continue;
    }

    const snapshot = String(run.partialText || '');
    if (!snapshot) {
      if (next[runId]) next[runId] = { ...next[runId], state: String(run.state || next[runId].state) };
      continue;
    }

    const previous = next[runId];
    const snapshotAt = stamp(run.partialUpdatedAt || run.updatedAt);
    let text = snapshot;
    if (previous?.text) {
      if (previous.text.startsWith(snapshot)) text = previous.text;
      else if (snapshot.startsWith(previous.text)) text = snapshot;
      else if (snapshotAt < previous.lastEventAt) text = previous.text;
    }

    next[runId] = {
      runId,
      text,
      startedAt: String(run.startedAt || previous?.startedAt || new Date().toISOString()),
      messageId: String(run.messageId || previous?.messageId || '') || undefined,
      plane: String(run.plane || previous?.plane || '') || undefined,
      state: String(run.state || previous?.state || 'running'),
      lastEventAt: Math.max(previous?.lastEventAt || 0, snapshotAt),
      lastSequence: previous?.lastSequence || 0,
    };
  }

  // Replies from a previous/unknown run must not leak into a restored session.
  for (const runId of Object.keys(next)) {
    if (!knownRunIds.has(runId) && persistedAssistantIds.has(`msg_${runId}`)) delete next[runId];
  }

  return next;
}
