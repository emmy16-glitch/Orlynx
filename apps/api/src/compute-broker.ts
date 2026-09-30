import type { WorkspaceProviderId } from '@orlynx/shared';
import { e2bConfigured } from './e2b-provider.js';
import { orlynxRunnerConfigured } from './orlynx-runner.js';
import { runnerPoolHealthSummary, taskRequiresBrowserE2e } from './runner-pool.js';

export type ComputeTargetId = 'direct-runtime' | WorkspaceProviderId;

interface ComputeTargetState {
  successes: number;
  failures: number;
  consecutiveFailures: number;
  latencyEmaMs: number;
  quarantineUntil: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastFailure?: string;
}

export interface ComputeBrokerScore {
  id: WorkspaceProviderId;
  score: number;
  quarantined: boolean;
  configured: boolean;
  reason: string;
}

const states = new Map<ComputeTargetId, ComputeTargetState>();
const ALPHA = 0.35;

function stateFor(id: ComputeTargetId): ComputeTargetState {
  let state = states.get(id);
  if (!state) {
    state = { successes: 0, failures: 0, consecutiveFailures: 0, latencyEmaMs: 0, quarantineUntil: 0 };
    states.set(id, state);
  }
  return state;
}

function updateLatency(state: ComputeTargetState, latencyMs?: number): void {
  if (!latencyMs || !Number.isFinite(latencyMs) || latencyMs <= 0) return;
  state.latencyEmaMs = state.latencyEmaMs > 0
    ? Math.round(state.latencyEmaMs * (1 - ALPHA) + latencyMs * ALPHA)
    : Math.round(latencyMs);
}

export function noteComputeSuccess(id: ComputeTargetId, latencyMs?: number): void {
  const state = stateFor(id);
  state.successes += 1;
  state.consecutiveFailures = 0;
  state.quarantineUntil = 0;
  state.lastSuccessAt = Date.now();
  updateLatency(state, latencyMs);
}

export function noteComputeFailure(id: ComputeTargetId, detail = 'compute failure', latencyMs?: number): void {
  const state = stateFor(id);
  state.failures += 1;
  state.consecutiveFailures += 1;
  state.lastFailureAt = Date.now();
  state.lastFailure = String(detail || 'compute failure').replace(/\s+/g, ' ').slice(0, 220);
  updateLatency(state, latencyMs);

  const threshold = Math.max(1, Number(process.env.ORLYNX_COMPUTE_QUARANTINE_FAILURES || 2));
  if (state.consecutiveFailures >= threshold) {
    const baseCooldown = Math.max(15_000, Number(process.env.ORLYNX_COMPUTE_QUARANTINE_MS || 90_000));
    const multiplier = Math.min(4, state.consecutiveFailures - threshold + 1);
    state.quarantineUntil = Date.now() + baseCooldown * multiplier;
  }
}

export function computeTargetQuarantined(id: ComputeTargetId, now = Date.now()): boolean {
  return (stateFor(id).quarantineUntil || 0) > now;
}

export function resetComputeBrokerForTests(): void {
  states.clear();
}

function providerConfigured(id: WorkspaceProviderId): boolean {
  if (id === 'e2b') return e2bConfigured();
  if (id === 'orlynx-runner') return orlynxRunnerConfigured();
  return true;
}

function baseProviderScore(id: WorkspaceProviderId): number {
  // Codespaces remains the durability baseline. Healthy warm runners/E2B can
  // overtake it through live health and observed latency rather than by a hard
  // coded global switch.
  if (id === 'github-codespaces') return 90;
  if (id === 'e2b') return 82;
  return 78;
}

