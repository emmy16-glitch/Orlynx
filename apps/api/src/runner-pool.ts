export interface RunnerHostConfig {
  id: string;
  url: string;
  publicUrl: string;
  region?: string;
  weight: number;
}

export const RUNNER_PROTOCOL_VERSION = 1;

export function expectedRunnerCommit(): string | null {
  const value = String(process.env.RENDER_GIT_COMMIT || process.env.ORLYNX_RUNNER_BUILD || '').slice(0, 40);
  return value || null;
}

export interface RunnerHostHealth {
  id: string;
  ok: boolean;
  capacity: number;
  running: number;
  available: number;
  stopped: number;
  draining: boolean;
  latencyMs: number;
  checkedAt: number;
  detail?: string;
  protocolVersion?: number;
  buildCommit?: string | null;
  serviceId?: string | null;
  stale?: boolean;
  capabilities?: {
    browserE2e?: boolean;
  };
}

type CircuitState = { failures: number; openUntil: number };
const circuits = new Map<string, CircuitState>();
const healthCache = new Map<string, RunnerHostHealth>();

function normalizedUrl(value: string): string {
  return String(value || '').trim().replace(/\/$/, '');
}

function safeHostId(value: string, fallback: string): string {
  const candidate = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return candidate || fallback;
}

function parseConfiguredHosts(): RunnerHostConfig[] {
  const raw = String(process.env.ORLYNX_RUNNER_HOSTS || '').trim();
  const legacyUrl = normalizedUrl(process.env.ORLYNX_RUNNER_URL || '');
  const legacyPublic = normalizedUrl(process.env.ORLYNX_RUNNER_PUBLIC_URL || legacyUrl);
  const hosts: RunnerHostConfig[] = [];

  if (raw) {
    if (raw.startsWith('[')) {
      let values: unknown;
      try { values = JSON.parse(raw); } catch { throw new Error('ORLYNX_RUNNER_HOSTS must be valid JSON or a comma-separated id=url list.'); }
      if (!Array.isArray(values)) throw new Error('ORLYNX_RUNNER_HOSTS JSON must be an array.');
      for (const [index, value] of values.entries()) {
        if (!value || typeof value !== 'object') continue;
        const row = value as { id?: string; url?: string; publicUrl?: string; region?: string; weight?: number };
        const url = normalizedUrl(row.url || '');
        if (!url.startsWith('https://')) continue;
        hosts.push({
          id: safeHostId(row.id || '', `runner-${index + 1}`),
          url,
          publicUrl: normalizedUrl(row.publicUrl || url),
          region: row.region ? String(row.region) : undefined,
          weight: Math.max(1, Math.min(100, Number(row.weight || 1))),
        });
      }
    } else {
      for (const [index, entry] of raw.split(',').map((value) => value.trim()).filter(Boolean).entries()) {
        const eq = entry.indexOf('=');
        const id = eq > 0 ? entry.slice(0, eq).trim() : `runner-${index + 1}`;
        const url = normalizedUrl(eq > 0 ? entry.slice(eq + 1) : entry);
        if (!url.startsWith('https://')) continue;
        hosts.push({ id: safeHostId(id, `runner-${index + 1}`), url, publicUrl: url, weight: 1 });
      }
    }
  }

  if (!hosts.length && legacyUrl.startsWith('https://')) {
    hosts.push({ id: 'default', url: legacyUrl, publicUrl: legacyPublic || legacyUrl, weight: 1 });
  }

  const seen = new Set<string>();
  return hosts.filter((host) => {
    if (seen.has(host.id)) throw new Error(`Duplicate Orlynx runner host id: ${host.id}`);
    seen.add(host.id);
    return true;
  });
}

export function runnerHosts(): RunnerHostConfig[] {
  return parseConfiguredHosts();
}

export function runnerPoolConfigured(): boolean {
  return runnerHosts().length > 0 && Boolean(process.env.ORLYNX_RUNNER_TOKEN);
}

export function runnerGlobalMaxWorkspaces(): number {
  return Math.max(1, Math.min(500, Number(process.env.ORLYNX_RUNNER_GLOBAL_MAX_WORKSPACES || 50)));
}

