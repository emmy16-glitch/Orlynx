import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBackpressuredWriter, createOrderedEventStream } from '../src/sse-stream.ts';

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

test('bounded history can establish a newer replay floor before live ordering begins', () => {
  const received = [];
  const stream = createOrderedEventStream(0, (event) => received.push(event.sequence));
  stream.finishReplay([{ sequence: 50 }, { sequence: 51 }]);
  stream.observe({ sequence: 53 });
  assert.deepEqual(received, [50, 51]);
  stream.observe({ sequence: 52 });
  assert.deepEqual(received, [50, 51, 52, 53]);
});

test('a live sequence gap is held until durable catch-up fills it', () => {
  const received = [];
  const gaps = [];
  const stream = createOrderedEventStream(4, (event) => received.push(event.sequence), (from, through) => gaps.push([from, through]));
  stream.finishReplay([{ sequence: 5 }]);
  stream.observe({ sequence: 8 });
  stream.observe({ sequence: 7 });
  assert.deepEqual(received, [5]);
  assert.equal(stream.sequence, 5);
  assert.deepEqual(gaps, [[6, 7], [6, 6]]);
  stream.observe({ sequence: 6 });
  assert.deepEqual(received, [5, 6, 7, 8]);
  assert.equal(stream.hasGap, false);
});

test('slow SSE writers flush in order after drain', () => {
  class Writable extends EventEmitter {
    chunks = [];
    blocked = true;
    write(chunk) {
      this.chunks.push(chunk);
      if (this.blocked) { this.blocked = false; return false; }
      return true;
    }
  }
  const target = new Writable();
  const writer = createBackpressuredWriter(target);
  writer.write('one');
  writer.write('two');
  writer.write('three');
  assert.deepEqual(target.chunks, ['one']);
  target.emit('drain');
  assert.deepEqual(target.chunks, ['one', 'two', 'three']);
  assert.equal(writer.bufferedBytes, 0);
});

test('slow SSE clients are disconnected when their bounded queue overflows', () => {
  class Writable extends EventEmitter {
    write() { return false; }
  }
  let overflowed = false;
  const writer = createBackpressuredWriter(new Writable(), { maxBufferedBytes: 16_384, onOverflow: () => { overflowed = true; } });
  writer.write('blocked');
  writer.write('x'.repeat(10_000));
  assert.equal(writer.write('y'.repeat(10_000)), false);
  assert.equal(overflowed, true);
  assert.equal(writer.bufferedBytes, 0);
});