function historicalScore(id: WorkspaceProviderId, now = Date.now()): { value: number; reason: string } {
  const state = stateFor(id);
  let value = 0;
  const reasons: string[] = [];

  if (state.successes > 0) {
    const successRatio = state.successes / Math.max(1, state.successes + state.failures);
    value += Math.round(successRatio * 12);
    reasons.push(`success=${Math.round(successRatio * 100)}%`);
  }
  if (state.consecutiveFailures > 0) {
    value -= Math.min(36, state.consecutiveFailures * 12);
    reasons.push(`failures=${state.consecutiveFailures}`);
  }
  if (state.latencyEmaMs > 0) {
    value -= Math.min(25, Math.round(state.latencyEmaMs / 4_000));
    reasons.push(`latency≈${state.latencyEmaMs}ms`);
  }
  if (state.quarantineUntil > now) {
    value -= 120;
    reasons.push('quarantined');
  }

  return { value, reason: reasons.join(', ') || 'no-history' };
}

export function workspaceProviderScores(input: {
  attempted?: Iterable<WorkspaceProviderId>;
  taskText?: string;
  preferredProvider?: WorkspaceProviderId;
  now?: number;
} = {}): ComputeBrokerScore[] {
  const now = input.now ?? Date.now();
  const attempted = new Set(input.attempted || []);
  const needsBrowser = taskRequiresBrowserE2e(input.taskText || '');
  const runner = runnerPoolHealthSummary();

  return (['github-codespaces', 'e2b', 'orlynx-runner'] as WorkspaceProviderId[]).map((id) => {
    const configured = providerConfigured(id);
    const history = historicalScore(id, now);
    let score = configured ? baseProviderScore(id) + history.value : -1_000;
    const reasons = [history.reason];

    if (input.preferredProvider === id) {
      score += 8;
      reasons.push('sticky-preference');
    }
    if (attempted.has(id)) {
      score -= 500;
      reasons.push('already-attempted');
    }

    if (id === 'orlynx-runner') {
      if (runner.knownHosts > 0) {
        if (runner.healthyHosts > 0 && runner.available > 0) {
          score += 18;
          const load = runner.running / Math.max(1, runner.capacity);
          score -= Math.round(load * 20);
          if (runner.bestLatencyMs > 0) score -= Math.min(10, Math.round(runner.bestLatencyMs / 1_000));
          reasons.push(`runner=${runner.healthyHosts}/${runner.totalHosts}, available=${runner.available}`);
        } else {
          score -= 35;
          reasons.push('runner-unhealthy');
        }
      } else {
        reasons.push('runner-health-unknown');
      }
      if (needsBrowser && runner.knownHosts > 0 && !runner.browserE2eAvailable) {
        score -= 120;
        reasons.push('browser-capability-missing');
      }
    }

    return {
      id,
      score,
      quarantined: computeTargetQuarantined(id, now),
      configured,
      reason: reasons.join('; '),
    };
  }).sort((a, b) => b.score - a.score);
}

export async function selectWorkspaceProvider(input: {
  attempted?: Iterable<WorkspaceProviderId>;
  taskText?: string;
  preferredProvider?: WorkspaceProviderId;
} = {}): Promise<WorkspaceProviderId | null> {
  const ranked = workspaceProviderScores(input);
  const usable = ranked.find((item) => item.configured && item.score > -400 && !item.quarantined);
  if (usable) return usable.id;

  // If every configured provider is quarantined, prefer degraded service over
  // a hard stop. The attempted set still prevents loops within one preparation.
  const degraded = ranked.find((item) => item.configured && item.score > -400);
  return degraded?.id || null;
}

export function computeBrokerSnapshot(): Array<{
  id: ComputeTargetId;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  latencyEmaMs: number;
  quarantined: boolean;
  quarantineUntil: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastFailure?: string;
}> {
  const ids: ComputeTargetId[] = ['direct-runtime', 'github-codespaces', 'e2b', 'orlynx-runner'];
  return ids.map((id) => {
    const state = stateFor(id);
    return {
      id,
      successes: state.successes,
      failures: state.failures,
      consecutiveFailures: state.consecutiveFailures,
      latencyEmaMs: state.latencyEmaMs,
      quarantined: computeTargetQuarantined(id),
      quarantineUntil: state.quarantineUntil,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      lastFailure: state.lastFailure,
    };
  });
}