function circuitOpen(host: RunnerHostConfig): boolean {
  return (circuits.get(host.id)?.openUntil || 0) > Date.now();
}

export function noteRunnerHostSuccess(hostId: string): void {
  circuits.set(hostId, { failures: 0, openUntil: 0 });
}

export function noteRunnerHostFailure(hostId: string): void {
  const current = circuits.get(hostId) || { failures: 0, openUntil: 0 };
  const failures = current.failures + 1;
  const threshold = Math.max(1, Number(process.env.ORLYNX_RUNNER_CIRCUIT_FAILURES || 3));
  const cooldown = Math.max(15_000, Number(process.env.ORLYNX_RUNNER_CIRCUIT_COOLDOWN_MS || 60_000));
  circuits.set(hostId, {
    failures,
    openUntil: failures >= threshold ? Date.now() + cooldown : current.openUntil,
  });
}

export function runnerHostById(id?: string): RunnerHostConfig | undefined {
  const hosts = runnerHosts();
  if (!id) return hosts[0];
  return hosts.find((host) => host.id === id) || hosts[0];
}

export async function probeRunnerHost(host: RunnerHostConfig, force = false): Promise<RunnerHostHealth> {
  const cached = healthCache.get(host.id);
  const ttl = Math.max(1_000, Number(process.env.ORLYNX_RUNNER_HEALTH_CACHE_MS || 5_000));
  if (!force && cached && cached.checkedAt + ttl > Date.now()) return cached;

  if (circuitOpen(host) && !force) {
    const result: RunnerHostHealth = {
      id: host.id,
      ok: false,
      capacity: 0,
      running: 0,
      available: 0,
      stopped: 0,
      draining: true,
      latencyMs: 0,
      checkedAt: Date.now(),
      detail: 'circuit-open',
    };
    healthCache.set(host.id, result);
    return result;
  }

  const started = Date.now();
  const normalTimeoutMs = Math.max(2_500, Number(process.env.ORLYNX_RUNNER_HEALTH_TIMEOUT_MS || 5_000));
  const coldStartTimeoutMs = Math.max(
    normalTimeoutMs,
    Number(process.env.ORLYNX_RUNNER_COLD_START_TIMEOUT_MS || 45_000),
  );
  const wakeRetryMs = Math.max(500, Number(process.env.ORLYNX_RUNNER_WAKE_RETRY_MS || 2_000));
  let lastDetail = 'health probe failed';
  let attempts = 0;

  const probeOnce = async (timeoutMs: number): Promise<{
    result?: RunnerHostHealth;
    retryable: boolean;
    detail: string;
  }> => {
    attempts += 1;
    try {
      const response = await fetch(`${host.url}/health`, {
        headers: process.env.ORLYNX_RUNNER_TOKEN ? { Authorization: `Bearer ${process.env.ORLYNX_RUNNER_TOKEN}` } : {},
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
      const body = await response.json().catch(() => ({})) as {
        ok?: boolean;
        capacity?: number;
        running?: number;
        available?: number;
        stopped?: number;
        draining?: boolean;
        workspace?: { state?: string } | null;
        protocolVersion?: number;
        buildCommit?: string | null;
        serviceId?: string | null;
        capabilities?: { browserE2e?: boolean };
      };
      const capacity = Math.max(1, Number(body.capacity || 1));
      const running = Math.max(0, Number(body.running ?? (body.workspace?.state === 'running' ? 1 : 0)));
      const available = Math.max(0, Number(body.available ?? (capacity - running)));
      const expected = expectedRunnerCommit();
      const reported = typeof body.buildCommit === 'string' && body.buildCommit ? body.buildCommit.slice(0, 40) : null;
      const stale = Boolean(expected && reported && expected !== reported);
      const protocolMismatch = typeof body.protocolVersion === 'number' && body.protocolVersion !== RUNNER_PROTOCOL_VERSION;
      const result: RunnerHostHealth = {
        id: host.id,
        // A stale or protocol-mismatched runner must never look healthy to
        // the pool: it is marked degraded so routing prefers current hosts.
        ok: response.ok && body.ok !== false && !stale && !protocolMismatch,
        capacity,
        running,
        available,
        stopped: Math.max(0, Number(body.stopped || 0)),
        draining: Boolean(body.draining),
        latencyMs: Date.now() - started,
        checkedAt: Date.now(),
        detail: stale
          ? `stale build ${reported} (expected ${expected})`
          : protocolMismatch
            ? `protocol v${body.protocolVersion} (expected v${RUNNER_PROTOCOL_VERSION})`
            : response.ok ? undefined : `HTTP ${response.status}`,
        protocolVersion: typeof body.protocolVersion === 'number' ? body.protocolVersion : undefined,
        buildCommit: reported,
        serviceId: typeof body.serviceId === 'string' && body.serviceId ? body.serviceId : null,
        stale,
        capabilities: body.capabilities,
      };
      return {
        result,
        retryable: response.status === 502 || response.status === 503 || response.status === 504,
        detail: result.detail || (result.ok ? 'healthy' : 'runner reported unhealthy'),
      };
    } catch (error) {
      return {
        retryable: true,
        detail: error instanceof Error ? error.message : 'health probe failed',
      };
    }
  };

  const accept = (result: RunnerHostHealth): RunnerHostHealth => {
    healthCache.set(host.id, result);
    if (result.ok) noteRunnerHostSuccess(host.id);
    else noteRunnerHostFailure(host.id);
    return result;
  };

  if (force) {
    // Render may answer 502/503 immediately while a free service is booting.
    // A single long request timeout therefore does not create a real cold-start
    // window. Retry transient edge responses until one overall deadline while
    // still failing fast on non-transient responses such as 401/403/404.
    const deadline = started + coldStartTimeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const outcome = await probeOnce(Math.min(normalTimeoutMs, remaining));
      lastDetail = outcome.detail;
      if (outcome.result?.ok) return accept(outcome.result);
      if (outcome.result && !outcome.retryable) return accept(outcome.result);

      const remainingAfterProbe = deadline - Date.now();
      if (remainingAfterProbe <= 0) break;
      const backoff = Math.min(5_000, wakeRetryMs * Math.min(3, attempts));
      await new Promise((resolve) => setTimeout(resolve, Math.min(backoff, remainingAfterProbe)));
    }

    noteRunnerHostFailure(host.id);
    const result: RunnerHostHealth = {
      id: host.id,
      ok: false,
      capacity: 0,
      running: 0,
      available: 0,
      stopped: 0,
      draining: false,
      latencyMs: Date.now() - started,
      checkedAt: Date.now(),
      detail: `${lastDetail}; wake attempts=${attempts}`,
    };
    healthCache.set(host.id, result);
    return result;
  }

  const attemptTimeouts = [normalTimeoutMs, coldStartTimeoutMs];
  for (let attempt = 0; attempt < attemptTimeouts.length; attempt += 1) {
    const outcome = await probeOnce(attemptTimeouts[attempt]);
    lastDetail = outcome.detail;
    if (outcome.result?.ok) return accept(outcome.result);
    if (outcome.result && !outcome.retryable) return accept(outcome.result);
    if (attempt + 1 < attemptTimeouts.length) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      continue;
    }
  }

  noteRunnerHostFailure(host.id);
  const result: RunnerHostHealth = {
    id: host.id,
    ok: false,
    capacity: 0,
    running: 0,
    available: 0,
    stopped: 0,
    draining: false,
    latencyMs: Date.now() - started,
    checkedAt: Date.now(),
    detail: lastDetail,
  };
  healthCache.set(host.id, result);
  return result;
}
export async function runnerPoolSnapshot(force = false): Promise<Array<{ host: RunnerHostConfig; health: RunnerHostHealth }>> {
  const hosts = runnerHosts();
  return Promise.all(hosts.map(async (host) => ({ host, health: await probeRunnerHost(host, force) })));
}

