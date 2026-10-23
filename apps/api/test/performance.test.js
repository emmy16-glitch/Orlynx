import test from 'node:test';
import assert from 'node:assert/strict';
import { performanceSnapshot, recordPerformance, resetPerformanceForTests } from '../src/performance.ts';

test('performance metrics expose bounded percentile summaries without payload data', () => {
  resetPerformanceForTests();
  for (let value = 1; value <= 100; value += 1) recordPerformance('event.persistence_ms', value);
  recordPerformance('invalid name', 10);
  recordPerformance('event.persistence_ms', Number.NaN);
  assert.deepEqual(performanceSnapshot(), [{
    name: 'event.persistence_ms', samples: 100, retainedSamples: 100,
    p50Ms: 50, p95Ms: 95, p99Ms: 99, minMs: 1, maxMs: 100,
    lastAt: performanceSnapshot()[0].lastAt,
  }]);
});
