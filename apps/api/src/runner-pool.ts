export interface RunnerHostConfig {
  id: string;
  url: string;
  publicUrl: string;
  region?: string;
  weight: number;
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
  const attemptTimeouts = force ? [coldStartTimeoutMs] : [normalTimeoutMs, coldStartTimeoutMs];
  let lastDetail = 'health probe failed';

  for (let attempt = 0; attempt < attemptTimeouts.length; attempt += 1) {
    try {
      const response = await fetch(`${host.url}/health`, {
        headers: process.env.ORLYNX_RUNNER_TOKEN ? { Authorization: `Bearer ${process.env.ORLYNX_RUNNER_TOKEN}` } : {},
        signal: AbortSignal.timeout(attemptTimeouts[attempt]),
      });
      const body = await response.json().catch(() => ({})) as {
        ok?: boolean;
        capacity?: number;
        running?: number;
        available?: number;
        stopped?: number;
        draining?: boolean;
        workspace?: { state?: string } | null;
        capabilities?: { browserE2e?: boolean };
      };
      const capacity = Math.max(1, Number(body.capacity || 1));
      const running = Math.max(0, Number(body.running ?? (body.workspace?.state === 'running' ? 1 : 0)));
      const available = Math.max(0, Number(body.available ?? (capacity - running)));
      const result: RunnerHostHealth = {
        id: host.id,
        ok: response.ok && body.ok !== false,
        capacity,
        running,
        available,
        stopped: Math.max(0, Number(body.stopped || 0)),
        draining: Boolean(body.draining),
        latencyMs: Date.now() - started,
        checkedAt: Date.now(),
        detail: response.ok ? undefined : `HTTP ${response.status}`,
        capabilities: body.capabilities,
      };

      if (result.ok) {
        healthCache.set(host.id, result);
        noteRunnerHostSuccess(host.id);
        return result;
      }

      lastDetail = result.detail || 'runner reported unhealthy';
      const retryableStatus = response.status === 502 || response.status === 503 || response.status === 504;
      if (attempt + 1 < attemptTimeouts.length && retryableStatus) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        continue;
      }

      healthCache.set(host.id, result);
      noteRunnerHostFailure(host.id);
      return result;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : 'health probe failed';
      if (attempt + 1 < attemptTimeouts.length) {
        // Render free services can be asleep when the first probe arrives.
        // Give the same request path one bounded cold-start window before
        // opening the circuit or falling back to Codespaces.
        await new Promise((resolve) => setTimeout(resolve, 750));
        continue;
      }
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