// Cached per-host health for diagnostics. Never probes: probing is the
// pool's job (bounded wake windows); diagnostics must stay fast and safe.
export function runnerPoolCachedHealth(): Array<{ hostId: string; url: string; health: RunnerHostHealth | null }> {
  return runnerHosts().map((host) => ({ hostId: host.id, url: host.url, health: healthCache.get(host.id) || null }));
}

export function runnerPoolHealthSummary(): {
  totalHosts: number;
  knownHosts: number;
  healthyHosts: number;
  capacity: number;
  running: number;
  available: number;
  bestLatencyMs: number;
  browserE2eAvailable: boolean;
} {
  const hosts = runnerHosts();
  const rows = hosts.map((host) => healthCache.get(host.id)).filter((value): value is RunnerHostHealth => Boolean(value));
  const healthy = rows.filter((row) => row.ok && !row.draining);
  const latencies = healthy.map((row) => row.latencyMs).filter((value) => value > 0);
  return {
    totalHosts: hosts.length,
    knownHosts: rows.length,
    healthyHosts: healthy.length,
    capacity: healthy.reduce((sum, row) => sum + row.capacity, 0),
    running: healthy.reduce((sum, row) => sum + row.running, 0),
    available: healthy.reduce((sum, row) => sum + row.available, 0),
    bestLatencyMs: latencies.length ? Math.min(...latencies) : 0,
    browserE2eAvailable: healthy.some((row) => row.available > 0 && row.capabilities?.browserE2e === true),
  };
}

