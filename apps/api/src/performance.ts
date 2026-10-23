const MAX_SAMPLES = Math.max(100, Number(process.env.ORLYNX_PERF_SAMPLES || 1_024));

type MetricBucket = {
  values: number[];
  total: number;
  min: number;
  max: number;
  lastAt: string;
};

const metrics = new Map<string, MetricBucket>();
const SAFE_NAME = /^[a-z][a-z0-9_.-]{1,63}$/;

export function recordPerformance(name: string, durationMs: number): void {
  if (!SAFE_NAME.test(name) || !Number.isFinite(durationMs) || durationMs < 0) return;
  const value = Math.round(durationMs * 100) / 100;
  const bucket = metrics.get(name) || {
    values: [], total: 0, min: value, max: value, lastAt: new Date().toISOString(),
  };
  bucket.values.push(value);
  if (bucket.values.length > MAX_SAMPLES) bucket.values.splice(0, bucket.values.length - MAX_SAMPLES);
  bucket.total += 1;
  bucket.min = Math.min(bucket.min, value);
  bucket.max = Math.max(bucket.max, value);
  bucket.lastAt = new Date().toISOString();
  metrics.set(name, bucket);
}

function percentile(sorted: number[], quantile: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

export function performanceSnapshot() {
  return [...metrics.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, bucket]) => {
    const sorted = [...bucket.values].sort((a, b) => a - b);
    return {
      name,
      samples: bucket.total,
      retainedSamples: sorted.length,
      p50Ms: percentile(sorted, 0.50),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      minMs: bucket.min,
      maxMs: bucket.max,
      lastAt: bucket.lastAt,
    };
  });
}

export function resetPerformanceForTests(): void {
  metrics.clear();
}
