/**
 * Replay and live delivery share one monotonically increasing cursor.
 *
 * Live notifications received while durable history is loading are buffered,
 * then merged with that history before the stream becomes live. Out-of-order
 * notifications are held until durable catch-up fills the missing range.
 */
export function createOrderedEventStream<T extends { sequence: number }>(
  after: number,
  deliver: (event: T) => void,
  onGap: (missingFrom: number, missingThrough: number) => void = () => {},
) {
  let cursor = after;
  let replaying = true;
  let closed = false;
  const pending = new Map<number, T>();
  let reportedGap = '';

  const drain = () => {
    while (!closed) {
      const next = pending.get(cursor + 1);
      if (!next) break;
      pending.delete(cursor + 1);
      cursor = next.sequence;
      deliver(next);
    }

    const nextSequence = Math.min(...pending.keys());
    if (!Number.isFinite(nextSequence) || nextSequence <= cursor + 1) {
      reportedGap = '';
      return;
    }
    const gap = `${cursor + 1}:${nextSequence - 1}`;
    if (gap !== reportedGap) {
      reportedGap = gap;
      onGap(cursor + 1, nextSequence - 1);
    }
  };

  const stage = (event: T) => {
    if (closed || !Number.isFinite(event.sequence) || event.sequence <= cursor) return;
    if (!pending.has(event.sequence)) pending.set(event.sequence, event);
    drain();
  };

  return {
    observe(event: T) {
      if (closed || !Number.isFinite(event.sequence) || event.sequence <= cursor) return;
      if (replaying) pending.set(event.sequence, event);
      else stage(event);
    },
    finishReplay(history: T[]) {
      if (closed || !replaying) return;
      const ordered = [...history, ...pending.values()].sort((a, b) => a.sequence - b.sequence);
      pending.clear();
      replaying = false;
      // Local development retains a bounded in-memory history. If its oldest
      // available event is newer than the requested cursor, establish the
      // replay floor there; live delivery remains contiguous afterwards.
      if (ordered.length && ordered[0].sequence > cursor + 1) cursor = ordered[0].sequence - 1;
      for (const event of ordered) stage(event);
      drain();
    },
    close() {
      closed = true;
      pending.clear();
    },
    get sequence() { return cursor; },
    get hasGap() {
      const nextSequence = Math.min(...pending.keys());
      return Number.isFinite(nextSequence) && nextSequence > cursor + 1;
    },
  };
}

export interface SseWritable {
  write(chunk: string): boolean;
  once(event: 'drain', listener: () => void): unknown;
  removeListener(event: 'drain', listener: () => void): unknown;
}

/**
 * Respect Node response backpressure without retaining unbounded terminal
 * output. Overflow closes only this delivery path; the durable cursor lets the
 * browser reconnect and replay every committed event.
 */
export function createBackpressuredWriter(
  writable: SseWritable,
  options: { maxBufferedBytes?: number; onOverflow?: () => void } = {},
) {
  const maxBufferedBytes = Math.max(16_384, options.maxBufferedBytes || 256 * 1024);
  const queued: string[] = [];
  let queuedBytes = 0;
  let blocked = false;
  let closed = false;

  const flush = () => {
    if (closed) return;
    blocked = false;
    while (queued.length) {
      const chunk = queued.shift()!;
      queuedBytes -= Buffer.byteLength(chunk);
      if (!writable.write(chunk)) {
        blocked = true;
        writable.once('drain', flush);
        break;
      }
    }
  };

  return {
    write(chunk: string): boolean {
      if (closed) return false;
      if (!blocked) {
        if (!writable.write(chunk)) {
          blocked = true;
          writable.once('drain', flush);
        }
        return true;
      }
      queued.push(chunk);
      queuedBytes += Buffer.byteLength(chunk);
      if (queuedBytes <= maxBufferedBytes) return true;
      closed = true;
      queued.length = 0;
      queuedBytes = 0;
      writable.removeListener('drain', flush);
      options.onOverflow?.();
      return false;
    },
    close() {
      closed = true;
      queued.length = 0;
      queuedBytes = 0;
      writable.removeListener('drain', flush);
    },
    get bufferedBytes() { return queuedBytes; },
  };
}
