/**
 * Replay and live delivery share one monotonically increasing cursor.
 *
 * Live notifications received while durable history is loading are buffered,
 * then merged with that history before the stream becomes live. This prevents
 * an event in the replay/subscribe window from being delayed or duplicated.
 */
export function createOrderedEventStream<T extends { sequence: number }>(
  after: number,
  deliver: (event: T) => void,
) {
  let cursor = after;
  let replaying = true;
  let closed = false;
  const pending: T[] = [];

  const forward = (event: T) => {
    if (closed || !Number.isFinite(event.sequence) || event.sequence <= cursor) return;
    cursor = event.sequence;
    deliver(event);
  };

  return {
    observe(event: T) {
      if (closed) return;
      if (replaying) pending.push(event);
      else forward(event);
    },
    finishReplay(history: T[]) {
      if (closed || !replaying) return;
      const ordered = [...history, ...pending].sort((a, b) => a.sequence - b.sequence);
      replaying = false;
      pending.length = 0;
      for (const event of ordered) forward(event);
    },
    close() {
      closed = true;
      pending.length = 0;
    },
    get sequence() { return cursor; },
  };
}
