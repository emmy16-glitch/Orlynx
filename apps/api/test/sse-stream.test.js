import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderedEventStream } from '../src/sse-stream.ts';

test('events emitted during asynchronous history loading are replayed once in sequence order', () => {
  const received = [];
  const stream = createOrderedEventStream(5, (event) => received.push(event.sequence));
  stream.observe({ sequence: 8 });
  stream.observe({ sequence: 7 });
  stream.finishReplay([{ sequence: 6 }, { sequence: 7 }]);
  stream.observe({ sequence: 8 });
  stream.observe({ sequence: 9 });
  assert.deepEqual(received, [6, 7, 8, 9]);
  assert.equal(stream.sequence, 9);
});

test('reconnection skips already seen sequences and ignores nonfinite cursors', () => {
  const received = [];
  const stream = createOrderedEventStream(100, (event) => received.push(event.sequence));
  stream.finishReplay([{ sequence: 99 }, { sequence: 100 }, { sequence: 101 }]);
  stream.observe({ sequence: Number.NaN });
  stream.observe({ sequence: 101 });
  stream.observe({ sequence: 102 });
  assert.deepEqual(received, [101, 102]);
});

test('closing stream during replay drops staged events', () => {
  const received = [];
  const stream = createOrderedEventStream(0, (event) => received.push(event.sequence));
  stream.observe({ sequence: 1 });
  stream.close();
  stream.finishReplay([{ sequence: 1 }, { sequence: 2 }]);
  stream.observe({ sequence: 3 });
  assert.deepEqual(received, []);
});