export function taskRequiresBrowserE2e(text: string): boolean {
  return /\b(?:playwright|end[- ]to[- ]end|e2e|browser\s+(?:test|testing|automation)|visual\s+regression|screenshot\s+test|axe\s+(?:test|audit)|lighthouse)\b/i.test(String(text || ''));
}

export async function runnerHostSupportsBrowserE2e(hostId?: string): Promise<boolean | undefined> {
  const host = runnerHostById(hostId);
  if (!host) return undefined;
  const health = await probeRunnerHost(host, true);
  return health.capabilities?.browserE2e;
}

function rankAvailableHosts(
  snapshot: Array<{ host: RunnerHostConfig; health: RunnerHostHealth }>,
  exclude: Set<string>,
): RunnerHostConfig[] {
  return snapshot
    .filter(({ host, health }) => !exclude.has(host.id) && health.ok && !health.draining && health.available > 0)
    .sort((a, b) => {
      const aLoad = a.health.running / Math.max(1, a.health.capacity);
      const bLoad = b.health.running / Math.max(1, b.health.capacity);
      if (aLoad !== bLoad) return aLoad - bLoad;
      if (a.host.weight !== b.host.weight) return b.host.weight - a.host.weight;
      return a.health.latencyMs - b.health.latencyMs;
    })
    .map(({ host }) => host);
}

export async function rankedRunnerHosts(exclude = new Set<string>()): Promise<RunnerHostConfig[]> {
  let snapshot = await runnerPoolSnapshot();
  let totalRunning = snapshot.reduce((sum, item) => sum + (item.health.ok ? item.health.running : 0), 0);
  if (totalRunning >= runnerGlobalMaxWorkspaces()) {
    throw new Error(`Orlynx runner pool reached the global workspace limit (${totalRunning}/${runnerGlobalMaxWorkspaces()}).`);
  }

  let ranked = rankAvailableHosts(snapshot, exclude);
  if (ranked.length > 0) return ranked;

  // Free/scale-to-zero hosts can all be asleep at once. A normal health pass
  // may cache timeouts or temporarily open the circuit, which must not make
  // configured capacity look permanently unavailable. Before falling back to
  // Codespaces, perform one bounded forced wake pass that bypasses the circuit
  // and gives each host the configured cold-start window.
  const wakeableHosts = runnerHosts().filter((host) => !exclude.has(host.id));
  if (!wakeableHosts.length) return [];

  console.warn(`[runner-pool] no immediately healthy hosts; forcing wake probe across ${wakeableHosts.length} configured runner host(s)`);
  snapshot = await Promise.all(wakeableHosts.map(async (host) => ({
    host,
    health: await probeRunnerHost(host, true),
  })));

  totalRunning = snapshot.reduce((sum, item) => sum + (item.health.ok ? item.health.running : 0), 0);
  if (totalRunning >= runnerGlobalMaxWorkspaces()) {
    throw new Error(`Orlynx runner pool reached the global workspace limit (${totalRunning}/${runnerGlobalMaxWorkspaces()}).`);
  }

  ranked = rankAvailableHosts(snapshot, exclude);
  if (ranked.length > 0) {
    console.info(`[runner-pool] forced wake recovered ${ranked.length} usable runner host(s)`);
  }
  return ranked;
}
